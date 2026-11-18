"""Characterization: AMQP telemetry wire format (contract docs/architecture/contracts/obs-batch.md).

Golden bytes live in ``golden/``. A diff here is a wire-format change: it needs a version decision
(ADR-018) before the golden file is regenerated, because acquisition and ingestion of different builds
share the same queues and the same SQLite spool.
"""

from __future__ import annotations

import ast
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest

from factorix.domain.canonical import (
    MAX_OBS_PER_BATCH,
    OBS_BATCH_CONTENT_TYPE,
    OBS_BATCH_HEADER,
    OBS_BATCH_HEADER_VALUE,
    CanonicalObservation,
    CanonicalProvenance,
    ObservationError,
    decode_observation_batch,
    derive_event_uid,
    encode_observation_batch,
)
from factorix.domain.quality import Origin, Quality
from factorix.modules.ingestion_worker import MAX_BATCH_MESSAGE_BYTES, MAX_MESSAGE_BYTES, IngestionWorker
from factorix.platform.broker import BrokerConfig, RabbitMQPublisher, tenant_live_routing_key, tenant_routing_key
from factorix.platform.settings import Settings

GOLDEN = Path(__file__).parent / "golden"
REPO = Path(__file__).resolve().parents[4]

T = UUID("11111111-1111-1111-1111-111111111111")
S = UUID("22222222-2222-2222-2222-222222222222")
R = UUID("33333333-3333-3333-3333-333333333333")
C = UUID("44444444-4444-4444-4444-444444444444")
J = UUID("55555555-5555-5555-5555-555555555555")
F = UUID("66666666-6666-6666-6666-666666666666")
AT = datetime(2026, 11, 18, 4, 30, 0, 123456, tzinfo=timezone.utc)


def _obs(*, acquired_at: datetime = AT, tenant: UUID = T, seq: int = 7) -> CanonicalObservation:
    uid = derive_event_uid(tenant_id=tenant, connection_id=C, source_field_id=F, signal_id=S, acquired_at=acquired_at, sequence_or_key=seq, data_epoch=3)
    return CanonicalObservation(
        event_uid=uid, tenant_id=tenant, signal_id=S, resource_id=R, acquired_at=acquired_at, value_type="float64", value=21.5,
        quality=Quality.GOOD, data_epoch=3, config_revision=9, connection_id=C, acquisition_job_id=J, source_field_id=F,
        source_time=acquired_at, unit="°C", origin=Origin.LIVE, source_sequence=seq,
        provenance=CanonicalProvenance(protocol="modbus_tcp", connection_id=C, job_id=J, source_field_id=F, config_revision=9,
                                       address_kind="holding_register", address_summary="HR 40001"),
    )


def _golden(name: str) -> bytes:
    return (GOLDEN / name).read_bytes().rstrip(b"\r\n")


# ---------------------------------------------------------------------------- v1 observation


def test_event_uid_derivation_is_stable() -> None:
    assert _obs().event_uid == "fx-3-7e2a9e3c002c2aafcecd6ac6e633e389"


def test_v1_observation_golden_bytes() -> None:
    assert _obs().to_json_bytes() == _golden("obs_v1.json")


def test_v1_observation_round_trip_from_golden() -> None:
    decoded = CanonicalObservation.from_json_bytes(_golden("obs_v1.json"))
    assert decoded == _obs()
    assert CanonicalObservation.from_dict(_obs().to_compact_dict()) == _obs()


def test_v1_rejects_other_schema_versions() -> None:
    body = json.loads(_golden("obs_v1.json"))
    body["schema_version"] = 2
    with pytest.raises(ObservationError) as exc:
        CanonicalObservation.from_dict(body)
    assert exc.value.code == "UNSUPPORTED_SCHEMA_VERSION"


# ---------------------------------------------------------------------------- v2 envelope


def test_v2_envelope_golden_bytes() -> None:
    assert encode_observation_batch([_obs()], batch_id="fxb-golden", created_at=AT) == _golden("obs_batch_v2.json")


