"""Dashboard Studio application service: CRUD, validate, publish, revisions, restore, duplicate, archive,
import/export and templates (contract ``dashboard.md`` §5).

Rules:

* tenant and actor always come from the principal (the router passes them; bodies never carry them);
* every mutation is optimistic: the caller sends the ``version`` it read; a mismatch is 409
  ``RESOURCE_VERSION_CONFLICT`` and nothing changes (the UPDATE is also guarded in SQL);
* drafts are stored *normalized* (schema v1, defaults filled); a legacy draft is upgraded on read;
* published revisions are immutable: publish appends a revision (and still writes ``breakpoints_json`` /
  ``widget_configs_json`` for older readers), restore copies a revision into the draft;
* create/update/publish/restore/archive/unarchive/duplicate/import and template changes are audited.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.application.dashboards import registry as R
from factorix.application.dashboards import sources as S
from factorix.application.dashboards import store
from factorix.application.dashboards import templates as T
from factorix.application.dashboards import validation as V
from factorix.application.dashboards.documents import (
    default_document,
    has_errors,
    issue,
    upgrade_document,
    validate_structure,
)
from factorix.application.dashboards.requests import (
    DashboardIn,
    DashboardPatch,
    DuplicateIn,
    ImportIn,
    PublishIn,
    ResolveIn,
    RestoreIn,
    TemplateIn,
    ValidateIn,
    VersionIn,
)
from factorix.modules.common import audit, iso_ms, utcnow
from factorix.platform.errors import AppError

EXPORT_FORMAT = "factorix.dashboard"
EXPORT_FORMAT_VERSION = 1


# ---------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------


def _json(raw: Any) -> Any:
    if isinstance(raw, (str, bytes)):
        try:
            return json.loads(raw)
        except ValueError:
            return None
    return raw


def _str(value: Any) -> str | None:
    return None if value is None else str(value)


def _uuid(value: str | None, *, code: str = "INVALID_ID", what: str = "identifier") -> UUID:
    canonical = R.canonical_uuid(value)
    if canonical is None:
        raise AppError(422, code, f"Invalid {what}.")
    return UUID(canonical)


def _invalid(issues: list[dict[str, Any]], *, code: str = "VALIDATION",
             message: str = "The dashboard document is not valid.") -> AppError:
    return AppError(422, code, message, extra={"details": {"issues": issues}})


def _conflict(current: dict[str, Any]) -> AppError:
    return AppError(409, "RESOURCE_VERSION_CONFLICT", "This dashboard was modified elsewhere. Reload it and try again.",
                    extra={"current_version": int(current["version"])})


async def _load(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    row = await store.get_dashboard(session, tenant_id, dashboard_id)
    if row is None:
        raise AppError(404, "NOT_FOUND", "Dashboard not found.")
    return row


def _check_writable(row: dict[str, Any], version: int, *, allow_archived: bool = False) -> None:
    if int(row["version"]) != int(version):
        raise _conflict(row)
    if row.get("archived_at") is not None and not allow_archived:
        raise AppError(409, "ARCHIVED", "The dashboard is archived; unarchive it first.")


def draft_document(row: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The draft as a v1 document (legacy drafts upgraded), plus upgrade/repair notes."""
    raw = _json(row.get("draft_json"))
    if not isinstance(raw, dict) or not raw:
        return default_document(), []
    doc, issues = validate_structure(raw)
    notes = [i["message"] for i in issues if i["code"] == "LEGACY_UPGRADED"]
    if doc is None:
        upgraded, _notes = upgrade_document(raw)
        notes += [i["message"] for i in issues if i["severity"] == "error"]
        return (upgraded if isinstance(upgraded, dict) else default_document()), notes
    return doc, notes


