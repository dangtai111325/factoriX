"""Unit tests for Storage Designer (S10), Storage Catalog & Lifecycle (S11), and Historian Explorer (S12).

Tests the service layers (`factorix.modules.storage_designs`, `factorix.modules.historian_service`)
and the FastAPI router (`factorix.transport.storage_api`).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.quality import Quality
from factorix.modules import historian_service as HS
from factorix.modules import storage_designs as SD
from factorix.modules.storage_dsl import (
    StorageCatalogSnapshot,
    StorageDesignAst,
    parse_storage_dsl,
    serialize_storage_dsl,
)
from factorix.platform.errors import AppError
from factorix.platform.http import json_error
from factorix.platform.tdengine import TDEngineClient, TDEngineHealth
from factorix.transport.storage_api import build_router

# ==============================================================================
# Constants & Test Fixtures
# ==============================================================================

TENANT_ID = UUID("00000000-0000-0000-0000-000000000001")
ACTOR_ID = UUID("00000000-0000-0000-0000-000000000002")

RES_MACHINE_ID = UUID("00000000-0000-0000-0000-000000000010")
SIG_TEMP_ID = UUID("00000000-0000-0000-0000-000000000101")
SIG_RPM_ID = UUID("00000000-0000-0000-0000-000000000102")
MODEL_CNC_ID = UUID("00000000-0000-0000-0000-000000000201")

SAMPLE_DSL_YAML = """apiVersion: factorix.io/storage/v1
kind: StorageDesign
metadata:
  name: "CNC Precision Spindle Telemetry"
  description: "High-resolution telemetry for CNC spindle"
spec:
  scope:
    mode: subtree
    resource: $machine[AA10-01]
  destination:
    engine: tdengine
    dbStrategy: tenant_isolated
  datasets:
    - key: spindle_metrics
      displayName: Spindle Metrics
      semantics: state_series
      sourceKind: signals
      timeAxis: acquired_at
      tags:
        - key: plant
          value: Factory-1
      fields:
        - key: temperature
          from: $machine[AA10-01].temp_1
          type: float64
          unit: "°C"
          transform: clamp(value * 1.0, -50, 500)
        - key: speed_rpm
          from: $machine[AA10-01].speed_rpm
          type: int64
          unit: "rpm"
      recording:
        mode: ON_CHANGE
        qualityTransitions: true
        deadband:
          kind: absolute
          value: 0.5
        maxCheckpointInterval: 60s
        lateTolerance: 5m
        missingPolicy: GAP_MARKER
      retention:
        days: 90
        legalHold: false
