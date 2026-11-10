"""PostgreSQL <-> TDengine SchemaCompiler application & physical registry reconciliation (S05)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import fetch_all, fetch_one, jsonb, execute, utcnow
from factorix.modules.storage_dsl import (
    CatalogModel,
    CatalogResource,
    CatalogSignal,
    CompiledStoragePlan,
    StorageCatalogSnapshot,
)
from factorix.platform.tdengine import TDEngineClient, TDEngineError, op_stable_for_type, op_subtable_name, tenant_database_name


def _extract_model_field_paths(spec_json: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(spec_json, dict):
        return out

    def _walk(nodes: Sequence[Any], prefix: str) -> None:
        for node in nodes:
            if not isinstance(node, dict):
                continue
            key = str(node.get("key") or "")
            path = f"{prefix}.{key}" if prefix and key else (key or prefix)
            ntype = str(node.get("type") or "")
            if ntype in {"object", "array"}:
                _walk(list(node.get("children") or []), path)
            elif key:
                out[path] = str(node.get("value_type") or "auto")

    root = spec_json.get("root") or {}
    if isinstance(root, dict):
        _walk(list(root.get("children") or []), "")
    return out


async def load_catalog_snapshot(session: AsyncSession, tenant_id: UUID) -> StorageCatalogSnapshot:
    res_rows = await fetch_all(
        session,
        """
        SELECT r.id, r.name, r.code, r.site_id, r.status, t.key AS type_key
        FROM resources r
        JOIN resource_types t ON t.id = r.type_id
        WHERE r.tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    )
    sig_rows = await fetch_all(
        session,
        """
        SELECT DISTINCT ON (s.id)
               s.id, s.resource_id, s.key, s.data_type, s.unit, s.status, s.expected_interval_ms, s.version,
               r.name AS resource_name, rt.key AS type_key, COALESCE(b.enabled, FALSE) AS binding_enabled
        FROM signal_definitions s
        JOIN resources r ON r.id = s.resource_id
        JOIN resource_types rt ON rt.id = r.type_id
        LEFT JOIN signal_bindings b ON b.signal_id = s.id AND b.valid_to IS NULL
        WHERE s.tenant_id = :tenant_id
        ORDER BY s.id, b.enabled DESC NULLS LAST, b.revision DESC NULLS LAST
        """,
        {"tenant_id": tenant_id},
    )
    mod_rows = await fetch_all(
        session,
        "SELECT id, display_name, status, spec_json FROM output_groups WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    return StorageCatalogSnapshot(
        resources=[
            CatalogResource(
                id=str(r["id"]).lower(),
                type_key=str(r["type_key"]),
                name=str(r["name"]),
                code=str(r["code"]),
                site_id=str(r["site_id"]).lower() if r.get("site_id") else None,
                active=str(r["status"]).upper() == "ACTIVE",
            )
            for r in res_rows
        ],
        signals=[
            CatalogSignal(
                id=str(s["id"]).lower(),
                resource_id=str(s["resource_id"]).lower(),
                resource_name=str(s["resource_name"]),
                type_key=str(s["type_key"]),
                key=str(s["key"]),
                data_type=str(s["data_type"]),
                unit=s.get("unit"),
                active=str(s["status"]).upper() == "ACTIVE",
                binding_enabled=bool(s["binding_enabled"]),
                expected_interval_ms=s.get("expected_interval_ms"),
                revision=int(s.get("version") or 1),
            )
            for s in sig_rows
        ],
        models=[
            CatalogModel(
                id=str(m["id"]).lower(),
                display_name=str(m["display_name"]),
                field_paths=_extract_model_field_paths(m.get("spec_json")),
                active=str(m["status"]).upper() == "ACTIVE",
            )
            for m in mod_rows
        ],
    )