def revision_document(rev: dict[str, Any]) -> dict[str, Any]:
    """The document of a revision; revisions published before schema v1 are rebuilt from ``widget_configs_json``."""
    stored = _json(rev.get("document_json"))
    if isinstance(stored, dict) and stored:
        return stored
    widgets = _json(rev.get("widget_configs_json"))
    legacy = {"widgets": widgets if isinstance(widgets, list) else []}
    doc, _issues = validate_structure(legacy)
    if doc is not None:
        return doc
    upgraded, _notes = upgrade_document(legacy)
    return upgraded


def _status(row: dict[str, Any]) -> str:
    return "PUBLISHED" if row.get("published_revision") is not None else "DRAFT"


def detail(row: dict[str, Any]) -> dict[str, Any]:
    document, notes = draft_document(row)
    published = _json(row.get("published_document_json"))
    stored = _json(row.get("draft_json"))
    unpublished = row.get("published_revision") is None or not isinstance(published, dict) or stored != published
    return {
        "id": str(row["id"]), "name": row["name"], "description": row.get("description") or "", "status": _status(row),
        "version": int(row["version"]), "draft_revision": int(row.get("draft_revision") or 1),
        "published_revision": row.get("published_revision"), "published_at": iso_ms(row.get("published_at")),
        "archived_at": iso_ms(row.get("archived_at")), "has_unpublished_changes": bool(unpublished),
        "site_id": _str(row.get("site_id")), "created_at": iso_ms(row.get("created_at")), "updated_at": iso_ms(row.get("updated_at")),
        "document": document, "upgrade_notes": notes,
    }


