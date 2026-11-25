"""Historian saved views (plan §8.3 "Saved Views / Queries"), backed by ``saved_queries``.

A view stores the *query* of the Historian (series tokens, relative or absolute range, mode,
resolution, compare offset) plus chart options — never SQL. Rules:

* ``visibility`` PRIVATE (owner only) or TEAM (whole tenant). Only the owner may change or delete a
  private view; a TEAM view may be changed by any admin of the tenant.
* Optimistic concurrency: ``PATCH`` must name the version it edits (``If-Match`` or ``version``);
  a stale version is answered with 409 ``VERSION_CONFLICT`` and the current version.
* Relative ranges stay relative (``range: "24h"``), absolute ones stay absolute (``start``/``end``).
* Series tokens are validated syntactically (signal uuid, ``mod:<uuid>:<path>``, ``subtable:<db>.<t>``);
  a view whose series no longer exists is still returned, and the Historian answers NOT_FOUND per
  series, so the UI can show a broken reference instead of silently remapping by name.
"""

from __future__ import annotations

from collections.abc import Mapping
import json
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import historian_sources as HSRC
from factorix.modules.common import execute, execute_rowcount, fetch_all, fetch_one, iso_ms, utcnow
from factorix.platform.errors import AppError

MAX_NAME = 120
MAX_DESCRIPTION = 1000
MAX_SERIES = 20
VISIBILITIES = ("PRIVATE", "TEAM")
_QUERY_KEYS = ("sources", "range", "start", "end", "mode", "resolution", "max_points", "bucket_ms",
               "compare_offset", "quality_filter")
#: Presentation keys of the Historian UI (WS-D, D4) kept verbatim: spec version, labels per token,
#: layout, hidden series, active tab, live follow.
_UI_KEYS = ("v", "labels", "layout", "hidden", "tab", "live")
MAX_SPEC_BYTES = 32_768


def _json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


def normalize_query_spec(raw: Any) -> dict[str, Any]:
    """Keep only Historian query keys; legacy ``signal_ids`` become ``sources``; no SQL is stored."""
    spec = dict(raw) if isinstance(raw, Mapping) else {}
    sources = spec.get("sources") or spec.get("signal_ids") or spec.get("signals") or []
    if isinstance(sources, str):
        sources = [s for s in sources.split(",") if s.strip()]
    tokens: list[str] = []
    for tok in sources:
        src = HSRC.parse_source_token(tok)
        if src is None:
            raise AppError(422, "INVALID_SOURCE", f"'{tok}' is not a Historian series reference.")
        if src.key not in tokens:
            tokens.append(src.key)
    if len(tokens) > MAX_SERIES:
        raise AppError(422, "TOO_MANY_SERIES", f"A view holds at most {MAX_SERIES} series.")
    out = {k: spec[k] for k in _QUERY_KEYS if k in spec and spec[k] is not None}
    out["sources"] = tokens
    for k in _UI_KEYS:
        if k in spec and spec[k] is not None:
            out[k] = spec[k]
    if isinstance(out.get("labels"), dict):
        out["labels"] = {str(t): str(v)[:200] for t, v in out["labels"].items() if str(t) in tokens or HSRC.parse_source_token(t)}
    elif "labels" in out:
        raise AppError(422, "INVALID_LABELS", "labels must be an object {token: label}.")
    if "hidden" in out and not isinstance(out["hidden"], list):
        raise AppError(422, "INVALID_HIDDEN", "hidden must be a list of tokens.")
    if len(json.dumps(out)) > MAX_SPEC_BYTES:
        raise AppError(422, "VIEW_TOO_LARGE", f"A saved view is limited to {MAX_SPEC_BYTES // 1024} KB.")
    if out.get("mode") not in (None, "operational", "recorded", "reconstructed"):
        raise AppError(422, "INVALID_MODE", "mode must be operational, recorded or reconstructed.")
    return out


