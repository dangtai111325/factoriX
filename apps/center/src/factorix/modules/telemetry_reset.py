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
  reachable, drops tenant TDengine time-series subtables while preserving STable schemas, deletes
  only tenant runtime/telemetry rows in PostgreSQL, invalidates ``LiveStateProvider`` cache,
  records an immutable ``storage_operations`` saga log and ``audit_events`` entry, and keeps the
  administrator authenticated.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import logging
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
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
from factorix.modules.identity import SESSION_COOKIE, assert_csrf, principal_from_token
from factorix.modules.live_state import get_live_state_provider
from factorix.platform.db import session_factory
from factorix.platform.errors import AppError
from factorix.platform.http import correlation_id
from factorix.platform.security import verify_password
from factorix.platform.settings import get_settings
from factorix.platform.tdengine import (
    TDEngineClient,
    TDEngineError,
    quote_fq_table,
    tenant_database_name,
    validate_identifier,
)

logger = logging.getLogger(__name__)

CONFIRM_PHRASE = "CLEAR TELEMETRY"
OPERATION_KIND = "TELEMETRY_RESET"
AUDIT_ACTION = "TELEMETRY_RESET_EXECUTED"

STAGE_R0_PREFLIGHT = "R0_PREFLIGHT"
STAGE_R1_QUIESCING = "R1_QUIESCING"
STAGE_R2_PURGE_BROKER = "R2_PURGE_BROKER"
STAGE_R3_CLEAR_TDENGINE = "R3_CLEAR_TDENGINE"
STAGE_R4_CLEAR_PG_RUNTIME_CACHES = "R4_CLEAR_PG_RUNTIME_CACHES"
STAGE_R5_RESUME_AND_AUDIT = "R5_RESUME_AND_AUDIT"

STATE_MACHINE_ORDER: tuple[str, ...] = ("R0", "R1", "R2", "R3", "R4", "R5")

# Explicit allowlist of runtime telemetry tables whose tenant rows are cleared in R4.
CLEARED_PG_TABLES: tuple[str, ...] = (
    "observations",
    "ingest_dedup",
    "latest_signal_state",
    "observation_quarantine",
    "model_snapshots",
    "model_state",
    "commissioning_jobs",
    "export_jobs",
)

# Explicit set of control-plane / configuration tables that MUST NEVER be deleted or truncated.
PROTECTED_CONTROL_PLANE_TABLES: frozenset[str] = frozenset(
    {
        "tenants",
        "sites",
        "admin_accounts",
        "sessions",
        "secret_store",
        "resource_types",
        "resources",
        "relation_types",
        "type_adjacency",
        "resource_relations",
        "hierarchy_templates",
        "hierarchy_views",
        "connections",
        "acquisition_jobs",
        "source_fields",
        "signal_definitions",
        "signal_bindings",
        "mapping_definitions",
        "formula_definitions",
        "formula_dependencies",
        "output_groups",
        "output_group_members",
        "model_templates",
        "model_refs",
        "storage_designs",
        "storage_design_versions",
        "storage_datasets",
        "storage_field_bindings",
        "storage_recording_policies",
        "storage_physical_registry",
        "storage_dependencies",
        "saved_queries",
        "alembic_version",
    }
)