async def _detail(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    return detail(await _load(session, tenant_id, dashboard_id))


async def _audit(session: AsyncSession, tenant_id: UUID, actor: UUID, event: str, entity_id: UUID, correlation_id: str, *,
                 before: Any = None, after: Any = None, entity_type: str = "dashboard") -> None:
    await audit(session, tenant_id=tenant_id, event_type=event, actor_id=actor, entity_type=entity_type, entity_id=entity_id,
                before=before, after=after, correlation_id=correlation_id)


def _publish_warnings(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for i in issues if i["code"] != "EMPTY_DASHBOARD"]


# ---------------------------------------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------------------------------------


async def list_dashboards(session: AsyncSession, tenant_id: UUID, *, include_archived: bool = False, q: str | None = None) -> dict[str, Any]:
    rows = await store.list_dashboards(session, tenant_id, include_archived=include_archived, q=(q or "")[:160] or None)
    return {"items": [{
        "id": str(r["id"]), "name": r["name"], "description": r.get("description") or "", "status": _status(r),
        "draft_revision": int(r.get("draft_revision") or 1), "published_revision": r.get("published_revision"),
        "published_at": iso_ms(r.get("published_at")), "has_unpublished_changes": bool(r.get("has_unpublished_changes")),
        "widget_count": int(r.get("widget_count") or 0), "theme_preset": r.get("theme_preset") or "factorix_light",
        "version": int(r["version"]), "created_at": iso_ms(r.get("created_at")), "updated_at": iso_ms(r.get("updated_at")),
        "archived_at": iso_ms(r.get("archived_at")),
    } for r in rows]}


async def get_dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    return await _detail(session, tenant_id, dashboard_id)


async def get_published(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    row = await _load(session, tenant_id, dashboard_id)
    if row.get("published_revision") is None:
        raise AppError(404, "NOT_PUBLISHED", "This dashboard has not been published yet.")
    rev = await store.get_revision(session, dashboard_id, int(row["published_revision"]))
    if rev is None:
        raise AppError(404, "NOT_PUBLISHED", "The published revision is missing.")
    return {"id": str(row["id"]), "name": row["name"], "description": row.get("description") or "",
            "revision": int(rev["revision"]), "published_at": iso_ms(rev.get("published_at")),
            "archived_at": iso_ms(row.get("archived_at")), "document": revision_document(rev)}


async def list_revisions(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    await _load(session, tenant_id, dashboard_id)
    rows = await store.list_revisions(session, dashboard_id)
    return {"items": [{
        "revision": int(r["revision"]), "published_at": iso_ms(r.get("published_at") or r.get("created_at")),
        "published_by": _str(r.get("published_by")), "published_by_name": r.get("published_by_name"),
        "note": r.get("note") or "", "widget_count": int(r.get("widget_count") or 0),
    } for r in rows]}


async def get_revision(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID, revision: int) -> dict[str, Any]:
    await _load(session, tenant_id, dashboard_id)
    rev = await store.get_revision(session, dashboard_id, revision)
    if rev is None:
        raise AppError(404, "REVISION_NOT_FOUND", f"Revision {revision} does not exist.")
    return {"revision": int(rev["revision"]), "published_at": iso_ms(rev.get("published_at") or rev.get("created_at")),
            "published_by": _str(rev.get("published_by")), "published_by_name": rev.get("published_by_name"),
            "note": rev.get("note") or "", "document": revision_document(rev)}


async def export_dashboard(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any]:
    row = await _load(session, tenant_id, dashboard_id)
    document, _notes = draft_document(row)
    return {"format": EXPORT_FORMAT, "format_version": EXPORT_FORMAT_VERSION, "exported_at": iso_ms(utcnow()),
            "name": row["name"], "description": row.get("description") or "", "document": document}


async def validate(session: AsyncSession, tenant_id: UUID, dashboard_id: UUID, body: ValidateIn) -> dict[str, Any]:
    row = await _load(session, tenant_id, dashboard_id)
    raw = body.document if body.document is not None else (_json(row.get("draft_json")) or default_document())
    _doc, issues = await V.validate_document(session, tenant_id, raw, dashboard_id=dashboard_id)
    return {"ok": V.ok(issues), "issues": issues}


# ---------------------------------------------------------------------------------------------------------
# Create / update
# ---------------------------------------------------------------------------------------------------------


async def _template_source(session: AsyncSession, tenant_id: UUID, template_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    builtin = T.BUILTIN_BY_ID.get(template_id)
    if builtin is not None:
        return builtin["document"], builtin["roles"]
    canonical = R.canonical_uuid(template_id)
    row = await store.get_template(session, tenant_id, UUID(canonical)) if canonical else None
    if row is None:
        raise AppError(404, "TEMPLATE_NOT_FOUND", "Template not found.")
    document = _json(row.get("document_json")) or default_document()
    roles = _json(row.get("roles_json")) or []
    return document, roles


async def _insert(session: AsyncSession, tenant_id: UUID, actor: UUID, *, name: str, description: str, document: dict[str, Any],
                  site_id: UUID | None = None) -> UUID:
    dashboard_id = uuid4()
    await store.insert_dashboard(session, dashboard_id=dashboard_id, tenant_id=tenant_id, site_id=site_id, name=name,
                                 description=description, owner=actor, document=document, now=utcnow())
    return dashboard_id


def _name(value: str) -> str:
    name = value.strip()
    if not name:
        raise AppError(422, "VALIDATION", "The name must not be empty.", extra={"details": {"issues": [
            issue("error", "REQUIRED", "The name must not be empty.", path="name")]}})
    return name


async def create_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, body: DashboardIn, correlation_id: str) -> dict[str, Any]:
    name = _name(body.name)
    if body.template_id and body.source_dashboard_id:
        raise _invalid([issue("error", "INVALID_VALUE", "Use either template_id or source_dashboard_id, not both.")],
                       message="Use either template_id or source_dashboard_id, not both.")
    if body.role_map and not body.template_id:
        raise _invalid([issue("error", "INVALID_VALUE", "role_map needs a template_id.", path="role_map")],
                       message="role_map needs a template_id.")
    raw: dict[str, Any] = default_document()
    if body.template_id:
        template_doc, roles = await _template_source(session, tenant_id, body.template_id)
        try:
            raw = T.instantiate(template_doc, roles, body.role_map)
        except T.RoleMapError as exc:
            raise _invalid(exc.issues, message="The role map is not valid for this template.") from None
    elif body.source_dashboard_id:
        source = await _load(session, tenant_id, _uuid(body.source_dashboard_id))
        raw, _notes = draft_document(source)
    document, issues = validate_structure(raw)
    if document is None:
        raise _invalid(issues)
    site_id = _uuid(body.site_id, what="site id") if body.site_id else None
    dashboard_id = await _insert(session, tenant_id, actor, name=name, description=body.description, document=document, site_id=site_id)
    await _audit(session, tenant_id, actor, "DASHBOARD_CREATE", dashboard_id, correlation_id, after={
        "name": name, "template_id": body.template_id, "source_dashboard_id": body.source_dashboard_id,
        "widget_count": len(document["widgets"]),
    })
    out = await _detail(session, tenant_id, dashboard_id)
    warnings: list[dict[str, Any]] = []
    if body.template_id or body.source_dashboard_id:
        _doc, full = await V.validate_document(session, tenant_id, document, dashboard_id=dashboard_id)
        warnings = _publish_warnings(full)
    out["warnings"] = warnings
    return out


async def patch_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: DashboardPatch,
                          correlation_id: str) -> dict[str, Any]:
    current = await _load(session, tenant_id, dashboard_id)
    _check_writable(current, body.version)
    fields: dict[str, Any] = {}
    if body.name is not None:
        fields["name"] = _name(body.name)
    if body.description is not None:
        fields["description"] = body.description
    widget_count = None
    if body.document is not None:
        document, issues = validate_structure(body.document)
        if document is None:
            raise _invalid(issues)
        fields["draft_json"] = document
        widget_count = len(document["widgets"])
    if not await store.update_dashboard(session, tenant_id, dashboard_id, expected_version=body.version, actor=actor, now=utcnow(),
                                        bump_draft="draft_json" in fields, **fields):
        raise _conflict(current)
    await _audit(session, tenant_id, actor, "DASHBOARD_UPDATE", dashboard_id, correlation_id,
                 before={"version": int(current["version"]), "name": current["name"]},
                 after={"version": int(current["version"]) + 1, "name": fields.get("name", current["name"]),
                        "document_changed": "draft_json" in fields, "widget_count": widget_count})
    return await _detail(session, tenant_id, dashboard_id)


# ---------------------------------------------------------------------------------------------------------
# Publish / restore / duplicate / archive
# ---------------------------------------------------------------------------------------------------------


async def publish_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: PublishIn,
                            correlation_id: str) -> dict[str, Any]:
    current = await _load(session, tenant_id, dashboard_id)
    _check_writable(current, body.version)
    raw = _json(current.get("draft_json")) or default_document()
    document, issues = await V.validate_document(session, tenant_id, raw, dashboard_id=dashboard_id)
    if document is None or has_errors(issues):
        raise _invalid(issues, code="PUBLISH_BLOCKED", message="The dashboard cannot be published until the errors are fixed.")
    revision = await store.next_revision(session, dashboard_id)
    now = utcnow()
    if not await store.update_dashboard(session, tenant_id, dashboard_id, expected_version=body.version, actor=actor, now=now,
                                        draft_json=document, published_revision=revision, published_at=now):
        raise _conflict(current)
    await store.insert_revision(session, revision_id=uuid4(), dashboard_id=dashboard_id, revision=revision, document=document,
                                actor=actor, note=body.note.strip(), now=now)
    await _audit(session, tenant_id, actor, "DASHBOARD_PUBLISH", dashboard_id, correlation_id,
                 before={"published_revision": current.get("published_revision")},
                 after={"revision": revision, "note": body.note.strip(), "widget_count": len(document["widgets"])})
    return await _detail(session, tenant_id, dashboard_id)


async def restore_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: RestoreIn,
                            correlation_id: str) -> dict[str, Any]:
    current = await _load(session, tenant_id, dashboard_id)
    _check_writable(current, body.version)
    rev = await store.get_revision(session, dashboard_id, body.revision)
    if rev is None:
        raise AppError(404, "REVISION_NOT_FOUND", f"Revision {body.revision} does not exist.")
    document, issues = validate_structure(revision_document(rev))
    if document is None:
        raise _invalid(issues, message="This revision can no longer be restored: its document is not valid in this version.")
    if not await store.update_dashboard(session, tenant_id, dashboard_id, expected_version=body.version, actor=actor, now=utcnow(),
                                        bump_draft=True, draft_json=document):
        raise _conflict(current)
    await _audit(session, tenant_id, actor, "DASHBOARD_RESTORE", dashboard_id, correlation_id,
                 before={"version": int(current["version"])}, after={"restored_revision": body.revision})
    return await _detail(session, tenant_id, dashboard_id)


