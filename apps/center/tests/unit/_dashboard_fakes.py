"""In-memory fakes for the Dashboard Studio unit tests (no database in the python-unit CI job).

* :class:`CatalogDB` answers the SQL of ``application.dashboards.sources`` (and ``storage_bindings.bound_model_fields``)
  from Python lists, honouring the tenant filter, so the real loader code runs.
* :class:`DashboardStore` replaces the functions of ``application.dashboards.store`` (same signatures).
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

TENANT = UUID("00000000-0000-0000-0000-0000000000a1")
OTHER_TENANT = UUID("00000000-0000-0000-0000-0000000000a2")
ACTOR = UUID("00000000-0000-0000-0000-0000000000b1")

LINE = "00000000-0000-0000-0000-000000000101"
M1 = "00000000-0000-0000-0000-000000000201"
M2 = "00000000-0000-0000-0000-000000000202"
M_ARCHIVED = "00000000-0000-0000-0000-000000000203"
M_OTHER = "00000000-0000-0000-0000-000000000299"  # other tenant

SIG_SPEED_1 = "00000000-0000-0000-0000-000000000301"  # M1 speed_1 float64
SIG_STATE_1 = "00000000-0000-0000-0000-000000000302"  # M1 state string
SIG_RUN_1 = "00000000-0000-0000-0000-000000000303"  # M1 running bool
SIG_SPEED_2 = "00000000-0000-0000-0000-000000000304"  # M2 speed_1 float64
SIG_OLD = "00000000-0000-0000-0000-000000000305"  # M1 archived
SIG_OTHER = "00000000-0000-0000-0000-000000000399"  # other tenant
SIG_JSON = "00000000-0000-0000-0000-000000000306"  # M1 json

MODEL = "00000000-0000-0000-0000-000000000401"
MODEL_ARCHIVED = "00000000-0000-0000-0000-000000000402"
MODEL_OTHER = "00000000-0000-0000-0000-000000000499"

MODEL_SPEC = {
    "version": 2,
    "root": {"type": "object", "children": [
        {"key": "spindle", "type": "object", "children": [
            {"key": "speed", "type": "field", "mode": "mapping", "ref": {"signal_id": SIG_SPEED_1}, "value_type": "auto"},
            {"key": "load", "type": "field", "mode": "calculated", "expr": "1 + 1", "value_type": "float"},
        ]},
        {"key": "status", "type": "field", "mode": "calculated", "expr": "'RUN'", "value_type": "string"},
        {"key": "a/b", "type": "field", "mode": "calculated", "expr": "1", "value_type": "int"},
    ]},
}


def _now() -> datetime:
    return datetime(2026, 11, 25, 8, 0, tzinfo=timezone.utc)


class CatalogDB:
    def __init__(self) -> None:
        self.resources = [
            {"id": LINE, "tenant_id": TENANT, "parent_id": None, "name": "Line 1", "code": "L1", "type_key": "line", "status": "ACTIVE", "archived_at": None},
            {"id": M1, "tenant_id": TENANT, "parent_id": LINE, "name": "Machine A", "code": "MA", "type_key": "machine", "status": "ACTIVE", "archived_at": None},
            {"id": M2, "tenant_id": TENANT, "parent_id": LINE, "name": "Machine B", "code": "MB", "type_key": "machine", "status": "ACTIVE", "archived_at": None},
            {"id": M_ARCHIVED, "tenant_id": TENANT, "parent_id": LINE, "name": "Old", "code": "OLD", "type_key": "machine", "status": "ARCHIVED", "archived_at": _now()},
            {"id": M_OTHER, "tenant_id": OTHER_TENANT, "parent_id": None, "name": "Foreign", "code": "F", "type_key": "machine", "status": "ACTIVE", "archived_at": None},
        ]
        self.signals = [
            {"id": SIG_SPEED_1, "tenant_id": TENANT, "resource_id": M1, "key": "speed_1", "display_name": "Speed", "data_type": "float64", "unit": "rpm", "status": "ACTIVE"},
            {"id": SIG_STATE_1, "tenant_id": TENANT, "resource_id": M1, "key": "state", "display_name": "State", "data_type": "string", "unit": None, "status": "ACTIVE"},
            {"id": SIG_RUN_1, "tenant_id": TENANT, "resource_id": M1, "key": "running", "display_name": "", "data_type": "bool", "unit": None, "status": "ACTIVE"},
            {"id": SIG_SPEED_2, "tenant_id": TENANT, "resource_id": M2, "key": "speed_1", "display_name": "Speed", "data_type": "float64", "unit": "rpm", "status": "ACTIVE"},
            {"id": SIG_OLD, "tenant_id": TENANT, "resource_id": M1, "key": "old", "display_name": "Old", "data_type": "float64", "unit": None, "status": "ARCHIVED"},
            {"id": SIG_JSON, "tenant_id": TENANT, "resource_id": M1, "key": "payload", "display_name": "Payload", "data_type": "json", "unit": None, "status": "ACTIVE"},
            {"id": SIG_OTHER, "tenant_id": OTHER_TENANT, "resource_id": M_OTHER, "key": "speed_1", "display_name": "Speed", "data_type": "float64", "unit": None, "status": "ACTIVE"},
        ]
        self.models = [
            {"id": MODEL, "tenant_id": TENANT, "display_name": "Spindle", "status": "ACTIVE", "resource_id": None, "spec_json": json.dumps(MODEL_SPEC)},
            {"id": MODEL_ARCHIVED, "tenant_id": TENANT, "display_name": "Gone", "status": "ARCHIVED", "resource_id": M1, "spec_json": MODEL_SPEC},
            {"id": MODEL_OTHER, "tenant_id": OTHER_TENANT, "display_name": "Foreign", "status": "ACTIVE", "resource_id": None, "spec_json": MODEL_SPEC},
        ]
        self.recorded_signals: set[str] = set()
        self.bound_fields: list[tuple[str, str]] = []
        self.statements: list[str] = []

    @staticmethod
    def _ids(values: Any) -> set[str]:
        return {str(v).lower() for v in values}

    async def fetch_all(self, _session: Any, sql: str, p: dict[str, Any]) -> list[dict[str, Any]]:
        self.statements.append(sql)
        tenant = p.get("tenant_id")
        if "FROM resources r JOIN resource_types" in sql:
            return [dict(r) for r in self.resources if r["tenant_id"] == tenant]
        if "FROM signal_definitions" in sql and "resource_id = ANY(:resource_ids)" in sql:
            rids, keys = self._ids(p["resource_ids"]), set(p["keys"])
            return [dict(s) for s in self.signals if s["tenant_id"] == tenant and s["status"] == "ACTIVE"
                    and s["resource_id"] in rids and s["key"] in keys]
        if "FROM signal_definitions" in sql and "id = ANY(:ids)" in sql:
            ids = self._ids(p["ids"])
            return [dict(s) for s in self.signals if s["tenant_id"] == tenant and s["id"] in ids]
        if "FROM output_groups" in sql:
            ids = self._ids(p["ids"])
            return [dict(m) for m in self.models if m["tenant_id"] == tenant and m["id"] in ids]
        if "FROM storage_physical_registry" in sql:
            return [{"signal_id": s} for s in self._ids(p["ids"]) if s in self.recorded_signals and tenant == TENANT]
        if "FROM storage_bindings" in sql:
            return [{"model_id": m, "model_field_path": f, "physical_db": "db", "physical_subtable": "t", "target_column": "c"}
                    for m, f in self.bound_fields if tenant == TENANT]
        raise AssertionError(f"unexpected SQL: {sql[:120]}")


def install_catalog(monkeypatch: Any, db: CatalogDB, *, history: bool = True, snapshots: bool = True, pg_fallback: bool = False) -> None:
    from factorix.application.dashboards import sources as S
    from factorix.modules import storage_bindings as SB

    monkeypatch.setattr(S, "fetch_all", db.fetch_all)
    monkeypatch.setattr(SB, "fetch_all", db.fetch_all)
    monkeypatch.setattr(S, "history_state", lambda: {"history": history, "snapshots": snapshots, "pg_fallback": pg_fallback})


class DashboardStore:
    """Same functions as ``application.dashboards.store`` over dicts."""

    def __init__(self) -> None:
        self.dashboards: dict[str, dict[str, Any]] = {}
        self.revisions: dict[str, list[dict[str, Any]]] = {}
        self.templates: dict[str, dict[str, Any]] = {}
        self.audits: list[dict[str, Any]] = []
        self.clock = _now()

    def tick(self) -> datetime:
        self.clock += timedelta(seconds=1)
        return self.clock

    def _published_doc(self, row: dict[str, Any]) -> Any:
        rev = next((r for r in self.revisions.get(str(row["id"]), []) if r["revision"] == row.get("published_revision")), None)
        return copy.deepcopy(rev["document_json"]) if rev else None

    async def list_dashboards(self, _s: Any, tenant_id: UUID, *, include_archived: bool, q: str | None) -> list[dict[str, Any]]:
        out = []
        for row in self.dashboards.values():
            if row["tenant_id"] != tenant_id or (row["archived_at"] is not None and not include_archived):
                continue
            if q and q.lower() not in (row["name"] + " " + row["description"]).lower():
                continue
            draft = row["draft_json"]
            published = self._published_doc(row)
            out.append({**copy.deepcopy(row), "widget_count": len(draft.get("widgets", [])),
                        "theme_preset": ((draft.get("settings") or {}).get("theme") or {}).get("preset"),
                        "has_unpublished_changes": row["published_revision"] is None or draft != published})
        return sorted(out, key=lambda r: r["name"].lower())

    async def get_dashboard(self, _s: Any, tenant_id: UUID, dashboard_id: UUID) -> dict[str, Any] | None:
        row = self.dashboards.get(str(dashboard_id))
        if row is None or row["tenant_id"] != tenant_id:
            return None
        return {**copy.deepcopy(row), "published_document_json": self._published_doc(row)}

    async def insert_dashboard(self, _s: Any, *, dashboard_id: UUID, tenant_id: UUID, site_id: Any, name: str, description: str,
                               owner: UUID, document: dict[str, Any], now: datetime) -> None:
        self.dashboards[str(dashboard_id)] = {
            "id": dashboard_id, "tenant_id": tenant_id, "site_id": site_id, "name": name, "description": description,
            "owner_admin_id": owner, "draft_revision": 1, "published_revision": None, "published_at": None,
            "draft_json": json.loads(json.dumps(document)), "archived_at": None, "version": 1, "created_at": now,
            "updated_at": now, "updated_by": owner,
        }

    async def update_dashboard(self, _s: Any, tenant_id: UUID, dashboard_id: UUID, *, expected_version: int, actor: UUID,
                               now: datetime, bump_draft: bool = False, **fields: Any) -> bool:
        row = self.dashboards.get(str(dashboard_id))
        if row is None or row["tenant_id"] != tenant_id or row["version"] != expected_version:
            return False
        for key, value in fields.items():
            row[key] = json.loads(json.dumps(value)) if key == "draft_json" else value
        row["version"] += 1
        row["updated_at"], row["updated_by"] = self.tick(), actor
        if bump_draft:
            row["draft_revision"] += 1
        return True

    async def next_revision(self, _s: Any, dashboard_id: UUID) -> int:
        return max((r["revision"] for r in self.revisions.get(str(dashboard_id), [])), default=0) + 1

    async def insert_revision(self, _s: Any, *, revision_id: UUID, dashboard_id: UUID, revision: int, document: dict[str, Any],
                              actor: UUID, note: str, now: datetime) -> None:
        revs = self.revisions.setdefault(str(dashboard_id), [])
        assert all(r["revision"] != revision for r in revs), "revision numbers are unique"
        revs.append({"id": revision_id, "revision": revision, "document_json": json.loads(json.dumps(document)),
                     "widget_configs_json": json.loads(json.dumps(document["widgets"])), "breakpoints_json": {"lg": 12, "md": 6, "sm": 1},
                     "published_by": actor, "published_by_name": "Admin", "note": note, "created_at": now, "published_at": now})

    async def list_revisions(self, _s: Any, dashboard_id: UUID) -> list[dict[str, Any]]:
        revs = sorted(self.revisions.get(str(dashboard_id), []), key=lambda r: -r["revision"])
        return [{**r, "widget_count": len((r.get("document_json") or {}).get("widgets") or r.get("widget_configs_json") or [])} for r in revs]

    async def get_revision(self, _s: Any, dashboard_id: UUID, revision: int) -> dict[str, Any] | None:
        rev = next((r for r in self.revisions.get(str(dashboard_id), []) if r["revision"] == revision), None)
        return copy.deepcopy(rev) if rev else None

    async def dashboard_states(self, _s: Any, tenant_id: UUID, ids: list[UUID]) -> dict[str, bool]:
        wanted = {str(i) for i in ids}
        return {k: v["archived_at"] is not None for k, v in self.dashboards.items() if k in wanted and v["tenant_id"] == tenant_id}

    async def delete_archived_dashboard(self, _s: Any, tenant_id: UUID, dashboard_id: UUID) -> int | None:
        row = self.dashboards.get(str(dashboard_id))
        if row is None or row["tenant_id"] != tenant_id or row["archived_at"] is None:
            return None
        del self.dashboards[str(dashboard_id)]
        return len(self.revisions.pop(str(dashboard_id), []))

    async def list_templates(self, _s: Any, tenant_id: UUID) -> list[dict[str, Any]]:
        return [copy.deepcopy(t) for t in self.templates.values() if t["tenant_id"] == tenant_id]

    async def get_template(self, _s: Any, tenant_id: UUID, template_id: UUID) -> dict[str, Any] | None:
        t = self.templates.get(str(template_id))
        return copy.deepcopy(t) if t and t["tenant_id"] == tenant_id else None

    async def insert_template(self, _s: Any, *, template_id: UUID, tenant_id: UUID, name: str, description: str, category: str,
                              document: dict[str, Any], roles: list[dict[str, Any]], actor: UUID, now: datetime) -> None:
        self.templates[str(template_id)] = {"id": template_id, "tenant_id": tenant_id, "name": name, "description": description,
                                            "category": category, "document_json": json.loads(json.dumps(document)),
                                            "roles_json": copy.deepcopy(roles), "created_by": actor, "created_at": now, "updated_at": now}

    async def delete_template(self, _s: Any, tenant_id: UUID, template_id: UUID) -> bool:
        t = self.templates.get(str(template_id))
        if t is None or t["tenant_id"] != tenant_id:
            return False
        del self.templates[str(template_id)]
        return True

    async def audit(self, _s: Any, **kw: Any) -> None:
        self.audits.append(kw)


def install_store(monkeypatch: Any, store_fake: DashboardStore) -> None:
    from factorix.application.dashboards import service, store

    for name in ("list_dashboards", "get_dashboard", "insert_dashboard", "update_dashboard", "next_revision", "insert_revision",
                 "list_revisions", "get_revision", "dashboard_states", "delete_archived_dashboard", "list_templates", "get_template", "insert_template",
                 "delete_template"):
        monkeypatch.setattr(store, name, getattr(store_fake, name))
    monkeypatch.setattr(service, "audit", store_fake.audit)


def new_id() -> str:
    return str(uuid4())