def _row(r: Mapping[str, Any]) -> dict[str, Any]:
    spec = _json(r.get("query_spec_json"))
    return {
        "id": str(r["id"]),
        "name": str(r["name"]),
        "description": str(r.get("description") or ""),
        "visibility": str(r.get("visibility") or "PRIVATE"),
        "owner_id": str(r["owner_id"]) if r.get("owner_id") else None,
        "query_spec": spec,
        "query_spec_json": spec,
        "chart_options": _json(r.get("chart_options_json")),
        "chart_options_json": _json(r.get("chart_options_json")),
        "is_default": bool(r.get("is_default")),
        "version": int(r.get("version") or 1),
        "created_at": iso_ms(r["created_at"]) if r.get("created_at") else None,
        "updated_at": iso_ms(r["updated_at"]) if r.get("updated_at") else None,
    }


_SELECT = """
    SELECT id, name, description, visibility, owner_id, query_spec_json, chart_options_json,
           is_default, version, created_at, updated_at
    FROM saved_queries
"""


async def list_views(session: AsyncSession, tenant_id: UUID, actor_id: UUID | None = None, *,
                     q: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"tenant_id": tenant_id, "actor": actor_id, "lim": min(max(int(limit), 1), 500),
                              "q": f"%{q.strip()}%" if q and q.strip() else None}
    rows = await fetch_all(
        session,
        _SELECT + """
        WHERE tenant_id = :tenant_id
          AND (visibility = 'TEAM' OR owner_id IS NULL OR CAST(:actor AS uuid) IS NULL OR owner_id = CAST(:actor AS uuid))
          AND (CAST(:q AS text) IS NULL OR name ILIKE :q OR description ILIKE :q)
        ORDER BY is_default DESC, updated_at DESC
        LIMIT :lim
        """,
        params,
    )
    return [_row(r) for r in rows]


async def get_view(session: AsyncSession, tenant_id: UUID, view_id: UUID, actor_id: UUID | None = None) -> dict[str, Any]:
    row = await fetch_one(session, _SELECT + " WHERE tenant_id = :tenant_id AND id = :id", {"tenant_id": tenant_id, "id": view_id})
    if not row or (str(row.get("visibility") or "PRIVATE") == "PRIVATE" and actor_id is not None
                   and row.get("owner_id") and str(row["owner_id"]) != str(actor_id)):
        raise AppError(404, "NOT_FOUND", f"Saved view {view_id} not found.")
    return _row(row)


def _validated(payload: Mapping[str, Any], *, partial: bool) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "name" in payload or not partial:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise AppError(422, "MISSING_NAME", "View name is required.")
        if len(name) > MAX_NAME:
            raise AppError(422, "NAME_TOO_LONG", f"View names are limited to {MAX_NAME} characters.")
        out["name"] = name
    if "description" in payload or not partial:
        desc = str(payload.get("description") or "")
        if len(desc) > MAX_DESCRIPTION:
            raise AppError(422, "DESCRIPTION_TOO_LONG", f"Descriptions are limited to {MAX_DESCRIPTION} characters.")
        out["description"] = desc
    if "visibility" in payload or not partial:
        vis = str(payload.get("visibility") or "PRIVATE").upper()
        if vis not in VISIBILITIES:
            raise AppError(422, "INVALID_VISIBILITY", "visibility must be PRIVATE or TEAM.")
        out["visibility"] = vis
    if any(k in payload for k in ("query_spec", "query_spec_json")) or not partial:
        out["query_spec"] = normalize_query_spec(payload.get("query_spec") or payload.get("query_spec_json") or {})
    if any(k in payload for k in ("chart_options", "chart_options_json")) or not partial:
        opts = payload.get("chart_options") or payload.get("chart_options_json") or {}
        out["chart_options"] = dict(opts) if isinstance(opts, Mapping) else {}
    if "is_default" in payload or not partial:
        out["is_default"] = bool(payload.get("is_default"))
    return out