async def duplicate_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: DuplicateIn,
                              correlation_id: str) -> dict[str, Any]:
    source = await _load(session, tenant_id, dashboard_id)
    raw, _notes = draft_document(source)
    document, issues = validate_structure(raw)
    if document is None:
        raise _invalid(issues)
    new_id = await _insert(session, tenant_id, actor, name=_name(body.name), description=source.get("description") or "",
                           document=document, site_id=source.get("site_id"))
    await _audit(session, tenant_id, actor, "DASHBOARD_DUPLICATE", new_id, correlation_id,
                 after={"source_dashboard_id": str(dashboard_id), "name": body.name.strip()})
    return await _detail(session, tenant_id, new_id)


async def set_archived(session: AsyncSession, tenant_id: UUID, actor: UUID, dashboard_id: UUID, body: VersionIn, correlation_id: str,
                       *, archived: bool) -> dict[str, Any]:
    current = await _load(session, tenant_id, dashboard_id)
    _check_writable(current, body.version, allow_archived=True)
    if archived and current.get("archived_at") is not None:
        raise AppError(409, "ARCHIVED", "The dashboard is already archived.")
    if not archived and current.get("archived_at") is None:
        raise AppError(409, "NOT_ARCHIVED", "The dashboard is not archived.")
    now = utcnow()
    if not await store.update_dashboard(session, tenant_id, dashboard_id, expected_version=body.version, actor=actor, now=now,
                                        archived_at=now if archived else None):
        raise _conflict(current)
    await _audit(session, tenant_id, actor, "DASHBOARD_ARCHIVE" if archived else "DASHBOARD_UNARCHIVE", dashboard_id, correlation_id,
                 before={"archived": not archived}, after={"archived": archived})
    return await _detail(session, tenant_id, dashboard_id)