"""


class _FakeResult:
    def __init__(self, rows: list[dict[str, Any]], rowcount: int = 1) -> None:
        self._rows = rows
        self.rowcount = rowcount

    def mappings(self) -> "_FakeResult":
        return self

    def first(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[dict[str, Any]]:
        return list(self._rows)


class FakeStorageAndHistorianSession:
    """In-memory async session tracking PostgreSQL tables for S10, S11, and S12."""

    def __init__(self) -> None:
        self.active_epoch: int = 1
        self.designs: dict[UUID, dict[str, Any]] = {}
        self.design_versions: list[dict[str, Any]] = []
        self.datasets: list[dict[str, Any]] = []
        self.field_bindings: list[dict[str, Any]] = []
        self.recording_policies: list[dict[str, Any]] = []
        self.physical_registry: list[dict[str, Any]] = []
        self.dependencies: list[dict[str, Any]] = []
        self.operations: list[dict[str, Any]] = []
        self.saved_queries: dict[UUID, dict[str, Any]] = {}
        self.export_jobs: dict[UUID, dict[str, Any]] = []
        self.observations: list[dict[str, Any]] = []
        self.latest_signal_state: dict[UUID, dict[str, Any]] = {}

        # Default catalog metadata
        self.resources: list[dict[str, Any]] = [
            {
                "id": RES_MACHINE_ID,
                "tenant_id": TENANT_ID,
                "name": "AA10-01",
                "code": "AA10-01",
                "site_id": None,
                "status": "ACTIVE",
                "type_key": "machine",
            }
        ]
        self.signal_definitions: list[dict[str, Any]] = [
            {
                "id": SIG_TEMP_ID,
                "tenant_id": TENANT_ID,
                "resource_id": RES_MACHINE_ID,
                "resource_name": "AA10-01",
                "type_key": "machine",
                "key": "temp_1",
                "data_type": "float64",
                "unit": "°C",
                "status": "ACTIVE",
                "expected_interval_ms": 1000,
                "version": 1,
                "binding_enabled": True,
            },
            {
                "id": SIG_RPM_ID,
                "tenant_id": TENANT_ID,
                "resource_id": RES_MACHINE_ID,
                "resource_name": "AA10-01",
                "type_key": "machine",
                "key": "speed_rpm",
                "data_type": "int64",
                "unit": "rpm",
                "status": "ACTIVE",
                "expected_interval_ms": 1000,
                "version": 1,
                "binding_enabled": True,
            },
        ]
        self.output_groups: list[dict[str, Any]] = [
            {
                "id": MODEL_CNC_ID,
                "tenant_id": TENANT_ID,
                "display_name": "CNC Spindle Model",
                "status": "ACTIVE",
                "spec_json": {"target": "AA10-01"},
            }
        ]

    async def execute(self, clause: Any, params: dict[str, Any] | None = None) -> _FakeResult:
        sql = " ".join(str(clause).split())
        p = dict(params or {})
        low = sql.lower()

        # ----------------------------------------------------------------------
        # Active epoch
        # ----------------------------------------------------------------------
        if "from telemetry_reset_operations" in low and "max(active_epoch)" in low:
            return _FakeResult([{"active_epoch": self.active_epoch}])

        # ----------------------------------------------------------------------
        # Storage Designs: Queries
        # ----------------------------------------------------------------------
        if "from storage_designs" in low:
            if "group by status" in low:
                counts: dict[str, int] = defaultdict(int)
                for d in self.designs.values():
                    counts[str(d.get("status", "DRAFT")).upper()] += 1
                return _FakeResult([{"status": st, "cnt": c, "count": c} for st, c in counts.items()])

            if "count(*)" in low:
                count = len([d for d in self.designs.values() if d.get("status") != "ARCHIVED"])
                return _FakeResult([{"cnt": count, "count": count}])

            if "lower(btrim(name))" in low or "lower(name)" in low:
                name_p = str(p.get("name") or "").lower().strip()
                excl = p.get("exclude_id") or p.get("exclude")
                for d in self.designs.values():
                    if d.get("status") != "ARCHIVED" and d["name"].lower().strip() == name_p:
                        if excl and d["id"] == excl:
                            continue
                        return _FakeResult([{"id": d["id"]}])
                return _FakeResult([])

            target_id = p.get("design_id") or p.get("id")
            if target_id:
                d = self.designs.get(target_id)
                return _FakeResult([d] if d else [])

            res = list(self.designs.values())
            if p.get("status"):
                res = [d for d in res if str(d.get("status")).upper() == str(p["status"]).upper()]
            if p.get("scope"):
                res = [d for d in res if str(d.get("scope")).lower() == str(p["scope"]).lower()]
            if p.get("mode"):
                res = [d for d in res if str(d.get("mode")).lower() == str(p["mode"]).lower()]
            return _FakeResult(res)

        # ----------------------------------------------------------------------
        # Storage Designs: DML
        # ----------------------------------------------------------------------
        if "insert into storage_designs" in low:
            self.designs[p["id"]] = {
                "id": p["id"],
                "tenant_id": p["tenant_id"],
                "name": p["name"],
                "description": p.get("description"),
                "status": p.get("status", "DRAFT"),
                "scope": p.get("scope", "global"),
                "mode": p.get("mode", "recorded"),
                "target_database": p.get("target_database", "default"),
                "current_version": p.get("current_version", 1),
                "draft_revision": p.get("draft_revision", 1),
                "draft_ast_json": json.loads(p["draft_ast_json"]) if isinstance(p.get("draft_ast_json"), str) else p.get("draft_ast_json"),
                "source_yaml": p.get("source_yaml"),
                "ui_meta_json": json.loads(p["ui_meta_json"]) if isinstance(p.get("ui_meta_json"), str) else p.get("ui_meta_json"),
                "created_by": p.get("created_by"),
                "updated_by": p.get("updated_by"),
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
                "last_published_at": None,
                "dataset_count": 0,
                "field_binding_count": 0,
            }
            return _FakeResult([], rowcount=1)

        if "update storage_designs" in low:
            d_id = p.get("id")
            if d_id and d_id in self.designs:
                target = self.designs[d_id]
                if "expected_version" in p:
                    if target["current_version"] != p["expected_version"]:
                        return _FakeResult([], rowcount=0)
                if "status = 'running'" in low:
                    target["status"] = "RUNNING"
                elif "status = 'paused'" in low:
                    target["status"] = "PAUSED"
                elif "status = 'archived'" in low:
                    target["status"] = "ARCHIVED"
                elif "status = :status" in low and "status" in p:
                    target["status"] = p["status"]
                if "current_version = :ver" in low and "ver" in p:
                    target["current_version"] = p["ver"]
                if "published_version_id = :ver_id" in low and "ver_id" in p:
                    target["published_version_id"] = p["ver_id"]
                for k, v in p.items():
                    if k not in {"id", "tenant_id", "expected_version", "ver", "ver_id"}:
                        if k in {"draft_ast_json", "ui_meta_json"} and isinstance(v, str):
                            try:
                                target[k] = json.loads(v)
                            except Exception:
                                target[k] = v
                        else:
                            target[k] = v
                target["updated_at"] = datetime.now(timezone.utc)
                return _FakeResult([], rowcount=1)
            return _FakeResult([], rowcount=0)

        # ----------------------------------------------------------------------
        # Sub-tables & Registry
        # ----------------------------------------------------------------------
        if "signals_mapped" in low:
            sig_mapped = len({b["signal_id"] for b in self.field_bindings if b.get("signal_id")})
            model_mapped = len({b["model_id"] for b in self.field_bindings if b.get("model_id")})
            return _FakeResult([{
                "signals_mapped": sig_mapped,
                "signals_total": len(self.signal_definitions),
                "models_mapped": model_mapped,
                "models_total": len(self.output_groups),
            }])

        if "from storage_datasets" in low and "select" in low:
            des_id = p.get("design_id")
            rows = []
            for ds in self.datasets:
                if not des_id or ds.get("design_id") == des_id:
                    item = dict(ds)
                    item.setdefault("dataset_id", ds.get("id"))
                    des = self.designs.get(ds.get("design_id"))
                    item.setdefault("design_name", des["name"] if des else "Design")
                    rows.append(item)
            return _FakeResult(rows)

        if "signals_mapped" in low:
            sig_mapped = len(set(b["signal_id"] for b in self.field_bindings if b.get("signal_id")))
            mod_mapped = len(set(b["model_id"] for b in self.field_bindings if b.get("model_id")))
            return _FakeResult([{
                "signals_mapped": sig_mapped,
                "signals_total": len(self.signal_definitions),
                "models_mapped": mod_mapped,
                "models_total": len(self.output_groups),
            }])

        if "from storage_field_bindings" in low and "select" in low:
            if "join signal_definitions" in low:
                res = []
                for b in self.field_bindings:
                    sig_id = b.get("signal_id")
                    if sig_id:
                        sig = next((s for s in self.signal_definitions if s["id"] == sig_id), None)
                        if sig:
                            res.append(
                                {
                                    "id": sig["id"],
                                    "key": sig["key"],
                                    "data_type": sig["data_type"],
                                    "status": sig["status"],
                                    "resource_name": sig.get("resource_name", "AA10-01"),
                                    "protocol": "opcua",
                                }
                            )
                return _FakeResult(res)
            if "join resources" in low:
                res = []
                for r in self.resources:
                    res.append({"id": r["id"], "name": r["name"], "code": r["code"], "status": r["status"]})
                return _FakeResult(res)
            des_id = p.get("design_id")
            rows = [b for b in self.field_bindings if not des_id or b.get("design_id") == des_id]
            return _FakeResult(rows)

        if "from storage_recording_policies" in low and "select" in low:
            des_id = p.get("design_id")
            rows = [rp for rp in self.recording_policies if not des_id or rp.get("design_id") == des_id]
            return _FakeResult(rows)

        if "from storage_design_versions" in low and "select" in low:
            if "join storage_designs" in low:
                res = []
                for v in self.design_versions:
                    des = self.designs.get(v.get("design_id"))
                    item = dict(v)
                    item["design_name"] = des["name"] if des else "Design"
                    res.append(item)
                return _FakeResult(res)
            des_id = p.get("design_id")
            rows = [v for v in self.design_versions if not des_id or v.get("design_id") == des_id]
            return _FakeResult(rows)

        if "from storage_physical_registry" in low:
            if "select tier, count(*) as cnt" in low:
                # Group by tier
                counts: dict[str, int] = {}
                for r in self.physical_registry:
                    tier = str(r.get("tier", "MANAGED")).upper()
                    counts[tier] = counts.get(tier, 0) + 1
                return _FakeResult(
                    [
                        {"tier": t, "cnt": cnt, "last_up": datetime.now(timezone.utc)}
                        for t, cnt in counts.items()
                    ]
                )
            des_id = p.get("design_id")
            rows = [r for r in self.physical_registry if not des_id or r.get("design_id") == des_id]
            return _FakeResult(rows)

        if "from storage_operations" in low and "select" in low:
            des_id = p.get("design_id")
            rows = [op for op in self.operations if not des_id or op.get("design_id") == des_id]
            return _FakeResult(rows)

        if "from storage_dependencies" in low and "select" in low:
            des_id = p.get("design_id")
            rows = [dep for dep in self.dependencies if not des_id or dep.get("design_id") == des_id]
            return _FakeResult(rows)

        # Deletions / Inserts into related tables
        if "delete from storage_datasets" in low:
            des_id = p.get("design_id")
            self.datasets = [ds for ds in self.datasets if ds.get("design_id") != des_id]
            return _FakeResult([])

        if "delete from storage_field_bindings" in low:
            des_id = p.get("design_id")
            self.field_bindings = [b for b in self.field_bindings if b.get("design_id") != des_id]
            return _FakeResult([])

        if "delete from storage_recording_policies" in low:
            des_id = p.get("design_id")
            self.recording_policies = [rp for rp in self.recording_policies if rp.get("design_id") != des_id]
            return _FakeResult([])

        if "delete from storage_dependencies" in low:
            des_id = p.get("design_id")
            self.dependencies = [dep for dep in self.dependencies if dep.get("design_id") != des_id]
            return _FakeResult([])

        if "insert into storage_datasets" in low:
            self.datasets.append(dict(p))
            return _FakeResult([], rowcount=1)

        if "insert into storage_field_bindings" in low:
            self.field_bindings.append(dict(p))
            return _FakeResult([], rowcount=1)

        if "insert into storage_recording_policies" in low:
            self.recording_policies.append(dict(p))
            return _FakeResult([], rowcount=1)

        if "insert into storage_design_versions" in low:
            ver = dict(p)
            ver.setdefault("publish_state", "APPLIED")
            ver.setdefault("effective_from_epoch", p.get("epoch", 1))
            ver.setdefault("effective_at", p.get("now"))
            ver.setdefault("created_at", p.get("now"))
            ver.setdefault("applied_at", p.get("now"))
            self.design_versions.append(ver)
            return _FakeResult([], rowcount=1)

        if "insert into storage_physical_registry" in low:
            reg = dict(p)
            reg.setdefault("tier", "MANAGED")
            reg.setdefault("status", "ACTIVE")
            reg.setdefault("physical_schema_hash", p.get("schema_hash", ""))
            reg.setdefault("created_at", p.get("now"))
            reg.setdefault("updated_at", p.get("now"))
            self.physical_registry.append(reg)
            return _FakeResult([], rowcount=1)

        if "insert into storage_dependencies" in low:
            self.dependencies.append(dict(p))
            return _FakeResult([], rowcount=1)

        if "insert into storage_operations" in low:
            op = dict(p)
            op.setdefault("target_id", p.get("design_id"))
            if "publish_design" in low:
                op.setdefault("operation_type", "PUBLISH_DESIGN")
                op.setdefault("status", "RUNNING")
            elif "pause_design" in low:
                op.setdefault("operation_type", "PAUSE_DESIGN")
                op.setdefault("status", "COMPLETED")
            elif "resume_design" in low:
                op.setdefault("operation_type", "RESUME_DESIGN")
                op.setdefault("status", "COMPLETED")
            elif "archive_design" in low:
                op.setdefault("operation_type", "ARCHIVE_DESIGN")
                op.setdefault("status", "COMPLETED")
            else:
                op.setdefault("operation_type", p.get("operation_type", "PUBLISH_DESIGN"))
                op.setdefault("status", p.get("status", "COMPLETED"))
            op.setdefault("target_type", p.get("target_type", "storage_design"))
            op.setdefault("requested_at", p.get("now"))
            op.setdefault("completed_at", p.get("now"))
            self.operations.append(op)
            return _FakeResult([], rowcount=1)

        if "update storage_operations" in low:
            op_id = p.get("id")
            for op in self.operations:
                if op.get("id") == op_id:
                    op.update(p)
                    break
            return _FakeResult([], rowcount=1)

        # ----------------------------------------------------------------------
        # S12: Saved Views (saved_queries)
        # ----------------------------------------------------------------------
        if "from saved_queries" in low and "select" in low:
            q_id = p.get("id")
            if q_id:
                item = self.saved_queries.get(q_id)
                return _FakeResult([item] if item else [])
            return _FakeResult(list(self.saved_queries.values()))

        if "insert into saved_queries" in low:
            self.saved_queries[p["id"]] = {
                "id": p["id"],
                "tenant_id": p["tenant_id"],
                "created_by": p.get("created_by"),
                "name": p["name"],
                "description": p.get("description", ""),
                "query_spec_json": json.loads(p["query_spec_json"]) if isinstance(p.get("query_spec_json"), str) else p.get("query_spec_json"),
                "chart_options_json": json.loads(p["chart_options_json"]) if isinstance(p.get("chart_options_json"), str) else p.get("chart_options_json"),
                "is_default": p.get("is_default", False),
                "version": p.get("version", 1),
                "created_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }
            return _FakeResult([], rowcount=1)

        if "delete from saved_queries" in low:
            q_id = p.get("id")
            if q_id in self.saved_queries:
                del self.saved_queries[q_id]
                return _FakeResult([], rowcount=1)
            return _FakeResult([], rowcount=0)

        # ----------------------------------------------------------------------
        # S12: Export Jobs
        # ----------------------------------------------------------------------
        if "from export_jobs" in low and "select" in low:
            exp_id = p.get("id")
            if exp_id:
                for item in self.export_jobs:
                    if item.get("id") == exp_id:
                        return _FakeResult([item])
                return _FakeResult([])
            return _FakeResult(self.export_jobs)

        if "insert into export_jobs" in low:
            d = dict(p)
            d.setdefault("status", "COMPLETED")
            d.setdefault("format", "csv")
            d.setdefault("created_at", p.get("now") or utcnow())
            self.export_jobs.append(d)
            return _FakeResult([], rowcount=1)

        if "update export_jobs" in low:
            exp_id = p.get("id")
            for item in self.export_jobs:
                if item.get("id") == exp_id:
                    item.update(p)
                    break
            return _FakeResult([], rowcount=1)

        # ----------------------------------------------------------------------
        # Catalog Snapshot Queries (storage_compiler)
        # ----------------------------------------------------------------------
        if "from resources r" in low and "join resource_types" in low:
            return _FakeResult(self.resources)

        if "from signal_definitions s" in low:
            sig_ids = p.get("sig_ids")
            sig_list = []
            for s in self.signal_definitions:
                if sig_ids and s["id"] not in sig_ids and str(s["id"]) not in [str(x) for x in sig_ids]:
                    continue
                item = dict(s)
                item["signal_id"] = s["id"]
                st = self.latest_signal_state.get(s["id"])
                if st:
                    item.update(st)
                    item["signal_id"] = s["id"]
                sig_list.append(item)
            return _FakeResult(sig_list)

        if "from output_groups" in low:
            return _FakeResult(self.output_groups)

        # ----------------------------------------------------------------------
        # Historian: Latest Signal State & Observations
        # ----------------------------------------------------------------------
        if "from latest_signal_state" in low:
            sig_id = p.get("signal_id")
            if sig_id:
                st = self.latest_signal_state.get(sig_id)
                return _FakeResult([st] if st else [])
            return _FakeResult(list(self.latest_signal_state.values()))

        if "from observations" in low:
            return _FakeResult(self.observations)

        # Fallback / notify / commit
        if "pg_notify" in low:
            return _FakeResult([])

        return _FakeResult([])


def _create_mock_tdengine() -> AsyncMock:
    client = AsyncMock(spec=TDEngineClient)
    created_subtables: set[str] = set()

    async def _execute_sql(stmt: str) -> None:
        import re
        m = re.search(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?[^`.\s]+`?\.)?`?([a-zA-Z0-9_]+)`?\s+USING", stmt, re.IGNORECASE)
        if m:
            created_subtables.add(m.group(1))

    client.execute_sql = AsyncMock(side_effect=_execute_sql)
    client.list_subtables = AsyncMock(side_effect=lambda db: list(created_subtables))
    client.health_probe = AsyncMock(
        return_value=TDEngineHealth(
            reachable=True,
            server_version="3.3.0.0",
            edition="Enterprise",
            server_now_utc=datetime.now(timezone.utc),
            dnode_status="ready",
            tenant_db_count=1,
            disk_used_bytes=1048576,
        )
    )
    client.execute = AsyncMock(return_value=None)
    client.query = AsyncMock(return_value=[])
    return client


# ==============================================================================
# S10 Designer Unit Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_s10_design_crud_concurrency_and_validation() -> None:
    session = FakeStorageAndHistorianSession()

    # 1. Standalone DSL Validation
    val_res = await SD.validate_design(session, TENANT_ID, body={"source_yaml": SAMPLE_DSL_YAML})
    assert val_res["valid"] is True
    assert val_res["ast"]["metadata"]["name"] == "CNC Precision Spindle Telemetry"
    assert val_res["row_width_bytes"] > 0
    assert not any(i["severity"] == "error" for i in val_res["issues"])

    # 2. Standalone DSL Validation with invalid destination (must catch issues)
    bad_yaml = SAMPLE_DSL_YAML.replace("engine: tdengine", "engine: rabbitmq")
    val_bad = await SD.validate_design(session, TENANT_ID, body={"source_yaml": bad_yaml})
    assert val_bad["valid"] is False
    assert any(i["code"] == "INVALID_DESTINATION" for i in val_bad["issues"])

    # 3. Create Design from YAML
    created = await SD.create_design(
        session,
        TENANT_ID,
        ACTOR_ID,
        {"source_yaml": SAMPLE_DSL_YAML},
    )
    assert created["id"] is not None
    assert created["status"] == "DRAFT"
    assert created["current_version"] == 1
    design_id = UUID(created["id"])

    # 4. Duplicate Name Conflict Check
    with pytest.raises(AppError) as exc_dup:
        await SD.create_design(
            session,
            TENANT_ID,
            ACTOR_ID,
            {"source_yaml": SAMPLE_DSL_YAML},
        )
    assert exc_dup.value.status == 409
    assert exc_dup.value.code == "DUPLICATE_NAME"

    # 5. Missing Name Check
    with pytest.raises(AppError) as exc_name:
        await SD.create_design(session, TENANT_ID, ACTOR_ID, {"name": ""})
    assert exc_name.value.status == 422
    assert exc_name.value.code == "MISSING_NAME"

    # 6. Read Design Detail
    detail = await SD.get_design(session, TENANT_ID, design_id)
    assert detail["name"] == "CNC Precision Spindle Telemetry"
    assert detail["current_version"] == 1

    # 7. Update with Optimistic Concurrency Conflict (expected_version mismatch)
    with pytest.raises(AppError) as exc_conf:
        await SD.update_design(
            session,
            TENANT_ID,
            ACTOR_ID,
            design_id,
            {"description": "New description"},
            correlation_id="test-corr",
            expected_version=99,
        )
    assert exc_conf.value.status == 409
    assert exc_conf.value.code == "VERSION_CONFLICT"

    # 8. Successful Update
    updated = await SD.update_design(
        session,
        TENANT_ID,
        ACTOR_ID,
        design_id,
        {"description": "Updated high-precision spindle telemetry"},
        correlation_id="test-corr",
        expected_version=1,
    )
    assert updated["description"] == "Updated high-precision spindle telemetry"


@pytest.mark.asyncio
async def test_s10_physical_plan_simulation_and_publish() -> None:
    session = FakeStorageAndHistorianSession()
    td = _create_mock_tdengine()

    # Create draft
    created = await SD.create_design(
        session,
        TENANT_ID,
        ACTOR_ID,
        {"source_yaml": SAMPLE_DSL_YAML},
    )
    design_id = UUID(created["id"])

    # 1. Compile Physical Plan
    plan_res = await SD.compile_design_physical_plan(session, TENANT_ID, design_id=design_id)
    assert plan_res["database_name"].startswith("fx_t_")
    assert plan_res["total_row_width_bytes"] < 64500
    assert len(plan_res["stables"]) > 0

    # 2. Simulate Design (Dry run with zero writes to managed subtables)
    sim_res = await SD.simulate_design(session, TENANT_ID, design_id=design_id)
    assert sim_res["dry_run"] is True
    assert "compression_ratio_estimate" in sim_res
    assert isinstance(sim_res["sample_rows"], list)

    # 3. Publish Design
    pub_res = await SD.publish_design(
        session,
        TENANT_ID,
        ACTOR_ID,
        design_id,
        payload={"expected_version": 1, "comment": "Initial production release"},
        tdengine=td,
    )
    assert pub_res["status"] == "RUNNING"
    assert pub_res["published_version"] == 1
    assert len(session.design_versions) == 1
    assert len(session.datasets) == 1
    assert len(session.field_bindings) == 2

    # 4. Check listing with summary
    listing = await SD.list_designs(session, TENANT_ID)
    assert len(listing["designs"]) == 1
    assert listing["summary"]["running"] == 1
    assert listing["summary"]["all"] == 1


# ==============================================================================
# S11 Lifecycle & Catalog Unit Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_s11_lifecycle_pause_resume_duplicate_archive_and_bulk() -> None:
    session = FakeStorageAndHistorianSession()
    td = _create_mock_tdengine()

    created = await SD.create_design(
        session,
        TENANT_ID,
        ACTOR_ID,
        {"source_yaml": SAMPLE_DSL_YAML},
    )
    design_id = UUID(created["id"])

    # Publish to make it RUNNING
    await SD.publish_design(session, TENANT_ID, ACTOR_ID, design_id, tdengine=td)

    # 1. Pause
    paused = await SD.pause_design(session, TENANT_ID, ACTOR_ID, design_id)
    assert paused["status"] == "PAUSED"

    # 2. Resume
    resumed = await SD.resume_design(session, TENANT_ID, ACTOR_ID, design_id)
    assert resumed["status"] == "RUNNING"

    # 3. Archive RUNNING without force -> 409 DESIGN_RUNNING
    with pytest.raises(AppError) as exc_arch:
        await SD.archive_design(session, TENANT_ID, ACTOR_ID, design_id, body={"force": False})
    assert exc_arch.value.status == 409
    assert exc_arch.value.code == "DESIGN_RUNNING"

    # 4. Archive with force -> ARCHIVED
    archived = await SD.archive_design(session, TENANT_ID, ACTOR_ID, design_id, body={"force": True})
    assert archived["status"] == "ARCHIVED"

    # 5. Restore -> PAUSED
    restored = await SD.restore_design(session, TENANT_ID, ACTOR_ID, design_id, body={"target_status": "PAUSED"})
    assert restored["status"] == "PAUSED"

    # 6. Duplicate
    dup_res = await SD.duplicate_design(session, TENANT_ID, ACTOR_ID, design_id, body={"target_name": "Cloned CNC Design"})
    assert dup_res["name"] == "Cloned CNC Design"
    assert dup_res["status"] == "DRAFT"
    cloned_id = UUID(dup_res["id"])

    # 7. Bulk pause/resume/archive
    bulk_res = await SD.bulk_designs(
        session,
        TENANT_ID,
        ACTOR_ID,
        {"action": "archive", "design_ids": [str(cloned_id)]},
    )
    assert bulk_res["succeeded"] == 1
    assert bulk_res["failed"] == 0

    # 8. Export bundle (zero secrets)
    bundle = await SD.export_design_bundle(session, TENANT_ID, design_id)
    assert bundle["name"] == "CNC Precision Spindle Telemetry"
    assert "content" in bundle
    assert "ast" in bundle

    # 9. Import bundle
    imported = await SD.import_design_bundle(
        session,
        TENANT_ID,
        ACTOR_ID,
        {"bundle": bundle, "target_name": "Imported Spindle Design"},
    )
    assert imported["name"] == "Imported Spindle Design"
    assert imported["status"] == "DRAFT"


@pytest.mark.asyncio
async def test_s11_health_operations_and_retention_preview() -> None:
    session = FakeStorageAndHistorianSession()
    td = _create_mock_tdengine()

    # 1. Storage Health Probe
    health = await SD.get_storage_health(session, TENANT_ID, tdengine=td)
    assert health["storage_destination"] == "TDengine"
    assert health["tdengine"]["status"] == "HEALTHY"
    assert health["tdengine"]["reachable"] is True
    # Zero fake cluster IPs
    assert "fake" not in str(health).lower()

    # 2. Operations log
    created = await SD.create_design(session, TENANT_ID, ACTOR_ID, {"source_yaml": SAMPLE_DSL_YAML})
    design_id = UUID(created["id"])
    await SD.publish_design(session, TENANT_ID, ACTOR_ID, design_id, tdengine=td)

    ops = await SD.list_storage_operations(session, TENANT_ID, design_id=design_id)
    assert len(ops) >= 1
    assert ops[0]["operation_type"] == "PUBLISH_DESIGN"

    # 3. Retention Preview
    preview = await SD.preview_storage_retention(session, TENANT_ID, payload={"design_id": str(design_id)})
    assert preview["can_execute"] is True
    assert preview["blocked_by_legal_hold"] is False
    assert len(preview["datasets"]) == 1
    assert preview["datasets"][0]["retention_days"] == 90


# ==============================================================================
# S12 Historian Service Unit Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_s12_historian_latest_query_and_events() -> None:
    session = FakeStorageAndHistorianSession()
    now = datetime.now(timezone.utc)

    # Seed latest state
    session.latest_signal_state[SIG_TEMP_ID] = {
        "tenant_id": TENANT_ID,
        "signal_id": SIG_TEMP_ID,
        "signal_key": "temp_1",
        "resource_id": RES_MACHINE_ID,
        "resource_name": "AA10-01",
        "value_json": {"v": 78.5},
        "value_type": "float64",
        "unit": "°C",
        "quality": "GOOD",
        "reason_code": "NORMAL",
        "source_time": now - timedelta(seconds=1),
        "last_acquired_at": now,
        "last_value_changed_at": now - timedelta(minutes=5),
        "data_epoch": 1,
        "source_health": "ONLINE",
        "connection_health": "CONNECTED",
        "broker_health": "HEALTHY",
        "storage_health": "HEALTHY",
    }

    # Seed observations
    session.observations = [
        {
            "id": uuid4(),
            "tenant_id": TENANT_ID,
            "signal_id": SIG_TEMP_ID,
            "signal_key": "temp_1",
            "acquired_at": now - timedelta(seconds=i * 10),
            "event_time": now - timedelta(seconds=i * 10),
            "value_json": {"v": 70.0 + i},
            "value_type": "float64",
            "unit": "°C",
            "raw_quality": "GOOD",
            "reason_code": "NORMAL",
            "data_epoch": 1,
        }
        for i in range(5)
    ]

    # 1. Latest Values with 4 Health Dimensions
    latest = await HS.get_historian_latest(session, TENANT_ID, signals=[SIG_TEMP_ID])
    assert len(latest["items"]) == 1
    item = latest["items"][0]
    assert item["value"] == 78.5
    assert item["source_health"] == "ONLINE"
    assert item["connection_health"] == "CONNECTED"
    assert item["broker_health"] == "HEALTHY"
    assert item["storage_health"] == "HEALTHY"

    # 2. Multi-series Query
    q_res = await HS.query_historian(
        session,
        TENANT_ID,
        {
            "signals": [str(SIG_TEMP_ID)],
            "mode": "recorded",
            "bucket_ms": 10000,
            "agg": "avg",
        },
    )
    assert str(SIG_TEMP_ID) in q_res["series"]
    series = q_res["series"][str(SIG_TEMP_ID)]
    assert "stats" in series
    assert series["stats"]["count"] == 5
    assert series["stats"]["min"] == 70.0
    assert series["stats"]["max"] == 74.0
    assert series["stats"]["good_pct"] == 100.0

    # 3. Events Feed (Quality transitions, reset boundaries)
    events = await HS.list_historian_events(session, TENANT_ID, signals=[SIG_TEMP_ID])
    assert "items" in events


@pytest.mark.asyncio
async def test_s12_saved_views_crud() -> None:
    session = FakeStorageAndHistorianSession()

    # 1. Create View
    created = await HS.create_saved_view(
        session,
        TENANT_ID,
        ACTOR_ID,
        {
            "name": "Spindle Thermal Monitoring",
            "description": "Monitors spindle temperature trends",
            "query_spec": {"signals": [str(SIG_TEMP_ID)], "mode": "recorded"},
            "chart_options": {"type": "line"},
        },
    )
    view_id = UUID(created["id"])
    assert created["name"] == "Spindle Thermal Monitoring"

    # 2. List Views
    views = await HS.list_saved_views(session, TENANT_ID)
    assert len(views) == 1
    assert views[0]["name"] == "Spindle Thermal Monitoring"

    # 3. Delete View
    await HS.delete_saved_view(session, TENANT_ID, ACTOR_ID, view_id)
    assert len(await HS.list_saved_views(session, TENANT_ID)) == 0

    # 4. Delete View Not Found -> 404
    with pytest.raises(AppError) as exc_del:
        await HS.delete_saved_view(session, TENANT_ID, ACTOR_ID, view_id)
    assert exc_del.value.status == 404


@pytest.mark.asyncio
async def test_s12_csv_exports_and_formula_injection_safety() -> None:
    session = FakeStorageAndHistorianSession()
    now = datetime.now(timezone.utc)

    # Seed an observation with potential formula injection string
    session.observations = [
        {
            "id": uuid4(),
            "tenant_id": TENANT_ID,
            "signal_id": SIG_TEMP_ID,
            "signal_key": "temp_1",
            "acquired_at": now,
            "event_time": now,
            "value_json": {"v": "=cmd|' /C calc'!A0"},
            "value_type": "string",
            "unit": None,
            "raw_quality": "GOOD",
            "reason_code": "NORMAL",
            "data_epoch": 1,
        }
    ]

    # 1. Create Export Job
    job = await HS.create_export_job(
        session,
        TENANT_ID,
        ACTOR_ID,
        {
            "signals": [str(SIG_TEMP_ID)],
            "mode": "recorded",
            "format": "csv",
        },
    )
    assert job["status"] == "COMPLETED"
    export_id = UUID(job["id"])

    # 2. Download CSV & check formula injection sanitization
    csv_text, file_name = await HS.download_export_csv(session, TENANT_ID, export_id)
    assert file_name.endswith(".csv")
    assert "timestamp,signal_id,signal_key,value,quality" in csv_text
    # Formula prefix '=' must be sanitized (escaped with single quote)
    assert "'=cmd|" in csv_text

    # 3. Test Expired Export -> 410 EXPORT_EXPIRED
    expired_id = uuid4()
    session.export_jobs.append(
        {
            "id": expired_id,
            "tenant_id": TENANT_ID,
            "created_by": ACTOR_ID,
            "status": "COMPLETED",
            "file_name": "expired.csv",
            "row_count": 10,
            "byte_size": 200,
            "query_json": {},
            "data_epoch": 1,
            "created_at": now - timedelta(days=10),
            "started_at": now - timedelta(days=10),
            "completed_at": now - timedelta(days=10),
            "expires_at": now - timedelta(days=1),
            "csv_content": "col1,col2\n1,2\n",
        }
    )

    with pytest.raises(AppError) as exc_exp:
        await HS.download_export_csv(session, TENANT_ID, expired_id)
    assert exc_exp.value.status == 410
    assert exc_exp.value.code == "EXPORT_EXPIRED"


# ==============================================================================
# S10-S12 FastAPI Transport Router Integration Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_fastapi_router_end_to_end_endpoints() -> None:
    session = FakeStorageAndHistorianSession()
    td = _create_mock_tdengine()

    app = FastAPI()

    @app.exception_handler(AppError)
    async def _on_app_err(_req: Any, exc: AppError) -> Any:
        return json_error(exc.status, exc.code, exc.message, correlation_id="test-corr", extra=exc.extra)

    async def _fake_admin() -> dict[str, Any]:
        return {"tenant_id": str(TENANT_ID), "admin_id": str(ACTOR_ID), "role": "admin"}

    async def _fake_session() -> Any:
        yield session

    router = build_router(admin=_fake_admin, db_session=_fake_session)
    app.include_router(router)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        # 1. Health check
        h_resp = await client.get("/api/v1/storage/health")
        assert h_resp.status_code == 200
        assert h_resp.json()["storage_destination"] == "TDengine"

        # 2. Standalone Validate
        v_resp = await client.post("/api/v1/storage/designs/validate", json={"source_yaml": SAMPLE_DSL_YAML})
        assert v_resp.status_code == 200
        assert v_resp.json()["valid"] is True

        # 3. Create Design
        c_resp = await client.post("/api/v1/storage/designs", json={"source_yaml": SAMPLE_DSL_YAML})
        assert c_resp.status_code == 201
        design = c_resp.json()
        design_id = design["id"]

        # 4. Get Design Detail
        d_resp = await client.get(f"/api/v1/storage/designs/{design_id}")
        assert d_resp.status_code == 200
        assert d_resp.json()["name"] == "CNC Precision Spindle Telemetry"

        # 5. Concurrency check via If-Match header
        bad_put = await client.put(
            f"/api/v1/storage/designs/{design_id}",
            headers={"If-Match": "99"},
            json={"description": "Stale update"},
        )
        assert bad_put.status_code == 409
        assert bad_put.json()["error"]["code"] == "VERSION_CONFLICT"

        # 6. Physical Plan
        p_resp = await client.post(f"/api/v1/storage/designs/{design_id}/physical-plan")
        assert p_resp.status_code == 200
        assert "database_name" in p_resp.json()

        # 7. Simulate
        s_resp = await client.post(f"/api/v1/storage/designs/{design_id}/simulate")
        assert s_resp.status_code == 200
        assert s_resp.json()["dry_run"] is True

        # 8. Publish
        pub_resp = await client.post(f"/api/v1/storage/designs/{design_id}/publish", json={"expected_version": 1})
        assert pub_resp.status_code == 200
        assert pub_resp.json()["status"] == "RUNNING"

        # 9. Pause
        pause_resp = await client.post(f"/api/v1/storage/designs/{design_id}/pause")
        assert pause_resp.status_code == 200
        assert pause_resp.json()["status"] == "PAUSED"

        # 10. Resume
        resume_resp = await client.post(f"/api/v1/storage/designs/{design_id}/resume")
        assert resume_resp.status_code == 200
        assert resume_resp.json()["status"] == "RUNNING"

        # 11. Dependencies
        dep_resp = await client.get(f"/api/v1/storage/designs/{design_id}/dependencies")
        assert dep_resp.status_code == 200

        # 12. Export bundle
        exp_resp = await client.get(f"/api/v1/storage/designs/{design_id}/export")
        assert exp_resp.status_code == 200
        bundle = exp_resp.json()

        # 13. Import bundle
        imp_resp = await client.post(
            "/api/v1/storage/designs/import",
            json={"bundle": bundle, "target_name": "HTTP Cloned CNC"},
        )
        assert imp_resp.status_code == 201
        cloned_id = imp_resp.json()["id"]

        # 14. Bulk operations
        bulk_resp = await client.post(
            "/api/v1/storage/designs/bulk",
            json={"action": "archive", "design_ids": [cloned_id]},
        )
        assert bulk_resp.status_code == 200
        assert bulk_resp.json()["succeeded"] == 1

        # 15. Operations list
        ops_resp = await client.get("/api/v1/storage/operations")
        assert ops_resp.status_code == 200
        assert isinstance(ops_resp.json(), list)

        # 16. Retention preview
        ret_resp = await client.post("/api/v1/storage/retention/preview", json={"design_id": design_id})
        assert ret_resp.status_code == 200
        assert ret_resp.json()["can_execute"] is True

        # 17. Historian Latest
        latest_resp = await client.get("/api/v1/historian/latest")
        assert latest_resp.status_code == 200
        assert "items" in latest_resp.json()

        # 18. Historian Query (POST & GET)
        q_post = await client.post(
            "/api/v1/historian/query",
            json={"signals": [str(SIG_TEMP_ID)], "mode": "recorded"},
        )
        assert q_post.status_code == 200
        assert "series" in q_post.json()

        q_get = await client.get(f"/api/v1/historian/query?signals={SIG_TEMP_ID}&mode=recorded")
        assert q_get.status_code == 200
        assert "series" in q_get.json()

        # 19. Historian Events
        events_resp = await client.get(f"/api/v1/historian/events?signals={SIG_TEMP_ID}")
        assert events_resp.status_code == 200
        assert "items" in events_resp.json()

        # 20. Saved Views CRUD
        v_create = await client.post(
            "/api/v1/historian/views",
            json={"name": "HTTP View", "query_spec": {"mode": "recorded"}},
        )
        assert v_create.status_code == 201
        v_id = v_create.json()["id"]

        v_list = await client.get("/api/v1/historian/views")
        assert v_list.status_code == 200
        assert len(v_list.json()) == 1

        v_del = await client.delete(f"/api/v1/historian/views/{v_id}")
        assert v_del.status_code == 200

        # 21. Historian Exports & CSV Download
        exp_post = await client.post(
            "/api/v1/historian/exports",
            json={"signals": [str(SIG_TEMP_ID)], "mode": "recorded"},
        )
        assert exp_post.status_code == 202
        exp_job_id = exp_post.json()["id"]

        exp_list = await client.get("/api/v1/historian/exports")
        assert exp_list.status_code == 200

        exp_get = await client.get(f"/api/v1/historian/exports/{exp_job_id}")
        assert exp_get.status_code == 200

        csv_dl = await client.get(f"/api/v1/historian/exports/{exp_job_id}/download")
        assert csv_dl.status_code == 200
        assert "text/csv" in csv_dl.headers["content-type"]
        assert "attachment;" in csv_dl.headers["content-disposition"]
