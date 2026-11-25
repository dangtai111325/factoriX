"""Dashboard sources: picker catalog, capabilities and resolution of source references (contract §3, §5, §6).

Only two source domains exist: Data Collector **signals** and Data Model **fields** (plus ``signal_key``, a
signal addressed by its exact key on the resource selected in a dashboard variable). Everything is
tenant-scoped and read-only; nothing is matched by display name.

* :func:`catalog` reuses the Historian picker read model (``historian_catalog.sources_by_machine``) restricted
  to ``signal`` + ``model_field`` and adds the stable ``source`` reference, ``value_kind`` and
  ``capabilities`` to every item.
* :func:`resolve_sources` resolves up to 400 references with a fixed number of batched queries (independent
  of the number of references), deduplicated, results in request order.
* Capabilities are computed from the same facts the Historian uses (history provider configured, PostgreSQL
  fallback flag, managed recordings, model-field storage bindings); the browser never guesses them.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.dashboards import registry as R
from factorix.application.dashboards.documents import normalize_source, source_key
from factorix.application.history.query_service import pg_fallback_enabled
from factorix.domain.body import spec_refs
from factorix.modules import historian_catalog
from factorix.modules import storage_bindings as SB
from factorix.modules.common import fetch_all
from factorix.modules.history_repository import get_history_provider, get_model_snapshot_provider
from factorix.platform.errors import AppError

#: Signal data type -> dashboard value kind.
SIGNAL_VALUE_KINDS = {
    "bool": "boolean", "boolean": "boolean", "int64": "number", "int32": "number", "int": "number",
    "float64": "number", "float32": "number", "double": "number", "string": "string", "enum": "string",
    "text": "string", "json": "json",
}
#: Data Model field value type -> dashboard value kind (``auto`` = unknown unless it maps a typed signal).
MODEL_VALUE_KINDS = {
    "float": "number", "int": "number", "bool": "boolean", "string": "string", "timestamp": "string", "json": "json",
}

SNAPSHOT_LIMIT = 500


def signal_value_kind(data_type: Any) -> str:
    return SIGNAL_VALUE_KINDS.get(str(data_type or "").lower(), "unknown")


def model_value_kind(value_type: Any) -> str:
    return MODEL_VALUE_KINDS.get(str(value_type or "").lower(), "unknown")


# ---------------------------------------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------------------------------------


def history_state() -> dict[str, bool]:
    """Which history readers exist in this process (same switches as ``historian_service.query_historian``)."""
    return {
        "history": get_history_provider() is not None,
        "snapshots": get_model_snapshot_provider() is not None,
        "pg_fallback": bool(pg_fallback_enabled()),
    }


def signal_capabilities(*, recorded: bool, state: dict[str, bool]) -> dict[str, Any]:
    if state["history"]:
        modes = ["operational"] + (["recorded"] if recorded else [])
        return {"latest": True, "live": True, "historical": True, "history_modes": modes,
                "fidelity": "operational_full", "notes": []}
    if state["pg_fallback"]:
        return {"latest": True, "live": True, "historical": True, "history_modes": ["operational"],
                "fidelity": "postgres_fallback",
                "notes": ["TDengine history is not configured; history comes from the PostgreSQL observations fallback."]}
    return {"latest": True, "live": True, "historical": False, "history_modes": [], "fidelity": "unavailable",
            "notes": ["TDengine history is not configured and the PostgreSQL observations fallback is disabled."]}


def model_field_capabilities(*, recorded: bool, state: dict[str, bool]) -> dict[str, Any]:
    if not state["history"]:
        return {"latest": True, "live": True, "historical": False, "history_modes": [], "fidelity": "unavailable",
                "notes": ["TDengine history is not configured."]}
    if recorded:
        return {"latest": True, "live": True, "historical": True, "history_modes": ["operational", "recorded"],
                "fidelity": "managed_recorded", "notes": ["Recorded field: history rows are the recorded changes."]}
    if not state["snapshots"]:
        return {"latest": True, "live": True, "historical": False, "history_modes": [], "fidelity": "unavailable",
                "notes": ["Not recorded, and model snapshots are not available in this process."]}
    return {"latest": True, "live": True, "historical": True, "history_modes": ["operational"],
            "fidelity": "model_snapshots",
            "notes": [f"Not recorded: only recent model snapshots are kept (at most {SNAPSHOT_LIMIT} samples). "
                      "Record the field in Storage Management for full history."]}


# ---------------------------------------------------------------------------------------------------------
# Batched loaders (one query each, independent of the number of references)
# ---------------------------------------------------------------------------------------------------------


async def load_resources(session: AsyncSession, tenant_id: UUID) -> dict[str, dict[str, Any]]:
    rows = await fetch_all(
        session,
        """
        SELECT r.id, r.parent_id, r.name, r.code, rt.key AS type_key, r.status, r.archived_at
        FROM resources r JOIN resource_types rt ON rt.id = r.type_id
        WHERE r.tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    )
    return {
        str(r["id"]).lower(): {
            "id": str(r["id"]).lower(),
            "parent_id": str(r["parent_id"]).lower() if r.get("parent_id") else None,
            "name": str(r.get("name") or ""),
            "code": str(r.get("code") or ""),
            "type_key": str(r.get("type_key") or ""),
            "archived": str(r.get("status") or "ACTIVE") != "ACTIVE" or r.get("archived_at") is not None,
        }
        for r in rows
    }