# ---------------------------------------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------------------------------------


async def import_dashboard(session: AsyncSession, tenant_id: UUID, actor: UUID, body: ImportIn, correlation_id: str) -> dict[str, Any]:
    payload = body.payload
    if payload.get("format") != EXPORT_FORMAT:
        raise AppError(422, "IMPORT_FORMAT", f"The file is not a FactoriX dashboard export (format must be '{EXPORT_FORMAT}').")
    if payload.get("format_version") != EXPORT_FORMAT_VERSION:
        raise AppError(422, "IMPORT_FORMAT", f"Unsupported export format_version {payload.get('format_version')!r} "
                       f"(supported: {EXPORT_FORMAT_VERSION}).")
    extra = sorted(set(payload) - {"format", "format_version", "exported_at", "name", "description", "document"})
    if extra:
        raise _invalid([issue("error", "UNKNOWN_KEY", f"Unknown export key '{k}'.", path=f"payload.{k}") for k in extra],
                       message="The export file has unknown keys.")
    if not isinstance(payload.get("document"), dict):
        raise _invalid([issue("error", "REQUIRED", "The export has no document.", path="payload.document")])
    name = body.name or payload.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "Imported dashboard"
    description = payload.get("description") if isinstance(payload.get("description"), str) else ""
    document, issues = validate_structure(payload["document"])
    if document is None:
        raise _invalid(issues, message="The imported dashboard document is not valid.")
    dashboard_id = await _insert(session, tenant_id, actor, name=_name(name[:160]), description=description[:2000], document=document)
    await _audit(session, tenant_id, actor, "DASHBOARD_IMPORT", dashboard_id, correlation_id,
                 after={"name": name.strip()[:160], "widget_count": len(document["widgets"])})
    _doc, full = await V.validate_document(session, tenant_id, document, dashboard_id=dashboard_id)
    out = await _detail(session, tenant_id, dashboard_id)
    out["warnings"] = _publish_warnings(full)
    return out


