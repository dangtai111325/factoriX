"""Edge cycle against the approved Modbus source. Read-only; no OT writes."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parents[2]
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    os.environ.setdefault(key.strip(), value)
os.environ["FACTORIX_BOOTSTRAP_TOKEN"] = "integration-bootstrap-token"
os.environ["FACTORIX_ENVIRONMENT"] = "test"
os.environ["FACTORIX_COOKIE_SECURE"] = "false"

from factorix.platform.settings import get_settings

get_settings.cache_clear()
import factorix.platform.db as db_module

db_module._engine = None
db_module._session_factory = None

from factorix.transport.app import app
from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox
from sqlalchemy import text
from factorix.platform.db import session_factory


async def _wipe() -> None:
    factory = session_factory()
    async with factory() as session:
        await session.execute(
            text(
                """
                TRUNCATE TABLE
                  tenants, sites, admin_accounts, sessions, login_throttle,
                  resource_types, resources, relation_types, resource_relations, type_adjacency,
                  hierarchy_templates, hierarchy_views, layout_definitions, layout_revisions,
                  edge_nodes, edge_enrollment_tokens, secret_store, connections, acquisition_jobs,
                  source_fields, signal_definitions, signal_bindings, mapping_definitions,
                  formula_definitions, formula_dependencies, output_groups, output_group_members,
                  configuration_drafts, configuration_releases, deployment_events, commissioning_jobs,
                  observations, ingest_dedup, latest_signal_state, observation_quarantine,
                  dashboards, dashboard_revisions, retention_policies, retention_jobs,
                  saved_queries, audit_events, export_jobs
                RESTART IDENTITY CASCADE
                """
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_edge_reads_live_modbus_into_historian(tmp_path: Path) -> None:
    await _wipe()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://localhost") as client:
        created = await client.post(
            "/api/v1/auth/bootstrap",
            headers={"X-Bootstrap-Token": "integration-bootstrap-token"},
            json={"login": "fxadmin", "email": "fxadmin@example.com", "password": "Correct-Horse-9", "display_name": "FactoriX", "tenant_code": "primary"},
        )
        assert created.status_code == 201, created.text
        login = await client.post("/api/v1/auth/login", json={"login": "fxadmin", "password": "Correct-Horse-9"})
        assert login.status_code == 200, login.text
        headers = {"X-CSRF-Token": client.cookies.get("fx_csrf")}
        site = await client.post(
            "/api/v1/sites",
            headers=headers,
            json={"code": "DongNai", "name": "Dong Nai", "timezone": "Asia/Ho_Chi_Minh"},
        )
        assert site.status_code == 201, site.text
        site_id = site.json()["id"]
        enterprise = await client.post("/api/v1/resources", headers=headers, json={"type_key": "enterprise", "code": "TIPA", "name": "TIPA"})
        plant_parent = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={"type_key": "site", "code": "DongNai-Site", "name": "Dong Nai", "site_id": site_id, "parent_id": enterprise.json()["id"]},
        )
        plant = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={"type_key": "plant", "code": "Factory-1", "name": "Factory 1", "site_id": site_id, "parent_id": plant_parent.json()["id"]},
        )
        machine = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={"type_key": "machine", "code": "AA10-01", "name": "AA10-01", "site_id": site_id, "parent_id": plant.json()["id"]},
        )
        assert machine.status_code == 201, machine.text
        edge = await client.post("/api/v1/edges", headers=headers, json={"name": "edge-01", "site_id": site_id})
        connection = await client.post(
            "/api/v1/connections",
            headers=headers,
            json={
                "name": "PLC AA10",
                "site_id": site_id,
                "edge_id": edge.json()["id"],
                "protocol": "modbus_tcp",
                "config": {"host": "192.168.2.108", "port": 1502, "unit_id": 1, "timeout_ms": 3000, "retries": 1},
            },
        )
        assert connection.status_code == 201, connection.text
        job_id = connection.json()["jobs"][0]["id"]
        bulk = await client.post(
            "/api/v1/signals/bulk",
            headers=headers,
            json={
                "resource_id": machine.json()["id"],
                "atomic": True,
                "items": [
                    {
                        "key": "status",
                        "name": "Trang thai",
                        "data_type": "int64",
                        "unit": None,
                        "source_field": {
                            "acquisition_job_id": job_id,
                            "address_kind": "modbus_register",
                            "address": {"offset": 0, "register_area": "holding", "native_type": "uint16", "register_count": 1},
                        },
                    },
                    {
                        "key": "temperature",
                        "name": "Nhiet do",
                        "data_type": "float64",
                        "unit": "Cel",
                        "source_field": {
                            "acquisition_job_id": job_id,
                            "address_kind": "modbus_register",
                            "address": {"offset": 100, "register_area": "holding", "native_type": "float32", "register_count": 2, "word_order": "big"},
                        },
                    },
                ],
            },
        )
        assert bulk.status_code == 201, bulk.text
        token = await client.post(f"/api/v1/edges/{edge.json()['id']}/enrollment-token", headers=headers)
        enrolled = await client.post("/api/v1/edge-sync/enroll", json={"enrollment_token": token.json()["enrollment_token"]})
        assert enrolled.status_code == 200, enrolled.text
        release = await client.post("/api/v1/config-releases/publish", headers=headers, json={"edge_id": edge.json()["id"]})
        assert release.status_code == 201, release.text
        assert release.json()["active_revision"] == 0
        outbox = Outbox(tmp_path / "outbox.sqlite")
        runtime = EdgeRuntime(
            client,
            enrolled.json()["credential"],
            ["192.168.2.108:1502"],
            outbox,
        )
        try:
            result = await runtime.cycle()
        finally:
            outbox.close()
        assert result.get("error") is None, result
        assert result["activated"] is True
        assert result["reads"] == 2
        assert result["flushed"] == 2
        signals = (await client.get("/api/v1/signals", params={"resource_id": machine.json()["id"]})).json()["items"]
        by_key = {item["key"]: item["id"] for item in signals}
        status = (await client.get(f"/api/v1/signals/{by_key['status']}/latest")).json()
        temperature = (await client.get(f"/api/v1/signals/{by_key['temperature']}/latest")).json()
        assert isinstance(status["value"], int)
        assert 0 <= status["value"] <= 6
        assert status["quality"] == "GOOD"
        assert isinstance(temperature["value"], float)
        assert 0 <= temperature["value"] <= 200
        assert temperature["quality"] == "GOOD"
        health = await client.get(f"/api/v1/edges/{edge.json()['id']}/health")
        assert health.status_code == 200, health.text
        assert health.json()["active_revision"] == release.json()["revision"]
        assert health.json()["active_revision"] == health.json()["desired_revision"]