def test_v2_envelope_decodes_to_identical_observations() -> None:
    batch = decode_observation_batch(_golden("obs_batch_v2.json"))
    assert batch.batch_id == "fxb-golden" and batch.tenant_id == T and batch.created_at == AT
    assert [CanonicalObservation.from_dict(item) for item in batch.items] == [_obs()]


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda b: b.update(envelope_version=3), "UNSUPPORTED_ENVELOPE_VERSION"),
        (lambda b: b.update(count=2), "INVALID_BATCH"),
        (lambda b: b.update(observations=[]), "INVALID_BATCH"),
        (lambda b: b.update(schema="other"), "INVALID_BATCH"),
    ],
)
def test_v2_envelope_shell_validation(mutate, code: str) -> None:
    body = json.loads(_golden("obs_batch_v2.json"))
    mutate(body)
    with pytest.raises(ObservationError) as exc:
        decode_observation_batch(json.dumps(body))
    assert exc.value.code == code


def test_v2_envelope_bounds_and_tenant_rule() -> None:
    other = UUID("77777777-7777-7777-7777-777777777777")
    with pytest.raises(ObservationError) as mixed:
        encode_observation_batch([_obs(), _obs(tenant=other)], batch_id="x")
    assert mixed.value.code == "MIXED_TENANT_BATCH"
    assert MAX_OBS_PER_BATCH == 5000
    assert MAX_BATCH_MESSAGE_BYTES == 4 * 1024 * 1024 and MAX_MESSAGE_BYTES == 262_144


def test_bad_item_does_not_poison_the_envelope_shell() -> None:
    body = json.loads(_golden("obs_batch_v2.json"))
    body["observations"].append("not-an-object")
    body["count"] = 2
    batch = decode_observation_batch(json.dumps(body))
    assert batch.items[1] == {"_invalid_item": "not-an-object"}


# ---------------------------------------------------------------------------- publisher framing


def _publisher(**kw) -> RabbitMQPublisher:
    return RabbitMQPublisher(BrokerConfig(amqp_url="amqp://contract-test/", **kw))


def test_publisher_batch_envelope_matches_canonical_encoder() -> None:
    now = datetime.now(timezone.utc)
    obs = [_obs(acquired_at=now - timedelta(seconds=1), seq=i) for i in range(3)]
    (env,) = _publisher(envelope_mode="batch").build_envelopes(obs)
    assert env.content_type == OBS_BATCH_CONTENT_TYPE == "application/vnd.factorix.obs-batch+json"
    assert env.headers == {OBS_BATCH_HEADER: OBS_BATCH_HEADER_VALUE, "x-tenant-id": str(T), "x-data-epoch": 3, "x-observation-count": 3}
    assert env.message_id.startswith("fxb-") and env.routing_key == tenant_live_routing_key(T)
    batch = decode_observation_batch(env.body)
    assert batch.batch_id == env.message_id
    assert [CanonicalObservation.from_dict(item) for item in batch.items] == obs
    # Same item encoding as the canonical encoder (the publisher splices pre-encoded items).
    canonical = json.loads(encode_observation_batch(obs, batch_id=env.message_id))
    assert json.loads(env.body)["observations"] == canonical["observations"]


def test_both_encoders_keep_the_header_less_detection_prefix() -> None:
    """Ingestion recognises a header-less v2 body (DLQ re-publish) by this prefix in the first 64 bytes."""
    prefix = b'{"schema":"factorix.obs-batch"'
    (env,) = _publisher(envelope_mode="batch").build_envelopes([_obs(acquired_at=datetime.now(timezone.utc))])
    assert env.body.startswith(prefix)
    assert encode_observation_batch([_obs()], batch_id="b").startswith(prefix)
    message = SimpleNamespace(content_type=None)
    assert IngestionWorker._is_batch_message(message, {}, env.body) is True
    assert IngestionWorker._is_batch_message(message, {}, _obs().to_json_bytes()) is False


def test_lane_routing_by_age_at_publish_time() -> None:
    now = datetime.now(timezone.utc)
    young = _obs(acquired_at=now - timedelta(seconds=2), seq=1)
    old = _obs(acquired_at=now - timedelta(seconds=60), seq=2)
    envs = _publisher(envelope_mode="batch").build_envelopes([young, old])
    keys = {env.routing_key: [o.event_uid for o in env.observations] for env in envs}
    assert keys == {tenant_live_routing_key(T): [young.event_uid], tenant_routing_key(T): [old.event_uid]}
    assert tenant_live_routing_key(T) == f"telemetry.live.v1.{T.hex}" and tenant_routing_key(T) == f"telemetry.v1.{T.hex}"


def test_publisher_cuts_envelopes_at_max_obs() -> None:
    now = datetime.now(timezone.utc)
    obs = [_obs(acquired_at=now, seq=i) for i in range(5)]
    envs = _publisher(envelope_mode="batch", batch_max_obs=2).build_envelopes(obs)
    assert [len(e.observations) for e in envs] == [2, 2, 1]