def _tenant_advisory_lock_key(tenant_id: UUID) -> int:
    """Derive a deterministic signed 64-bit advisory lock key scoped to ``tenant_id``."""
    digest = hashlib.sha256(f"factorix:telemetry_reset:{tenant_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


def _compute_manifest_hash(tenant_id: UUID, active_epoch: int, preserved: Mapping[str, int]) -> str:
    canonical = json.dumps(
        {
            "tenant_id": str(tenant_id),
            "active_epoch": int(active_epoch),
            "preserved": {k: int(preserved[k]) for k in sorted(preserved)},
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _is_missing_td_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "not exist",
            "doesn't exist",
            "does not exist",
            "unknown database",
            "database not specified",
            "0x0362",
            "0x2103",
            "0x2603",
            "0x0380",
        )
    )


async def _safe_count(session: AsyncSession, sql: str, params: dict[str, Any]) -> int:
    try:
        row = await fetch_one(session, sql, params)
        if not row:
            return 0
        for val in row.values():
            return int(val or 0)
        return 0
    except SQLAlchemyError:
        return 0


async def _collect_pg_cleared_counts(session: AsyncSession, tenant_id: UUID) -> dict[str, int]:
    p = {"tenant_id": tenant_id}
    return {
        "observations": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM observations WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "latest_signal_state": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM latest_signal_state WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "model_snapshots": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM model_snapshots WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "model_state": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM model_state WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "ingest_dedup": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM ingest_dedup WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "observation_quarantine": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM observation_quarantine WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "commissioning_jobs": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM commissioning_jobs WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
        "export_jobs": await _safe_count(
            session, "SELECT COUNT(*) AS cnt FROM export_jobs WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        ),
    }


async def _collect_preserved_counts(session: AsyncSession, tenant_id: UUID) -> dict[str, int]:
    p = {"tenant_id": tenant_id}
    connections = await _safe_count(
        session, "SELECT COUNT(*) AS cnt FROM connections WHERE tenant_id = CAST(:tenant_id AS uuid)", p
    )
    signals_active = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM signal_definitions WHERE tenant_id = CAST(:tenant_id AS uuid) AND status = 'ACTIVE'",
        p,
    )
    signals_archived = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM signal_definitions WHERE tenant_id = CAST(:tenant_id AS uuid) AND status = 'ARCHIVED'",
        p,
    )
    data_models = await _safe_count(
        session, "SELECT COUNT(*) AS cnt FROM output_groups WHERE tenant_id = CAST(:tenant_id AS uuid)", p
    )
    storage_designs = await _safe_count(
        session, "SELECT COUNT(*) AS cnt FROM storage_designs WHERE tenant_id = CAST(:tenant_id AS uuid)", p
    )
    resources_cnt = await _safe_count(
        session, "SELECT COUNT(*) AS cnt FROM resources WHERE tenant_id = CAST(:tenant_id AS uuid)", p
    )
    admin_accounts = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM admin_accounts WHERE tenant_id = CAST(:tenant_id AS uuid) AND disabled_at IS NULL",
        p,
    )
    sessions_cnt = await _safe_count(
        session,
        """
        SELECT COUNT(*) AS cnt
        FROM sessions s
        JOIN admin_accounts a ON a.id = s.admin_id
        WHERE a.tenant_id = CAST(:tenant_id AS uuid) AND s.revoked_at IS NULL
        """,
        p,
    )
    secret_store = await _safe_count(
        session, "SELECT COUNT(*) AS cnt FROM secret_store WHERE tenant_id = CAST(:tenant_id AS uuid)", p
    )
    formulas = await _safe_count(
        session,
        """
        SELECT COUNT(*) AS cnt
        FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        WHERE s.tenant_id = CAST(:tenant_id AS uuid)
        """,
        p,
    )
    return {
        "connections": connections,
        "signals_active": signals_active,
        "signals_archived": signals_archived,
        "data_models": data_models,
        "storage_designs": storage_designs,
        "resources": resources_cnt,
        "admin_accounts": admin_accounts,
        "sessions": sessions_cnt,
        "secret_store": secret_store,
        "formulas": formulas,
    }


async def _inspect_tdengine_subtables(
    session: AsyncSession,
    tenant_id: UUID,
    tdengine: TDEngineClient | None,
) -> tuple[list[str], list[str]]:
    """Return ``(operational_subtables, managed_subtables)`` for ``tenant_id``."""
    op_subs: list[str] = []
    managed_subs: list[str] = []
    seen: set[str] = set()

    if tdengine is not None:
        prefix = getattr(getattr(tdengine, "config", None), "db_prefix", "fx_t_") or "fx_t_"
        db = tenant_database_name(tenant_id, prefix=prefix)
        try:
            subtables = await tdengine.list_subtables(db)
        except Exception as exc:  # noqa: BLE001
            if not _is_missing_td_error(exc):
                logger.warning("TDengine subtable listing failed for %s: %s", db, exc)
            subtables = []
        for sub in subtables:
            name = str(sub).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            if name.startswith(("op_", "ms_")):
                op_subs.append(name)
            else:
                managed_subs.append(name)

    try:
        reg_rows = await fetch_all(
            session,
            """
            SELECT td_subtable, tier
            FROM storage_physical_registry
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            ORDER BY td_subtable ASC
            """,
            {"tenant_id": tenant_id},
        )
    except SQLAlchemyError:
        reg_rows = []

    for row in reg_rows:
        sub = str(row.get("td_subtable") or "").strip()
        if not sub or sub in seen:
            continue
        seen.add(sub)
        tier = str(row.get("tier") or "MANAGED").upper()
        if tier in {"OPERATIONAL", "MODEL_SNAPSHOT"} or sub.startswith(("op_", "ms_")):
            op_subs.append(sub)
        else:
            managed_subs.append(sub)

    return op_subs, managed_subs


def _extract_purged_count(res: Any) -> int:
    if isinstance(res, Mapping):
        return int(res.get("messages_purged") or res.get("purged") or res.get("message_count") or 0)
    if isinstance(res, (int, float)) and not isinstance(res, bool):
        return int(res)
    msg_cnt = getattr(res, "message_count", None)
    if isinstance(msg_cnt, int) and not isinstance(msg_cnt, bool):
        return msg_cnt
    return 0