async def _signals_by_id(session: AsyncSession, tenant_id: UUID, ids: list[UUID]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT id, key, display_name, data_type, unit, status, resource_id
        FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": ids},
    )
    return {str(r["id"]).lower(): r for r in rows}


async def _signals_by_key(session: AsyncSession, tenant_id: UUID, resource_ids: list[UUID], keys: list[str]
                          ) -> dict[tuple[str, str], dict[str, Any]]:
    """ACTIVE signals by exact ``(resource_id, key)`` (unique index ``signal_key_active``)."""
    if not resource_ids or not keys:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT id, key, display_name, data_type, unit, status, resource_id
        FROM signal_definitions
        WHERE tenant_id = :tenant_id AND status = 'ACTIVE' AND resource_id = ANY(:resource_ids) AND key = ANY(:keys)
        """,
        {"tenant_id": tenant_id, "resource_ids": resource_ids, "keys": keys},
    )
    return {(str(r["resource_id"]).lower(), str(r["key"])): r for r in rows}


async def _models(session: AsyncSession, tenant_id: UUID, ids: list[UUID]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    rows = await fetch_all(
        session,
        "SELECT id, display_name, status, resource_id, spec_json FROM output_groups WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
        {"tenant_id": tenant_id, "ids": ids},
    )
    return {str(r["id"]).lower(): r for r in rows}


async def _signal_meta(session: AsyncSession, tenant_id: UUID, ids: list[UUID]) -> dict[str, dict[str, Any]]:
    """``signal id (lower) -> {resource_id, data_type}`` for the signals a Data Model references."""
    if not ids:
        return {}
    rows = await fetch_all(
        session,
        "SELECT id, resource_id, data_type FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
        {"tenant_id": tenant_id, "ids": ids},
    )
    return {str(r["id"]).lower(): {"resource_id": str(r["resource_id"]).lower() if r.get("resource_id") else None,
                                   "data_type": r.get("data_type")} for r in rows}


async def _recorded_signals(session: AsyncSession, tenant_id: UUID, ids: list[UUID]) -> set[str]:
    """Signals with an ACTIVE/PAUSED managed recording (what ``mode=recorded`` reads for a signal)."""
    if not ids:
        return set()
    rows = await fetch_all(
        session,
        """
        SELECT DISTINCT signal_id FROM storage_physical_registry
        WHERE tenant_id = :tenant_id AND tier = 'MANAGED' AND status IN ('ACTIVE', 'PAUSED') AND signal_id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": ids},
    )
    return {str(r["signal_id"]).lower() for r in rows if r.get("signal_id")}


async def _bound_fields(session: AsyncSession, tenant_id: UUID) -> set[tuple[str, str]]:
    """``(model id, field path)`` recorded by an ACTIVE storage binding (same rule as the Historian)."""
    bound = await SB.bound_model_fields(session, tenant_id)
    return {(str(mid).lower(), path) for (mid, path) in bound}


# ---------------------------------------------------------------------------------------------------------
# Resource context
# ---------------------------------------------------------------------------------------------------------


def resource_path(index: dict[str, dict[str, Any]], resource_id: str | None) -> list[str]:
    ctx = SB.resource_context(index, resource_id)
    return [a["name"] for a in reversed(ctx["ancestors"])]


def resource_ref(index: dict[str, dict[str, Any]], resource_id: Any) -> dict[str, Any] | None:
    rid = str(resource_id).lower() if resource_id else None
    res = index.get(rid) if rid else None
    if res is None:
        return None
    return {"id": res["id"], "name": res["name"], "code": res["code"], "type_key": res["type_key"],
            "parent_id": res["parent_id"], "path": resource_path(index, rid)}


