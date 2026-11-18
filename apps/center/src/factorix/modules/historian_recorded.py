"""Recorded tables for the Historian picker: server-side search and paging (R2-03), and "where is this
raw signal recorded" hints (R2-17).

PostgreSQL only (registry + bindings + Factory Model), no TDengine call, so it is cheap for any number of
tables. One item per bound value column of a user subtable (the token the Historian query accepts:
``subtable:<db>.<table>:<column>``). FactoriX system tables (``op_*`` / ``ms_*``) are the raw store and are
never listed here.

The machine of an item is, strongest first: the subtable tag whose value is a *machine* of the Factory
Model, the Data Model's machine (``output_groups.resource_id`` or derived from its rules, same as the
picker), the bound signal's resource. Nothing is guessed when none of them is known.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_bindings as SB
from factorix.modules.common import fetch_all, iso_ms, utcnow

MAX_PAGE_SIZE = 500


def _json(raw: Any, default: Any) -> Any:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return default
    return raw if raw is not None else default


def _tag_map(raw: Any) -> dict[str, Any]:
    tags = _json(raw, {})
    if isinstance(tags, list):  # [{name, value}] as some wizard payloads store it
        return {str(t.get("name")): t.get("value") for t in tags if isinstance(t, dict) and t.get("name")}
    return dict(tags) if isinstance(tags, dict) else {}


async def _rows(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    return await fetch_all(
        session,
        """
        SELECT b.id AS binding_id, b.source_kind, b.model_id, b.model_field_path, b.signal_id, b.target_column,
               b.status AS binding_status, b.source_data_type,
               o.physical_db, o.physical_name, o.parent_name, o.display_name, o.status AS object_status, o.tags_json,
               m.display_name AS model_name, m.resource_id AS model_resource_id, m.spec_json,
               s.key AS signal_key, s.resource_id AS signal_resource_id, s.unit
        FROM storage_bindings b
        JOIN storage_objects o ON o.tenant_id = b.tenant_id AND o.object_type = 'subtable'
         AND o.physical_db = b.physical_db AND o.physical_name = b.physical_subtable AND o.status <> 'PURGED'
        LEFT JOIN output_groups m ON m.id = b.model_id
        LEFT JOIN signal_definitions s ON s.id = b.signal_id
        WHERE b.tenant_id = :tenant_id AND b.status <> 'RETIRED'
        ORDER BY o.physical_name, b.target_column
        """,
        {"tenant_id": tenant_id},
    )


def _machine_of(r: dict[str, Any], resources: dict[str, dict[str, Any]], signal_res: dict[str, str],
                model_cache: dict[str, str | None]) -> str | None:
    def is_machine(rid: str | None) -> bool:
        return bool(rid) and rid in resources and "machine" in resources[rid]["type_key"].lower()

    for value in _tag_map(r.get("tags_json")).values():
        rid = str(value) if value is not None else None
        if is_machine(rid):
            return rid
    if r.get("model_id"):
        mid = str(r["model_id"])
        if mid not in model_cache:
            rid = str(r["model_resource_id"]) if r.get("model_resource_id") else None
            model_cache[mid] = rid if is_machine(rid) else SB.model_resource_id(r.get("spec_json"), resources, signal_res)
        if model_cache[mid]:
            return model_cache[mid]
    if r.get("signal_resource_id"):
        return str(r["signal_resource_id"])
    return None


def _item(r: dict[str, Any], machine: dict[str, Any] | None) -> dict[str, Any]:
    db, name, col = r["physical_db"], r["physical_name"], r["target_column"]
    source = (f"mod:{r['model_id']}:{SB.normalize_field_path(r.get('model_field_path'))}" if r.get("model_id")
              else (str(r["signal_id"]) if r.get("signal_id") else None))
    label = r.get("display_name") or name
    return {
        "kind": "subtable",
        "token": f"subtable:{db}.{name}:{col}",
        "label": label,
        "database": db,
        "subtable": name,
        "stable": r.get("parent_name"),
        "column": col,
        "value_type": r.get("source_data_type"),
        "unit": r.get("unit"),
        "recording": r.get("object_status"),
        "binding_status": r.get("binding_status"),
        "source": source,
        "source_kind": r.get("source_kind"),
        "model_id": str(r["model_id"]) if r.get("model_id") else None,
        "model_name": r.get("model_name"),
        "field_path": SB.normalize_field_path(r.get("model_field_path")) if r.get("model_field_path") else None,
        "signal_id": str(r["signal_id"]) if r.get("signal_id") else None,
        "signal_key": r.get("signal_key"),
        "machine": machine,
    }


async def recorded_items(session: AsyncSession, tenant_id: UUID) -> list[dict[str, Any]]:
    rows = await _rows(session, tenant_id)
    if not rows:
        return []
    resources = await SB.load_resource_index(session, tenant_id)
    signal_res = await SB.signal_resource_map(session, tenant_id)
    model_cache: dict[str, str | None] = {}
    out = []
    for r in rows:
        rid = _machine_of(r, resources, signal_res, model_cache)
        res = resources.get(rid) if rid else None
        machine = {"id": res["id"], "name": res["name"], "code": res["code"], "type_key": res["type_key"]} if res else None
        out.append(_item(r, machine))
    return out


def _matches(item: dict[str, Any], q: str) -> bool:
    hay = " ".join(str(v) for v in (
        item["subtable"], item["label"], item["stable"], item["column"], item["field_path"], item["model_name"],
        item["signal_key"], (item["machine"] or {}).get("name"), (item["machine"] or {}).get("code"),
    ) if v).lower()
    return all(part in hay for part in q.lower().split())


async def search_recorded(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    q: str | None = None,
    machine_id: str | None = None,
    stable: str | None = None,
    database: str | None = None,
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    """Paged, searchable list of recorded series (every term of ``q`` must match one of: table name,
    display name, supertable, column, field path, model name, signal key, machine name / code).
    ``machines`` counts the filtered items per machine (for the tree badges)."""
    page = max(1, int(page))
    page_size = min(max(1, int(page_size)), MAX_PAGE_SIZE)
    items = await recorded_items(session, tenant_id)
    if q and q.strip():
        items = [i for i in items if _matches(i, q.strip())]
    if machine_id:
        if machine_id == "none":
            items = [i for i in items if not i["machine"]]
        else:
            items = [i for i in items if (i["machine"] or {}).get("id") == machine_id]
    if stable:
        items = [i for i in items if i["stable"] == stable or f"{i['database']}.{i['stable']}" == stable]
    if database:
        items = [i for i in items if i["database"] == database]
    items.sort(key=lambda i: ((i["machine"] or {}).get("name") or "￿", i["subtable"], i["column"]))
    machines: dict[str, dict[str, Any]] = {}
    for i in items:
        m = i["machine"] or {"id": None, "name": None}
        key = m["id"] or "none"
        machines.setdefault(key, {"id": m["id"], "name": m["name"], "count": 0})["count"] += 1
    start = (page - 1) * page_size
    return {
        "items": items[start:start + page_size],
        "total": len(items),
        "page": page,
        "page_size": page_size,
        "has_more": start + page_size < len(items),
        "machines": sorted(machines.values(), key=lambda m: (m["name"] is None, m["name"] or "")),
        "observed_at": iso_ms(utcnow()),
    }


async def recorded_for_signals(session: AsyncSession, tenant_id: UUID, signal_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """``signal id -> recorded series`` that store it: bound directly, or through a Data Model field that
    maps exactly that signal (R2-17: "Recorded as other_aa10_01_speed_1")."""
    wanted = {str(s).lower() for s in signal_ids if s}
    if not wanted:
        return {}
    rows = await _rows(session, tenant_id)
    out: dict[str, list[dict[str, Any]]] = {}
    maps: dict[str, dict[str, str]] = {}
    for r in rows:
        sid = str(r["signal_id"]).lower() if r.get("signal_id") else None
        if sid is None and r.get("model_id"):
            mid = str(r["model_id"])
            if mid not in maps:
                maps[mid] = SB.mapping_signals(r.get("spec_json"))
            sid = maps[mid].get(SB.normalize_field_path(r.get("model_field_path")))
        if sid in wanted:
            out.setdefault(sid, []).append({
                "token": f"subtable:{r['physical_db']}.{r['physical_name']}:{r['target_column']}",
                "label": r.get("display_name") or r["physical_name"], "recording": r.get("object_status"),
            })
    return out