# ---------------------------------------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------------------------------------


def _tenant_template_item(row: dict[str, Any]) -> dict[str, Any]:
    document = _json(row.get("document_json")) or {}
    roles = _json(row.get("roles_json")) or []
    return T.template_item(template_id=str(row["id"]), label=row["name"], description=row.get("description") or "",
                           category=row.get("category") or "custom", builtin=False, roles=roles, document=document,
                           created_at=iso_ms(row.get("created_at")))


async def list_templates(session: AsyncSession, tenant_id: UUID) -> dict[str, Any]:
    rows = await store.list_templates(session, tenant_id)
    return {"items": T.builtin_items() + [_tenant_template_item(r) for r in rows]}


async def create_template(session: AsyncSession, tenant_id: UUID, actor: UUID, body: TemplateIn, correlation_id: str) -> dict[str, Any]:
    source = await _load(session, tenant_id, _uuid(body.dashboard_id))
    raw, _notes = draft_document(source)
    document, issues = validate_structure(raw)
    if document is None:
        raise _invalid(issues)
    template_doc, roles = T.template_from_document(document)
    checked, issues = validate_structure(template_doc)
    if checked is None:  # pragma: no cover - template_from_document keeps a valid document valid
        raise _invalid(issues)
    template_id = uuid4()
    name = _name(body.name)
    await store.insert_template(session, template_id=template_id, tenant_id=tenant_id, name=name, description=body.description,
                                category=body.category.strip() or "custom", document=checked, roles=roles, actor=actor, now=utcnow())
    await _audit(session, tenant_id, actor, "DASHBOARD_TEMPLATE_CREATE", template_id, correlation_id, entity_type="dashboard_template",
                 after={"name": name, "source_dashboard_id": str(source["id"]), "roles": len(roles)})
    row = await store.get_template(session, tenant_id, template_id)
    assert row is not None
    return _tenant_template_item(row)


async def delete_template(session: AsyncSession, tenant_id: UUID, actor: UUID, template_id: str, correlation_id: str) -> None:
    if template_id in T.BUILTIN_BY_ID:
        raise AppError(409, "TEMPLATE_BUILTIN", "Built-in templates cannot be deleted.")
    canonical = R.canonical_uuid(template_id)
    row = await store.get_template(session, tenant_id, UUID(canonical)) if canonical else None
    if row is None or not await store.delete_template(session, tenant_id, UUID(str(row["id"]))):
        raise AppError(404, "TEMPLATE_NOT_FOUND", "Template not found.")
    await _audit(session, tenant_id, actor, "DASHBOARD_TEMPLATE_DELETE", UUID(str(row["id"])), correlation_id,
                 entity_type="dashboard_template", before={"name": row["name"]})


# ---------------------------------------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------------------------------------


async def list_sources(session: AsyncSession, tenant_id: UUID, *, q: str | None = None) -> dict[str, Any]:
    return await S.catalog(session, tenant_id, q=(q or "")[:160] or None)


async def resolve(session: AsyncSession, tenant_id: UUID, body: ResolveIn) -> dict[str, Any]:
    return {"items": await S.resolve_sources(session, tenant_id, body.variables, body.sources)}