async def create_view(session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, payload: Mapping[str, Any]) -> dict[str, Any]:
    v = _validated(payload, partial=False)
    now = utcnow()
    view_id = uuid4()
    if v["is_default"]:
        await execute(session, "UPDATE saved_queries SET is_default = FALSE WHERE tenant_id = :tenant_id", {"tenant_id": tenant_id})
    await execute(
        session,
        """
        INSERT INTO saved_queries (
            id, tenant_id, name, description, selected_signals_json, aggregation_json, visibility, owner_id,
            query_spec_json, chart_options_json, is_default, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :name, :description, CAST(:sel AS jsonb), CAST(:agg AS jsonb), :visibility, :owner,
            CAST(:query_spec_json AS jsonb), CAST(:chart_options_json AS jsonb), :is_default, 1, :now, :now
        )
        """,
        {"id": view_id, "tenant_id": tenant_id, "name": v["name"], "description": v["description"],
         "sel": json.dumps(v["query_spec"]["sources"]),
         "agg": json.dumps({"resolution": v["query_spec"].get("resolution"), "bucket_ms": v["query_spec"].get("bucket_ms")}),
         "visibility": v["visibility"], "owner": actor_id, "query_spec_json": json.dumps(v["query_spec"]),
         "chart_options_json": json.dumps(v["chart_options"]), "is_default": v["is_default"], "now": now},
    )
    return {"id": str(view_id), "name": v["name"], "description": v["description"], "visibility": v["visibility"],
            "owner_id": str(actor_id) if actor_id else None, "query_spec": v["query_spec"],
            "chart_options": v["chart_options"], "is_default": v["is_default"], "version": 1,
            "created_at": iso_ms(now), "updated_at": iso_ms(now)}


async def update_view(session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, view_id: UUID,
                      payload: Mapping[str, Any], *, if_match: str | None = None) -> dict[str, Any]:
    current = await get_view(session, tenant_id, view_id, actor_id)
    expected = if_match.strip('"W/ ') if if_match else payload.get("version")
    if expected is None:
        raise AppError(428, "VERSION_REQUIRED", "Send the version you edit (If-Match header or 'version').")
    if int(expected) != current["version"]:
        raise AppError(409, "VERSION_CONFLICT", "The view was changed elsewhere; reload it.",
                       extra={"current": current})
    v = _validated(payload, partial=True)
    merged = {**current, **v}
    if v.get("is_default"):
        await execute(session, "UPDATE saved_queries SET is_default = FALSE WHERE tenant_id = :tenant_id AND id <> :id",
                      {"tenant_id": tenant_id, "id": view_id})
    n = await execute_rowcount(
        session,
        """
        UPDATE saved_queries
        SET name = :name, description = :description, visibility = :visibility,
            query_spec_json = CAST(:query_spec_json AS jsonb), chart_options_json = CAST(:chart_options_json AS jsonb),
            is_default = :is_default, version = version + 1, updated_at = :now
        WHERE tenant_id = :tenant_id AND id = :id AND version = :version
        """,
        {"tenant_id": tenant_id, "id": view_id, "version": current["version"], "name": merged["name"],
         "description": merged["description"], "visibility": merged["visibility"],
         "query_spec_json": json.dumps(merged["query_spec"]), "chart_options_json": json.dumps(merged["chart_options"]),
         "is_default": merged["is_default"], "now": utcnow()},
    )
    if not n:
        raise AppError(409, "VERSION_CONFLICT", "The view was changed elsewhere; reload it.")
    return await get_view(session, tenant_id, view_id, actor_id)


async def duplicate_view(session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, view_id: UUID,
                         name: str | None = None) -> dict[str, Any]:
    src = await get_view(session, tenant_id, view_id, actor_id)
    return await create_view(session, tenant_id, actor_id, {
        "name": (name or f"{src['name']} (copy)")[:MAX_NAME], "description": src["description"],
        "visibility": "PRIVATE", "query_spec": src["query_spec"], "chart_options": src["chart_options"],
    })


async def delete_view(session: AsyncSession, tenant_id: UUID, actor_id: UUID | None, view_id: UUID) -> None:
    await get_view(session, tenant_id, view_id, actor_id)  # 404 for someone else's private view
    if not await execute_rowcount(session, "DELETE FROM saved_queries WHERE tenant_id = :tenant_id AND id = :id",
                                  {"tenant_id": tenant_id, "id": view_id}):
        raise AppError(404, "NOT_FOUND", f"Saved view {view_id} not found.")
