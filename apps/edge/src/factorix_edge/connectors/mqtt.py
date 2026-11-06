"""MQTT subscriber bridged into asyncio. This client never publishes.

paho runs its network loop in a background thread. ``on_message`` stamps the arrival
time there and hands the message to the event loop with ``call_soon_threadsafe``; no
code in the event loop ever blocks on a thread primitive. Each consumer (an acquisition
job, a capture, a test) owns a bounded ``MqttListener`` queue. The subscribed topic set
is the union of the consumers' topics and can change without rebuilding the client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from typing import Any

import paho.mqtt.client as mqtt

from factorix.domain.network import AllowedEndpoint, assert_allowed
from factorix_edge.aio import bounded
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.timeutil import from_epoch

logger = logging.getLogger(__name__)

# MQTT 3.1.1 CONNACK 4/5 and MQTT 5 reason codes for rejected credentials.
_AUTH_CODES = {4, 5, 134, 135}

Message = tuple[str, Any, str, str]  # (topic, decoded JSON payload, arrival time ISO, payload text as received)


class MqttListener:
    """A bounded queue of messages for one consumer. Oldest messages drop when full."""

    def __init__(self, maxsize: int = 10_000, topics: list[str] | None = None) -> None:
        self.queue: asyncio.Queue[Message] = asyncio.Queue(maxsize=maxsize)
        self.topics = list(topics or [])
        self.dropped = 0

    def put(self, item: Message) -> None:
        if self.topics and not any(mqtt.topic_matches_sub(sub, item[0]) for sub in self.topics):
            return
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self.dropped += 1
        self.queue.put_nowait(item)

    def drain_nowait(self) -> list[Message]:
        items: list[Message] = []
        while True:
            try:
                items.append(self.queue.get_nowait())
            except asyncio.QueueEmpty:
                return items


class MqttConnector:
    can_write = False

    def __init__(
        self,
        host: str,
        port: int,
        allowlist: list[AllowedEndpoint],
        client_id: str,
        username: str | None = None,
        password: str | None = None,
        keepalive: int = 60,
        clean_session: bool = True,
        tls: bool = False,
        ca_pem: str | None = None,
        tls_insecure: bool = False,
        protocol_version: str = "3.1.1",
    ) -> None:
        assert_allowed(host, port, allowlist, scheme="mqtt")
        self.host = host
        self.port = port
        self.client_id = client_id
        self.keepalive = max(5, min(int(keepalive or 60), 3600))
        self.clean_session = bool(clean_session)
        self.username = username or None
        self.password = password
        self.protocol_version = mqtt.MQTTv5 if str(protocol_version).strip() in {"5", "5.0"} else mqtt.MQTTv311
        self.tls = bool(tls)
        self.tls_insecure = bool(tls_insecure)
        self._ca_path: str | None = None
        if self.tls and ca_pem:
            with tempfile.NamedTemporaryFile("w", delete=False, suffix=".pem") as handle:
                handle.write(ca_pem)
                self._ca_path = handle.name
        self.client = self._build_client(client_id)

        self.state = "DOWN"
        self.last_error_code: str | None = None
        self.last_error: str | None = None
        self.last_message_at: str | None = None
        self.messages = 0
        self.decode_errors = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._listeners: list[MqttListener] = []
        self._topics_by_owner: dict[str, dict[str, int]] = {}
        self._subscribed: dict[str, int] = {}
        self._started = False
        self._connected_event: asyncio.Event | None = None

    def _build_client(self, client_id: str) -> mqtt.Client:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, protocol=self.protocol_version, clean_session=self.clean_session if self.protocol_version != mqtt.MQTTv5 else None)
        if self.username:
            client.username_pw_set(self.username, self.password or None)
        if self.tls:
            client.tls_set(ca_certs=self._ca_path) if self._ca_path else client.tls_set()
            if self.tls_insecure:
                client.tls_insecure_set(True)
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_connect_fail = self._on_connect_fail
        client.on_message = self.on_message
        return client

    # ---- consumers and topics (event loop) ----

    def add_listener(self, topics: list[str] | None = None, maxsize: int = 10_000) -> MqttListener:
        listener = MqttListener(maxsize=maxsize, topics=topics)
        self._listeners.append(listener)
        return listener

    def remove_listener(self, listener: MqttListener) -> None:
        if listener in self._listeners:
            self._listeners.remove(listener)

    @property
    def queue_length(self) -> int:
        return sum(listener.queue.qsize() for listener in self._listeners)

    @property
    def dropped(self) -> int:
        return sum(listener.dropped for listener in self._listeners)

    def set_topics(self, owner: str, topics: list[tuple[str, int]]) -> None:
        """Register the topics one consumer needs and apply the union to the broker."""
        if topics:
            self._topics_by_owner[owner] = {topic: max(0, min(int(qos), 2)) for topic, qos in topics}
        else:
            self._topics_by_owner.pop(owner, None)
        self._apply_subscriptions()

    def wanted_topics(self) -> dict[str, int]:
        wanted: dict[str, int] = {}
        for topics in self._topics_by_owner.values():
            for topic, qos in topics.items():
                wanted[topic] = max(qos, wanted.get(topic, 0))
        return wanted

    def _apply_subscriptions(self) -> None:
        if self.state != "UP":
            return  # on_connect subscribes the current set
        wanted = self.wanted_topics()
        removed = [topic for topic in self._subscribed if topic not in wanted]
        added = [(topic, qos) for topic, qos in wanted.items() if self._subscribed.get(topic) != qos]
        if removed:
            self.client.unsubscribe(removed)
        if added:
            self.client.subscribe(added)
        self._subscribed = dict(wanted)

    # ---- lifecycle ----

    async def start(self) -> None:
        """Connect in the background. paho reconnects with 1..30 s backoff."""
        if self._started:
            return
        self._loop = asyncio.get_running_loop()
        self._connected_event = asyncio.Event()
        try:
            self.client.connect_async(self.host, self.port, keepalive=self.keepalive)
        except (OSError, ValueError) as exc:
            raise ConnectorError("NETWORK", f"Cannot connect to MQTT broker {self.host}:{self.port}.") from exc
        self.client.loop_start()
        self._started = True

    async def wait_connected(self, timeout_s: float) -> None:
        """Wait for the first CONNACK. Raises ConnectorError (NETWORK/AUTH/TIMEOUT)."""
        if self.state == "UP":
            return
        assert self._connected_event is not None, "start() first"
        deadline = time.monotonic() + timeout_s
        while self.state != "UP":
            if self.state == "AUTH_FAILED":
                raise ConnectorError("AUTH", self.last_error or "MQTT broker rejected the credentials.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self.last_error_code == "NETWORK":
                    raise ConnectorError("NETWORK", self.last_error or f"Cannot connect to MQTT broker {self.host}:{self.port}.")
                raise ConnectorError("TIMEOUT", f"MQTT broker {self.host}:{self.port} did not accept the connection in time.")
            self._connected_event.clear()
            try:
                await bounded(self._connected_event.wait(), timeout=min(remaining, 0.5))
            except asyncio.TimeoutError:
                continue

    async def close(self) -> None:
        if self._started:
            self._started = False
            self.client.disconnect()
            await asyncio.to_thread(self.client.loop_stop)
        self.state = "DOWN"
        self._listeners.clear()
        if self._ca_path:
            try:
                os.unlink(self._ca_path)
            except OSError as exc:
                logger.info("Could not remove MQTT CA file: %r", exc)
            self._ca_path = None

    # ---- paho callbacks (network thread) ----

    def _call(self, callback: Any, *args: Any) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            # The loop is shutting down; the message has nowhere to go.
            logger.debug("MQTT message after event loop closed")

    def _on_connect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any = None) -> None:
        del client, userdata, flags, properties
        code = int(getattr(reason_code, "value", reason_code) or 0)
        self._call(self._connected, code, str(reason_code))

    def _on_connect_fail(self, client: mqtt.Client, userdata: Any) -> None:
        del client, userdata
        self._call(self._set_down, "NETWORK", f"Cannot connect to MQTT broker {self.host}:{self.port}.")

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any = None) -> None:
        del client, userdata, flags, properties
        code = int(getattr(reason_code, "value", reason_code) or 0)
        if code != 0:
            self._call(self._set_down, "NETWORK", f"MQTT connection lost ({reason_code}).")

    def on_message(self, client: Any, userdata: Any, message: mqtt.MQTTMessage) -> None:
        del client, userdata
        arrival = from_epoch(time.time())
        try:
            raw = message.payload.decode("utf-8")
            payload = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            self._call(self._decode_error, message.topic)
            return
        self._call(self._dispatch, (message.topic, payload, arrival, raw))

    # ---- event-loop side of the callbacks ----

    def _connected(self, code: int, text: str) -> None:
        if code != 0:
            if code in _AUTH_CODES:
                self.state = "AUTH_FAILED"
                self.last_error_code = "AUTH"
                self.last_error = f"MQTT broker rejected the credentials ({text})."
            else:
                self._set_down("PROTOCOL", f"MQTT broker refused the connection ({text}).")
            if self._connected_event:
                self._connected_event.set()
            return
        if self.last_error_code is not None:
            logger.info("MQTT %s:%s connected again after: %s", self.host, self.port, self.last_error)
        self.state = "UP"
        self.last_error_code = None
        self.last_error = None
        self._subscribed = {}
        self._apply_subscriptions()
        if self._connected_event:
            self._connected_event.set()

    def _set_down(self, code: str, text: str) -> None:
        if self.state == "UP":
            logger.warning("MQTT %s:%s (client %s) went down: %s %s", self.host, self.port, self.client_id, code, text)
        if self.state != "AUTH_FAILED" or code != "NETWORK":
            self.state = "DOWN"
        self.last_error_code = code
        self.last_error = text
        if self._connected_event:
            self._connected_event.set()

    def _decode_error(self, topic: str) -> None:
        self.decode_errors += 1
        if self.decode_errors == 1 or self.decode_errors % 1000 == 0:
            logger.warning("MQTT payload on %s is not UTF-8 JSON (%d so far)", topic, self.decode_errors)

    def _dispatch(self, item: Message) -> None:
        self.messages += 1
        self.last_message_at = item[2]
        for listener in list(self._listeners):
            listener.put(item)


async def capture(connector: MqttConnector, topic: str, seconds: float, max_messages: int, connect_timeout_s: float = 10.0) -> list[Message]:
    """Collect messages on ``topic`` for up to ``seconds`` (or ``max_messages``)."""
    if not topic or "\x00" in topic:
        raise ConnectorError("TOPIC", "Invalid MQTT topic.")
    listener = connector.add_listener(topics=[topic], maxsize=max(1, max_messages))
    owner = f"capture-{id(listener)}"
    try:
        await connector.start()
        await connector.wait_connected(connect_timeout_s)
        connector.set_topics(owner, [(topic, 1)])
        messages: list[Message] = []
        deadline = time.monotonic() + seconds
        while len(messages) < max_messages:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                messages.append(await bounded(listener.queue.get(), timeout=remaining))
            except asyncio.TimeoutError:
                break
        return messages
    finally:
        connector.set_topics(owner, [])
        connector.remove_listener(listener)
