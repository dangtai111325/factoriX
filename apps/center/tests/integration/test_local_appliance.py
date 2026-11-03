"""Local appliance enrollment must never replace another Site implicitly."""

import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from sqlalchemy import text

from test_support.center import authenticated_center


@pytest_asyncio.fixture
async def appliance(tmp_path, monkeypatch):
    from factorix.transport import app as transport

    async with authenticated_center() as client:
        credential = tmp_path / "edge-credential"
        enrollment = tmp_path / "enrollment"
        config = transport.settings.model_copy(update={
            "appliance": True, "data_dir": str(tmp_path), "credential_path": str(credential),
            "enrollment_file": str(enrollment), "data_key": Fernet.generate_key().decode(),
        })
        monkeypatch.setattr(transport, "settings", config)
        yield SimpleNamespace(client=client, credential=credential, enrollment=enrollment, config=config)


async def site(appliance, code):
    response = await appliance.client.post("/api/v1/resources", json={
        "type_key": "site", "code": code, "name": code, "create_edge": True,
    })
    assert response.status_code == 201, response.text
    return response.json()


async def token_count():
    from factorix.platform.db import session_factory

    async with session_factory()() as session:
        return (await session.execute(text("SELECT count(*) FROM edge_enrollment_tokens"))).scalar_one()


@pytest.mark.asyncio
async def test_site_creation_does_not_enroll_and_explicit_request_cannot_replace_another_site(appliance):
    first, second = await site(appliance, "One"), await site(appliance, "Two")
    initial = await appliance.client.get("/api/v1/appliance")
    assert initial.status_code == 200, initial.text
    assert initial.json()["state"] == "AVAILABLE" and initial.json()["available"] is True
    assert not appliance.enrollment.exists() and await token_count() == 0
    queued = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert queued.status_code == 201, queued.text
    assert "enrollment_token" not in queued.json()
    assert appliance.enrollment.exists()
    original = appliance.enrollment.read_text()
    denied = await appliance.client.post(f"/api/v1/edges/{second['edge']['id']}/appliance")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "APPLIANCE_ASSIGNED", denied.text
    assert appliance.enrollment.read_text() == original and await token_count() == 1


@pytest.mark.asyncio
async def test_simultaneous_requests_claim_only_one_local_appliance(appliance):
    first, second = await site(appliance, "One"), await site(appliance, "Two")
    responses = await asyncio.gather(*[
        appliance.client.post(f"/api/v1/edges/{node['edge']['id']}/appliance") for node in (first, second)
    ])
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert await token_count() == 1
    current = (await appliance.client.get("/api/v1/appliance")).json()
    assert current["state"] == "QUEUED" and current["available"] is False
    assert current["edge_id"] in {first["edge"]["id"], second["edge"]["id"]}


@pytest.mark.asyncio
async def test_existing_local_credential_is_recognized_and_never_rotated_by_queue(appliance):
    first, second = await site(appliance, "One"), await site(appliance, "Two")
    issued = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/enrollment-token")
    assert issued.status_code == 201
    enrolled = await appliance.client.post("/api/v1/edge-sync/enroll", json={"enrollment_token": issued.json()["enrollment_token"]})
    assert enrolled.status_code == 200
    credential = enrolled.json()["credential"]
    appliance.credential.write_text(credential)
    current = await appliance.client.get("/api/v1/appliance")
    assert current.status_code == 200 and current.json()["state"] == "BOUND", current.text
    assert current.json()["edge_id"] == first["edge"]["id"]
    same = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert same.status_code == 201 and same.json()["status"] == "already_enrolled", same.text
    other = await appliance.client.post(f"/api/v1/edges/{second['edge']['id']}/appliance")
    assert other.status_code == 409, other.text
    assert appliance.credential.read_text() == credential
    assert not appliance.enrollment.exists() and await token_count() == 1
    assert credential not in current.text and credential not in other.text


@pytest.mark.asyncio
async def test_failed_file_delivery_retains_a_durable_same_edge_retry_without_new_token(appliance, monkeypatch):
    from factorix.modules.appliance import LocalApplianceFiles

    first, second = await site(appliance, "One"), await site(appliance, "Two")
    publish = LocalApplianceFiles.publish

    def unavailable(*args, **kwargs):
        raise OSError("Controlled delivery failure")

    monkeypatch.setattr(LocalApplianceFiles, "publish", unavailable)
    requested = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert requested.status_code == 201 and requested.json()["status"] == "pending", requested.text
    assert not appliance.enrollment.exists() and await token_count() == 1
    current = (await appliance.client.get("/api/v1/appliance")).json()
    assert current["state"] == "DELIVERY_PENDING" and current["edge_id"] == first["edge"]["id"]
    denied = await appliance.client.post(f"/api/v1/edges/{second['edge']['id']}/appliance")
    assert denied.status_code == 409, denied.text
    monkeypatch.setattr(LocalApplianceFiles, "publish", publish)
    retried = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert retried.status_code == 201 and appliance.enrollment.exists(), retried.text
    assert await token_count() == 1
    from factorix.platform.db import session_factory

    async with session_factory()() as session:
        ciphertext = (await session.execute(text("SELECT token_ciphertext FROM appliance_bindings WHERE slot = 'local'"))).scalar_one()
    assert appliance.enrollment.read_text().encode() not in bytes(ciphertext)