def test_v1_single_message_framing_kill_switch() -> None:
    now = datetime.now(timezone.utc)
    o = _obs(acquired_at=now)
    (env,) = _publisher(envelope_mode="single").build_envelopes([o])
    assert env.content_type == "application/json" and env.message_id == o.event_uid and env.body == o.to_json_bytes()
    assert env.headers == {
        "x-schema-version": 1, "x-data-epoch": 3, "x-config-revision": 9, "x-tenant-id": str(T),
        "x-signal-id": str(S), "x-value-type": "float64", "x-source-sequence": 7,
    }


# ---------------------------------------------------------------------------- topology configuration


QUEUE_ARGUMENT_FIELDS = {
    "queue_name", "live_queue_name", "dlx_name", "dlq_name", "binding_pattern", "live_binding_pattern",
    "max_length_bytes", "live_max_length_bytes", "delivery_limit",
}


def test_acquisition_and_ingestion_declare_identical_queue_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    """CT-08 fixed (R2-E C9): one owner declares the topology (ingestion); acquisition builds its config from the
    same ``BrokerSettings`` section and only checks the exchange passively, so queue arguments cannot diverge."""
    from factorix.platform.settings import BrokerSettings

    src = (REPO / "apps" / "acquisition" / "src" / "factorix_acquisition" / "__main__.py").read_text(encoding="utf-8")
    inline = [n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "BrokerConfig"]
    assert not inline, "acquisition must not build BrokerConfig from a private env subset"
    assert "BrokerConfig.from_settings(BrokerSettings(), declare_topology=False)" in src
    for name, value in {"FACTORIX_RABBITMQ_MAX_LENGTH_BYTES": "1048576", "FACTORIX_RABBITMQ_DELIVERY_LIMIT": "7",
                        "FACTORIX_RABBITMQ_LIVE_QUEUE": "x.live.q", "FACTORIX_RABBITMQ_LIVE_MAX_LENGTH_BYTES": "2097152"}.items():
        monkeypatch.setenv(name, value)
    acq = BrokerConfig.from_settings(BrokerSettings(rabbitmq_url="amqp://contract-test/"), declare_topology=False)
    ing = BrokerConfig.from_settings(Settings.model_construct(**BrokerSettings(rabbitmq_url="amqp://contract-test/").model_dump()))
    assert {f: getattr(acq, f) for f in QUEUE_ARGUMENT_FIELDS} == {f: getattr(ing, f) for f in QUEUE_ARGUMENT_FIELDS}
    assert (acq.delivery_limit, acq.max_length_bytes, acq.live_queue_name) == (7, 1048576, "x.live.q")
    assert ing.declare_topology and not acq.declare_topology


async def test_passive_publisher_never_declares_queues() -> None:
    """The publisher of a non-owner checks the ingress exchange with ``passive=True`` and declares no queue."""
    from factorix.platform import broker as B

    calls: list[tuple[str, dict[str, Any]]] = []

    class Channel:
        is_closed = False

        async def declare_exchange(self, name: str, *_a: Any, **kw: Any) -> Any:
            calls.append((name, kw))
            if kw.get("passive") and name == "missing":
                raise RuntimeError("NOT_FOUND - no exchange")
            return SimpleNamespace(name=name)

        async def declare_queue(self, *_a: Any, **_kw: Any) -> Any:  # pragma: no cover - must not be called
            raise AssertionError("a passive publisher must not declare queues")

    ex = await B.passive_ingress_exchange(Channel(), BrokerConfig(amqp_url="amqp://x/"))  # type: ignore[arg-type]
    assert ex.name == "factorix.telemetry.ingress" and calls[0][1]["passive"] is True
    with pytest.raises(B.BrokerUnavailableError, match="not provisioned"):
        await B.passive_ingress_exchange(Channel(), BrokerConfig(amqp_url="amqp://x/", exchange_name="missing"))  # type: ignore[arg-type]


def test_broker_settings_are_declared() -> None:
    """CT-09 fixed: every setting ``BrokerConfig.from_settings`` reads is declared (no silent getattr default)."""
    real = Settings.model_construct(rabbitmq_url="amqp://contract-test/")
    read: set[str] = set()

    class Spy:
        def __getattr__(self, name: str):
            read.add(name)
            return getattr(real, name)  # undeclared names raise AttributeError -> getattr default

    BrokerConfig.from_settings(Spy())
    assert read - set(Settings.model_fields) == set()