def resources_payload(index: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    items = [resource_ref(index, rid) for rid, res in index.items() if not res["archived"]]
    out = [i for i in items if i is not None]
    out.sort(key=lambda r: (" / ".join(r["path"] + [r["name"]]).lower(), r["code"]))
    return out


def _spec(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


# ---------------------------------------------------------------------------------------------------------
# Catalog (GET /dashboards/sources)
# ---------------------------------------------------------------------------------------------------------


async def catalog(session: AsyncSession, tenant_id: UUID, *, q: str | None = None) -> dict[str, Any]:
    picker = await historian_catalog.sources_by_machine(session, tenant_id, search=q, kinds={"signal", "model_field"})
    state = history_state()
    signal_ids = [UUID(s["token"]) for g in picker["items"] for s in g["signals"]]
    recorded = await _recorded_signals(session, tenant_id, signal_ids)
    bound = await _bound_fields(session, tenant_id) if any(g["models"] for g in picker["items"]) else set()
    for group in picker["items"]:
        group.pop("subtables", None)
        for s in group["signals"]:
            s["source"] = {"kind": "signal", "signal_id": s["token"]}
            s["value_kind"] = signal_value_kind(s.get("value_type"))
            s["capabilities"] = signal_capabilities(recorded=s["token"].lower() in recorded, state=state)
        for m in group["models"]:
            for f in m["fields"]:
                f["source"] = {"kind": "model_field", "model_id": m["model_id"], "field_path": f["field_path"]}
                f["model_id"] = m["model_id"]
                # An ``auto`` field has no declared type; like the binding defaults (R2-14) its kind follows the
                # live value, so the picker's Numeric/Text filters do not hide every auto field.
                inferred, _how = SB.infer_value_type(str(f.get("value_type") or ""), None, bool(f.get("has_last_value")),
                                                     f.get("last_value"))
                f["value_kind"] = model_value_kind(inferred)
                f["capabilities"] = model_field_capabilities(recorded=(str(m["model_id"]).lower(), f["field_path"]) in bound, state=state)
    picker["total_series"] = sum(len(g["signals"]) + sum(len(m["fields"]) for m in g["models"]) for g in picker["items"])
    picker["resources"] = resources_payload(await load_resources(session, tenant_id))
    return picker


# ---------------------------------------------------------------------------------------------------------
# Resolve (POST /dashboards/resolve, validate, publish)
# ---------------------------------------------------------------------------------------------------------


def _error(source: Any, code: str, message: str) -> dict[str, Any]:
    return {"source": source, "ok": False, "error": {"code": code, "message": message}}


def _variable_resource(variables: dict[str, Any], variable: str, index: dict[str, dict[str, Any]]
                       ) -> tuple[str | None, tuple[str, str] | None]:
    """``(resource id, None)`` or ``(None, (error code, message))`` for the resource selected in a variable."""
    if variable not in variables:
        return None, ("VARIABLE_UNKNOWN", f"Variable '{variable}' is not defined.")
    value = variables[variable]
    if value is None or value == "":
        return None, ("VARIABLE_UNSET", f"Variable '{variable}' has no resource selected.")
    rid = R.canonical_uuid(value)
    if rid is None:
        return None, ("INVALID_REF", f"Variable '{variable}' does not hold a resource id.")
    res = index.get(rid)
    if res is None:
        return None, ("NOT_FOUND", f"The resource selected in variable '{variable}' does not exist.")
    if res["archived"]:
        return None, ("ARCHIVED", f"The resource selected in variable '{variable}' is archived.")
    return rid, None


async def resolve_sources(session: AsyncSession, tenant_id: UUID, variables: dict[str, Any] | None, sources: list[Any], *,
                          resources: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Resolve source references (tenant-scoped, exact matching); one result per input, in input order."""
    if len(sources) > R.MAX_RESOLVE_REFS:
        raise AppError(422, "LIMIT", f"At most {R.MAX_RESOLVE_REFS} sources per resolve call.")
    variables = dict(variables or {})
    index = resources if resources is not None else await load_resources(session, tenant_id)
    state = history_state()

    parsed: list[tuple[Any, dict[str, Any] | None, str | None, str]] = []
    for raw in sources:
        norm, code, message = normalize_source(raw)
        parsed.append((raw, norm, code, message))
    unique: dict[str, dict[str, Any]] = {}
    for _raw, norm, _c, _m in parsed:
        if norm is not None:
            unique.setdefault(source_key(norm), norm)

    # signal_key -> (resource id, key) through the variables (exact, never by name).
    key_targets: dict[str, tuple[str, str]] = {}
    key_errors: dict[str, tuple[str, str]] = {}
    for k, src in unique.items():
        if src["kind"] == "signal_key":
            rid, err = _variable_resource(variables, src["variable"], index)
            if err is not None:
                key_errors[k] = err
            else:
                key_targets[k] = (str(rid), src["key"])

    signal_ids = sorted({UUID(s["signal_id"]) for s in unique.values() if s["kind"] == "signal"}, key=str)
    model_ids = sorted({UUID(s["model_id"]) for s in unique.values() if s["kind"] == "model_field"}, key=str)
    by_id = await _signals_by_id(session, tenant_id, signal_ids)
    by_key = await _signals_by_key(session, tenant_id, sorted({UUID(r) for r, _k in key_targets.values()}, key=str),
                                   sorted({key for _r, key in key_targets.values()}))
    models = await _models(session, tenant_id, model_ids)

    specs = {mid: _spec(m.get("spec_json")) for mid, m in models.items()}
    referenced: set[str] = set()
    for spec in specs.values():
        if isinstance(spec.get("root"), dict):
            referenced |= spec_refs(spec)[0]
    meta = await _signal_meta(session, tenant_id, sorted({UUID(s) for s in referenced if R.canonical_uuid(s)}, key=str))
    found_signals = [str(r["id"]).lower() for r in by_id.values() if r.get("status") == "ACTIVE"]
    found_signals += [str(r["id"]).lower() for r in by_key.values()]
    recorded = await _recorded_signals(session, tenant_id, sorted({UUID(s) for s in found_signals}, key=str))
    bound = await _bound_fields(session, tenant_id) if models else set()
    signal_resources = {sid: v["resource_id"] for sid, v in meta.items() if v.get("resource_id")}

    def signal_result(raw: Any, row: dict[str, Any]) -> dict[str, Any]:
        sid = str(row["id"]).lower()
        return {
            "source": raw, "ok": True, "token": sid, "kind": "signal", "signal_id": sid, "key": row["key"],
            "label": row.get("display_name") or row["key"], "resource": resource_ref(index, row.get("resource_id")),
            "value_type": row.get("data_type"), "value_kind": signal_value_kind(row.get("data_type")),
            "unit": row.get("unit"), "capabilities": signal_capabilities(recorded=sid in recorded, state=state),
        }

    results: dict[str, Any] = {}
    for k, src in unique.items():
        kind = src["kind"]
        if kind == "role":
            results[k] = ("UNBOUND", f"Template role '{src['role']}' is not mapped to a source.")
        elif kind == "signal":
            row = by_id.get(src["signal_id"])
            if row is None:
                results[k] = ("NOT_FOUND", "Signal not found in this tenant.")
            elif row.get("status") != "ACTIVE":
                results[k] = ("ARCHIVED", f"Signal '{row['key']}' is archived.")
            else:
                results[k] = row
        elif kind == "signal_key":
            if k in key_errors:
                results[k] = key_errors[k]
            else:
                rid, key = key_targets[k]
                row = by_key.get((rid, key))
                results[k] = row if row is not None else (
                    "KEY_NOT_ON_RESOURCE", f"No active signal with key '{key}' on resource '{index[rid]['name']}'.")
        else:  # model_field
            m = models.get(src["model_id"])
            if m is None:
                results[k] = ("NOT_FOUND", "Data Model not found in this tenant.")
            elif str(m.get("status") or "") == "ARCHIVED":
                results[k] = ("ARCHIVED", f"Data Model '{m['display_name']}' is archived.")
            else:
                leaves = {leaf["path"]: leaf for leaf in SB.model_leaf_fields(m.get("spec_json"))}
                leaf = leaves.get(src["field_path"])
                results[k] = ("FIELD_NOT_FOUND", f"Field '{src['field_path']}' is not a field of Data Model "
                              f"'{m['display_name']}'.") if leaf is None else (m, leaf)

    out: list[dict[str, Any]] = []
    for raw, norm, _code, message in parsed:
        if norm is None:
            out.append(_error(raw, "INVALID_REF", message))
            continue
        res = results[source_key(norm)]
        if isinstance(res, tuple) and len(res) == 2 and isinstance(res[0], str):
            out.append(_error(raw, res[0], res[1]))
        elif norm["kind"] in ("signal", "signal_key"):
            out.append(signal_result(raw, res))
        else:
            m, leaf = res
            mid, path = str(m["id"]).lower(), leaf["path"]
            spec = specs.get(mid, {})
            rid = str(m["resource_id"]).lower() if m.get("resource_id") else SB.model_resource_id(spec, index, signal_resources)
            mapped = SB.mapping_signals(spec).get(path)
            value_type, _how = SB.infer_value_type(leaf["value_type"], (meta.get(mapped) or {}).get("data_type") if mapped else None, False, None)
            out.append({
                "source": raw, "ok": True, "token": f"mod:{mid}:{path}", "kind": "model_field", "model_id": mid,
                "field_path": path, "label": f"{m['display_name']} · {path}", "resource": resource_ref(index, rid),
                "value_type": value_type or leaf["value_type"], "value_kind": model_value_kind(value_type),
                "unit": None, "is_timestamp": bool(leaf.get("is_timestamp")),
                "capabilities": model_field_capabilities(recorded=(mid, path) in bound, state=state),
            })
    return out
