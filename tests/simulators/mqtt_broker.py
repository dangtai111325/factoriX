"""Minimal pure-Python async MQTT 3.1.1 broker for isolated OT testing & fault injection."""

from __future__ import annotations

import asyncio
import contextlib
import struct
from dataclasses import dataclass
from typing import Any


def _encode_remaining_length(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n % 128
        n //= 128
        if n > 0:
            byte |= 0x80
        out.append(byte)
        if n == 0:
            break
    return bytes(out)


async def _read_remaining_length(reader: asyncio.StreamReader) -> int:
    multiplier = 1
    value = 0
    for _ in range(4):
        b = (await reader.readexactly(1))[0]
        value += (b & 0x7F) * multiplier
        if (b & 0x80) == 0:
            return value
        multiplier *= 128
    raise ValueError("Malformed MQTT remaining length")


def _decode_str(buf: memoryview, offset: int) -> tuple[str, int]:
    (ln,) = struct.unpack_from("!H", buf, offset)
    offset += 2
    s = bytes(buf[offset : offset + ln]).decode("utf-8", errors="replace")
    return s, offset + ln


def _encode_str(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("!H", len(b)) + b


def topic_matches(pattern: str, topic: str) -> bool:
    p_parts = pattern.split("/")
    t_parts = topic.split("/")
    for idx, pat in enumerate(p_parts):
        if pat == "#":
            return True
        if idx >= len(t_parts):
            return False
        if pat != "+" and pat != t_parts[idx]:
            return False
    return len(p_parts) == len(t_parts)


@dataclass(eq=False)
class _ClientSession:
    client_id: str
    writer: asyncio.StreamWriter
    subscriptions: dict[str, int]
    lock: asyncio.Lock


class MiniMqttBroker:
    """Asyncio MQTT 3.1.1 server supporting CONNECT/AUTH, SUBSCRIBE wildcards, QoS 0/1, RETAIN."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 0,
        *,
        expected_user: str | None = None,
        expected_password: str | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.expected_user = expected_user
        self.expected_password = expected_password
        self.reject_all_auth = False
        self._server: asyncio.AbstractServer | None = None
        self._sessions: set[_ClientSession] = set()
        self._retained: dict[str, tuple[bytes, int]] = {}
        self._next_pid = 1

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle_client, self.host, self.port)
        sock = self._server.sockets[0]
        self.port = int(sock.getsockname()[1])
        return self.port

    async def _safe_drain(self, writer: asyncio.StreamWriter) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer.drain(), timeout=1.0)

    async def stop(self) -> None:
        await self.disconnect_clients()
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._server.wait_closed(), timeout=2.0)
            self._server = None

    async def disconnect_clients(self) -> None:
        for sess in list(self._sessions):
            with contextlib.suppress(Exception):
                sess.writer.close()
                await asyncio.wait_for(sess.writer.wait_closed(), timeout=1.0)
        self._sessions.clear()

    async def publish_local(self, topic: str, payload: bytes | str, *, qos: int = 0, retain: bool = False) -> None:
        raw = payload.encode("utf-8") if isinstance(payload, str) else payload
        if retain:
            if raw:
                self._retained[topic] = (raw, qos)
            else:
                self._retained.pop(topic, None)
        await self._fanout(topic, raw, qos=qos, retain=False)

    async def _send_publish(self, sess: _ClientSession, topic: str, payload: bytes, qos: int, retain: bool) -> None:
        eff_qos = 1 if qos >= 1 else 0
        flags = (eff_qos << 1) | (1 if retain else 0)
        vh = _encode_str(topic)
        if eff_qos == 1:
            pid = self._next_pid
            self._next_pid = (self._next_pid % 65535) + 1
            vh += struct.pack("!H", pid)
        body = vh + payload
        pkt = bytes([0x30 | flags]) + _encode_remaining_length(len(body)) + body
        async with sess.lock:
            if sess.writer.is_closing():
                raise ConnectionError("client writer closing")
            sess.writer.write(pkt)
            await asyncio.wait_for(sess.writer.drain(), timeout=1.0)

    async def _fanout(self, topic: str, payload: bytes, *, qos: int = 0, retain: bool = False) -> None:
        for sess in list(self._sessions):
            matched_qos = [sub_qos for pat, sub_qos in sess.subscriptions.items() if topic_matches(pat, topic)]
            if not matched_qos:
                continue
            eff_qos = min(qos, max(matched_qos)) if qos else 0
            try:
                await self._send_publish(sess, topic, payload, eff_qos, retain)
            except Exception:
                self._sessions.discard(sess)

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        sess: _ClientSession | None = None
        try:
            while True:
                first = await reader.read(1)
                if not first:
                    break
                pkt_type = first[0] >> 4
                flags = first[0] & 0x0F
                rem_len = await _read_remaining_length(reader)
                data = await reader.readexactly(rem_len) if rem_len else b""
                mv = memoryview(data)

                if pkt_type == 1:  # CONNECT
                    proto, off = _decode_str(mv, 0)
                    _level = mv[off]
                    conn_flags = mv[off + 1]
                    off += 4  # level + flags + keepalive(2)
                    cid, off = _decode_str(mv, off)
                    if conn_flags & 0x04:  # will flag
                        _, off = _decode_str(mv, off)
                        _, off = _decode_str(mv, off)
                    uname = None
                    pwd = None
                    if conn_flags & 0x80:
                        uname, off = _decode_str(mv, off)
                    if conn_flags & 0x40:
                        pwd, off = _decode_str(mv, off)

                    rc = 0
                    if self.reject_all_auth:
                        rc = 5
                    elif self.expected_user is not None:
                        if uname != self.expected_user or pwd != (self.expected_password or ""):
                            rc = 5
                    writer.write(bytes([0x20, 0x02, 0x00, rc]))
                    await asyncio.wait_for(writer.drain(), timeout=1.0)
                    if rc != 0:
                        break
                    sess = _ClientSession(client_id=cid or f"anon-{id(writer)}", writer=writer, subscriptions={}, lock=asyncio.Lock())
                    self._sessions.add(sess)

                elif pkt_type == 3 and sess is not None:  # PUBLISH
                    qos = (flags >> 1) & 0x03
                    retain = bool(flags & 0x01)
                    topic, off = _decode_str(mv, 0)
                    pid = None
                    if qos > 0:
                        (pid,) = struct.unpack_from("!H", mv, off)
                        off += 2
                    payload = bytes(mv[off:])
                    if retain:
                        if payload:
                            self._retained[topic] = (payload, qos)
                        else:
                            self._retained.pop(topic, None)
                    if qos == 1 and pid is not None:
                        async with sess.lock:
                            writer.write(struct.pack("!BBH", 0x40, 2, pid))
                            await asyncio.wait_for(writer.drain(), timeout=1.0)
                    await self._fanout(topic, payload, qos=qos)

                elif pkt_type == 8 and sess is not None:  # SUBSCRIBE
                    (pid,) = struct.unpack_from("!H", mv, 0)
                    off = 2
                    granted = bytearray()
                    new_topics: list[tuple[str, int]] = []
                    while off < len(mv):
                        tpat, off = _decode_str(mv, off)
                        req_qos = min(int(mv[off]), 1)
                        off += 1
                        sess.subscriptions[tpat] = req_qos
                        granted.append(req_qos)
                        new_topics.append((tpat, req_qos))
                    body = struct.pack("!H", pid) + bytes(granted)
                    async with sess.lock:
                        writer.write(bytes([0x90]) + _encode_remaining_length(len(body)) + body)
                        await asyncio.wait_for(writer.drain(), timeout=1.0)
                    for tpat, _q in new_topics:
                        for rtopic, (rpay, rqos) in list(self._retained.items()):
                            if topic_matches(tpat, rtopic):
                                await self._send_publish(sess, rtopic, rpay, rqos, True)

                elif pkt_type == 10 and sess is not None:  # UNSUBSCRIBE
                    (pid,) = struct.unpack_from("!H", mv, 0)
                    off = 2
                    while off < len(mv):
                        tpat, off = _decode_str(mv, off)
                        sess.subscriptions.pop(tpat, None)
                    async with sess.lock:
                        writer.write(struct.pack("!BBH", 0xB0, 2, pid))
                        await asyncio.wait_for(writer.drain(), timeout=1.0)

                elif pkt_type == 12:  # PINGREQ
                    writer.write(b"\xD0\x00")
                    await asyncio.wait_for(writer.drain(), timeout=1.0)

                elif pkt_type == 14:  # DISCONNECT
                    break
        except (asyncio.IncompleteReadError, ConnectionError, EOFError, ValueError, asyncio.TimeoutError):
            pass
        finally:
            if sess is not None:
                self._sessions.discard(sess)
            with contextlib.suppress(Exception):
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=1.0)
