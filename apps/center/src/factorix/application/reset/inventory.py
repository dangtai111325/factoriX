"""R0 read-only inventory of a telemetry reset: advisory-lock key, configuration fingerprint and manifest hash,
cleared/preserved PostgreSQL counts, TDengine subtables (R2-E B8, moved verbatim from
``factorix.modules.telemetry_reset``)."""

from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import logging
from typing import Any
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
    fetch_all,
    fetch_one,
)
from factorix.platform.tdengine import (
    TDEngineClient,
    is_missing_object_error,
    quote_fq_table,
    tenant_database_name,
    validate_identifier,
)

logger = logging.getLogger("factorix.modules.telemetry_reset")


def _tenant_advisory_lock_key(tenant_id: UUID) -> int:
    """Derive a deterministic signed 64-bit advisory lock key scoped to ``tenant_id``."""
    digest = hashlib.sha256(f"factorix:telemetry_reset:{tenant_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


async def _collect_structural_fingerprint(session: AsyncSession, tenant_id: UUID) -> str:
    """Deterministic fingerprint of the protected configuration (connections, signals, models,
    storage objects, resources, formulas). Any query error propagates: a fingerprint that silently
    skips a part would let a preview hash match a changed configuration."""
    p = {"tenant_id": tenant_id}
    parts: list[str] = []
    for sql, fmt in (
        ("SELECT id, name, protocol FROM connections WHERE tenant_id = CAST(:tenant_id AS uuid) ORDER BY id",
         lambda r: f"{r['id']}:{r['name']}:{r['protocol']}"),
        ("SELECT id, key, data_type FROM signal_definitions WHERE tenant_id = CAST(:tenant_id AS uuid) ORDER BY id",
         lambda r: f"{r['id']}:{r['key']}:{r['data_type']}"),
        ("SELECT id, display_name, version FROM output_groups WHERE tenant_id = CAST(:tenant_id AS uuid) ORDER BY id",
         lambda r: f"{r['id']}:{r['display_name']}:{r['version']}"),
        ("SELECT id, physical_name, object_type FROM storage_objects "
         "WHERE tenant_id = CAST(:tenant_id AS uuid) AND status != 'PURGED' ORDER BY id",
         lambda r: f"{r['id']}:{r['physical_name']}:{r['object_type']}"),
        ("SELECT id, code FROM resources WHERE tenant_id = CAST(:tenant_id AS uuid) ORDER BY id",
         lambda r: f"{r['id']}:{r['code']}"),
        ("SELECT f.id, f.expression_source, f.revision FROM formula_definitions f "
         "JOIN signal_definitions s ON s.id = f.signal_id WHERE s.tenant_id = CAST(:tenant_id AS uuid) ORDER BY f.id",
         lambda r: f"{r['id']}:{r['revision']}:{r['expression_source']}"),
    ):
        rows = await fetch_all(session, sql, p)
        parts.append(",".join(fmt(r) for r in rows))
    raw_payload = "|".join(parts)
    return hashlib.sha256(raw_payload.encode("utf-8")).hexdigest()


def _compute_manifest_hash(
    tenant_id: UUID,
    active_epoch: int,
    preserved: Mapping[str, int],
    structural_fingerprint: str = "",
) -> str:
    canonical = json.dumps(
        {
            "tenant_id": str(tenant_id),
            "active_epoch": int(active_epoch),
            "preserved": {k: int(preserved[k]) for k in sorted(preserved)},
            "structural_fingerprint": structural_fingerprint,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_is_missing_td_error = is_missing_object_error  # B-14: one shared list (platform.tdengine)


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
    # R2-08: the UI shows these as "N preserved"; archived models/resources are preserved too but are
    # reported separately (36 active + 2 archived, not "38"), like signals_active / signals_archived.
    data_models = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM output_groups WHERE tenant_id = CAST(:tenant_id AS uuid) AND status <> 'ARCHIVED'",
        p,
    )
    data_models_archived = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM output_groups WHERE tenant_id = CAST(:tenant_id AS uuid) AND status = 'ARCHIVED'",
        p,
    )
    storage_designs = await _safe_count(
        session, "SELECT COUNT(*) AS cnt FROM storage_designs WHERE tenant_id = CAST(:tenant_id AS uuid)", p
    )
    resources_cnt = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM resources WHERE tenant_id = CAST(:tenant_id AS uuid) AND status <> 'ARCHIVED'",
        p,
    )
    resources_archived = await _safe_count(
        session,
        "SELECT COUNT(*) AS cnt FROM resources WHERE tenant_id = CAST(:tenant_id AS uuid) AND status = 'ARCHIVED'",
        p,
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
        "data_models_archived": data_models_archived,
        "storage_designs": storage_designs,
        "resources": resources_cnt,
        "resources_archived": resources_archived,
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
    td_listed = False  # R2-08: when TDengine answered, it is the truth; the registry is only a fallback

    if tdengine is not None:
        prefix = getattr(getattr(tdengine, "config", None), "db_prefix", "fx_t_") or "fx_t_"
        db = tenant_database_name(tenant_id, prefix=prefix)
        try:
            subtables = await tdengine.list_subtables(db)
            td_listed = True
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

    stale = 0
    for row in reg_rows:
        sub = str(row.get("td_subtable") or "").strip()
        if not sub or sub in seen:
            continue
        if td_listed:
            # Registry row without a physical table (e.g. a purged subtable whose registry row was
            # left behind): nothing to clear -> not counted (it inflated "will be cleared": 351 vs 324).
            stale += 1
            continue
        seen.add(sub)
        tier = str(row.get("tier") or "MANAGED").upper()
        if tier in {"OPERATIONAL", "MODEL_SNAPSHOT"} or sub.startswith(("op_", "ms_")):
            op_subs.append(sub)
        else:
            managed_subs.append(sub)

    if stale:
        logger.info("Reset inventory: %d storage_physical_registry rows of tenant %s have no physical subtable",
                    stale, tenant_id)
    return op_subs, managed_subs


USER_HISTORY_WARNING_CODE = "USER_RECORDED_HISTORY_CLEARED"


async def _collect_storage_inventory(
    session: AsyncSession,
    tenant_id: UUID,
    tdengine: TDEngineClient | None,
) -> dict[str, Any]:
    """R0 read-only, preview only (R2-08): the user-created TDengine objects (Storage Management) and
    their bindings, which a reset PRESERVES as structure, and the rows of their STABLEs, which R3
    DELETES (``DELETE FROM db.stable`` for every STABLE of every tenant database). Not part of the
    preservation invariant / manifest hash (a UI user may still create objects while the dialog is
    open); counts that cannot be read are ``None``, never a guessed 0."""
    out: dict[str, Any] = {
        "user_databases": 0,
        "user_stables": 0,
        "user_subtables": 0,
        "user_subtables_recording": 0,
        "recording_bindings": 0,
        "user_stable_rows": [],
        "user_rows_total": 0,
    }
    p = {"tenant_id": tenant_id}
    try:
        rows = await fetch_all(
            session,
            """
            SELECT object_type, status, COUNT(*) AS n
            FROM storage_objects
            WHERE tenant_id = CAST(:tenant_id AS uuid) AND status <> 'PURGED'
            GROUP BY object_type, status
            """,
            p,
        )
        stables = await fetch_all(
            session,
            """
            SELECT physical_db, physical_name
            FROM storage_objects
            WHERE tenant_id = CAST(:tenant_id AS uuid) AND object_type = 'stable' AND status <> 'PURGED'
            ORDER BY physical_db, physical_name
            """,
            p,
        )
        bindings = await fetch_one(
            session,
            "SELECT COUNT(*) AS n FROM storage_bindings WHERE tenant_id = CAST(:tenant_id AS uuid) AND status = 'ACTIVE'",
            p,
        )
    except SQLAlchemyError as exc:
        logger.warning("Reset preview could not read the storage registry for %s: %s", tenant_id, exc)
        return {k: None for k in out}
    for row in rows:
        kind, status, n = str(row.get("object_type") or ""), str(row.get("status") or ""), int(row.get("n") or 0)
        if kind == "database":
            out["user_databases"] += n
        elif kind == "stable":
            out["user_stables"] += n
        elif kind == "subtable":
            out["user_subtables"] += n
            if status == "ACTIVE":
                out["user_subtables_recording"] += n
    out["recording_bindings"] = int((bindings or {}).get("n") or 0)

    total: int | None = 0
    for st in stables:
        db, name = str(st.get("physical_db") or ""), str(st.get("physical_name") or "")
        n_rows: int | None = None
        if tdengine is not None and db and name:
            try:
                validate_identifier(db, kind="database")
                validate_identifier(name, kind="stable")
                res = await tdengine.query_rows(f"SELECT COUNT(*) AS n FROM {quote_fq_table(db, name)}")
                first = (res or [{}])[0]
                n_rows = int((first.get("n") if isinstance(first, dict) else None) or 0)
            except Exception as exc:  # noqa: BLE001 - preview stays available; unknown is reported as None
                if _is_missing_td_error(exc):
                    n_rows = 0
                else:
                    logger.warning("Reset preview could not count rows of %s.%s: %s", db, name, exc)
        out["user_stable_rows"].append({"database": db, "stable": name, "rows": n_rows})
        total = None if total is None or n_rows is None else total + n_rows
    out["user_rows_total"] = total
    return out


def _storage_warnings(storage: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Explicit warning for the preview: the reset empties the user's recorded (MES) history too."""
    stables = storage.get("user_stables")
    if not stables:
        return []
    rows = storage.get("user_rows_total")
    subs = storage.get("user_subtables")
    rows_txt = f"{rows:,}" if isinstance(rows, int) else "an unknown number of"
    return [
        {
            "code": USER_HISTORY_WARNING_CODE,
            "severity": "HIGH",
            "message": (
                f"The recorded history in {stables} user-created supertable(s) / {subs} subtable(s) "
                f"({rows_txt} rows) will be DELETED. The supertables, subtables, tags and recording "
                "bindings are kept; recording restarts with a new baseline in the next epoch."
            ),
            "stables": list(storage.get("user_stable_rows") or []),
            "rows_total": rows,
        }
    ]
