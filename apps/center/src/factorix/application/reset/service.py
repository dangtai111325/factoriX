"""``TelemetryResetService``: preview (R0 read-only), status, and ``execute`` running the stages of
:mod:`.telemetry_reset` (R2-E B8; ``preview``/``status`` and the ``execute`` preamble moved verbatim from
``factorix.modules.telemetry_reset``)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
    as_uuid,
    fetch_one,
    iso_ms,
    utcnow,
)
from factorix.modules.live_state import get_live_state_provider
from factorix.platform.tdengine import (
    TDEngineClient,
    tenant_database_name,
)

from factorix.application.reset import telemetry_reset as stages
from factorix.application.reset.constants import CONFIRM_PHRASE, OPERATION_KIND, STAGE_R0_PREFLIGHT
from factorix.application.reset.inventory import (
    _collect_pg_cleared_counts,
    _collect_preserved_counts,
    _collect_storage_inventory,
    _collect_structural_fingerprint,
    _compute_manifest_hash,
    _inspect_tdengine_subtables,
    _storage_warnings,
)


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
        storage = await _collect_storage_inventory(session, tid, eff_td)

        cleared = {
            **pg_cleared,
            "tdengine_operational_subtables": len(op_subs),
            "tdengine_managed_subtables": len(managed_subs),
            "tdengine_subtables_total": len(op_subs) + len(managed_subs),
            # R2-08: rows of the user's own (Storage Management) supertables are deleted too.
            "tdengine_user_subtables": storage["user_subtables"],
            "tdengine_user_rows": storage["user_rows_total"],
        }
        fingerprint = await _collect_structural_fingerprint(session, tid)
        # The hash covers the preservation invariant only (same dict R0 of execute recomputes).
        manifest_hash = _compute_manifest_hash(tid, active_epoch, preserved, structural_fingerprint=fingerprint)
        prefix = getattr(getattr(eff_td, "config", None), "db_prefix", "fx_t_") or "fx_t_"
        shown_preserved = {
            **preserved,
            # structure kept by the reset (display only, not part of the invariant)
            "storage_user_databases": storage["user_databases"],
            "storage_user_stables": storage["user_stables"],
            "storage_user_subtables": storage["user_subtables"],
            "storage_recording_bindings": storage["recording_bindings"],
        }

        return {
            "tenant_id": str(tid),
            "mode": "CLEAR_TELEMETRY_ONLY",
            "stage": STAGE_R0_PREFLIGHT,
            "active_epoch": active_epoch,
            "next_epoch": active_epoch + 1,
            "lifecycle_state": lifecycle_state,
            "confirm_phrase_required": CONFIRM_PHRASE,
            "config_manifest_hash": manifest_hash,
            "structural_fingerprint": fingerprint,
            "cleared": cleared,
            "will_be_cleared": dict(cleared),
            "preserved": shown_preserved,
            "will_be_preserved": dict(shown_preserved),
            "storage": storage,
            "warnings": _storage_warnings(storage),
            "tdengine_subtables": {
                "database": tenant_database_name(tid, prefix=prefix),
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

        run = await stages.stage_r0_preflight(
            session, tid, aid, confirm_phrase=confirm_phrase, password=password, eff_td=eff_td
        )
        await stages.stage_r1_quiescing(session, run)

        try:
            await stages.stage_r2_purge_broker(run, eff_broker)
            await stages.stage_r3_clear_tdengine(session, run, eff_td)
            await stages.stage_r4_clear_pg_runtime_caches(session, run)
            await stages.verify_preservation(session, run)
            return await stages.stage_r5_resume_and_audit(session, run, eff_live)
        except Exception as exc:
            await stages.record_failed_fenced(session, run, exc)
            raise
