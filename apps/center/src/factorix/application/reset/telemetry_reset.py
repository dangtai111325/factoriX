"""Stage functions of the ``CLEAR_TELEMETRY_ONLY`` reset state machine ``R0 -> R1 -> R2 -> R3 -> R4 -> R5``
(R2-E B8; the body of ``TelemetryResetService.execute``, moved verbatim and cut at the stage comments).

The module keeps the stem ``telemetry_reset``: it emits ``factorix_config_changed`` / ``factorix_epoch_changed``
(R1 fence, R5 resume) and is listed under that name as a producer in ``contracts/notify.md``
(``tests/contracts/test_notify_payloads.py``). :mod:`.service` runs the stages; R2..R5 run inside the failure
fence (:func:`record_failed_fenced`), R0/R1 outside it, exactly as before."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import logging
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    queue_stream_event,
    utcnow,
)
from factorix.platform.errors import AppError
from factorix.platform.security import verify_password
from factorix.platform.tdengine import (
    TDEngineClient,
    quote_fq_table,
    quote_str,
    tenant_database_name,
    validate_identifier,
)

from factorix.application.reset.broker_purge import _purge_broker_softly
from factorix.application.reset.constants import (
    AUDIT_ACTION,
    CONFIRM_PHRASE,
    OPERATION_KIND,
    STAGE_R0_PREFLIGHT,
    STAGE_R1_QUIESCING,
    STAGE_R2_PURGE_BROKER,
    STAGE_R3_CLEAR_TDENGINE,
    STAGE_R4_CLEAR_PG_RUNTIME_CACHES,
    STAGE_R5_RESUME_AND_AUDIT,
    STATE_MACHINE_ORDER,
)
from factorix.application.reset.inventory import (
    _collect_pg_cleared_counts,
    _collect_preserved_counts,
    _collect_structural_fingerprint,
    _compute_manifest_hash,
    _inspect_tdengine_subtables,
    _is_missing_td_error,
    _tenant_advisory_lock_key,
)

logger = logging.getLogger("factorix.modules.telemetry_reset")


@dataclass(slots=True)
class ResetRun:
    """State of one ``execute`` call handed from stage to stage (the former locals of ``execute``)."""

    tid: UUID
    aid: UUID
    now: datetime
    previous_epoch: int
    new_epoch: int
    preserved_before: dict[str, int]
    pg_before: dict[str, int]
    op_subs_before: list[str]
    managed_subs_before: list[str]
    fingerprint_before: str
    manifest_hash: str
    operation_id: UUID
    trace_id: str
    stages_completed: list[str]
    stage_details: dict[str, Any]
    broker_res: dict[str, Any] = field(default_factory=dict)
    dropped_op: int = 0
    dropped_managed: int = 0
    dropped_subtables: list[str] = field(default_factory=list)
    cleared_stables: list[str] = field(default_factory=list)
    td_db: str = ""
    cleared_counts: dict[str, Any] = field(default_factory=dict)
    preserved_after: dict[str, int] = field(default_factory=dict)


async def stage_r0_preflight(
    session: AsyncSession,
    tid: UUID,
    aid: UUID,
    *,
    confirm_phrase: str,
    password: str,
    eff_td: TDEngineClient | None,
) -> ResetRun:
    """R0: confirmation phrase + administrator password, tenant advisory lock, generation row ``FOR UPDATE``, and the
    inventory taken before any mutation (preserved/cleared counts, TDengine subtables, fingerprint, manifest hash)."""
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
    fingerprint_before = await _collect_structural_fingerprint(session, tid)
    manifest_hash = _compute_manifest_hash(tid, previous_epoch, preserved_before, structural_fingerprint=fingerprint_before)

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
    return ResetRun(
        tid=tid, aid=aid, now=now, previous_epoch=previous_epoch, new_epoch=new_epoch,
        preserved_before=preserved_before, pg_before=pg_before, op_subs_before=op_subs_before,
        managed_subs_before=managed_subs_before, fingerprint_before=fingerprint_before, manifest_hash=manifest_hash,
        operation_id=operation_id, trace_id=trace_id, stages_completed=stages_completed, stage_details=stage_details,
    )


async def stage_r1_quiescing(session: AsyncSession, run: ResetRun) -> None:
    """R1 (QUIESCING): RUNNING saga row, ``active_epoch`` advanced + ``RESETTING``, epoch fence NOTIFY (outside the
    failure fence of R2..R5, as before the split)."""
    tid, aid, now = run.tid, run.aid, run.now
    previous_epoch, new_epoch = run.previous_epoch, run.new_epoch
    operation_id, trace_id = run.operation_id, run.trace_id
    stages_completed, stage_details = run.stages_completed, run.stage_details

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


async def stage_r2_purge_broker(run: ResetRun, eff_broker: Any) -> None:
    """R2 (PURGE_BROKER)."""
    stages_completed, stage_details = run.stages_completed, run.stage_details

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
    run.broker_res = broker_res


async def stage_r3_clear_tdengine(session: AsyncSession, run: ResetRun, eff_td: TDEngineClient | None) -> None:
    """R3 (CLEAR_TDENGINE)."""
    tid = run.tid
    managed_subs_before = run.managed_subs_before
    stages_completed, stage_details = run.stages_completed, run.stage_details

    # ------------------------------------------------------------------
    # R3 (CLEAR_TDENGINE): delete telemetry ROWS only (plan §10: "delete rows, not schema").
    # Every STABLE of every tenant-owned database is emptied with ``DELETE FROM db.stable``;
    # databases, STABLEs, subtables, their TAG values and the storage registry are preserved,
    # so user-created (UI) subtables survive a reset with their tags and bindings intact.
    # Any TDengine failure aborts the reset (FAILED_FENCED) instead of being logged and ignored.
    # ------------------------------------------------------------------
    stage_details["current_stage"] = STAGE_R3_CLEAR_TDENGINE
    dropped_op = 0
    dropped_managed = 0
    dropped_subtables: list[str] = []  # historical name: subtables whose ROWS were cleared (tables kept)
    cleared_stables: list[str] = []
    preserved_subtables = 0
    preserved_managed = 0
    missing_subtables: list[str] = []
    unverified_dbs: list[str] = []
    td_db = tenant_database_name(tid)

    if eff_td is not None:
        prefix = getattr(getattr(eff_td, "config", None), "db_prefix", "fx_t_") or "fx_t_"
        td_db = tenant_database_name(tid, prefix=prefix)
        validate_identifier(td_db, kind="database")
        tenant_dbs: list[str] = [td_db]
        try:
            db_rows = await fetch_all(
                session,
                """
                SELECT physical_name FROM storage_objects
                WHERE tenant_id = CAST(:tenant_id AS uuid) AND object_type = 'database'
                  AND status <> 'PURGED'
                """,
                {"tenant_id": tid},
            )
        except SQLAlchemyError:
            db_rows = []
        for row in db_rows:
            name = str(row.get("physical_name") or "").strip()
            if name and name not in tenant_dbs:
                validate_identifier(name, kind="database")
                tenant_dbs.append(name)

        for db_name in tenant_dbs:
            try:
                live_subs = await eff_td.list_subtables(db_name)
                st_rows = await eff_td.query_rows(
                    "SELECT stable_name FROM information_schema.ins_stables "
                    f"WHERE db_name = {quote_str(db_name)}"
                )
            except Exception as exc:  # noqa: BLE001
                if _is_missing_td_error(exc):
                    continue
                raise AppError(
                    503,
                    "TDENGINE_UNAVAILABLE",
                    f"TDengine failed while enumerating {db_name} for reset: {exc}",
                    retryable=True,
                ) from exc
            for sub in live_subs or []:
                name = str(sub).strip()
                if not name:
                    continue
                dropped_subtables.append(name)  # rows cleared (table kept)
                if name.startswith(("op_", "ms_")):
                    dropped_op += 1
                else:
                    dropped_managed += 1
            for st_row in st_rows or []:
                st_name = str(
                    (st_row.get("stable_name") if isinstance(st_row, dict) else None) or ""
                ).strip()
                if not st_name:
                    continue
                validate_identifier(st_name, kind="stable")
                fq = quote_fq_table(db_name, st_name)
                try:
                    await eff_td.execute_sql(f"DELETE FROM {fq}")
                except Exception as exc:  # noqa: BLE001
                    if _is_missing_td_error(exc):
                        continue
                    raise AppError(
                        503,
                        "TDENGINE_RESET_FAILED",
                        f"Failed clearing TDengine rows of {fq}: {exc}",
                        retryable=True,
                    ) from exc
                cleared_stables.append(f"{db_name}.{st_name}")
            # B-17: rows-only reset -> verify every subtable still exists (do not assume it).
            before = {str(s).strip() for s in live_subs or [] if str(s).strip()}
            try:
                after = {str(s).strip() for s in (await eff_td.list_subtables(db_name)) or [] if str(s).strip()}
            except Exception as exc:  # noqa: BLE001 - reported, the rows are already gone
                logger.warning("Could not re-list subtables of %s after reset: %s", db_name, exc)
                after = None
            if after is None:
                unverified_dbs.append(db_name)
            else:
                preserved_subtables += len(before & after)
                preserved_managed += sum(1 for n in before & after if not n.startswith(("op_", "ms_")))
                missing_subtables.extend(f"{db_name}.{n}" for n in sorted(before - after))

        if missing_subtables:
            logger.error("Reset R3: %d subtables disappeared during a rows-only reset: %s",
                         len(missing_subtables), missing_subtables[:20])

        try:
            await eff_td.ensure_operational_schema(tid)
        except Exception as exc:  # noqa: BLE001
            if not _is_missing_td_error(exc):
                raise AppError(
                    503,
                    "TDENGINE_RESET_FAILED",
                    f"Operational schema could not be verified after reset: {exc}",
                    retryable=True,
                ) from exc

    stages_completed.append("R3")
    stage_details["stages_completed"] = list(stages_completed)
    stage_details["R3"] = {
        "stage": STAGE_R3_CLEAR_TDENGINE,
        "at": iso_ms(utcnow()),
        "database": td_db,
        "cleared_stables": cleared_stables,
        "cleared_operational_subtables": dropped_op,
        "cleared_managed_subtables": dropped_managed,
        "cleared_subtables_total": len(dropped_subtables),
        # B-17: measured, not assumed — subtables that no longer exist after the rows-only delete
        # (expected 0) and subtables re-listed afterwards (a DB that could not be re-listed is named).
        "dropped_subtables_total": len(missing_subtables),
        "missing_subtables": missing_subtables[:200],
        "preserved_subtables_total": preserved_subtables,
        "preserved_managed_subtables": preserved_managed,
        "unverified_databases": unverified_dbs,
        "managed_subtables_at_preflight": len(managed_subs_before),
    }
    run.dropped_op, run.dropped_managed = dropped_op, dropped_managed
    run.dropped_subtables, run.cleared_stables, run.td_db = dropped_subtables, cleared_stables, td_db


async def stage_r4_clear_pg_runtime_caches(session: AsyncSession, run: ResetRun) -> None:
    """R4 (CLEAR_PG_RUNTIME_CACHES)."""
    tid = run.tid
    pg_before, op_subs_before, managed_subs_before = run.pg_before, run.op_subs_before, run.managed_subs_before
    dropped_op, dropped_managed, dropped_subtables = run.dropped_op, run.dropped_managed, run.dropped_subtables
    broker_res = run.broker_res
    stages_completed, stage_details = run.stages_completed, run.stage_details

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
    # Managed model-field recording state (WS-H, migration 0010) is telemetry-derived:
    # the durable "last committed value" and undelivered outbox rows of the old epoch go.
    del_field_state = 0
    del_record_outbox = 0
    reg = await fetch_one(
        session,
        "SELECT to_regclass('public.storage_field_state') IS NOT NULL AS has_state, "
        "to_regclass('public.storage_record_outbox') IS NOT NULL AS has_outbox",
        {},
    )
    if reg and reg.get("has_state"):
        del_field_state = await execute_rowcount(
            session, "DELETE FROM storage_field_state WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        )
    if reg and reg.get("has_outbox"):
        del_record_outbox = await execute_rowcount(
            session, "DELETE FROM storage_record_outbox WHERE tenant_id = CAST(:tenant_id AS uuid)", p
        )
    outbox_reset = await execute_rowcount(
        session,
        "UPDATE edge_nodes SET outbox_pending = 0 WHERE tenant_id = CAST(:tenant_id AS uuid) AND outbox_pending <> 0",
        p,
    )

    # B-17: report what was really deleted (DELETE rowcount / subtables enumerated in R3), not
    # max(deleted, preflight count) which hid a short delete. The preflight counts are reported next
    # to them and every difference is listed in ``count_differences`` (more rows than at preflight is
    # normal for in-flight telemetry; fewer means rows went elsewhere and is worth a look).
    cleared_counts = {
        "observations": del_observations,
        "ingest_dedup": del_dedup,
        "latest_signal_state": del_latest,
        "observation_quarantine": del_quarantine,
        "model_snapshots": del_snapshots,
        "model_state": del_model_state,
        "commissioning_jobs": del_commissioning,
        "export_jobs": del_exports,
        "edge_outbox_reset": outbox_reset,
        "storage_field_state": del_field_state,
        "storage_record_outbox": del_record_outbox,
        "tdengine_operational_subtables": dropped_op,
        "tdengine_managed_subtables": dropped_managed,
        "tdengine_subtables_total": len(dropped_subtables),
        "broker_messages_purged": int(broker_res.get("messages_purged") or 0),
    }
    counts_before = {
        **{k: int(pg_before.get(k) or 0) for k in (
            "observations", "ingest_dedup", "latest_signal_state", "observation_quarantine",
            "model_snapshots", "model_state", "commissioning_jobs", "export_jobs",
        )},
        "tdengine_operational_subtables": len(op_subs_before),
        "tdengine_managed_subtables": len(managed_subs_before),
        "tdengine_subtables_total": len(op_subs_before) + len(managed_subs_before),
    }
    count_differences = {
        k: {"preflight": v, "cleared": cleared_counts[k]}
        for k, v in counts_before.items()
        if cleared_counts.get(k) != v
    }

    stages_completed.append("R4")
    stage_details["stages_completed"] = list(stages_completed)
    stage_details["R4"] = {
        "stage": STAGE_R4_CLEAR_PG_RUNTIME_CACHES,
        "at": iso_ms(utcnow()),
        "cleared": cleared_counts,
        "counts_at_preflight": counts_before,
        "count_differences": count_differences,
    }
    run.cleared_counts = cleared_counts


async def verify_preservation(session: AsyncSession, run: ResetRun) -> None:
    """After R4: protected counts and the configuration fingerprint must be unchanged (else the reset fails fenced)."""
    tid = run.tid
    preserved_before, fingerprint_before = run.preserved_before, run.fingerprint_before

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

    fingerprint_after = await _collect_structural_fingerprint(session, tid)
    if fingerprint_after != fingerprint_before:
        raise AppError(
            500,
            "PRESERVATION_INVARIANT_VIOLATED",
            "Protected configuration structural fingerprint changed during reset.",
        )
    run.preserved_after = preserved_after


async def stage_r5_resume_and_audit(session: AsyncSession, run: ResetRun, eff_live: Any) -> dict[str, Any]:
    """R5 (RESUME & AUDIT); returns the ``execute`` response."""
    tid, aid = run.tid, run.aid
    previous_epoch, new_epoch = run.previous_epoch, run.new_epoch
    operation_id, trace_id, manifest_hash = run.operation_id, run.trace_id, run.manifest_hash
    cleared_counts, preserved_after = run.cleared_counts, run.preserved_after
    stages_completed, stage_details = run.stages_completed, run.stage_details

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


async def record_failed_fenced(session: AsyncSession, run: ResetRun, exc: Exception) -> None:
    """A stage of R2..R5 raised: tenant ``FAILED_FENCED`` + saga row ``FAILED`` (best effort); the caller re-raises."""
    tid, operation_id, stage_details = run.tid, run.operation_id, run.stage_details

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
