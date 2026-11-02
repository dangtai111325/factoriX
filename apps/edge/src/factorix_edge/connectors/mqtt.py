"""MQTT subscriber. This client never publishes."""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from typing import Any

import paho.mqtt.client as mqtt

from factorix.domain.network import AllowedEndpoint, assert_allowed
from factorix_edge.connectors.errors import ConnectorError

InboxItem = dict[str, Any]  # {"topic": str, "payload": dict}


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
    ) -> None:
        assert_allowed(host, port, allowlist, scheme="mqtt")
        self.host = host
        self.port = port
        self.keepalive = max(5, int(keepalive or 60))
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        if username:
            self.client.username_pw_set(username, password or None)
        self._inbox: deque[InboxItem] = deque(maxlen=10_000)
        self._dropped = 0
        self._error: list[str] = []
        self._started = False
        self._lock = threading.Lock()

    @property
    def dropped_count(self) -> int:
        with self._lock:
            return self._dropped

    def start(self, topics: list[tuple[str, int]]) -> None:
        if self._started:
            return
        if not topics:
            raise ConnectorError("TOPIC", "Chưa có topic MQTT.")

        def on_connect(client: mqtt.Client, userdata: object, flags: object, reason_code: object, properties: object = None) -> None:
            del userdata, flags, properties
            code = getattr(reason_code, "value", reason_code)
            if int(code) != 0:
                with self._lock:
                    self._error.append("AUTH")
                return
            for topic, qos in topics:
                client.subscribe(topic, qos=max(0, min(int(qos), 2)))

        def on_message(client: mqtt.Client, userdata: object, message: mqtt.MQTTMessage) -> None:
            del client, userdata
            try:
                payload = json.loads(message.payload.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                with self._lock:
                    self._error.append("DECODE")
                return
            if isinstance(payload, dict):
                with self._lock:
                    before = len(self._inbox)
                    self._inbox.append({"topic": str(message.topic or ""), "payload": payload})
                    # deque drops from left when full; count if we were already at maxlen
                    if before == self._inbox.maxlen:
                        self._dropped += 1

        self.client.on_connect = on_connect
        self.client.on_message = on_message
        try:
            self.client.connect(self.host, self.port, self.keepalive)
        except OSError as exc:
            raise ConnectorError("NETWORK", "Không kết nối được broker MQTT.") from exc
        self.client.loop_start()
        self._started = True

    def next_json(self, timeout_s: float = 2.0) -> dict[str, Any]:
        """Legacy single-pop API — returns payload only for callers that expect a dict document."""
        item = self.next_message(timeout_s=timeout_s)
        return item["payload"]

    def next_message(self, timeout_s: float = 2.0) -> InboxItem:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            with self._lock:
                if self._error:
                    raise ConnectorError(self._error[0], "MQTT từ chối hoặc payload không phải JSON.")
                if self._inbox:
                    return self._inbox.popleft()
            time.sleep(0.05)
        raise ConnectorError("TIMEOUT", "Không nhận được bản tin MQTT trong thời gian cho phép.")

    def drain(self) -> list[InboxItem]:
        """Return all queued messages (newest last). Clears the inbox."""
        with self._lock:
            if self._error:
                raise ConnectorError(self._error[0], "MQTT từ chối hoặc payload không phải JSON.")
            items = list(self._inbox)
            self._inbox.clear()
            return items

    def drain_latest_by_topic(self) -> list[InboxItem]:
        """Drain inbox keeping only the newest message per topic."""
        items = self.drain()
        latest: dict[str, InboxItem] = {}
        for item in items:
            latest[str(item.get("topic") or "")] = item
        return list(latest.values())

    def close(self) -> None:
        if not self._started:
            return
        self.client.loop_stop()
        self.client.disconnect()
        self._started = False

    def capture(self, topic: str, timeout_s: float = 8.0) -> dict[str, Any]:
        """Blocking one-shot subscribe for handshake. Returns {topic, payload}."""
        if not topic or "\x00" in topic:
            raise ConnectorError("TOPIC", "Topic MQTT không hợp lệ.")
        received: list[InboxItem] = []
        done = threading.Event()
        error: list[str] = []

        def on_connect(client: mqtt.Client, userdata: object, flags: object, reason_code: object, properties: object = None) -> None:
            del userdata, flags, properties
            code = getattr(reason_code, "value", reason_code)
            if int(code) != 0:
                error.append("AUTH")
                done.set()
                return
            client.subscribe(topic, qos=1)

        def on_message(client: mqtt.Client, userdata: object, message: mqtt.MQTTMessage) -> None:
            del client, userdata
            try:
                payload = json.loads(message.payload.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                error.append("DECODE")
                done.set()
                return
            if isinstance(payload, dict):
                received.append({"topic": str(message.topic or ""), "payload": payload})
                done.set()

        self.client.on_connect = on_connect
        self.client.on_message = on_message
        try:
            self.client.connect(self.host, self.port, self.keepalive)
        except OSError as exc:
            raise ConnectorError("NETWORK", "Không kết nối được broker MQTT.") from exc
        self.client.loop_start()
        try:
            if not done.wait(timeout_s):
                raise ConnectorError("TIMEOUT", "Không nhận được bản tin MQTT trong thời gian cho phép.")
        finally:
            self.client.loop_stop()
            self.client.disconnect()
        if error:
            raise ConnectorError(error[0], "MQTT từ chối hoặc payload không phải JSON.")
        if not received:
            raise ConnectorError("PROTOCOL", "MQTT không trả payload.")
        return received[0]
