"""Unified Source Discovery and Binding Validation Service.

Provides a unified discovery layer across:
1. Factory Hierarchy (resources -> signals & data model fields)
2. Data Collector (connections -> raw signals)
3. Data Models (output groups / models -> rule & computed fields)

Also validates source-to-column mappings, data type conversions, and
Row Assembly Policies (INDEPENDENT_EVENTS, LATEST_AS_OF_TRIGGER, TIME_BUCKET, EXACT_TIMESTAMP).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
from typing import Any, Literal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import fetch_all, fetch_one

logger = logging.getLogger(__name__)

# Supported Row Assembly Policies
ROW_ASSEMBLY_POLICIES = frozenset({
    "INDEPENDENT_EVENTS",
    "LATEST_AS_OF_TRIGGER",
    "TIME_BUCKET",
    "EXACT_TIMESTAMP",
})

# Type compatibility matrix: source_type -> set of compatible TDengine column types
TYPE_COMPATIBILITY_MAP: dict[str, set[str]] = {
    "float64": {"DOUBLE", "FLOAT", "INT", "BIGINT", "SMALLINT", "TINYINT", "VARCHAR", "NCHAR"},
    "int64": {"BIGINT", "INT", "SMALLINT", "TINYINT", "DOUBLE", "FLOAT", "VARCHAR", "NCHAR"},
    "bool": {"BOOL", "TINYINT", "INT", "VARCHAR", "NCHAR"},
    "string": {"VARCHAR", "NCHAR", "BINARY"},
    "enum": {"VARCHAR", "NCHAR", "BINARY", "INT", "TINYINT"},
    "json": {"JSON", "VARCHAR", "NCHAR", "VARBINARY"},
    "timestamp": {"TIMESTAMP", "BIGINT"},
}


@dataclass
class SourceReference:
    kind: Literal["signal", "model_field", "resource_context"]
    id: str
    name: str
    display_name: str
    data_type: str
    unit: str | None = None
    status: str = "ACTIVE"
    resource_id: str | None = None
    resource_name: str | None = None
    connection_id: str | None = None
    connection_name: str | None = None
    protocol: str | None = None
    model_id: str | None = None
    field_path: str | None = None
    expected_interval_ms: int | None = None


class StorageBindingService:
    """Discovers sources and validates bindings to physical TDengine columns."""

    async def list_sources(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        view: Literal["hierarchy", "collector", "models"] = "hierarchy",
        search: str | None = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Unified endpoint returning source items based on the requested perspective."""
        if view == "hierarchy":
            return await self._get_hierarchy_view(session, tenant_id, search, limit)
        elif view == "collector":
            return await self._get_collector_view(session, tenant_id, search, limit)
        elif view == "models":
            return await self._get_models_view(session, tenant_id, search, limit)
        else:
            return {"items": [], "total": 0, "view": view}

    # ------------------------------------------------------------------
    # Perspective 1: Factory Hierarchy
    # ------------------------------------------------------------------

    async def _get_hierarchy_view(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        search: str | None,
        limit: int,
    ) -> dict[str, Any]:
        """Resources organized in a tree or flat resource list with their signals/models."""
        res_rows = await fetch_all(
            session,
            """
            SELECT r.id, r.name, r.code, r.site_id, r.parent_id, r.status,
                   rt.key AS type_key
            FROM resources r
            JOIN resource_types rt ON rt.id = r.type_id
            WHERE r.tenant_id = :tenant_id
            ORDER BY r.name
            LIMIT 500
            """,
            {"tenant_id": tenant_id},
        )

        res_name_map = {str(r["id"]): str(r["name"]) for r in res_rows}

        sig_rows = await fetch_all(
            session,
            """
            SELECT s.id, s.resource_id, s.key, s.data_type, s.unit, s.status,
                   s.expected_interval_ms
            FROM signal_definitions s
            WHERE s.tenant_id = :tenant_id AND s.status = 'ACTIVE'
            ORDER BY s.key
            LIMIT 1000
            """,
            {"tenant_id": tenant_id},
        )

        flat_leaves: list[dict[str, Any]] = []
        sigs_by_resource: dict[str, list[dict[str, Any]]] = {}
        for s in sig_rows:
            rid = str(s["resource_id"]) if s.get("resource_id") else "unassigned"
            r_name = res_name_map.get(rid, "Unassigned")
            sig_id = str(s["id"])
            can_id = f"sig:{sig_id}"
            item = {
                "kind": "signal",
                "id": can_id,
                "canonical_id": can_id,
                "signal_id": sig_id,
                "tenant_id": str(tenant_id),
                "key": str(s["key"]),
                "name": str(s["key"]),
                "display_name": f"{r_name} / {s['key']}",
                "display_path": f"{r_name} / {s['key']}",
                "data_type": str(s["data_type"]),
                "unit": s.get("unit"),
                "status": str(s["status"]),
                "quality": "GOOD",
                "freshness": "FRESH",
                "resource_id": rid if rid != "unassigned" else None,
                "resource_name": r_name,
                "expected_interval_ms": s.get("expected_interval_ms"),
            }
            if not search or search.lower() in item["name"].lower() or search.lower() in r_name.lower():
                sigs_by_resource.setdefault(rid, []).append(item)
                flat_leaves.append(item)

        resources: list[dict[str, Any]] = []
        for r in res_rows:
            rid = str(r["id"])
            attached = sigs_by_resource.get(rid, [])
            if search and not attached and search.lower() not in str(r["name"]).lower():
                continue
            resources.append({
                "id": rid,
                "name": str(r["name"]),
                "code": str(r["code"]),
                "site_id": str(r["site_id"]) if r.get("site_id") else None,
                "parent_id": str(r["parent_id"]) if r.get("parent_id") else None,
                "type_key": str(r["type_key"]),
                "signals": attached,
                "signals_count": len(attached),
            })

        return {
            "view": "hierarchy",
            "items": resources[:limit],
            "groups": resources[:limit],
            "sources": flat_leaves[:limit * 10],
            "leaves": flat_leaves[:limit * 10],
            "total": len(resources),
        }

    # ------------------------------------------------------------------
    # Perspective 2: Data Collector (Connections -> Signals)
    # ------------------------------------------------------------------

    async def _get_collector_view(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        search: str | None,
        limit: int,
    ) -> dict[str, Any]:
        """Connections and raw active signals with protocol and adapter details."""
        conn_rows = await fetch_all(
            session,
            """
            SELECT id, name, protocol, status, connection_type
            FROM connections
            WHERE tenant_id = :tenant_id
            ORDER BY name
            """,
            {"tenant_id": tenant_id},
        )

        sig_rows = await fetch_all(
            session,
            """
            SELECT s.id, s.key, s.data_type, s.unit, s.status, s.expected_interval_ms,
                   b.connection_id, c.name AS connection_name, c.protocol
            FROM signal_definitions s
            JOIN signal_bindings b ON b.signal_id = s.id AND b.valid_to IS NULL
            JOIN connections c ON c.id = b.connection_id
            WHERE s.tenant_id = :tenant_id AND s.status = 'ACTIVE'
            ORDER BY s.key
            """,
            {"tenant_id": tenant_id},
        )

        flat_leaves: list[dict[str, Any]] = []
        signals_by_conn: dict[str, list[dict[str, Any]]] = {}
        for s in sig_rows:
            cid = str(s["connection_id"])
            c_name = str(s["connection_name"])
            sig_id = str(s["id"])
            can_id = f"sig:{sig_id}"
            item = {
                "kind": "signal",
                "id": can_id,
                "canonical_id": can_id,
                "signal_id": sig_id,
                "tenant_id": str(tenant_id),
                "key": str(s["key"]),
                "name": str(s["key"]),
                "display_name": f"{c_name} / {s['key']}",
                "display_path": f"Connections / {c_name} / {s['key']}",
                "data_type": str(s["data_type"]),
                "unit": s.get("unit"),
                "status": str(s["status"]),
                "quality": "GOOD",
                "freshness": "FRESH",
                "connection_id": cid,
                "connection_name": c_name,
                "protocol": str(s["protocol"]),
                "expected_interval_ms": s.get("expected_interval_ms"),
            }
            if not search or search.lower() in item["name"].lower() or search.lower() in str(s["protocol"]).lower():
                signals_by_conn.setdefault(cid, []).append(item)
                flat_leaves.append(item)

        connections: list[dict[str, Any]] = []
        for c in conn_rows:
            cid = str(c["id"])
            signals = signals_by_conn.get(cid, [])
            if search and not signals and search.lower() not in str(c["name"]).lower():
                continue
            connections.append({
                "id": cid,
                "name": str(c["name"]),
                "protocol": str(c["protocol"]),
                "status": str(c["status"]),
                "connection_type": str(c["connection_type"]),
                "signals": signals,
                "signals_count": len(signals),
            })

        return {
            "view": "collector",
            "items": connections[:limit],
            "groups": connections[:limit],
            "sources": flat_leaves[:limit * 10],
            "leaves": flat_leaves[:limit * 10],
            "total": len(connections),
        }

    # ------------------------------------------------------------------
    # Perspective 3: Data Models
    # ------------------------------------------------------------------

    async def _get_models_view(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        search: str | None,
        limit: int,
    ) -> dict[str, Any]:
        """Output groups (Data Models) and their rule / formula output fields."""
        rows = await fetch_all(
            session,
            """
            SELECT id, display_name, status, spec_json
            FROM output_groups
            WHERE tenant_id = :tenant_id AND status = 'ACTIVE'
            ORDER BY display_name
            """,
            {"tenant_id": tenant_id},
        )

        flat_leaves: list[dict[str, Any]] = []
        models: list[dict[str, Any]] = []
        for r in rows:
            mid = str(r["id"])
            dname = str(r["display_name"])
            spec = r["spec_json"]
            if isinstance(spec, str):
                try:
                    spec = json.loads(spec)
                except Exception:
                    spec = {}
            elif not isinstance(spec, dict):
                spec = {}

            fields = spec.get("fields", [])
            field_items = []
            for f in fields:
                f_path = f.get("path") or f.get("name") or "output"
                f_type = f.get("type", "float64")
                can_id = f"mod:{mid}:{f_path}"
                leaf_item = {
                    "kind": "model_field",
                    "id": can_id,
                    "canonical_id": can_id,
                    "model_id": mid,
                    "model_name": dname,
                    "model_revision": 1,
                    "field_path": f_path,
                    "key": f_path,
                    "name": f"{dname} -> {f_path}",
                    "display_name": f"{dname} -> {f_path}",
                    "display_path": f"Models / {dname} / {f_path}",
                    "data_type": f_type,
                    "unit": f.get("unit"),
                    "status": "ACTIVE",
                    "quality": "GOOD",
                    "freshness": "FRESH",
                    "calculation_cycle": spec.get("calculation_cycle_ms", 5000),
                }
                if not search or search.lower() in f_path.lower() or search.lower() in dname.lower():
                    field_items.append(leaf_item)
                    flat_leaves.append(leaf_item)

            if not search or field_items or search.lower() in dname.lower():
                models.append({
                    "id": mid,
                    "name": dname,
                    "display_name": dname,
                    "status": str(r["status"]),
                    "fields": field_items,
                    "fields_count": len(field_items),
                })

        return {
            "view": "models",
            "items": models[:limit],
            "groups": models[:limit],
            "sources": flat_leaves[:limit * 10],
            "leaves": flat_leaves[:limit * 10],
            "total": len(models),
        }

    # ------------------------------------------------------------------
    # Validation & Row Assembly
    # ------------------------------------------------------------------

    def validate_binding(
        self,
        source_kind: str,
        source_type: str,
        target_column_type: str,
    ) -> tuple[bool, str | None]:
        """Validate if a source data type can be cleanly written to target TDengine type."""
        s_norm = source_type.lower()
        t_norm = target_column_type.upper().split("(")[0].strip()

        compat_targets = TYPE_COMPATIBILITY_MAP.get(s_norm, {"VARCHAR", "NCHAR"})
        if t_norm not in compat_targets:
            return False, f"Source type '{source_type}' is incompatible with column type '{target_column_type}'"
        return True, None

    def validate_row_assembly(
        self,
        policy: str,
        policy_config: dict[str, Any] | None = None,
    ) -> tuple[bool, str | None]:
        """Validate a Row Assembly Policy for multi-source subtables."""
        pol = policy.upper()
        if pol not in ROW_ASSEMBLY_POLICIES:
            return False, f"Unknown policy '{policy}'. Must be one of: {sorted(ROW_ASSEMBLY_POLICIES)}"

        cfg = policy_config or {}
        if pol == "LATEST_AS_OF_TRIGGER":
            max_age = cfg.get("max_age_seconds") or cfg.get("max_age_ms")
            if not max_age or float(max_age) <= 0:
                return False, "LATEST_AS_OF_TRIGGER requires a positive max_age_seconds setting"
        elif pol == "TIME_BUCKET":
            bucket = cfg.get("time_bucket_seconds") or cfg.get("bucket_ms")
            if not bucket or float(bucket) <= 0:
                return False, "TIME_BUCKET requires a positive time_bucket_seconds setting (e.g. 1, 5, 10, 30, 60)"

        return True, None
