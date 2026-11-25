"""RabbitMQ -> Validation -> Epoch Fence -> TDengine -> Live State Ingestion Worker (S06).

Consumes canonical observations from RabbitMQ Quorum Queue ``factorix.telemetry.ingest.q``,
validates envelopes, fences stale epochs via ``telemetry_generations``, verifies signal
bindings in PostgreSQL (without requiring legacy ``edge_nodes``), evaluates recording
policies, writes durably to TDengine operational history, evaluates published formulas
synchronously (depth <= 4), updates ``latest_signal_state`` and ``connections`` liveness,
pushes chunked WebSocket events via PostgreSQL ``NOTIFY``, and ACKs RabbitMQ ONLY after all
durable storage effects succeed.

Compatibility shim (R2-E Phase B, B4): the implementation moved, unchanged, to the package
``factorix.application.ingestion`` (one module per stage) and ``to_asyncpg_dsn`` to
``factorix.platform.db``. Every name is re-exported here, and attribute patches on this module are
forwarded to the new modules (``factorix._shims``).
"""

from __future__ import annotations

# Original imports, kept so every name importable from this module before the split still is.
import asyncio  # noqa: F401
from collections import OrderedDict, deque  # noqa: F401
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence  # noqa: F401
from dataclasses import dataclass, field, replace  # noqa: F401
from datetime import datetime, timedelta, timezone  # noqa: F401
import hashlib  # noqa: F401
import json  # noqa: F401
import logging  # noqa: F401
import math  # noqa: F401
import os  # noqa: F401
import time  # noqa: F401
from typing import Any  # noqa: F401
from uuid import UUID, uuid4  # noqa: F401
import asyncpg  # noqa: F401
from aio_pika.abc import AbstractIncomingMessage  # noqa: F401
from factorix.domain.canonical import (  # noqa: F401
    OBS_BATCH_CONTENT_TYPE,
    OBS_BATCH_HEADER,
    OBS_BATCH_HEADER_VALUE,
    OBS_BATCH_SCHEMA,
    CanonicalObservation,
    LatencySLIs,
    decode_observation_batch,
    intern_uuid,
    measure_latency_slis,
    redact_provenance,
)
from factorix.domain.formula import FormulaError, bind, evaluate, output_quality, parse_expression  # noqa: F401
from factorix.domain.health import NO_DATA_PREFIX, effective_connection_health  # noqa: F401
from factorix.domain.observation import ObservationError, resolve_times  # noqa: F401
from factorix.domain.quality import Origin, Quality  # noqa: F401
from factorix.modules.common import iso_ms  # noqa: F401
from factorix.modules.live_state import TDengineLiveStateProvider  # noqa: F401
from factorix.modules.providers import LiveSignalRecord, RecordingDecision, RecordingPolicyEvaluator  # noqa: F401
from factorix.modules.recording_policy import (  # noqa: F401
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
    ManagedSubtableWrite,
    build_managed_target_from_row,
    build_managed_target_from_storage_binding,
)
from factorix.modules.telemetry import RejectionThrottle, connection_health_payload, latest_stream_payload, select_binding  # noqa: F401
from factorix.platform.broker import BrokerConfig, ConsumeOutcome, RabbitMQConsumer  # noqa: F401
from factorix.platform.tdengine import (  # noqa: F401
    BatchWriteFailure,
    BatchWriteResult,
    SubtableWriteItem,
    TDEngineClient,
    TDEngineError,
    op_stable_for_type,
    op_subtable_name,
    td_error_is_schema_missing,
    tenant_database_name,
    to_td_timestamp_us,
    to_utc_datetime,
)

from factorix.application.ingestion.common import (  # noqa: F401
    DEFAULT_INSTANCE_ID,
    LANE_LEGACY,
    LANE_LIVE,
    MAX_BATCH_ITEMS,
    MAX_BATCH_MESSAGE_BYTES,
    MAX_FORMULA_DEPTH,
    MAX_MESSAGE_BYTES,
    REPLAY_YIELD_MAX_S,
    YIELD_EVERY_ITEMS,
    _WakeAll,
    _WorkerStoppingRetry,
    _deterministic_calc_uid,
    _json_val,
    _utcnow,
    logger,
)
from factorix.application.ingestion.metrics import (  # noqa: F401
    LatencyHistogram,
    RecentUidLru,
    WorkerMetrics,
)
from factorix.application.ingestion.notify import (  # noqa: F401
    NOTIFY_CHANNEL_HEALTH,
    NOTIFY_CHANNEL_STREAM,
    NOTIFY_CHUNK_MAX_BYTES,
    NOTIFY_CHUNK_MAX_EVENTS,
    _emit_chunked_notify,
    _latest_ids_payloads,
)
from factorix.application.ingestion.envelope import (  # noqa: F401
    _PendingEnvelope,
    _PreparedObs,
)
from factorix.application.ingestion.catalog import (  # noqa: F401
    TenantCatalog,
    _CatalogStage,
    _CatalogStore,
    _default_owned_check,
)
from factorix.application.ingestion.latest_state import (  # noqa: F401
    _LatestStateStore,
)
from factorix.application.ingestion.pg_store import (  # noqa: F401
    PgIngestionStore,
)
from factorix.application.ingestion.decode import (  # noqa: F401
    _DecodeStage,
)
from factorix.application.ingestion.lanes import (  # noqa: F401
    _LaneStage,
)
from factorix.application.ingestion.validate import (  # noqa: F401
    _ValidateStage,
)
from factorix.application.ingestion.td_write import (  # noqa: F401
    _TdWriteStage,
)
from factorix.application.ingestion.policy import (  # noqa: F401
    _PolicyStage,
)
from factorix.application.ingestion.formulas import (  # noqa: F401
    _FormulaStage,
)
from factorix.application.ingestion.persist import (  # noqa: F401
    _PersistStage,
)
from factorix.application.ingestion.worker import (  # noqa: F401
    IngestionWorker,
)
from factorix.application.ingestion.parity import (  # noqa: F401
    ParityDiffReport,
    _values_equal,
    compare_pg_vs_tdengine_observations,
)
from factorix.platform.db import (  # noqa: F401
    to_asyncpg_dsn,
)

from factorix import _shims  # noqa: E402

_shims.forward_patches(
    __name__,
    "factorix.application.ingestion.common",
    "factorix.application.ingestion.metrics",
    "factorix.application.ingestion.notify",
    "factorix.application.ingestion.envelope",
    "factorix.application.ingestion.catalog",
    "factorix.application.ingestion.latest_state",
    "factorix.application.ingestion.pg_store",
    "factorix.application.ingestion.decode",
    "factorix.application.ingestion.lanes",
    "factorix.application.ingestion.validate",
    "factorix.application.ingestion.td_write",
    "factorix.application.ingestion.policy",
    "factorix.application.ingestion.formulas",
    "factorix.application.ingestion.persist",
    "factorix.application.ingestion.worker",
    "factorix.application.ingestion.parity",
)
