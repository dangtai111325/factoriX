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

from factorix.modules.common import fetch_all, fetch_one, utcnow

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
                   s.expected_interval_ms, l.quality, l.last_acquired_at
            FROM signal_definitions s
            LEFT JOIN latest_signal_state l ON l.tenant_id = s.tenant_id AND l.signal_id = s.id
            WHERE s.tenant_id = :tenant_id AND s.status = 'ACTIVE'
            ORDER BY s.key
            LIMIT 1000
            """,
            {"tenant_id": tenant_id},
        )

        now = utcnow()
        flat_leaves: list[dict[str, Any]] = []
        sigs_by_resource: dict[str, list[dict[str, Any]]] = {}
        for s in sig_rows:
            rid = str(s["resource_id"]) if s.get("resource_id") else "unassigned"
            r_name = res_name_map.get(rid, "Unassigned")
            sig_id = str(s["id"])
            can_id = f"sig:{sig_id}"
            raw_qual = str(s.get("quality") or "UNKNOWN").upper()
            last_acq = s.get("last_acquired_at")
            exp_intv_ms = int(s.get("expected_interval_ms") or 1000)
            if last_acq is not None:
                diff_s = (now - last_acq).total_seconds()
                fresh = "FRESH" if diff_s <= max(exp_intv_ms * 3 / 1000.0, 15.0) else "STALE"
            else:
                fresh = "UNKNOWN"
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
                "path": f"{r_name} / {s['key']}",
                "data_type": str(s["data_type"]),
                "unit": s.get("unit"),
                "status": str(s["status"]),
                "quality": raw_qual,
                "freshness": fresh,
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
            SELECT id, name, protocol, status
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
                   j.connection_id, c.name AS connection_name, c.protocol,
                   l.quality, l.last_acquired_at
            FROM signal_definitions s
            LEFT JOIN signal_bindings b ON b.signal_id = s.id AND b.valid_to IS NULL
            LEFT JOIN source_fields sf ON sf.id = b.source_field_id
            LEFT JOIN acquisition_jobs j ON j.id = sf.acquisition_job_id
            LEFT JOIN connections c ON c.id = j.connection_id
            LEFT JOIN latest_signal_state l ON l.tenant_id = s.tenant_id AND l.signal_id = s.id
            WHERE s.tenant_id = :tenant_id AND s.status = 'ACTIVE'
            ORDER BY s.key
            """,
            {"tenant_id": tenant_id},
        )

        now = utcnow()
        flat_leaves: list[dict[str, Any]] = []
        signals_by_conn: dict[str, list[dict[str, Any]]] = {}
        for s in sig_rows:
            cid = str(s["connection_id"]) if s.get("connection_id") else "unassigned"
            c_name = str(s.get("connection_name") or "Unassigned Connections")
            sig_id = str(s["id"])
            can_id = f"sig:{sig_id}"
            raw_qual = str(s.get("quality") or "UNKNOWN").upper()
            last_acq = s.get("last_acquired_at")
            exp_intv_ms = int(s.get("expected_interval_ms") or 1000)
            if last_acq is not None:
                diff_s = (now - last_acq).total_seconds()
                fresh = "FRESH" if diff_s <= max(exp_intv_ms * 3 / 1000.0, 15.0) else "STALE"
            else:
                fresh = "UNKNOWN"
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
                "path": f"Connections / {c_name} / {s['key']}",
                "data_type": str(s["data_type"]),
                "unit": s.get("unit"),
                "status": str(s["status"]),
                "quality": raw_qual,
                "freshness": fresh,
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
                "connection_type": str(c.get("protocol") or "connection"),
                "signals": signals,
                "signals_count": len(signals),
            })

        if "unassigned" in signals_by_conn and signals_by_conn["unassigned"]:
            unassigned_signals = signals_by_conn["unassigned"]
            if not search or any(search.lower() in s["name"].lower() for s in unassigned_signals):
                connections.append({
                    "id": "unassigned",
                    "name": "Unassigned Signals",
                    "protocol": "other",
                    "status": "ACTIVE",
                    "connection_type": "other",
                    "signals": unassigned_signals,
                    "signals_count": len(unassigned_signals),
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
        """Data Models (groups) with their bindable **field leaves** and Factory Model context.

        Every leaf carries ``kind='model_field'``, ``model_id`` and ``field_path`` (JSON-pointer path
        without the leading ``/``), the declared value type and the last value of the latest body,
        so the subtable wizard binds a field, never a whole model (P0-1 / G-02 / G-04). Each group
        carries the machine it belongs to and that machine's ancestors (line, zone, ...) so tag
        values such as ``machine_ref`` / ``line_ref`` / ``zone_ref`` are picked, not pasted.
        """
        rows = await fetch_all(
            session,
            """
            SELECT m.id, m.display_name, m.key, m.status, m.state, m.kind, m.version, m.sample_ms,
                   m.spec_json, m.resource_id, s.sampled_at, s.error_count, s.body_text
            FROM output_groups m
            LEFT JOIN model_state s ON s.group_id = m.id
            WHERE m.tenant_id = :tenant_id AND m.status = 'ACTIVE'
            ORDER BY m.display_name
            """,
            {"tenant_id": tenant_id},
        )
        resources = await load_resource_index(session, tenant_id)
        bound = await bound_model_fields(session, tenant_id)
        now = utcnow()
        needle = (search or "").strip().lower()
        flat_leaves: list[dict[str, Any]] = []
        models: list[dict[str, Any]] = []
        for r in rows:
            mid = str(r["id"])
            dname = str(r["display_name"])
            sample_t = r.get("sampled_at")
            if sample_t is not None:
                diff_s = (now - sample_t).total_seconds()
                m_fresh = "FRESH" if diff_s <= max(3.0 * (r.get("sample_ms") or 1000) / 1000.0, 15.0) else "STALE"
                m_qual = "BAD" if int(r.get("error_count") or 0) else "GOOD"
            else:
                m_fresh = "UNKNOWN"
                m_qual = "UNKNOWN"
            body: Any = None
            if r.get("body_text"):
                try:
                    body = json.loads(str(r["body_text"]))
                except ValueError:
                    body = None
            context = resource_context(resources, r.get("resource_id"))
            machine = context["resource"]
            field_items = []
            for leaf in model_leaf_fields(r.get("spec_json")):
                f_path = leaf["path"]
                found, last_value = extract_field(body, f_path) if body is not None else (False, None)
                can_id = f"mod:{mid}:{f_path}"
                owner = bound.get((mid, f_path))
                leaf_item = {
                    "kind": "model_field",
                    "source_kind": "model_field",
                    "id": can_id,
                    "canonical_id": can_id,
                    "model_id": mid,
                    "model_name": dname,
                    "model_kind": str(r.get("kind") or "STATE"),
                    "model_revision": int(r.get("version") or 1),
                    "field_path": f_path,
                    "key": leaf["key"],
                    "name": f_path,
                    "display_name": f"{dname} \u00b7 {f_path}",
                    "display_path": f"Data Models / {dname} / {f_path}",
                    "path": f"Data Models / {dname} / {f_path}",
                    "data_type": leaf["data_type"],
                    "value_type": leaf["value_type"],
                    "field_mode": leaf["mode"],
                    "is_timestamp": leaf["is_timestamp"],
                    "unit": None,
                    "status": "ACTIVE",
                    "quality": m_qual,
                    "freshness": m_fresh,
                    "last_value": last_value if found else None,
                    "has_last_value": bool(found),
                    "resource_id": machine["id"] if machine else None,
                    "resource_name": machine["name"] if machine else None,
                    "resource_code": machine["code"] if machine else None,
                    "bound_to": owner,
                }
                hay = f"{f_path} {dname} {machine['code'] if machine else ''}".lower()
                if not needle or needle in hay:
                    field_items.append(leaf_item)
                    flat_leaves.append(leaf_item)

            if not needle or field_items or needle in dname.lower():
                models.append({
                    "id": mid,
                    "kind": "model",
                    "selectable": False,
                    "name": dname,
                    "display_name": dname,
                    "key": str(r.get("key") or ""),
                    "model_kind": str(r.get("kind") or "STATE"),
                    "status": str(r["status"]),
                    "state": str(r.get("state") or ""),
                    "model_revision": int(r.get("version") or 1),
                    "resource": machine,
                    "ancestors": context["ancestors"],
                    "fields": field_items,
                    "signals": field_items,
                    "fields_count": len(field_items),
                    "signals_count": len(field_items),
                    "freshness": m_fresh,
                    "quality": m_qual,
                })

        return {
            "view": "models",
            "items": models[:limit],
            "groups": models[:limit],
            "sources": flat_leaves,
            "leaves": flat_leaves,
            "total": len(models),
            "leaf_total": len(flat_leaves),
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


# ----------------------------------------------------------------------
# Model field leaves, body extraction and Factory Model context (shared with the writer)
# ----------------------------------------------------------------------

_VALUE_TYPE_TO_DATA_TYPE = {
    "float": "float64", "int": "int64", "string": "string", "bool": "bool",
    "timestamp": "timestamp", "json": "json", "auto": "auto",
}
_TIMESTAMP_KEYS = frozenset({"source_timestamp", "publish_timestamp"})


def _spec_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _path_text(parts: list[Any]) -> str:
    return "/".join(str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def split_field_path(path: str) -> list[str]:
    """``"electrical/voltage_1"`` (or ``"/electrical/voltage_1"``) -> ``["electrical", "voltage_1"]``."""
    text = str(path or "").strip()
    if text.startswith("/"):
        text = text[1:]
    if not text:
        return []
    return [p.replace("~1", "/").replace("~0", "~") for p in text.split("/")]


def normalize_field_path(path: Any) -> str:
    return _path_text(split_field_path(str(path or "")))


def model_leaf_fields(spec_raw: Any) -> list[dict[str, Any]]:
    """Every field leaf of a Data Model v2 spec (objects/arrays are containers, never bindable)."""
    from factorix.domain.body import iter_fields

    spec = _spec_dict(spec_raw)
    out: list[dict[str, Any]] = []
    if isinstance(spec.get("root"), dict):
        for parts, node in iter_fields(spec):
            vtype = str(node.get("value_type") or "auto")
            path = _path_text(list(parts))
            key = str(parts[-1]) if parts else path
            out.append({
                "path": path,
                "key": key,
                "value_type": vtype,
                "data_type": _VALUE_TYPE_TO_DATA_TYPE.get(vtype, "auto"),
                "mode": str(node.get("mode") or ""),
                "is_timestamp": vtype == "timestamp" or (len(parts) == 1 and key in _TIMESTAMP_KEYS),
            })
        return out
    for f in spec.get("fields") or []:  # legacy flat spec
        if isinstance(f, dict):
            path = normalize_field_path(f.get("key") or f.get("path") or f.get("name") or "")
            if path:
                vtype = str(f.get("value_type") or f.get("type") or "auto")
                out.append({"path": path, "key": path.split("/")[-1], "value_type": vtype,
                            "data_type": _VALUE_TYPE_TO_DATA_TYPE.get(vtype, vtype), "mode": "",
                            "is_timestamp": path in _TIMESTAMP_KEYS})
    return out


def extract_field(body: Any, path: str) -> tuple[bool, Any]:
    """``(found, value)`` of a field in an evaluated body. Missing (not sampled) is not null."""
    node: Any = body
    for part in split_field_path(path):
        if isinstance(node, dict):
            if part not in node:
                return False, None
            node = node[part]
        elif isinstance(node, list):
            try:
                idx = int(part)
            except ValueError:
                return False, None
            if idx < 0 or idx >= len(node):
                return False, None
            node = node[idx]
        else:
            return False, None
    return True, node


async def load_resource_index(session: AsyncSession, tenant_id: UUID) -> dict[str, dict[str, Any]]:
    rows = await fetch_all(
        session,
        """
        SELECT r.id, r.parent_id, r.name, r.code, rt.key AS type_key
        FROM resources r JOIN resource_types rt ON rt.id = r.type_id
        WHERE r.tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    )
    return {
        str(r["id"]): {
            "id": str(r["id"]),
            "parent_id": str(r["parent_id"]) if r.get("parent_id") else None,
            "name": str(r.get("name") or ""),
            "code": str(r.get("code") or ""),
            "type_key": str(r.get("type_key") or ""),
        }
        for r in rows
    }


def resource_context(index: dict[str, dict[str, Any]], resource_id: Any) -> dict[str, Any]:
    """The resource a model belongs to and its ancestors (nearest first), for tag pickers."""
    rid = str(resource_id) if resource_id else None
    res = index.get(rid) if rid else None
    ancestors: list[dict[str, Any]] = []
    seen: set[str] = set()
    cur = index.get(res["parent_id"]) if res and res.get("parent_id") else None
    while cur is not None and cur["id"] not in seen and len(ancestors) < 16:
        seen.add(cur["id"])
        ancestors.append({k: cur[k] for k in ("id", "name", "code", "type_key")})
        cur = index.get(cur["parent_id"]) if cur.get("parent_id") else None
    resource = {k: res[k] for k in ("id", "name", "code", "type_key")} if res else None
    return {"resource": resource, "ancestors": ancestors}


async def bound_model_fields(session: AsyncSession, tenant_id: UUID) -> dict[tuple[str, str], dict[str, Any]]:
    """Active owners of model fields: ``(model_id, field_path) -> {database, subtable, column}``."""
    rows = await fetch_all(
        session,
        """
        SELECT model_id, model_field_path, physical_db, physical_subtable, target_column
        FROM storage_bindings
        WHERE tenant_id = :tenant_id AND status = 'ACTIVE' AND source_kind = 'model_field'
          AND model_id IS NOT NULL
        """,
        {"tenant_id": tenant_id},
    )
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        out[(str(r["model_id"]), normalize_field_path(r.get("model_field_path")))] = {
            "database": r["physical_db"],
            "subtable": r["physical_subtable"],
            "column": r["target_column"],
        }
    return out


#: Data Model value type -> TDengine column base types it can be written to without loss.
MODEL_TYPE_COMPATIBILITY: dict[str, set[str]] = {
    "float": {"DOUBLE", "FLOAT"},
    "int": {"BIGINT", "INT", "SMALLINT", "TINYINT", "DOUBLE"},
    "bool": {"BOOL", "TINYINT", "INT", "BIGINT"},
    "string": {"VARCHAR", "NCHAR", "BINARY"},
    "timestamp": {"TIMESTAMP", "VARCHAR", "NCHAR"},
    "json": {"VARCHAR", "NCHAR"},
    # "auto" fields (rules without an explicit type) produce whatever the rule returns: allow the
    # usual value columns; the writer rejects a value that does not fit at write time (visible error).
    "auto": {"DOUBLE", "FLOAT", "BIGINT", "INT", "SMALLINT", "TINYINT", "BOOL", "VARCHAR", "NCHAR", "BINARY"},
}


def model_type_compatible(value_type: str, column_type: str) -> bool:
    base = str(column_type or "").upper().split("(")[0].strip()
    return base in MODEL_TYPE_COMPATIBILITY.get(str(value_type or "auto").lower(), set())


def suggest_value_column(value_type: str, columns: list[str]) -> str | None:
    """Typed value column suggestion (guide F3): float->value_f64, int->value_i64, string->value_text."""
    prefs = {
        "float": ["value_f64", "value_double", "value"],
        "int": ["value_i64", "value_int", "value_f64", "value"],
        "bool": ["value_bool", "value_i64", "value"],
        "string": ["value_text", "value_str", "value"],
        "timestamp": ["value_text"],
        "json": ["value_text", "value_json"],
        "auto": ["value_f64", "value_i64", "value_text", "value"],
    }.get(str(value_type or "auto").lower(), [])
    for cand in prefs:
        if cand in columns:
            return cand
    return None
