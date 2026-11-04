"""MQTT subscriber. This client never publishes."""

from __future__ import annotations

from collections import deque
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

        # Select protocol version
        proto = mqtt.MQTTv5 if str(protocol_version).strip() in {"5", "5.0"} else mqtt.MQTTv311
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=proto,
        )

        if username:
            self.client.username_pw_set(username, password or None)

        if tls:
            if ca_pem:
                import tempfile
                with tempfile.NamedTemporaryFile("w", delete=False) as tf:
                    tf.write(ca_pem)
                    ca_path = tf.name
                self.client.tls_set(ca_certs=ca_path)
            else:
                self.client.tls_set()
            if tls_insecure:
                self.client.tls_insecure_set(True)

        self._inbox: deque[tuple[str, dict[str, Any]]] = deque(maxlen=10000)
        self.dropped = 0
        self._error: list[str] = []
        self._started = False
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self.client.on_message = self.on_message

    def on_message(self, client: Any, userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            with self._cond:
                self._error.append("DECODE")
                self._cond.notify_all()
            return
        if isinstance(payload, dict):
            with self._cond:
                if len(self._inbox) >= self._inbox.maxlen:
                    self.dropped += 1
                self._inbox.append((message.topic, payload))
                self._cond.notify_all()

    def start(self, topics: list[tuple[str, int]]) -> None:
        if self._started:
            return
        if not topics:
            raise ConnectorError("TOPIC", "No MQTT topics provided.")

        def on_connect(client: mqtt.Client, userdata: object, flags: object, reason_code: object, properties: object = None) -> None:
            del userdata, flags, properties
            code = getattr(reason_code, "value", reason_code)
            if int(code) != 0:
                with self._cond:
                    self._error.append("AUTH")
                    self._cond.notify_all()
                return
            for topic, qos in topics:
                client.subscribe(topic, qos=max(0, min(int(qos), 2)))

        self.client.on_connect = on_connect
        self.client.on_message = self.on_message
        try:
            self.client.connect(self.host, self.port, keepalive=self.keepalive)
        except OSError as exc:
            raise ConnectorError("NETWORK", f"Cannot connect to MQTT broker ({exc}).") from exc
        self.client.loop_start()
        self._started = True

    def drain(self, timeout_s: float = 0.5) -> list[tuple[str, dict[str, Any]]]:
        """Drain all messages from queue. Waits up to timeout_s for at least one message if queue is empty."""
        deadline = time.monotonic() + timeout_s
        with self._cond:
            while not self._inbox and not self._error and time.monotonic() < deadline:
                remaining = max(0.01, deadline - time.monotonic())
                self._cond.wait(timeout=remaining)
            if self._error:
                err = self._error.pop(0)
                raise ConnectorError(err, f"MQTT connection or decoding error: {err}")
            results: list[tuple[str, dict[str, Any]]] = []
            while self._inbox:
                results.append(self._inbox.popleft())
            return results

    def next_json(self, timeout_s: float = 2.0) -> dict[str, Any]:
        """Legacy helper returning latest payload for test commissioning."""
        batch = self.drain(timeout_s=timeout_s)
        if not batch:
            raise ConnectorError("TIMEOUT", "No MQTT message received within timeout.")
        return batch[-1][1]

    @property
    def queue_length(self) -> int:
        with self._lock:
            return len(self._inbox)

    def close(self) -> None:
        if not self._started:
            return
        self.client.loop_stop()
        self.client.disconnect()
        self._started = False

    def capture(self, topic: str, timeout_s: float = 8.0, max_messages: int = 200) -> list[tuple[str, dict[str, Any]]]:
        """Capture samples on topic for commissioning."""
        if not topic or "\x00" in topic:
            raise ConnectorError("TOPIC", "Invalid MQTT topic.")
        samples: list[tuple[str, dict[str, Any]]] = []
        done = threading.Event()
        error: list[str] = []

        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{self.client_id}-cap")
        if self.client._username:
            client.username_pw_set(self.client._username, self.client._password)

        def on_connect(c: mqtt.Client, u: object, f: object, rc: object, p: object = None) -> None:
            del u, f, p
            code = getattr(rc, "value", rc)
            if int(code) != 0:
                error.append("AUTH")
                done.set()
                return
            c.subscribe(topic, qos=1)

        def on_message(c: mqtt.Client, u: object, msg: mqtt.MQTTMessage) -> None:
            del c, u
            try:
                payload = json.loads(msg.payload.decode("utf-8"))
            except Exception:
                return
            if isinstance(payload, dict):
                samples.append((msg.topic, payload))
                if len(samples) >= max_messages:
                    done.set()

        client.on_connect = on_connect
        client.on_message = on_message
        try:
            client.connect(self.host, self.port, 10)
        except OSError as exc:
            raise ConnectorError("NETWORK", f"Cannot connect to MQTT broker ({exc}).") from exc
        client.loop_start()
        try:
            done.wait(timeout=timeout_s)
        finally:
            client.loop_stop()
            client.disconnect()

        if error:
            raise ConnectorError(error[0], "MQTT capture failed.")
        return samples
