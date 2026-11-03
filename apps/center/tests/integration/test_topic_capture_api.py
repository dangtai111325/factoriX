"""Read-only capture ownership and lifecycle on disposable Postgres."""

import asyncio
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text

from test_support.center import authenticated_center


@pytest_asyncio.fixture
async def capture_setup():
    async with authenticated_center() as client:
        site = (await client.post('/api/v1/sites', json={'code': 'S', 'name': 'Site', 'timezone': 'UTC'})).json()
        edge = (await client.post('/api/v1/edges', json={'name': 'capture-edge', 'site_id': site['id']})).json()
        token = (await client.post(f"/api/v1/edges/{edge['id']}/enrollment-token")).json()
        credential = (await client.post('/api/v1/edge-sync/enroll', json={'enrollment_token': token['enrollment_token']})).json()['credential']
        connection = await client.post('/api/v1/connections', json={
            'name': 'capture-mqtt', 'site_id': site['id'], 'edge_id': edge['id'], 'protocol': 'mqtt_client',
            'config': {'host': '127.0.0.1', 'topics': ['factory/+/state', 'factory/line/#'], 'anonymous': True},
        })
        assert connection.status_code == 201, connection.text
        yield client, connection.json(), {'Authorization': f'Bearer {credential}'}, edge


async def queue(client, connection, **overrides):
    response = await client.post(f"/api/v1/connections/{connection['id']}/topic-captures", json={
        'topic_filter': 'factory/line/#', 'duration_s': 2, **overrides,
    })
    return response


def sample_result():
    return {'status': 'COMPLETED', 'samples': [{'topic': 'factory/line/order', 'payload': {'employee': '0007', 'qty': 0},
            'received_time': '2026-11-03T01:00:00Z', 'source_time': None, 'error': None}],
            'received': 3, 'dropped': 0, 'truncated': False}


@pytest.mark.asyncio
async def test_capture_real_lifecycle_filters_secrets_and_safe_ack_retry(capture_setup):
    client, connection, headers, _ = capture_setup
    queued = await queue(client, connection)
    assert queued.status_code == 202, queued.text
    job = queued.json()
    assert job['status'] == 'PENDING'
    public = (await client.get(f"/api/v1/topic-captures/{job['id']}")).json()
    assert not {'config_json', 'secret_ref', 'credential', 'samples'} & public.keys()
    pulled = await client.get('/api/v1/edge-sync/topic-captures', headers=headers)
    assert pulled.status_code == 200, pulled.text
    command = pulled.json()['job']
    assert command['id'] == job['id'] and command['topic_filter'] == 'factory/line/#'
    assert command['config_json']['host'] == '127.0.0.1'
    assert (await client.get('/api/v1/edge-sync/topic-captures', headers=headers)).json()['job'] is None
    finished = await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=sample_result())
    assert finished.status_code == 200, finished.text
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=sample_result())).status_code == 200
    public = (await client.get(f"/api/v1/topic-captures/{job['id']}")).json()
    assert public['samples'][0]['payload'] == {'employee': '0007', 'qty': 0}
    assert public['received'] == 3 and public['status'] == 'COMPLETED'
    different = {**sample_result(), 'received': 99}
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=different)).status_code == 409


@pytest.mark.asyncio
async def test_capture_narrows_configured_filters_and_bounds_input(capture_setup):
    client, connection, _, _ = capture_setup
    for topic in ['#', 'factory/#', 'factory/+/+', 'factory/line/#/bad', 'factory/line/+tail', 'other/line/#']:
        response = await queue(client, connection, topic_filter=topic)
        assert response.status_code == 422, (topic, response.text)
    assert (await queue(client, connection, duration_s=31)).status_code == 422
    assert (await queue(client, connection, topic_filter='factory/machine/state')).status_code == 202


@pytest.mark.asyncio
async def test_capture_one_active_slot_per_edge_under_concurrent_requests(capture_setup):
    client, connection, _, _ = capture_setup
    responses = await asyncio.gather(queue(client, connection), queue(client, connection))
    assert sorted(item.status_code for item in responses) == [202, 409], [r.text for r in responses]
    assert next(r for r in responses if r.status_code == 409).json()['error']['code'] == 'CAPTURE_BUSY'


