"""Actual temporary MQTT subscriber, bounded results and nonblocking Edge ownership."""

import asyncio
import json
import threading
import time

import httpx
import pytest

from factorix.domain.network import AllowedEndpoint
from factorix_edge.connectors.mqtt import MqttMessage
from factorix_edge.topic_capture import CaptureBuffer, TopicCaptureService, capture_topics


def message(topic, payload, stamp='2026-11-03T01:00:00Z'):
    return MqttMessage(topic, payload, stamp, len(json.dumps(payload)), stamp)


def test_capture_buffer_is_latest_only_and_bounds_topic_and_byte_counts():
    buffer = CaptureBuffer(max_topics=2, max_result_bytes=1600, max_sample_bytes=80)
    buffer.add(message('f/a', {'employee': '0007', 'qty': 0}))
    buffer.add(message('f/a', {'employee': '0008', 'qty': 1}))
    buffer.add(message('f/b', 'x' * 200))
    result = buffer.result(received=3, dropped=0)
    assert len(result['samples']) == 2
    assert result['samples'][0]['payload'] == {'employee': '0008', 'qty': 1}
    assert result['samples'][1]['error'] == 'SAMPLE_TOO_LARGE' and result['samples'][1]['payload'] is None
    assert result['truncated'] is True
    buffer.add(message('f/c', False))
    result = buffer.result(received=4, dropped=0)
    assert [s['topic'] for s in result['samples']] == ['f/b', 'f/c']
    assert result['dropped'] == 1
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= 1600


def test_capture_byte_budget_and_out_of_order_messages_remain_bounded():
    buffer = CaptureBuffer(max_topics=2000, max_result_bytes=4000, max_sample_bytes=1000)
    for at in range(1000):
        buffer.add(message(f'f/{at}', {'v': 'x' * 600}))
    buffer.add(message('f/999', {'v': 'old'}, '2026-11-03T00:59:00Z'))
    result = buffer.result(received=1001, dropped=0)
    assert result['dropped'] > 990 and result['truncated'] is True
    assert result['samples'][-1]['payload'] == {'v': 'x' * 600}
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= 4000


@pytest.mark.asyncio
async def test_capture_uses_real_separate_clean_mqtt_client_and_closes(mqtt_broker):
    with mqtt_broker() as broker:
        result = await asyncio.to_thread(capture_topics, {'host': '127.0.0.1', 'port': broker['port'], 'client_id': 'LIVE-DO-NOT-REUSE',
            'clean_session': False, 'session_expiry': 100, 'protocol_version': '3.1.1'}, 'factory/#',
            [AllowedEndpoint('127.0.0.1', broker['port'])], None, threading.Event(), .2)
    assert result['status'] == 'COMPLETED' and result['received'] == 1
    assert result['samples'][0]['topic'] == 'factory/m1/state'
    assert result['samples'][0]['payload']['employee'] == '0021113185'
    assert b'LIVE-DO-NOT-REUSE' not in broker['connect'] and b'fx-capture-' in broker['connect']
    assert broker['connect'][7] & 2  # Clean session, independent of the live client setting.
    assert broker['after_subscribe_kind'] == 0xE0  # MQTT DISCONNECT; no PUBLISH/write packet.


@pytest.mark.asyncio
async def test_capture_cancellation_joins_temporary_subscriber_without_waiting_full_window(mqtt_broker):
    stop = threading.Event()
    with mqtt_broker() as broker:
        task = asyncio.create_task(asyncio.to_thread(capture_topics, {'host': '127.0.0.1', 'port': broker['port']},
            'factory/#', [AllowedEndpoint('127.0.0.1', broker['port'])], None, stop, 30))
        await asyncio.sleep(.1)
        started = time.monotonic()
        stop.set()
        result = await asyncio.wait_for(task, 2)
        assert time.monotonic() - started < 2
    assert result['status'] == 'FAILED' and result['error_code'] == 'CANCELLED'


