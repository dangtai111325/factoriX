"""API flow against the migrated database."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parents[4]
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
from sqlalchemy import text
from factorix.platform.db import session_factory


@pytest.fixture(autouse=True)
async def _close_pool_between_tests():
    yield
    engine = db_module._engine
    db_module._engine = None
    db_module._session_factory = None
    if engine is not None:
        await engine.dispose()


async def _wipe() -> None:
    factory = session_factory()
    async with factory() as session:
        await session.execute(
            text(
                """
                TRUNCATE TABLE
                  tenants, sites, admin_accounts, sessions, login_throttle, password_reset_codes,
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


def _stamp(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


@pytest.mark.asyncio
async def test_auth_resource_ingest_formula_dashboard() -> None:
    await _wipe()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://localhost") as client:
        denied = await client.post(
            "/api/v1/auth/bootstrap",
            json={"login": "fxadmin", "email": "fxadmin@example.com", "password": "Correct-Horse-9", "display_name": "FactoriX", "tenant_code": "primary"},
        )
        assert denied.status_code == 403
        created = await client.post(
            "/api/v1/auth/bootstrap",
            headers={"X-Bootstrap-Token": "integration-bootstrap-token"},
            json={"login": "fxadmin", "email": "fxadmin@example.com", "password": "Correct-Horse-9", "display_name": "FactoriX", "tenant_code": "primary"},
        )
        assert created.status_code == 201, created.text
        assert created.json()["email"] == "fxadmin@example.com"
        again = await client.post(
            "/api/v1/auth/bootstrap",
            headers={"X-Bootstrap-Token": "integration-bootstrap-token"},
            json={"login": "other", "email": "other@example.com", "password": "Correct-Horse-9", "display_name": "FactoriX", "tenant_code": "other"},
        )
        assert again.status_code == 409
        bad = await client.post("/api/v1/auth/login", json={"login": "fxadmin", "password": "wrong-password-1"})
        assert bad.status_code == 401
        login = await client.post("/api/v1/auth/login", json={"login": "fxadmin", "password": "Correct-Horse-9"})
        assert login.status_code == 200, login.text
        by_email = await client.post("/api/v1/auth/login", json={"login": "FXADMIN@example.com", "password": "Correct-Horse-9"})
        assert by_email.status_code == 200, by_email.text
        csrf = client.cookies.get("fx_csrf")
        assert csrf
        headers = {"X-CSRF-Token": csrf}
        assert (await client.get("/api/v1/auth/me")).json()["login"] == "fxadmin"
        async with AsyncClient(transport=transport, base_url="http://localhost") as stranger:
            assert (await stranger.get("/api/v1/resources")).status_code == 401

        site = await client.post(
            "/api/v1/sites",
            headers=headers,
            json={"code": "DongNai", "name": "Dong Nai", "timezone": "Asia/Ho_Chi_Minh"},
        )
        assert site.status_code == 201, site.text
        site_id = site.json()["id"]
        enterprise = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={"type_key": "enterprise", "code": "TIPA", "name": "TIPA"},
        )
        assert enterprise.status_code == 201, enterprise.text
        second = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={"type_key": "enterprise", "code": "NORTH", "name": "North"},
        )
        assert second.status_code == 201, second.text
        listed = await client.get("/api/v1/resources?view=all&limit=200", headers=headers)
        codes = {item["code"] for item in listed.json()["items"]}
        assert {"TIPA", "NORTH"} <= codes
        site_resource = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={
                "type_key": "site",
                "code": "DongNai-Site",
                "name": "Dong Nai",
                "site_id": site_id,
                "parent_id": enterprise.json()["id"],
            },
        )
        assert site_resource.status_code == 201, site_resource.text
        plant = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={
                "type_key": "plant",
                "code": "Factory-1",
                "name": "Factory 1",
                "site_id": site_id,
                "parent_id": site_resource.json()["id"],
            },
        )
        assert plant.status_code == 201, plant.text
        machine = await client.post(
            "/api/v1/resources",
            headers=headers,
            json={
                "type_key": "machine",
                "code": "AA10-01",
                "name": "AA10-01",
                "site_id": site_id,
                "parent_id": plant.json()["id"],
            },
        )
        assert machine.status_code == 201, machine.text
        renamed = await client.patch(
            f"/api/v1/resources/{machine.json()['id']}",
            headers=headers,
            json={"version": 1, "name": "May AA10-01"},
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["id"] == machine.json()["id"]

        edge = await client.post("/api/v1/edges", headers=headers, json={"name": "edge-01", "site_id": site_id})
        assert edge.status_code == 201, edge.text
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
                        "key": "machine_temp_1",
                        "name": "Nhiet do may",
                        "data_type": "float64",
                        "unit": "Cel",
                        "source_field": {
                            "acquisition_job_id": job_id,
                            "address_kind": "modbus_register",
                            "address": {"offset": 100, "native_type": "float32"},
                        },
                    }
                ],
            },
        )
        assert bulk.status_code == 201, bulk.text
        signal_id = bulk.json()["created"][0]
        token = await client.post(f"/api/v1/edges/{edge.json()['id']}/enrollment-token", headers=headers)
        assert token.status_code == 201, token.text
        enrolled = await client.post("/api/v1/edge-sync/enroll", json={"enrollment_token": token.json()["enrollment_token"]})
        assert enrolled.status_code == 200, enrolled.text
        edge_headers = {"Authorization": f"Bearer {enrolled.json()['credential']}"}
        release = await client.post("/api/v1/config-releases/publish", headers=headers, json={"edge_id": edge.json()["id"]})
        assert release.status_code == 201, release.text
        assert release.json()["active_revision"] == 0
        ack = await client.post(
            "/api/v1/edge-sync/ack",
            headers=edge_headers,
            json={"revision": release.json()["revision"], "state": "ACTIVE", "diagnostic": ""},
        )
        assert ack.status_code == 200, ack.text
        moment = datetime.now(timezone.utc)
        newer = _stamp(moment)
        older = _stamp(moment - timedelta(seconds=30))
        payload = {
            "resource_id": machine.json()["id"],
            "signal_id": signal_id,
            "data_type": "float64",
            "unit": "Cel",
            "quality": "GOOD",
            "origin": "LIVE",
            "config_revision": release.json()["revision"],
        }
        first = await client.post(
            "/api/v1/edge-sync/observations",
            headers=edge_headers,
            json={"observations": [{**payload, "event_uid": "edge-01:temp:1", "event_time": newer, "received_time": newer, "value": 49.5}]},
        )
        assert first.status_code == 200, first.text
        assert first.json()["results"][0]["status"] == "committed"
        replay = await client.post(
            "/api/v1/edge-sync/observations",
            headers=edge_headers,
            json={
                "observations": [
                    {**payload, "event_uid": "edge-01:temp:1", "event_time": newer, "received_time": newer, "value": 1, "origin": "REPLAYED"},
                    {**payload, "event_uid": "edge-01:temp:0", "event_time": older, "received_time": newer, "value": 10, "origin": "REPLAYED"},
                ]
            },
        )
        assert replay.status_code == 200, replay.text
        latest = await client.get(f"/api/v1/signals/{signal_id}/latest")
        assert latest.json()["value"] == 49.5
        zero_time = _stamp(moment + timedelta(seconds=1))
        zero = await client.post(
            "/api/v1/edge-sync/observations",
            headers=edge_headers,
            json={"observations": [{**payload, "event_uid": "edge-01:temp:zero", "event_time": zero_time, "received_time": zero_time, "value": 0}]},
        )
        assert zero.status_code == 200, zero.text
        assert (await client.get(f"/api/v1/signals/{signal_id}/latest")).json()["value"] == 0
        formula = await client.post(
            "/api/v1/formulas",
            headers=headers,
            json={
                "resource_id": machine.json()["id"],
                "key": "temp_f",
                "display_name": "Nhiet do F",
                "expression": "temp_c * 9 / 5 + 32",
                "aliases": {"temp_c": signal_id},
                "unit": "F",
            },
        )
        assert formula.status_code == 201, formula.text
        assert (await client.post(f"/api/v1/formulas/{formula.json()['id']}/publish", headers=headers)).status_code == 200
        group = await client.post(
            "/api/v1/output-groups",
            headers=headers,
            json={
                "resource_id": machine.json()["id"],
                "key": "state",
                "display_name": "State",
                "members": [{"signal_id": signal_id, "alias": "temperature"}],
            },
        )
        assert group.status_code == 201, group.text
        preview = await client.get(f"/api/v1/output-groups/{group.json()['id']}/preview")
        assert preview.status_code == 200, preview.text
        assert preview.json()["values"]["temperature"]["value"] == 0
        dashboard = await client.post("/api/v1/dashboards", headers=headers, json={"name": "Chuyen lap rap", "site_id": site_id})
        assert dashboard.status_code == 201, dashboard.text
        drafted = await client.patch(
            f"/api/v1/dashboards/{dashboard.json()['id']}",
            headers=headers,
            json={"version": 1, "draft": {"widgets": [{"id": "w1", "type": "kpi", "bindings": [{"signal_id": signal_id}]}]}},
        )
        assert drafted.status_code == 200, drafted.text
        assert (await client.post(f"/api/v1/dashboards/{dashboard.json()['id']}/publish", headers=headers)).status_code == 200
        overview = await client.get("/api/v1/overview")
        assert overview.json()["machines"] == 1
        assert (await client.get("/api/v1/storage/overview")).json()["observations"] >= 2
        history = await client.get(
            "/api/v1/observations/history",
            params={"signal_id": signal_id, "start": older, "end": _stamp(datetime.now(timezone.utc) + timedelta(minutes=1))},
        )
        assert history.status_code == 200, history.text
        assert any(item["value"] == 0 for item in history.json()["items"])
        assert (await client.post("/api/v1/auth/logout", headers=headers)).status_code == 200
        assert (await client.get("/api/v1/auth/me")).status_code == 401


