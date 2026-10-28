"""MQTT subscriber. This client never publishes."""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import paho.mqtt.client as mqtt

from factorix.domain.network import AllowedEndpoint, assert_allowed
from factorix_edge.connectors.errors import ConnectorError


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
    ) -> None:
        assert_allowed(host, port, allowlist, scheme="mqtt")
        self.host = host
        self.port = port
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        if username:
            self.client.username_pw_set(username, password or None)
        self._inbox: list[dict[str, Any]] = []
        self._error: list[str] = []
        self._started = False
        self._lock = threading.Lock()

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
                client.subscribe(topic, qos=max(0, min(int(qos), 1)))

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
                    self._inbox.append(payload)

        self.client.on_connect = on_connect
        self.client.on_message = on_message
        try:
            self.client.connect(self.host, self.port, 10)
        except OSError as exc:
            raise ConnectorError("NETWORK", "Không kết nối được broker MQTT.") from exc
        self.client.loop_start()
        self._started = True

    def next_json(self, timeout_s: float = 2.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            with self._lock:
                if self._error:
                    raise ConnectorError(self._error[0], "MQTT từ chối hoặc payload không phải JSON.")
                if self._inbox:
                    return self._inbox.pop(0)
            time.sleep(0.05)
        raise ConnectorError("TIMEOUT", "Không nhận được bản tin MQTT trong thời gian cho phép.")

    def close(self) -> None:
        if not self._started:
            return
        self.client.loop_stop()
        self.client.disconnect()
        self._started = False

    def capture(self, topic: str, timeout_s: float = 8.0) -> dict[str, Any]:
        if not topic or "\x00" in topic:
            raise ConnectorError("TOPIC", "Topic MQTT không hợp lệ.")
        received: list[dict[str, Any]] = []
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
                received.append(payload)
                done.set()

        self.client.on_connect = on_connect
        self.client.on_message = on_message
        try:
            self.client.connect(self.host, self.port, 10)
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