@pytest.mark.asyncio
async def test_capture_auth_failure_is_explicit_and_never_exposes_password(mqtt_broker):
    with mqtt_broker(reject_auth=True) as broker:
        result = await asyncio.to_thread(capture_topics, {'host': '127.0.0.1', 'port': broker['port'], 'username': 'test-user'},
            'factory/#', [AllowedEndpoint('127.0.0.1', broker['port'])], 'test-password-not-in-output', threading.Event(), .2)
    assert result['status'] == 'FAILED' and result['error_code'] == 'AUTH'
    assert 'test-password' not in json.dumps(result)


@pytest.mark.asyncio
async def test_capture_service_does_not_block_cycle_and_cancels_actual_background_worker(mqtt_broker):
    with mqtt_broker() as broker:
        state = {'status': 'RUNNING', 'pulls': 0}

        async def request(method, path, body=None):
            if path.endswith('/topic-captures'):
                state['pulls'] += 1
                return {'job': {'id': 'capture-1', 'duration_s': 30, 'topic_filter': 'factory/#',
                    'config_json': {'host': '127.0.0.1', 'port': broker['port']}}}
            return {'status': state['status']}

        service = TopicCaptureService(request, [AllowedEndpoint('127.0.0.1', broker['port'])])
        started = time.monotonic()
        await service.tick()
        assert time.monotonic() - started < .1  # Subscription work is not awaited by the collector cycle.
        await asyncio.sleep(.1)
        await service.tick()
        assert state['pulls'] == 1
        state['status'] = 'CANCELLED'
        await service.tick()
        await asyncio.wait_for(service.close(), 2)
        assert not service.active


@pytest.mark.asyncio
async def test_capture_service_retries_result_ack_without_resubscribing(mqtt_broker):
    with mqtt_broker() as broker:
        calls, posts = [], []

        async def request(method, path, body=None):
            calls.append((method, path))
            if method == 'POST':
                posts.append(body)
                if len(posts) == 1:
                    raise httpx.ReadTimeout('Lost acknowledgment')
                return {'status': 'COMPLETED'}
            if path.endswith('/topic-captures'):
                return {'job': {'id': 'capture-1', 'duration_s': .15, 'topic_filter': 'factory/#',
                    'config_json': {'host': '127.0.0.1', 'port': broker['port']}}}
            return {'status': 'RUNNING'}

        service = TopicCaptureService(request, [AllowedEndpoint('127.0.0.1', broker['port'])])
        try:
            await service.tick()
            for _ in range(80):
                try:
                    await service.tick()
                except httpx.ReadTimeout:
                    break
                await asyncio.sleep(.02)
            assert len(posts) == 1
            await service.tick()
            assert len(posts) == 2 and posts[0] == posts[1]
            assert sum(path.endswith('/topic-captures') for _, path in calls) == 1
        finally:
            await service.close()


@pytest.mark.asyncio
async def test_actual_edge_cycles_keep_heartbeats_while_capture_worker_is_running(tmp_path, mqtt_broker):
    from factorix_edge.runtime import EdgeRuntime
    from factorix_edge.store.outbox import Outbox

    heartbeats = []
    with mqtt_broker() as broker:
        def center(request):
            if request.url.path.endswith('/topic-captures'):
                return httpx.Response(200, json={'job': {'id': 'concurrent-capture', 'duration_s': 30, 'topic_filter': 'factory/#',
                    'config_json': {'host': '127.0.0.1', 'port': broker['port']}}})
            if request.url.path.endswith('/concurrent-capture'):
                return httpx.Response(200, json={'status':'RUNNING'})
            if request.url.path.endswith('/heartbeat'):
                heartbeats.append(json.loads(request.content))
            return httpx.Response(200, json={'job':None})

        async with httpx.AsyncClient(transport=httpx.MockTransport(center), base_url='http://center.test') as client:
            outbox = Outbox(tmp_path / 'capture-heartbeat.sqlite')
            runtime = EdgeRuntime(client, 'test-only', [f"127.0.0.1:{broker['port']}"], outbox)
            try:
                await runtime.cycle()
                await asyncio.sleep(.1)
                await asyncio.wait_for(runtime.cycle(), .5)
                assert len(heartbeats) == 2
                assert runtime.topic_capture.active
            finally:
                await runtime.close()
                outbox.close()
