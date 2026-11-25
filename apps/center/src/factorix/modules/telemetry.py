"""Historian ingest, queries, retention and dashboards.

Compatibility shim (R2-E Phase B, B5): the implementation moved, unchanged, to
``factorix.application.live.latest_api``, ``factorix.application.history.legacy_api``,
``factorix.application.dashboards`` and ``factorix.adapters.legacy_pg_telemetry.{retention,ingest}``.
Every name is re-exported here, and attribute patches on this module are forwarded to the new modules
(``factorix._shims``).
"""

from __future__ import annotations

# Original imports, kept so every name importable from this module before the split still is.
import asyncio  # noqa: F401
import collections  # noqa: F401
from collections.abc import Mapping  # noqa: F401
import logging  # noqa: F401
import math  # noqa: F401
import time  # noqa: F401
from datetime import datetime, timedelta, timezone  # noqa: F401
from typing import Any  # noqa: F401
from uuid import UUID, uuid4  # noqa: F401
from pydantic import BaseModel, Field  # noqa: F401
from sqlalchemy import text  # noqa: F401
from sqlalchemy.exc import SQLAlchemyError  # noqa: F401
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: F401
from factorix.domain.csv_safe import csv_row  # noqa: F401
from factorix.domain.formula import FormulaError, bind, evaluate, output_quality, parse_expression  # noqa: F401
from factorix.domain.health import NO_DATA_PREFIX, effective_connection_health  # noqa: F401
from factorix.domain.observation import EDGE_CLOCK_FUTURE, Observation, ObservationError, Quality, resolve_times  # noqa: F401
from factorix.domain.quality import Origin  # noqa: F401
from factorix.domain.signal_state import evaluate_signal_state  # noqa: F401
from factorix.modules.history_repository import get_history_provider  # noqa: F401
from factorix.modules.live_state import (  # noqa: F401
    compute_health_dimensions,
    extract_runtime_health,
    get_live_state_provider,
    record_from_pg_row,
)
from factorix.modules.common import (  # noqa: F401
    as_uuid,
    audit,
    create_partitions_for,
    execute,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    parse_uuid,
    queue_stream_event,
    utcnow,
)
from factorix.platform.errors import AppError  # noqa: F401

from factorix.application.live.latest_api import (  # noqa: F401
    RejectionThrottle,
    _LATEST_TIME_FIELDS,
    connection_health_payload,
    finite_or_none,
    latest_states,
    latest_stream_payload,
    logger,
    select_binding,
)
from factorix.application.history.legacy_api import (  # noqa: F401
    AGGREGATES,
    _INGEST_RATE,
    _IngestRate,
    _TOTALS_TTL_S,
    _active_epoch,
    _compute_observation_totals,
    _estimated_totals,
    _observation_totals,
    _refresh_totals,
    _schedule_totals_refresh,
    _totals_cache,
    _totals_refreshing,
    _totals_tasks,
    aggregate,
    export_csv,
    history,
    storage_overview,
)
from factorix.application.dashboards import (  # noqa: F401
    DashboardIn,
    DashboardPatch,
    WIDGETS,
    create_dashboard,
    get_dashboard,
    patch_dashboard,
    publish_dashboard,
)
from factorix.adapters.legacy_pg_telemetry.retention import (  # noqa: F401
    RetentionIn,
    _policy,
    _scope_held,
    apply_retention_policies,
    create_retention,
    enable_retention,
    execute_retention,
    preview_retention,
    retention_scope,
)
from factorix.adapters.legacy_pg_telemetry.ingest import (  # noqa: F401
    _BULK_DEDUP,
    _BULK_LATEST,
    _BULK_OBSERVATIONS,
    _BatchContext,
    _StoreOutcome,
    _batch_context,
    _item_revisions,
    _item_signal_ids,
    _mark_connections_live,
    _owned_binding,
    _quarantine,
    _rejections,
    _run_formulas,
    _store_batch,
    _store_observation,
    _store_rows,
    _to_observation,
    _truncate_events,
    _upsert_latest,
    _value_json,
    ingest_observations,
    newest_per_signal,
)

from factorix import _shims  # noqa: E402

_shims.forward_patches(
    __name__,
    "factorix.application.live.latest_api",
    "factorix.application.history.legacy_api",
    "factorix.application.dashboards",
    "factorix.adapters.legacy_pg_telemetry.retention",
    "factorix.adapters.legacy_pg_telemetry.ingest",
)