@pytest.mark.asyncio
@pytest.mark.parametrize('claim', [False, True])
async def test_capture_cancel_is_idempotent_and_late_result_cannot_restore_it(capture_setup, claim):
    client, connection, headers, _ = capture_setup
    response = await queue(client, connection)
    assert response.status_code == 202, response.text
    job = response.json()
    if claim:
        await client.get('/api/v1/edge-sync/topic-captures', headers=headers)
    for _ in range(2):
        cancelled = await client.post(f"/api/v1/topic-captures/{job['id']}/cancel")
        assert cancelled.status_code == 200 and cancelled.json()['status'] == 'CANCELLED'
    assert (await client.get('/api/v1/edge-sync/topic-captures', headers=headers)).json()['job'] is None
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=sample_result())).status_code == 409
    assert (await queue(client, connection)).status_code == 202


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation,error', [('expiry', 'TIMEOUT'), ('version', 'CONFIG_CHANGED')])
async def test_capture_expiry_or_config_change_rejects_stale_results(capture_setup, mutation, error):
    from factorix.platform.db import session_factory

    client, connection, headers, _ = capture_setup
    response = await queue(client, connection)
    assert response.status_code == 202, response.text
    job = response.json()
    await client.get('/api/v1/edge-sync/topic-captures', headers=headers)
    async with session_factory()() as session:
        statement = ("UPDATE mqtt_topic_captures SET expires_at=now()-interval '1 second' WHERE id=:id" if mutation == 'expiry'
                     else 'UPDATE connections SET version=version+1 WHERE id=:id')
        await session.execute(text(statement), {'id': job['id'] if mutation == 'expiry' else connection['id']})
        await session.commit()
    public = await client.get(f"/api/v1/topic-captures/{job['id']}")
    assert public.status_code == 200 and public.json()['error_code'] == error, public.text
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=sample_result())).status_code == 409


@pytest.mark.asyncio
async def test_capture_edge_ownership_and_result_validation(capture_setup):
    client, connection, headers, edge = capture_setup
    response = await queue(client, connection)
    assert response.status_code == 202, response.text
    job = response.json()
    other = (await client.post('/api/v1/edges', json={'name': 'other', 'site_id': edge['site_id']})).json()
    token = (await client.post(f"/api/v1/edges/{other['id']}/enrollment-token")).json()
    credential = (await client.post('/api/v1/edge-sync/enroll', json={'enrollment_token': token['enrollment_token']})).json()['credential']
    foreign = {'Authorization': f'Bearer {credential}'}
    assert (await client.get('/api/v1/edge-sync/topic-captures', headers=foreign)).json()['job'] is None
    assert (await client.get(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=foreign)).status_code == 404
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=foreign, json=sample_result())).status_code == 404
    await client.get('/api/v1/edge-sync/topic-captures', headers=headers)
    bad = {**sample_result(), 'samples': []}
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=bad)).status_code == 422
    bad = sample_result()
    bad['samples'][0]['topic'] = 'other/secret'
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=bad)).status_code == 422
    bad = sample_result()
    bad['samples'][0]['payload'] = 'x' * 65536
    assert (await client.post(f"/api/v1/edge-sync/topic-captures/{job['id']}", headers=headers, json=bad)).status_code == 422
    assert (await client.get(f'/api/v1/topic-captures/{uuid4()}')).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize('address,code', [
    ({'jsonpath':'$.employee'}, 'TOPIC_REQUIRED'),
    ({'topic':'other/#','jsonpath':'$.employee'}, 'TOPIC_SCOPE'),
    ({'topic':'factory/line/#/bad','jsonpath':'$.employee'}, 'TOPIC'),
    ({'topic':'factory/line/state','jsonpath':'$.['}, 'JSONPATH'),
    ({'topic':'factory/line/state','jsonpath':'$.employee','qos':3}, 'QOS'),
])
async def test_new_mqtt_mapping_rejects_ambiguous_or_invalid_address_before_test_or_activation(capture_setup, address, code):
    client, connection, _, _ = capture_setup
    field = {'name':'Employee','data_type':'string','address':address}
    response = await client.post(f"/api/v1/connections/{connection['id']}/tests", json={'fields':[field]})
    assert response.status_code == 422 and response.json()['error']['field_errors'][0]['code'] == code, response.text
    machine = await client.post('/api/v1/resources',json={'type_key':'machine','code':'M','name':'Machine','site_id':connection['site_id']})
    assert machine.status_code == 201, machine.text
    response = await client.post('/api/v1/signals/bulk',json={'resource_id':machine.json()['id'],'items':[{
        'key':'employee','name':'Employee','data_type':'string','source_field':{
            'acquisition_job_id':connection['jobs'][0]['id'],'address_kind':'mqtt','address':address},
    }]})
    assert response.status_code == 422 and response.json()['error']['field_errors'][0]['code'] == code, response.text
    assert (await client.get('/api/v1/signals')).json()['items'] == []
