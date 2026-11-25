"""Full validation of a dashboard document: structure + completeness + source resolution + fit (contract §5 validate/publish).

``validate`` and ``publish`` use :func:`validate_document`; ``ok`` is ``True`` when no issue has severity ``error``.
A binding *fits* its widget when it resolves in the tenant, its value kind is accepted by the widget type
(``any`` accepts everything; an unknown kind is a warning), and the history the widget needs exists for the
source (``history: required``, a ``value_mode`` other than ``latest``, a sparkline, ``history_mode=recorded``).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.dashboards import registry as R
from factorix.application.dashboards import sources as S
from factorix.application.dashboards import store
from factorix.application.dashboards.documents import (
    completeness_issues,
    has_errors,
    issue,
    validate_structure,
)


def needs_history(widget: dict[str, Any]) -> bool:
    wt = R.WIDGET_TYPES[widget["type"]]
    opts = widget.get("options") or {}
    return wt.history == "required" or opts.get("value_mode", "latest") != "latest" or bool(opts.get("sparkline"))


def accepted_kinds(widget: dict[str, Any]) -> tuple[str, ...]:
    wt = R.WIDGET_TYPES[widget["type"]]
    opts = widget.get("options") or {}
    if wt.type == "kpi" and (opts.get("value_mode", "latest") != "latest" or opts.get("sparkline")):
        return ("number",)
    return wt.value_kinds


def fit_issues(widget: dict[str, Any], binding: dict[str, Any], resolved: dict[str, Any]) -> list[dict[str, Any]]:
    """Issues of one resolved binding against its widget (value kind, history capability)."""
    out: list[dict[str, Any]] = []
    wid, bid = widget["id"], binding["id"]
    label = resolved.get("label") or resolved.get("token")
    kinds = accepted_kinds(widget)
    kind = resolved.get("value_kind") or "unknown"
    if "any" not in kinds:
        if kind == "unknown":
            out.append(issue("warning", "VALUE_KIND_UNKNOWN", f"The value type of '{label}' is not declared; the widget expects "
                             f"{' or '.join(kinds)} values.", widget_id=wid, binding_id=bid))
        elif kind not in kinds:
            out.append(issue("error", "VALUE_KIND_MISMATCH", f"'{label}' has {kind} values; widget type {widget['type']} needs "
                             f"{' or '.join(kinds)} values.", widget_id=wid, binding_id=bid))
    caps = resolved.get("capabilities") or {}
    if needs_history(widget):
        if not caps.get("historical"):
            out.append(issue("error", "HISTORY_UNAVAILABLE", f"'{label}' has no history; this widget reads the Historian. "
                             + " ".join(caps.get("notes") or []), widget_id=wid, binding_id=bid))
        elif caps.get("fidelity") in ("model_snapshots", "postgres_fallback"):
            out.append(issue("warning", "HISTORY_LIMITED", " ".join(caps.get("notes") or []) or f"Limited history for '{label}'.",
                             widget_id=wid, binding_id=bid))
        if (widget.get("options") or {}).get("history_mode") == "recorded" and "recorded" not in (caps.get("history_modes") or []):
            out.append(issue("error", "HISTORY_MODE_UNAVAILABLE", f"'{label}' is not recorded; use history mode 'operational'.",
                             widget_id=wid, binding_id=bid))
    return out


async def reference_issues(session: AsyncSession, tenant_id: UUID, document: dict[str, Any],
                           resources: dict[str, dict[str, Any]], dashboard_id: UUID | None = None) -> list[dict[str, Any]]:
    """Variables defaults, resource refs and dashboard refs of a normalized document."""
    out: list[dict[str, Any]] = []
    for v in document.get("variables", []):
        default = v.get("default")
        if default is None:
            continue
        res = resources.get(default)
        if res is None:
            out.append(issue("error", "VARIABLE_DEFAULT_NOT_FOUND", f"The default resource of variable '{v['id']}' does not exist.",
                             path=f"variables.{v['id']}.default"))
        elif res["archived"]:
            out.append(issue("warning", "ARCHIVED", f"The default resource of variable '{v['id']}' is archived.",
                             path=f"variables.{v['id']}.default"))
        elif v.get("resource_type") and res["type_key"] != v["resource_type"]:
            out.append(issue("error", "VARIABLE_TYPE_MISMATCH", f"The default resource of variable '{v['id']}' is a {res['type_key']}, "
                             f"not a {v['resource_type']}.", path=f"variables.{v['id']}.default"))
    dashboard_refs: dict[str, list[str]] = {}
    for w in document.get("widgets", []):
        wt = R.WIDGET_TYPES[w["type"]]
        for spec in wt.all_options:
            value = w["options"].get(spec.key)
            if value is None:
                continue
            if spec.type == "resource_ref":
                res = resources.get(value)
                if res is None:
                    out.append(issue("error", "RESOURCE_NOT_FOUND", f"{spec.label}: the resource does not exist.", widget_id=w["id"],
                                     path=f"widgets.{w['id']}.options.{spec.key}"))
                elif res["archived"]:
                    out.append(issue("warning", "ARCHIVED", f"{spec.label}: the resource is archived.", widget_id=w["id"],
                                     path=f"widgets.{w['id']}.options.{spec.key}"))
            elif spec.type == "dashboard_ref":
                dashboard_refs.setdefault(value, []).append(w["id"])
    targets = {k: v for k, v in dashboard_refs.items() if dashboard_id is None or k != str(dashboard_id)}
    states = await store.dashboard_states(session, tenant_id, [UUID(k) for k in targets]) if targets else {}
    for target, widget_ids in targets.items():
        for wid in widget_ids:
            if target not in states:
                out.append(issue("error", "LINK_TARGET_NOT_FOUND", "The linked dashboard does not exist.", widget_id=wid))
            elif states[target]:
                out.append(issue("warning", "ARCHIVED", "The linked dashboard is archived.", widget_id=wid))
    return out


async def binding_issues(session: AsyncSession, tenant_id: UUID, document: dict[str, Any],
                         resources: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve every binding (variables at their defaults) and check it fits its widget."""
    out: list[dict[str, Any]] = []
    defaults = {v["id"]: v.get("default") for v in document.get("variables", [])}
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for w in document.get("widgets", []):
        for b in w["bindings"]:
            src = b["source"]
            if src["kind"] == "role":
                continue  # reported as UNBOUND by completeness_issues
            if src["kind"] == "signal_key" and defaults.get(src["variable"]) is None:
                out.append(issue("warning", "VARIABLE_UNSET", f"Signal key '{src['key']}' is resolved when a resource is selected "
                                 f"in variable '{src['variable']}' (no default).", widget_id=w["id"], binding_id=b["id"]))
                continue
            pairs.append((w, b))
    if not pairs:
        return out
    results = await S.resolve_sources(session, tenant_id, defaults, [b["source"] for _w, b in pairs], resources=resources)
    for (w, b), res in zip(pairs, results, strict=True):
        if not res["ok"]:
            err = res["error"]
            out.append(issue("error", err["code"], err["message"], widget_id=w["id"], binding_id=b["id"]))
        else:
            out.extend(fit_issues(w, b, res))
    return out


async def validate_document(session: AsyncSession, tenant_id: UUID, raw: Any, *, dashboard_id: UUID | None = None
                            ) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """``(normalized document or None, issues)``: structural, completeness, references and bindings."""
    document, issues = validate_structure(raw)
    if document is None:
        return None, issues
    issues = issues + completeness_issues(document)
    resources = await S.load_resources(session, tenant_id)
    issues += await reference_issues(session, tenant_id, document, resources, dashboard_id)
    issues += await binding_issues(session, tenant_id, document, resources)
    return document, issues


def ok(issues: list[dict[str, Any]]) -> bool:
    return not has_errors(issues)