class _MemoryMailer:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def send_code(self, recipient: str, code: str) -> None:
        self.sent.append((recipient, code))


@pytest.mark.asyncio
async def test_password_reset_code_is_single_use() -> None:
    await _wipe()
    mailer = _MemoryMailer()
    app.state.mailer = mailer
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://localhost") as client:
            created = await client.post(
                "/api/v1/auth/bootstrap",
                headers={"X-Bootstrap-Token": "integration-bootstrap-token"},
                json={"login": "fxadmin", "email": "fxadmin@example.com", "password": "Correct-Horse-9", "display_name": "FactoriX", "tenant_code": "primary"},
            )
            assert created.status_code == 201, created.text
            missing = await client.post("/api/v1/auth/forgot", json={"email": "nobody@example.com"})
            assert missing.status_code == 200, missing.text
            assert missing.json() == {"status": "accepted"}
            assert mailer.sent == []
            asked = await client.post("/api/v1/auth/forgot", json={"email": "FXADMIN@example.com"})
            assert asked.status_code == 200, asked.text
            assert "code" not in asked.json()
            assert len(mailer.sent) == 1
            code = mailer.sent[0][1]
            wrong = await client.post(
                "/api/v1/auth/reset",
                json={"email": "fxadmin@example.com", "code": "000000" if code != "000000" else "000001", "new_password": "Correct-Horse-8"},
            )
            assert wrong.status_code == 401
            still = await client.post("/api/v1/auth/login", json={"login": "fxadmin", "password": "Correct-Horse-9"})
            assert still.status_code == 200, still.text
            changed = await client.post(
                "/api/v1/auth/reset",
                json={"email": "fxadmin@example.com", "code": code, "new_password": "Correct-Horse-8"},
            )
            assert changed.status_code == 200, changed.text
            reused = await client.post(
                "/api/v1/auth/reset",
                json={"email": "fxadmin@example.com", "code": code, "new_password": "Correct-Horse-7"},
            )
            assert reused.status_code == 401
            old = await client.post("/api/v1/auth/login", json={"login": "fxadmin@example.com", "password": "Correct-Horse-9"})
            assert old.status_code == 401
            fresh = await client.post("/api/v1/auth/login", json={"login": "fxadmin@example.com", "password": "Correct-Horse-8"})
            assert fresh.status_code == 200, fresh.text
    finally:
        app.state.mailer = None
        await _wipe()
