"""Historian source picker grouped by machine (plan §8.3 "Source Explorer", WS-D request).

One read model for the Historian picker: every Factory Model resource that owns data, with
* its signals (live quality + freshness from ``latest_signal_state``),
* the fields of its Data Models (last value of the latest body, model freshness),
* the user subtables recording those fields (``storage_bindings``).

Every item carries the Historian series ``token`` accepted by ``POST /api/v1/historian/query``
(``<signal uuid>``, ``mod:<model uuid>:<field path>``, ``subtable:<db>.<table>:<column>``), so the UI
never builds identifiers itself. Quality is reported as stored; nothing is defaulted to GOOD.
"""

from __future__ import annotations

from datetime import datetime
import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.signal_state import canonical_stale_after_ms
from factorix.modules import storage_bindings as SB
from factorix.modules.common import fetch_all, iso_ms, utcnow

UNASSIGNED = "unassigned"


def _freshness(last: datetime | None, interval_ms: int | None, now: datetime) -> str:
    if last is None:
        return "NO_DATA"
    age_ms = (now - last).total_seconds() * 1000.0
    return "FRESH" if age_ms <= canonical_stale_after_ms(interval_ms or 1000) else "STALE"


def _value_of(raw: Any) -> Any:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return raw
    return raw.get("v") if isinstance(raw, dict) else raw