async def apply_compiled_plan(
    tdengine: TDEngineClient,
    session: AsyncSession,
    *,
    tenant_id: UUID,
    design_id: UUID,
    design_version_id: UUID,
    dataset_ids_by_key: dict[str, UUID],
    plan: CompiledStoragePlan,
    generation: int,
) -> dict[str, Any]:
    """Execute read-only-planned DDL in TDengine, verify existence, and update ``storage_physical_registry``."""
    applied_ddl: list[str] = []
    # Topological ordering: DB & STABLE DDL -> ALTER STABLE diffs -> Subtable creation
    stable_or_db = [s for s in plan.ddl_statements if not s.upper().startswith("CREATE TABLE ")]
    subtable_ddls = [s for s in plan.ddl_statements if s.upper().startswith("CREATE TABLE ")]
    for stmt in (*stable_or_db, *plan.diff.ddl_statements, *subtable_ddls):
        await tdengine.execute_sql(stmt)
        applied_ddl.append(stmt)

    # Verify subtables exist inside TDengine before registering PG ownership
    existing_tables = set(await tdengine.list_subtables(plan.td_database))
    missing = [s.td_subtable for s in plan.series if s.td_subtable not in existing_tables]
    if missing:
        raise TDEngineError(
            "PHYSICAL_VERIFICATION_FAILED",
            f"Compiled subtables missing after DDL execution: {', '.join(missing[:5])}",
        )

    now = utcnow()
    for s in plan.series:
        ds_uuid = dataset_ids_by_key.get(s.dataset_key)
        await execute(
            session,
            """
            INSERT INTO storage_physical_registry (
                id, tenant_id, tier, design_id, design_version_id, dataset_id, signal_id,
                series_key, value_type, td_database, td_stable, td_subtable,
                physical_schema_hash, generation, status, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, 'MANAGED', :design_id, :design_version_id, :dataset_id, :signal_id,
                :series_key, :value_type, :td_database, :td_stable, :td_subtable,
                :schema_hash, :generation, 'ACTIVE', :now, :now
            )
            ON CONFLICT (tenant_id, tier, series_key) DO UPDATE SET
                design_id = EXCLUDED.design_id,
                design_version_id = EXCLUDED.design_version_id,
                dataset_id = EXCLUDED.dataset_id,
                value_type = EXCLUDED.value_type,
                td_stable = EXCLUDED.td_stable,
                td_subtable = EXCLUDED.td_subtable,
                physical_schema_hash = EXCLUDED.physical_schema_hash,
                generation = EXCLUDED.generation,
                status = 'ACTIVE',
                updated_at = EXCLUDED.updated_at
            """,
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "design_id": design_id,
                "design_version_id": design_version_id,
                "dataset_id": ds_uuid,
                "signal_id": UUID(s.signal_id) if s.signal_id else None,
                "series_key": f"{design_id}:{s.series_key}",
                "value_type": s.value_type,
                "td_database": s.td_database,
                "td_stable": s.td_stable,
                "td_subtable": s.td_subtable,
                "schema_hash": s.physical_schema_hash,
                "generation": int(generation),
                "now": now,
            },
        )
    return {"applied_statements": len(applied_ddl), "verified_subtables": len(plan.series)}


async def reconcile_operational_registry(
    tdengine: TDEngineClient,
    session: AsyncSession,
    *,
    tenant_id: UUID,
    signal_id: UUID,
    value_type: str,
    generation: int,
) -> str:
    """Ensure Operational History subtable for ``signal_id`` is registered in ``storage_physical_registry``."""
    db = tenant_database_name(tenant_id, prefix=tdengine.config.db_prefix)
    stable = op_stable_for_type(value_type)
    subtable = op_subtable_name(signal_id, value_type)
    existing = await fetch_one(
        session,
        """
        SELECT td_subtable FROM storage_physical_registry
        WHERE tenant_id = :tenant_id AND tier = 'OPERATIONAL' AND series_key = :series_key
        """,
        {"tenant_id": tenant_id, "series_key": f"op:{signal_id}"},
    )
    if existing is None:
        now = utcnow()
        await execute(
            session,
            """
            INSERT INTO storage_physical_registry (
                id, tenant_id, tier, signal_id, series_key, value_type,
                td_database, td_stable, td_subtable, physical_schema_hash,
                generation, status, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, 'OPERATIONAL', :signal_id, :series_key, :value_type,
                :td_database, :td_stable, :td_subtable, 'op_v1',
                :generation, 'ACTIVE', :now, :now
            )
            ON CONFLICT (tenant_id, tier, series_key) DO NOTHING
            """,
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "signal_id": signal_id,
                "series_key": f"op:{signal_id}",
                "value_type": value_type,
                "td_database": db,
                "td_stable": stable,
                "td_subtable": subtable,
                "generation": int(generation),
                "now": now,
            },
        )
    return subtable