async def _purge_broker_softly(broker: Any) -> dict[str, Any]:
    """Purge queued telemetry messages if broker is reachable; non-fatal if offline."""
    if broker is None:
        return {"attempted": False, "purged": False, "messages_purged": 0, "status": "SKIPPED_NO_BROKER"}
    try:
        inst_dict = getattr(broker, "__dict__", {}) or {}
        cls_dict = getattr(type(broker), "__dict__", {}) or {}
        method_names = ("purge_queue", "purge_telemetry_queues", "purge")
        chosen_fn: Any = None
        for name in method_names:
            if name in inst_dict or name in cls_dict:
                cand = getattr(broker, name, None)
                if callable(cand):
                    chosen_fn = cand
                    break
        if chosen_fn is None:
            for name in method_names:
                cand = getattr(broker, name, None)
                if callable(cand) and not hasattr(broker, "amqp_url"):
                    chosen_fn = cand
                    break
        if chosen_fn is not None:
            res = await chosen_fn()
            return {
                "attempted": True,
                "purged": True,
                "messages_purged": _extract_purged_count(res),
                "status": "PURGED",
            }
        if isinstance(getattr(broker, "amqp_url", None), str) and broker.amqp_url:
            import aio_pika

            conn = await aio_pika.connect(broker.amqp_url, timeout=3.0)
            purged_total = 0
            try:
                channel = await conn.channel()
                for q_attr in ("queue_name", "dlq_name"):
                    q_name = getattr(broker, q_attr, None)
                    if isinstance(q_name, str) and q_name:
                        try:
                            q_obj = await channel.declare_queue(q_name, passive=True)
                            del_res = await q_obj.purge()
                            purged_total += _extract_purged_count(del_res)
                        except Exception:  # noqa: BLE001
                            pass
            finally:
                await conn.close()
            return {"attempted": True, "purged": True, "messages_purged": purged_total, "status": "PURGED"}
        return {"attempted": True, "purged": True, "messages_purged": 0, "status": "NOOP"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Soft broker purge skipped during telemetry reset (epoch fence active): %s", exc)
        return {
            "attempted": True,
            "purged": False,
            "messages_purged": 0,
            "status": "SOFT_FAILED_EPOCH_FENCED",
            "warning": str(exc),
        }


@dataclass(slots=True)
class TelemetryResetService:
    """Deterministic state machine ``R0 -> R1 -> R2 -> R3 -> R4 -> R5`` for ``CLEAR_TELEMETRY_ONLY``."""

    tdengine: TDEngineClient | None = None
    broker: Any = None
    live_provider: Any = None

    async def preview(
        self,
        session: AsyncSession,
        tenant_id: UUID | str,
        tdengine: TDEngineClient | None = None,
    ) -> dict[str, Any]:
        """R0 readonly preflight returning exact counts of what WILL be cleared vs preserved."""
        tid = as_uuid(tenant_id)
        eff_td = tdengine if tdengine is not None else self.tdengine

        gen_row = await fetch_one(
            session,
            """
            SELECT active_epoch, lifecycle_state, updated_at, reset_operation_id
            FROM telemetry_generations
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            """,
            {"tenant_id": tid},
        )
        active_epoch = max(1, int((gen_row or {}).get("active_epoch") or 1))
        lifecycle_state = str((gen_row or {}).get("lifecycle_state") or "ACTIVE")

        pg_cleared = await _collect_pg_cleared_counts(session, tid)
        preserved = await _collect_preserved_counts(session, tid)
        op_subs, managed_subs = await _inspect_tdengine_subtables(session, tid, eff_td)

        cleared = {
            **pg_cleared,
            "tdengine_operational_subtables": len(op_subs),
            "tdengine_managed_subtables": len(managed_subs),
            "tdengine_subtables_total": len(op_subs) + len(managed_subs),
        }
        manifest_hash = _compute_manifest_hash(tid, active_epoch, preserved)

        return {
            "tenant_id": str(tid),
            "mode": "CLEAR_TELEMETRY_ONLY",
            "stage": STAGE_R0_PREFLIGHT,
            "active_epoch": active_epoch,
            "next_epoch": active_epoch + 1,
            "lifecycle_state": lifecycle_state,
            "confirm_phrase_required": CONFIRM_PHRASE,
            "config_manifest_hash": manifest_hash,
            "cleared": cleared,
            "will_be_cleared": dict(cleared),
            "preserved": preserved,
            "will_be_preserved": dict(preserved),
            "tdengine_subtables": {
                "database": tenant_database_name(tid),
                "operational": op_subs,
                "managed": managed_subs,
            },
            "generated_at": iso_ms(utcnow()),
        }

    async def status(
        self,
        session: AsyncSession,
        tenant_id: UUID | str,
        *,
        operation_id: UUID | str | None = None,
    ) -> dict[str, Any]:
        """Return current epoch, lifecycle state, and latest ``TELEMETRY_RESET`` operation status."""
        tid = as_uuid(tenant_id)
        gen_row = await fetch_one(
            session,
            """
            SELECT active_epoch, lifecycle_state, updated_at, updated_by, reset_operation_id
            FROM telemetry_generations
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            """,
            {"tenant_id": tid},
        )
        active_epoch = max(1, int((gen_row or {}).get("active_epoch") or 1))
        lifecycle_state = str((gen_row or {}).get("lifecycle_state") or "ACTIVE")
        target_op_id = as_uuid(operation_id) if operation_id else (
            as_uuid(gen_row["reset_operation_id"]) if gen_row and gen_row.get("reset_operation_id") else None
        )

        if target_op_id is not None:
            op_row = await fetch_one(
                session,
                """
                SELECT id, operation_type, status, requested_at, started_at, completed_at,
                       step_state_json, error_code, error_message, actor_id
                FROM storage_operations
                WHERE tenant_id = CAST(:tenant_id AS uuid) AND id = CAST(:op_id AS uuid)
                """,
                {"tenant_id": tid, "op_id": target_op_id},
            )
        else:
            op_row = await fetch_one(
                session,
                """
                SELECT id, operation_type, status, requested_at, started_at, completed_at,
                       step_state_json, error_code, error_message, actor_id
                FROM storage_operations
                WHERE tenant_id = CAST(:tenant_id AS uuid) AND operation_type = CAST(:op_type AS text)
                ORDER BY requested_at DESC
                LIMIT 1
                """,
                {"tenant_id": tid, "op_type": OPERATION_KIND},
            )

        step_state: dict[str, Any] = {}
        if op_row and op_row.get("step_state_json"):
            raw_ss = op_row["step_state_json"]
            if isinstance(raw_ss, str):
                try:
                    step_state = json.loads(raw_ss)
                except json.JSONDecodeError:
                    step_state = {}
            elif isinstance(raw_ss, Mapping):
                step_state = dict(raw_ss)

        op_status = str(op_row["status"]) if op_row else "IDLE"
        if op_status == "COMPLETED":
            display_status = str(step_state.get("result_status") or "SUCCEEDED")
        else:
            display_status = op_status

        return {
            "tenant_id": str(tid),
            "active_epoch": active_epoch,
            "lifecycle_state": lifecycle_state,
            "operation_id": str(op_row["id"]) if op_row else None,
            "kind": OPERATION_KIND,
            "status": display_status,
            "db_status": op_status,
            "requested_at": iso_ms(op_row.get("requested_at")) if op_row else None,
            "started_at": iso_ms(op_row.get("started_at")) if op_row else None,
            "completed_at": iso_ms(op_row.get("completed_at")) if op_row else None,
            "error_code": op_row.get("error_code") if op_row else None,
            "error_message": op_row.get("error_message") if op_row else None,
            "step_state": step_state,
        }

    async def execute(
        self,
        session: AsyncSession,
        tenant_id: UUID | str,
        actor_id: UUID | str,
        *,
        confirm_phrase: str,
        password: str,
        tdengine: TDEngineClient | None = None,
        broker: Any = None,
        live_provider: Any = None,
    ) -> dict[str, Any]:
        """Execute deterministic selective reset ``R0 -> R1 -> R2 -> R3 -> R4 -> R5``."""
        tid = as_uuid(tenant_id)
        aid = as_uuid(actor_id)
        eff_td = tdengine if tdengine is not None else self.tdengine
        eff_broker = broker if broker is not None else self.broker
        eff_live = live_provider if live_provider is not None else (self.live_provider or get_live_state_provider())

        # ------------------------------------------------------------------
        # R0: Verify exact confirmation phrase & administrator credentials
        # ------------------------------------------------------------------
        if confirm_phrase != CONFIRM_PHRASE:
            raise AppError(
                400,
                "INVALID_CONFIRM_PHRASE",
                f"Confirmation phrase must be '{CONFIRM_PHRASE}'. Destructive 'REVERT TO ZERO' is disabled.",
            )

        if not password:
            raise AppError(401, "INVALID_CREDENTIALS", "Administrator password is required to clear telemetry.")

        admin_row = await fetch_one(
            session,
            """
            SELECT id, tenant_id, login, password_hash, disabled_at
            FROM admin_accounts
            WHERE id = CAST(:actor_id AS uuid) AND tenant_id = CAST(:tenant_id AS uuid)
            """,
            {"actor_id": aid, "tenant_id": tid},
        )
        if (
            admin_row is None
            or admin_row.get("disabled_at") is not None
            or not verify_password(str(admin_row["password_hash"]), password)
        ):
            raise AppError(401, "INVALID_CREDENTIALS", "Administrator password verification failed.")

        # Acquire tenant-scoped transaction advisory lock to prevent concurrent resets
        lock_key = _tenant_advisory_lock_key(tid)
        lock_row = await fetch_one(
            session,
            "SELECT pg_try_advisory_xact_lock(CAST(:lock_key AS bigint)) AS acquired",
            {"lock_key": lock_key},
        )
        if lock_row is not None and lock_row.get("acquired") is False:
            raise AppError(409, "RESET_IN_PROGRESS", "A telemetry reset is already in progress for this tenant.")

        now = utcnow()
        await execute(
            session,
            """
            INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at)
            VALUES (CAST(:tenant_id AS uuid), 1, 'ACTIVE', CAST(:now AS timestamptz))
            ON CONFLICT (tenant_id) DO NOTHING
            """,
            {"tenant_id": tid, "now": now},
        )

        gen_row = await fetch_one(
            session,
            """
            SELECT active_epoch, lifecycle_state
            FROM telemetry_generations
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            FOR UPDATE
            """,
            {"tenant_id": tid},
        )
        if gen_row and str(gen_row.get("lifecycle_state") or "").upper() == "RESETTING":
            raise AppError(409, "RESET_IN_PROGRESS", "A telemetry reset is already in progress for this tenant.")

        previous_epoch = max(1, int((gen_row or {}).get("active_epoch") or 1))
        new_epoch = previous_epoch + 1

        # R0 Preflight inventory before mutation
        preserved_before = await _collect_preserved_counts(session, tid)
        pg_before = await _collect_pg_cleared_counts(session, tid)
        op_subs_before, managed_subs_before = await _inspect_tdengine_subtables(session, tid, eff_td)
        manifest_hash = _compute_manifest_hash(tid, previous_epoch, preserved_before)

        operation_id = uuid4()
        trace_id = f"reset-{operation_id.hex[:12]}"
        stages_completed: list[str] = ["R0"]
        stage_details: dict[str, Any] = {
            "kind": OPERATION_KIND,
            "current_stage": STAGE_R1_QUIESCING,
            "stages_completed": list(stages_completed),
            "previous_epoch": previous_epoch,
            "new_epoch": new_epoch,
            "config_manifest_hash": manifest_hash,
            "R0": {
                "stage": STAGE_R0_PREFLIGHT,
                "at": iso_ms(now),
                "preserved_before": preserved_before,
                "pg_before": pg_before,
            },
        }

        # ------------------------------------------------------------------
        # R0 -> R1 (QUIESCING): Advance active_epoch, set RESETTING, notify
        # ------------------------------------------------------------------
        await execute(
            session,
            """
            INSERT INTO storage_operations (
                id, tenant_id, operation_type, target_type, target_id, actor_id,
                idempotency_key, status, requested_at, approved_at, started_at,
                step_state_json, trace_id
            ) VALUES (
                CAST(:id AS uuid), CAST(:tenant_id AS uuid), CAST(:op_type AS text), 'tenant', CAST(:tenant_id AS uuid),
                CAST(:actor_id AS uuid), CAST(:idemp_key AS text), 'RUNNING', CAST(:now AS timestamptz), CAST(:now AS timestamptz), CAST(:now AS timestamptz),
                CAST(:step_state AS jsonb), CAST(:trace_id AS text)
            )
            """,
            {
                "id": operation_id,
                "tenant_id": tid,
                "op_type": OPERATION_KIND,
                "actor_id": aid,
                "idemp_key": f"telemetry-reset-epoch-{new_epoch}-{operation_id.hex[:8]}",
                "now": now,
                "step_state": jsonb(stage_details),
                "trace_id": trace_id,
            },
        )

        await execute(
            session,
            """
            UPDATE telemetry_generations
            SET active_epoch = CAST(:new_epoch AS bigint),
                lifecycle_state = 'RESETTING',
                updated_at = CAST(:now AS timestamptz),
                updated_by = CAST(:actor_id AS uuid),
                reset_operation_id = CAST(:op_id AS uuid)
            WHERE tenant_id = CAST(:tenant_id AS uuid)
            """,
            {
                "new_epoch": new_epoch,
                "now": now,
                "actor_id": aid,
                "op_id": operation_id,
                "tenant_id": tid,
            },
        )

        fence_payload = jsonb(
            {
                "tenant_id": str(tid),
                "previous_epoch": previous_epoch,
                "active_epoch": new_epoch,
                "new_epoch": new_epoch,
                "lifecycle_state": "RESETTING",
                "operation_id": str(operation_id),
                "kind": OPERATION_KIND,
            }
        )
        await execute(
            session,
            "SELECT pg_notify('factorix_config_changed', CAST(:payload AS text))",
            {"payload": fence_payload},
        )
        await execute(
            session,
            "SELECT pg_notify('factorix_epoch_changed', CAST(:payload AS text))",
            {"payload": fence_payload},
        )

        stages_completed.append("R1")
        stage_details["stages_completed"] = list(stages_completed)
        stage_details["R1"] = {
            "stage": STAGE_R1_QUIESCING,
            "at": iso_ms(utcnow()),
            "previous_epoch": previous_epoch,
            "active_epoch": new_epoch,
            "lifecycle_state": "RESETTING",
        }

        try:
            # ------------------------------------------------------------------
            # R2 (PURGE_BROKER): Soft-purge RabbitMQ queues if reachable
            # ------------------------------------------------------------------
            stage_details["current_stage"] = STAGE_R2_PURGE_BROKER
            broker_res = await _purge_broker_softly(eff_broker)
            stages_completed.append("R2")
            stage_details["stages_completed"] = list(stages_completed)
            stage_details["R2"] = {
                "stage": STAGE_R2_PURGE_BROKER,
                "at": iso_ms(utcnow()),
                **broker_res,
            }

            # ------------------------------------------------------------------
            # R3 (CLEAR_TDENGINE): Drop all tenant subtables & re-ensure STables
            # ------------------------------------------------------------------
            stage_details["current_stage"] = STAGE_R3_CLEAR_TDENGINE
            dropped_op = 0
            dropped_managed = 0
            dropped_subtables: list[str] = []
            td_db = tenant_database_name(tid)

            if eff_td is not None:
                prefix = getattr(getattr(eff_td, "config", None), "db_prefix", "fx_t_") or "fx_t_"
                td_db = tenant_database_name(tid, prefix=prefix)
                validate_identifier(td_db, kind="database")
                try:
                    live_subs = await eff_td.list_subtables(td_db)
                except Exception as exc:  # noqa: BLE001
                    if _is_missing_td_error(exc):
                        live_subs = []
                    else:
                        raise AppError(
                            503,
                            "TDENGINE_UNAVAILABLE",
                            f"TDengine failed while enumerating subtables for reset: {exc}",
                            retryable=True,
                        ) from exc

                all_subs_to_drop: list[str] = []
                seen_subs: set[str] = set()
                for cand in [*live_subs, *op_subs_before, *managed_subs_before]:
                    c_name = str(cand).strip()
                    if c_name and c_name not in seen_subs:
                        seen_subs.add(c_name)
                        all_subs_to_drop.append(c_name)

                for sub in all_subs_to_drop:
                    validate_identifier(sub, kind="subtable")
                    fq = quote_fq_table(td_db, sub)
                    try:
                        await eff_td.execute_sql(f"DROP TABLE IF EXISTS {fq}")
                        dropped_subtables.append(sub)
                        if sub.startswith(("op_", "ms_")):
                            dropped_op += 1
                        else:
                            dropped_managed += 1
                    except Exception as exc:  # noqa: BLE001
                        if not _is_missing_td_error(exc):
                            raise AppError(
                                503,
                                "TDENGINE_RESET_FAILED",
                                f"Failed dropping TDengine subtable {fq}: {exc}",
                                retryable=True,
                            ) from exc

                try:
                    await eff_td.ensure_operational_schema(tid)
                except Exception as exc:  # noqa: BLE001
                    if not _is_missing_td_error(exc):
                        logger.warning("Re-ensuring operational schema after reset returned warning: %s", exc)

            stages_completed.append("R3")
            stage_details["stages_completed"] = list(stages_completed)
            stage_details["R3"] = {
                "stage": STAGE_R3_CLEAR_TDENGINE,
                "at": iso_ms(utcnow()),
                "database": td_db,
                "dropped_operational_subtables": dropped_op,
                "dropped_managed_subtables": dropped_managed,
                "dropped_subtables_total": len(dropped_subtables),
            }

            # ------------------------------------------------------------------
            # R4 (CLEAR_PG_RUNTIME_CACHES): Delete tenant telemetry rows ONLY
            # ------------------------------------------------------------------
            stage_details["current_stage"] = STAGE_R4_CLEAR_PG_RUNTIME_CACHES
            p = {"tenant_id": tid}
            del_observations = await execute_rowcount(
                session, "DELETE FROM observations WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_dedup = await execute_rowcount(
                session, "DELETE FROM ingest_dedup WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_latest = await execute_rowcount(
                session, "DELETE FROM latest_signal_state WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_quarantine = await execute_rowcount(
                session, "DELETE FROM observation_quarantine WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_snapshots = await execute_rowcount(
                session, "DELETE FROM model_snapshots WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_model_state = await execute_rowcount(
                session, "DELETE FROM model_state WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_commissioning = await execute_rowcount(
                session, "DELETE FROM commissioning_jobs WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            del_exports = await execute_rowcount(
                session, "DELETE FROM export_jobs WHERE tenant_id = CAST(:tenant_id AS uuid)", p
            )
            outbox_reset = await execute_rowcount(
                session,
                "UPDATE edge_nodes SET outbox_pending = 0 WHERE tenant_id = CAST(:tenant_id AS uuid) AND outbox_pending <> 0",
                p,
            )

            cleared_counts = {
                "observations": max(del_observations, pg_before["observations"]),
                "ingest_dedup": max(del_dedup, pg_before["ingest_dedup"]),
                "latest_signal_state": max(del_latest, pg_before["latest_signal_state"]),
                "observation_quarantine": max(del_quarantine, pg_before["observation_quarantine"]),
                "model_snapshots": max(del_snapshots, pg_before["model_snapshots"]),
                "model_state": max(del_model_state, pg_before["model_state"]),
                "commissioning_jobs": max(del_commissioning, pg_before["commissioning_jobs"]),
                "export_jobs": max(del_exports, pg_before["export_jobs"]),
                "edge_outbox_reset": outbox_reset,
                "tdengine_operational_subtables": max(dropped_op, len(op_subs_before)),
                "tdengine_managed_subtables": max(dropped_managed, len(managed_subs_before)),
                "tdengine_subtables_total": max(
                    len(dropped_subtables), len(op_subs_before) + len(managed_subs_before)
                ),
                "broker_messages_purged": int(broker_res.get("messages_purged") or 0),
            }

            stages_completed.append("R4")
            stage_details["stages_completed"] = list(stages_completed)
            stage_details["R4"] = {
                "stage": STAGE_R4_CLEAR_PG_RUNTIME_CACHES,
                "at": iso_ms(utcnow()),
                "cleared": cleared_counts,
            }

            # Verify protected control-plane entities were untouched
            preserved_after = await _collect_preserved_counts(session, tid)
            for key, before_val in preserved_before.items():
                after_val = preserved_after.get(key, 0)
                if after_val != before_val:
                    raise AppError(
                        500,
                        "PRESERVATION_INVARIANT_VIOLATED",
                        f"Protected configuration count for '{key}' changed during reset ({before_val} -> {after_val}).",
                    )

            # ------------------------------------------------------------------
            # R5 (RESUME & AUDIT): Mark ACTIVE, invalidate LiveState, audit
            # ------------------------------------------------------------------
            stage_details["current_stage"] = STAGE_R5_RESUME_AND_AUDIT
            completed_at = utcnow()

            await execute(
                session,
                """
                UPDATE telemetry_generations
                SET lifecycle_state = 'ACTIVE',
                    updated_at = CAST(:now AS timestamptz),
                    updated_by = CAST(:actor_id AS uuid)
                WHERE tenant_id = CAST(:tenant_id AS uuid)
                """,
                {"now": completed_at, "actor_id": aid, "tenant_id": tid},
            )

            if eff_live is not None:
                if hasattr(eff_live, "invalidate_epoch") and callable(eff_live.invalidate_epoch):
                    await eff_live.invalidate_epoch(tid, new_epoch)
                elif hasattr(eff_live, "invalidate_epoch_sync") and callable(eff_live.invalidate_epoch_sync):
                    eff_live.invalidate_epoch_sync(tid, new_epoch)

            resume_payload = jsonb(
                {
                    "tenant_id": str(tid),
                    "previous_epoch": previous_epoch,
                    "active_epoch": new_epoch,
                    "new_epoch": new_epoch,
                    "lifecycle_state": "ACTIVE",
                    "operation_id": str(operation_id),
                    "kind": OPERATION_KIND,
                }
            )
            await execute(
                session,
                "SELECT pg_notify('factorix_config_changed', CAST(:payload AS text))",
                {"payload": resume_payload},
            )
            await execute(
                session,
                "SELECT pg_notify('factorix_epoch_changed', CAST(:payload AS text))",
                {"payload": resume_payload},
            )

            stages_completed.append("R5")
            stage_details["stages_completed"] = list(stages_completed)
            stage_details["result_status"] = "SUCCEEDED"
            stage_details["R5"] = {
                "stage": STAGE_R5_RESUME_AND_AUDIT,
                "at": iso_ms(completed_at),
                "active_epoch": new_epoch,
                "lifecycle_state": "ACTIVE",
                "stay_authenticated": True,
            }

            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'COMPLETED',
                    completed_at = CAST(:completed_at AS timestamptz),
                    step_state_json = CAST(:step_state AS jsonb)
                WHERE id = CAST(:id AS uuid) AND tenant_id = CAST(:tenant_id AS uuid)
                """,
                {
                    "completed_at": completed_at,
                    "step_state": jsonb(stage_details),
                    "id": operation_id,
                    "tenant_id": tid,
                },
            )

            await audit(
                session,
                tenant_id=tid,
                event_type=AUDIT_ACTION,
                actor_id=aid,
                entity_type="telemetry_generation",
                entity_id=operation_id,
                before={"active_epoch": previous_epoch, "lifecycle_state": "ACTIVE"},
                after={
                    "action": AUDIT_ACTION,
                    "operation_id": str(operation_id),
                    "previous_epoch": previous_epoch,
                    "new_epoch": new_epoch,
                    "active_epoch": new_epoch,
                    "cleared": cleared_counts,
                    "preserved": preserved_after,
                    "config_manifest_hash": manifest_hash,
                    "stay_authenticated": True,
                },
                correlation_id=trace_id,
                severity="WARN",
            )

            queue_stream_event(
                session,
                "health",
                tid,
                {
                    "type": "telemetry_reset",
                    "tenant_id": str(tid),
                    "previous_epoch": previous_epoch,
                    "active_epoch": new_epoch,
                    "new_epoch": new_epoch,
                    "completed_at": iso_ms(completed_at),
                },
            )

            return {
                "status": "SUCCEEDED",
                "operation_id": str(operation_id),
                "tenant_id": str(tid),
                "actor_id": str(aid),
                "previous_epoch": previous_epoch,
                "active_epoch": new_epoch,
                "new_epoch": new_epoch,
                "lifecycle_state": "ACTIVE",
                "state_machine": list(STATE_MACHINE_ORDER),
                "stages_completed": list(stages_completed),
                "cleared": cleared_counts,
                "will_be_cleared": dict(cleared_counts),
                "preserved": preserved_after,
                "will_be_preserved": dict(preserved_after),
                "config_manifest_hash": manifest_hash,
                "stay_authenticated": True,
                "completed_at": iso_ms(completed_at),
            }

        except Exception as exc:
            fail_now = utcnow()
            err_code = exc.code if isinstance(exc, AppError) else "RESET_STAGE_FAILED"
            stage_details["result_status"] = "FAILED"
            stage_details["error"] = {"code": err_code, "message": str(exc), "at": iso_ms(fail_now)}
            try:
                await execute(
                    session,
                    """
                    UPDATE telemetry_generations
                    SET lifecycle_state = 'FAILED_FENCED',
                        updated_at = CAST(:now AS timestamptz)
                    WHERE tenant_id = CAST(:tenant_id AS uuid)
                    """,
                    {"now": fail_now, "tenant_id": tid},
                )
                await execute(
                    session,
                    """
                    UPDATE storage_operations
                    SET status = 'FAILED',
                        completed_at = CAST(:now AS timestamptz),
                        error_code = CAST(:err_code AS text),
                        error_message = CAST(:err_msg AS text),
                        step_state_json = CAST(:step_state AS jsonb)
                    WHERE id = CAST(:id AS uuid) AND tenant_id = CAST(:tenant_id AS uuid)
                    """,
                    {
                        "now": fail_now,
                        "err_code": err_code,
                        "err_msg": str(exc)[:500],
                        "step_state": jsonb(stage_details),
                        "id": operation_id,
                        "tenant_id": tid,
                    },
                )
            except Exception:  # noqa: BLE001
                logger.debug("Could not persist FAILED_FENCED state after reset exception", exc_info=True)
            raise


class TelemetryResetExecuteIn(BaseModel):
    confirm_phrase: str = Field(default="")
    password: str = Field(default="")


async def _default_db_session() -> Any:
    factory = session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


async def _default_admin_principal(
    request: Request,
    session: AsyncSession = Depends(_default_db_session),
) -> dict[str, Any]:
    row = await principal_from_token(session, request.cookies.get(SESSION_COOKIE))
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        assert_csrf(request.headers.get("x-csrf-token"), row["csrf_hash"])
    return row


def _resolve_td_client(request: Request) -> TDEngineClient | None:
    app = getattr(request, "app", None)
    state = getattr(app, "state", None)
    return getattr(state, "td_client", None)


def _resolve_broker_config() -> Any:
    try:
        from factorix.platform.broker import BrokerConfig

        cfg = get_settings()
        if getattr(cfg, "rabbitmq_url", ""):
            return BrokerConfig.from_settings(cfg)
    except Exception:  # noqa: BLE001
        return None
    return None


def build_router(
    admin_dep: Callable[..., Any] = _default_admin_principal,
    session_dep: Callable[..., Any] = _default_db_session,
) -> APIRouter:
    """Build FastAPI ``APIRouter`` for ``/api/v1/admin/telemetry-reset`` endpoints."""
    r = APIRouter(prefix="/api/v1/admin/telemetry-reset", tags=["telemetry-reset"])
    service = TelemetryResetService()

    @r.get("/preview")
    @r.post("/preview")
    async def preview_reset(
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        td_client = _resolve_td_client(request)
        return await service.preview(session, tenant_id, tdengine=td_client)

    @r.post("/execute")
    async def execute_reset(
        body: TelemetryResetExecuteIn,
        request: Request,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        actor_id = as_uuid(principal["admin_id"])
        td_client = _resolve_td_client(request)
        broker_cfg = getattr(getattr(request.app, "state", None), "broker", None) or _resolve_broker_config()
        live_prov = getattr(getattr(request.app, "state", None), "live_state_provider", None) or get_live_state_provider()
        return await service.execute(
            session,
            tenant_id,
            actor_id,
            confirm_phrase=body.confirm_phrase,
            password=body.password,
            tdengine=td_client,
            broker=broker_cfg,
            live_provider=live_prov,
        )

    @r.get("/status")
    async def reset_status(
        operation_id: str | None = None,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        op_uuid = parse_uuid(operation_id) if operation_id else None
        return await service.status(session, tenant_id, operation_id=op_uuid)

    @r.get("/{operation_id}")
    async def reset_status_by_id(
        operation_id: str,
        principal: dict[str, Any] = Depends(admin_dep),
        session: AsyncSession = Depends(session_dep),
    ) -> dict[str, Any]:
        tenant_id = as_uuid(principal["tenant_id"])
        return await service.status(session, tenant_id, operation_id=parse_uuid(operation_id))

    return r


router = build_router()