async def sources_by_machine(session: AsyncSession, tenant_id: UUID, *, search: str | None = None,
                             kinds: set[str] | None = None) -> dict[str, Any]:
    kinds = kinds or {"signal", "model_field", "subtable"}
    needle = (search or "").strip().lower()
    now = utcnow()
    resources = await SB.load_resource_index(session, tenant_id)
    groups: dict[str, dict[str, Any]] = {}

    def group_of(resource_id: str | None) -> dict[str, Any]:
        rid = resource_id if resource_id in resources else UNASSIGNED
        g = groups.get(rid)
        if g is None:
            ctx = SB.resource_context(resources, rid if rid != UNASSIGNED else None)
            g = groups[rid] = {
                "resource": ctx["resource"] or {"id": None, "name": "Unassigned", "code": "", "type_key": ""},
                "path": [a["name"] for a in reversed(ctx["ancestors"])],
                "ancestors": ctx["ancestors"],
                "signals": [], "models": [], "subtables": [],
            }
        return g

    def match(*texts: Any) -> bool:
        return not needle or any(needle in str(t or "").lower() for t in texts)

    if "signal" in kinds:
        rows = await fetch_all(
            session,
            """
            SELECT s.id, s.key, s.display_name, s.data_type, s.unit, s.resource_id, s.expected_interval_ms,
                   l.quality, l.last_acquired_at, l.value_json
            FROM signal_definitions s
            LEFT JOIN latest_signal_state l ON l.tenant_id = s.tenant_id AND l.signal_id = s.id
            WHERE s.tenant_id = :tenant_id AND s.status = 'ACTIVE'
            ORDER BY s.key
            """,
            {"tenant_id": tenant_id},
        )
        for r in rows:
            rid = str(r["resource_id"]) if r.get("resource_id") else None
            g = group_of(rid)
            if not match(r["key"], r.get("display_name"), g["resource"]["name"], g["resource"]["code"]):
                continue
            g["signals"].append({
                "kind": "signal", "token": str(r["id"]), "key": r["key"], "label": r.get("display_name") or r["key"],
                "value_type": r.get("data_type"), "unit": r.get("unit"),
                "quality": (str(r["quality"]).upper() if r.get("quality") else None),
                "freshness": _freshness(r.get("last_acquired_at"), r.get("expected_interval_ms"), now),
                "last_value": _value_of(r.get("value_json")),
                "last_at": iso_ms(r["last_acquired_at"]) if r.get("last_acquired_at") else None,
            })

    recorded = await fetch_all(
        session,
        """
        SELECT b.model_id, b.model_field_path, b.signal_id, b.physical_db, b.physical_subtable, b.target_column,
               o.display_name, o.status
        FROM storage_bindings b
        JOIN storage_objects o ON o.tenant_id = b.tenant_id AND o.object_type = 'subtable'
         AND o.physical_db = b.physical_db AND o.physical_name = b.physical_subtable AND o.status <> 'PURGED'
        WHERE b.tenant_id = :tenant_id AND b.status = 'ACTIVE'
        """,
        {"tenant_id": tenant_id},
    )
    by_field = {(str(r["model_id"]), SB.normalize_field_path(r["model_field_path"])): r for r in recorded if r.get("model_id")}

    model_resource: dict[str, str | None] = {}
    if "model_field" in kinds or "subtable" in kinds:
        signal_resources = await SB.signal_resource_map(session, tenant_id)
        models = await fetch_all(
            session,
            """
            SELECT m.id, m.display_name, m.resource_id, m.spec_json, m.sample_ms, m.state, s.body_text, s.sampled_at, s.error_count
            FROM output_groups m LEFT JOIN model_state s ON s.group_id = m.id
            WHERE m.tenant_id = :tenant_id AND m.status = 'ACTIVE'
            ORDER BY m.display_name
            """,
            {"tenant_id": tenant_id},
        )
        for m in models:
            mid = str(m["id"])
            rid = str(m["resource_id"]) if m.get("resource_id") else SB.model_resource_id(m.get("spec_json"), resources, signal_resources)
            model_resource[mid] = rid
            if "model_field" not in kinds:
                continue
            g = group_of(rid)
            try:
                body = json.loads(m["body_text"]) if m.get("body_text") else None
            except ValueError:
                body = None
            fresh = _freshness(m.get("sampled_at"), m.get("sample_ms"), now)
            fields = []
            for leaf in SB.model_leaf_fields(m.get("spec_json")):
                if not match(leaf["path"], m["display_name"], g["resource"]["name"], g["resource"]["code"]):
                    continue
                found, value = SB.extract_field(body, leaf["path"]) if body is not None else (False, None)
                rec = by_field.get((mid, leaf["path"]))
                fields.append({
                    "kind": "model_field", "token": f"mod:{mid}:{leaf['path']}", "key": leaf["key"],
                    "field_path": leaf["path"], "label": f"{m['display_name']} · {leaf['path']}",
                    "value_type": leaf["value_type"], "is_timestamp": leaf["is_timestamp"],
                    "freshness": fresh, "model_state": m.get("state"),
                    "quality": "BAD" if int(m.get("error_count") or 0) else ("GOOD" if m.get("sampled_at") else None),
                    "last_value": value if found else None, "has_last_value": bool(found),
                    "last_at": iso_ms(m["sampled_at"]) if m.get("sampled_at") else None,
                    "recorded_in": {"token": f"subtable:{rec['physical_db']}.{rec['physical_subtable']}:{rec['target_column']}",
                                    "status": rec["status"]} if rec else None,
                })
            if fields:
                g["models"].append({"model_id": mid, "name": m["display_name"], "state": m.get("state"),
                                    "freshness": fresh, "fields": fields})

    if "subtable" in kinds:
        sig_res = {}
        if any(r.get("signal_id") for r in recorded):
            sig_res = await SB.signal_resource_map(session, tenant_id)
        for r in recorded:
            rid = model_resource.get(str(r["model_id"])) if r.get("model_id") else sig_res.get(str(r["signal_id"]).lower())
            g = group_of(rid)
            label = r.get("display_name") or r["physical_subtable"]
            if not match(label, r["physical_subtable"], g["resource"]["name"], g["resource"]["code"]):
                continue
            g["subtables"].append({
                "kind": "subtable", "token": f"subtable:{r['physical_db']}.{r['physical_subtable']}:{r['target_column']}",
                "label": label, "database": r["physical_db"], "subtable": r["physical_subtable"],
                "column": r["target_column"], "recording": r["status"],
                "source": f"mod:{r['model_id']}:{r['model_field_path']}" if r.get("model_id") else str(r.get("signal_id")),
            })

    items = [g for g in groups.values() if g["signals"] or g["models"] or g["subtables"]]
    items.sort(key=lambda g: (g["resource"]["id"] is None, " / ".join(g["path"]), g["resource"]["name"]))
    return {
        "items": items,
        "total_groups": len(items),
        "total_series": sum(len(g["signals"]) + sum(len(m["fields"]) for m in g["models"]) + len(g["subtables"]) for g in items),
        "observed_at": iso_ms(now),
    }
