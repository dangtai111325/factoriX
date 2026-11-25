"""Safe Selective Telemetry Reset (``CLEAR_TELEMETRY_ONLY``) service and HTTP router (S13).

Implements §10 / §13 of the Master Implementation Plan (RESET-01..17):
- Replaces destructive ``TRUNCATE ... RESTART IDENTITY CASCADE`` full-installation wipe with
  a deterministic 6-stage state machine (``R0 -> R1 -> R2 -> R3 -> R4 -> R5``).
- Strictly preserves all control-plane and configuration entities: ``tenants``, ``sites``,
  ``admin_accounts``, ``sessions``, ``secret_store``, ``resource_types``, ``resources``,
  ``connections``, ``acquisition_jobs``, ``source_fields``, ``signal_definitions``,
  ``signal_bindings``, ``formula_definitions``, ``output_groups``, ``storage_designs``,
  ``storage_design_versions``, ``storage_datasets``, ``storage_field_bindings``,
  ``storage_recording_policies``, ``saved_queries``, and ``alembic_version``.
- Advances ``telemetry_generations.active_epoch`` atomically under a tenant-scoped advisory lock,
  fences in-flight producers/consumers via ``pg_notify``, softly purges RabbitMQ queues when
  reachable, deletes the rows of every tenant TDengine supertable (databases, supertables, subtables and tags are kept), deletes
  only tenant runtime/telemetry rows in PostgreSQL, invalidates ``LiveStateProvider`` cache,
  records an immutable ``storage_operations`` saga log and ``audit_events`` entry, and keeps the
  administrator authenticated.

R2-E B8: compatibility shim. The code lives in ``factorix.application.reset``: ``constants``, ``inventory`` (R0
read-only counts/fingerprint/TDengine subtables), ``broker_purge`` (R2), ``telemetry_reset`` (one function per stage
R0..R5 + the failure fence), ``service`` (``TelemetryResetService``), ``router`` (``build_router``). This module keeps
the old import path, the original imports, every original name and the module-level ``router``; patches set on it
reach the moved code (``factorix._shims.forward_patches``).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping  # noqa: F401
from dataclasses import dataclass, field  # noqa: F401
from datetime import datetime, timezone  # noqa: F401
import hashlib  # noqa: F401
import json  # noqa: F401
import logging
from typing import Any  # noqa: F401
from uuid import UUID, uuid4  # noqa: F401

from fastapi import APIRouter, Depends, Request  # noqa: F401
from pydantic import BaseModel, Field  # noqa: F401
from sqlalchemy.exc import SQLAlchemyError  # noqa: F401
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: F401

from factorix.modules.common import (  # noqa: F401
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    parse_uuid,
    queue_stream_event,
    utcnow,
)
from factorix.modules.identity import SESSION_COOKIE, assert_csrf, principal_from_token  # noqa: F401
from factorix.modules.live_state import get_live_state_provider  # noqa: F401
from factorix.platform.db import session_factory  # noqa: F401
from factorix.platform.errors import AppError  # noqa: F401
from factorix.platform.http import correlation_id  # noqa: F401
from factorix.platform.security import verify_password  # noqa: F401
from factorix.platform.settings import get_settings  # noqa: F401
from factorix.platform.tdengine import (  # noqa: F401
    TDEngineClient,
    TDEngineError,
    quote_fq_table,
    quote_str,
    tenant_database_name,
    validate_identifier,
)

from factorix.application.reset.broker_purge import _extract_purged_count, _purge_broker_softly  # noqa: F401
from factorix.application.reset.constants import (  # noqa: F401
    AUDIT_ACTION,
    CLEARED_PG_TABLES,
    CONFIRM_PHRASE,
    OPERATION_KIND,
    PROTECTED_CONTROL_PLANE_TABLES,
    STAGE_R0_PREFLIGHT,
    STAGE_R1_QUIESCING,
    STAGE_R2_PURGE_BROKER,
    STAGE_R3_CLEAR_TDENGINE,
    STAGE_R4_CLEAR_PG_RUNTIME_CACHES,
    STAGE_R5_RESUME_AND_AUDIT,
    STATE_MACHINE_ORDER,
)
from factorix.application.reset.inventory import (  # noqa: F401
    _collect_pg_cleared_counts,
    _collect_preserved_counts,
    _collect_structural_fingerprint,
    _compute_manifest_hash,
    _inspect_tdengine_subtables,
    _is_missing_td_error,
    _safe_count,
    _tenant_advisory_lock_key,
)
from factorix.application.reset.router import (  # noqa: F401
    TelemetryResetExecuteIn,
    _default_admin_principal,
    _default_db_session,
    _resolve_broker_config,
    _resolve_td_client,
    build_router,
)
from factorix.application.reset.service import TelemetryResetService  # noqa: F401
from factorix.application.reset.telemetry_reset import (  # noqa: F401
    ResetRun,
    record_failed_fenced,
    stage_r0_preflight,
    stage_r1_quiescing,
    stage_r2_purge_broker,
    stage_r3_clear_tdengine,
    stage_r4_clear_pg_runtime_caches,
    stage_r5_resume_and_audit,
    verify_preservation,
)

logger = logging.getLogger(__name__)

from factorix import _shims  # noqa: E402

_shims.forward_patches(
    __name__,
    "factorix.application.reset.constants",
    "factorix.application.reset.inventory",
    "factorix.application.reset.broker_purge",
    "factorix.application.reset.telemetry_reset",
    "factorix.application.reset.service",
    "factorix.application.reset.router",
)

router = build_router()
