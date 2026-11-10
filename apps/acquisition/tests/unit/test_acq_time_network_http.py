"""Timestamp formatter, network allowlist and HTTP request budget in factorix_acquisition."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from factorix.domain.network import AllowedEndpoint, NetworkPolicyError, assert_allowed, assert_url, endpoint_from_url, parse_allowlist
from factorix_acquisition.config_provider import endpoints_for
from factorix_acquisition.connectors.errors import CAPABILITIES, ConnectorError
from factorix_acquisition.connectors.http_pull import TokenBucket, parse_retry_after
from factorix_acquisition.timeutil import from_epoch_ms, iso_ms, normalize_time


def test_iso_ms_exactly_three_digits_utc() -> None:
    assert iso_ms(None) is None
    assert iso_ms(datetime(2026, 11, 5, 8, 41, 25, 123456, tzinfo=timezone.utc)) == "2026-11-05T08:41:25.123Z"
    assert iso_ms(datetime(2026, 11, 5, 8, 41, 25, tzinfo=timezone.utc)) == "2026-11-05T08:41:25.000Z"
    plus7 = timezone(timedelta(hours=7))
    assert iso_ms(datetime(2026, 11, 5, 15, 41, 25, 5000, tzinfo=plus7)) == "2026-11-05T08:41:25.005Z"
    assert iso_ms(datetime(2026, 11, 5, 8, 41, 25)) == "2026-11-05T08:41:25.000Z"


def test_epoch_ms_and_normalize() -> None:
    ms = (417 << 32) | (44777 << 16) | 37416
    text = from_epoch_ms(ms)
    assert text.endswith("Z") and len(text) == 24
    assert normalize_time(ms) == text
    assert normalize_time("2026-11-05T08:41:25.123Z") == "2026-11-05T08:41:25.123Z"
    assert normalize_time("2026-11-05T15:41:25.123+07:00") == "2026-11-05T08:41:25.123Z"
    assert normalize_time("2026-11-05T08:41:25.123456Z") == "2026-11-05T08:41:25.123Z"
    assert normalize_time(None) is None
    with pytest.raises(ValueError):
        normalize_time("yesterday")


def test_allowlist_no_port_equivalence_hack() -> None:
    allow = parse_allowlist(["10.0.0.5:18883"])
    with pytest.raises(NetworkPolicyError):
        assert_allowed("10.0.0.5", 1883, allow, scheme="mqtt")


def test_ws_schemes_and_default_ports() -> None:
    assert endpoint_from_url("ws://10.0.0.5/ws/live") == AllowedEndpoint("10.0.0.5", 80, "ws")
    assert endpoint_from_url("wss://10.0.0.5/ws/live") == AllowedEndpoint("10.0.0.5", 443, "wss")
    assert endpoint_from_url("opc.tcp://10.0.0.5/sim/") == AllowedEndpoint("10.0.0.5", 4840, "opc.tcp")
    assert endpoint_from_url("https://10.0.0.5") == AllowedEndpoint("10.0.0.5", 443, "https")
    assert parse_allowlist(["ws://10.0.0.5"]) == [AllowedEndpoint("10.0.0.5", 80, "ws")]
    assert assert_url("ws://10.0.0.5/ws/live", parse_allowlist(["10.0.0.5:80"])) == ("10.0.0.5", 80)
    with pytest.raises(NetworkPolicyError):
        assert_url("ftp://10.0.0.5/", parse_allowlist(["10.0.0.5:21"]))


def test_endpoints_from_connection_configs() -> None:
    assert endpoints_for("modbus_tcp", {"host": "10.0.0.5"}) == [AllowedEndpoint("10.0.0.5", 502, None)]
    assert endpoints_for("mqtt", {"host": "10.0.0.5", "port": 1883}) == [AllowedEndpoint("10.0.0.5", 1883, "mqtt")]
    assert endpoints_for("http", {"base_url": "http://10.0.0.5:443"}) == [AllowedEndpoint("10.0.0.5", 443, "http")]
    assert endpoints_for("websocket", {"url": "ws://10.0.0.5/ws/live"}) == [AllowedEndpoint("10.0.0.5", 80, "ws")]
    assert endpoints_for("opcua", {"endpoint": "opc.tcp://10.0.0.5:4840/sim/"}) == [AllowedEndpoint("10.0.0.5", 4840, "opc.tcp")]
    assert endpoints_for("mqtt", {}) == []
    assert endpoints_for("modbus_tcp", {"host": "10.0.0.5"})[0] in endpoints_for("modbus_tcp", {"host": "10.0.0.5", "port": 502})
    assert_allowed("10.0.0.5", 502, endpoints_for("modbus_tcp", {"host": "10.0.0.5"}))


def test_websocket_capability() -> None:
    assert CAPABILITIES["websocket"]["can_subscribe"] is True
    assert CAPABILITIES["websocket"]["can_poll"] is False


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_token_bucket_burst_then_rate() -> None:
    clock = Clock()
    bucket = TokenBucket(60, clock=clock)
    assert bucket.capacity == 15
    assert sum(bucket.try_take() for _ in range(20)) == 15
    assert bucket.delay() == pytest.approx(1.0)
    clock.now += 1.0
    assert bucket.try_take() is True
    assert bucket.try_take() is False


def test_token_bucket_never_exceeds_source_limit() -> None:
    clock = Clock()
    bucket = TokenBucket(60, clock=clock)
    sent = 0
    for _ in range(600):
        while bucket.try_take():
            sent += 1
        clock.now += 0.1
    assert sent <= 120


def test_token_bucket_retry_after_blocks() -> None:
    clock = Clock()
    bucket = TokenBucket(60, clock=clock)
    bucket.block(30)
    assert bucket.try_take() is False
    assert bucket.delay() == pytest.approx(30.0)
    clock.now += 31
    assert bucket.try_take() is True


@pytest.mark.asyncio
async def test_token_bucket_acquire_gives_up_with_rate_limited() -> None:
    bucket = TokenBucket(60)
    bucket.block(10)
    with pytest.raises(ConnectorError) as raised:
        await bucket.acquire(max_wait_s=0.05)
    assert raised.value.code == "RATE_LIMITED"
    assert raised.value.retry_after == pytest.approx(10.0, abs=0.5)


def test_parse_retry_after() -> None:
    assert parse_retry_after("12") == 12.0
    assert parse_retry_after(None, 60.0) == 60.0
    assert 0 <= parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") <= 1