@pytest.mark.asyncio
async def test_legacy_pending_token_is_adopted_without_overwriting_it(appliance):
    first, second = await site(appliance, "One"), await site(appliance, "Two")
    issued = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/enrollment-token")
    assert issued.status_code == 201
    token = issued.json()["enrollment_token"]
    appliance.enrollment.write_text(token)
    denied = await appliance.client.post(f"/api/v1/edges/{second['edge']['id']}/appliance")
    assert denied.status_code == 409, denied.text
    same = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert same.status_code == 201 and appliance.enrollment.read_text() == token
    assert await token_count() == 1
    assert token not in denied.text and token not in same.text


@pytest.mark.asyncio
async def test_rollback_never_publishes_token_or_keeps_a_claim(appliance):
    from factorix.modules.appliance import LocalAppliance
    from factorix.platform.after_commit import discard, flush
    from factorix.platform.db import session_factory

    first = await site(appliance, "One")
    async with session_factory()() as session:
        principal = (await session.execute(text("SELECT id, tenant_id FROM admin_accounts LIMIT 1"))).mappings().one()
        edge_id = (await session.execute(text("SELECT id FROM edge_nodes WHERE id = CAST(:id AS uuid)"), {"id": first["edge"]["id"]})).scalar_one()
        result = await LocalAppliance(session, appliance.config).request(principal["tenant_id"], principal["id"], edge_id, "test-rollback")
        assert result["status"] == "pending" and not appliance.enrollment.exists()
        discard(session)
        await session.rollback()
        await flush(session)
    assert not appliance.enrollment.exists() and await token_count() == 0
    async with session_factory()() as session:
        assert (await session.execute(text("SELECT count(*) FROM appliance_bindings"))).scalar_one() == 0


@pytest.mark.asyncio
async def test_expired_request_can_retry_only_its_original_edge(appliance):
    from factorix.platform.db import session_factory

    first, second = await site(appliance, "One"), await site(appliance, "Two")
    queued = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert queued.status_code == 201
    original = appliance.enrollment.read_text()
    async with session_factory()() as session:
        await session.execute(text("UPDATE edge_enrollment_tokens SET expires_at = now() - interval '1 second'"))
        await session.execute(text("UPDATE appliance_bindings SET token_expires_at = now() - interval '1 second'"))
        await session.commit()
    current = (await appliance.client.get("/api/v1/appliance")).json()
    assert current["state"] == "EXPIRED" and current["available"] is False
    denied = await appliance.client.post(f"/api/v1/edges/{second['edge']['id']}/appliance")
    assert denied.status_code == 409
    retry = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert retry.status_code == 201
    assert appliance.enrollment.read_text() != original and await token_count() == 2


@pytest.mark.asyncio
async def test_other_tenants_local_identity_is_not_exposed_or_reassigned(appliance):
    from factorix.platform.db import session_factory
    from factorix.platform.security import hash_token

    own = await site(appliance, "Own")
    tenant, scope, edge = uuid4(), uuid4(), uuid4()
    credential = "foreign-test-only-credential"
    async with session_factory()() as session:
        await session.execute(text("INSERT INTO tenants (id, code, display_name, created_at) VALUES (:id, 'private', 'Private tenant', now())"), {"id": tenant})
        await session.execute(text("INSERT INTO sites (id, tenant_id, code, name, created_at) VALUES (:id, :tenant, 'Private', 'Private Site', now())"), {"id": scope, "tenant": tenant})
        await session.execute(text("INSERT INTO edge_nodes (id, tenant_id, site_id, name, enrollment_status, credential_hash, created_at) VALUES (:id, :tenant, :site, 'Private Edge', 'ENROLLED', :hash, now())"), {"id": edge, "tenant": tenant, "site": scope, "hash": hash_token(credential)})
        await session.commit()
    appliance.credential.write_text(credential)
    current = await appliance.client.get("/api/v1/appliance")
    assert current.status_code == 200 and current.json()["state"] == "BOUND"
    assert current.json()["edge_id"] is None and current.json()["site_id"] is None
    foreign = await appliance.client.post(f"/api/v1/edges/{edge}/appliance")
    assert foreign.status_code == 404
    other = await appliance.client.post(f"/api/v1/edges/{own['edge']['id']}/appliance")
    assert other.status_code == 409
    assert credential not in current.text + foreign.text + other.text
    assert "Private" not in current.text + foreign.text + other.text
    assert appliance.credential.read_text() == credential and not appliance.enrollment.exists()


@pytest.mark.asyncio
async def test_csrf_denial_never_claims_or_delivers_an_enrollment(appliance):
    first = await site(appliance, "One")
    response = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance", headers={"X-CSRF-Token": "wrong"})
    assert response.status_code == 403 and response.json()["error"]["code"] == "CSRF"
    assert not appliance.enrollment.exists() and await token_count() == 0
    assert (await appliance.client.get("/api/v1/appliance")).json()["state"] == "AVAILABLE"


@pytest.mark.asyncio
async def test_authorized_disposable_reset_clears_binding_files_and_keeps_migration(appliance):
    from factorix.platform.db import session_factory

    async with session_factory()() as session:
        revision = (await session.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
    first = await site(appliance, "One")
    queued = await appliance.client.post(f"/api/v1/edges/{first['edge']['id']}/appliance")
    assert queued.status_code == 201 and appliance.enrollment.exists()
    response = await appliance.client.post("/api/v1/admin/revert-to-zero", json={"confirm": "REVERT"})
    assert response.status_code == 200, response.text
    assert not appliance.enrollment.exists()
    async with session_factory()() as session:
        assert (await session.execute(text("SELECT count(*) FROM appliance_bindings"))).scalar_one() == 0
        assert (await session.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == revision
