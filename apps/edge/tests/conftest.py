"""Controlled wire-level protocol servers. Never use the live factory broker."""

import socket
import ssl
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import pytest_asyncio
import httpx

from factorix_edge.runtime import EdgeRuntime
from factorix_edge.store.outbox import Outbox


@pytest_asyncio.fixture
async def probe_runtime(tmp_path):
    async with httpx.AsyncClient() as client:
        outbox = Outbox(tmp_path / "outbox.sqlite")
        runtime = EdgeRuntime(client, "test-only", [], outbox)
        yield runtime
        for connector in runtime._mqtt.values():
            connector.close()
        for connector in runtime._modbus.values():
            await connector.close()
        outbox.close()


def _exact(stream, count):
    value = b""
    while len(value) < count:
        chunk = stream.recv(count - len(value))
        if not chunk:
            raise EOFError("Client closed the protocol test connection.")
        value += chunk
    return value


def _packet(stream):
    kind = _exact(stream, 1)[0]
    size, multiplier = 0, 1
    for _ in range(4):
        digit = _exact(stream, 1)[0]
        size += (digit & 127) * multiplier
        if not digit & 128:
            return kind, _exact(stream, size)
        multiplier *= 128
    raise ValueError("Invalid MQTT remaining length.")


@pytest.fixture
def mqtt_broker():
    @contextmanager
    def serve(*, reject_auth=False, tls_context=None, expect_tls_rejection=False):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(3)
        observed = {"port": listener.getsockname()[1]}
        errors = []

        def run():
            try:
                accepted = listener.accept()[0]
                accepted.settimeout(3)
                if tls_context:
                    try:
                        accepted = tls_context.wrap_socket(accepted, server_side=True)
                    except ssl.SSLError:
                        accepted.close()
                        if expect_tls_rejection:
                            observed["tls_rejected"] = True
                            return
                        raise
                with accepted as stream:
                    stream.settimeout(12)
                    kind, connect = _packet(stream)
                    assert kind == 0x10
                    observed["connect"] = connect
                    version = connect[6]
                    stream.sendall((b"\x20\x03\x00\x86\x00" if version == 5 else b"\x20\x02\x00\x05") if reject_auth
                                   else (b"\x20\x03\x00\x00\x00" if version == 5 else b"\x20\x02\x00\x00"))
                    if reject_auth:
                        return
                    kind, subscribe = _packet(stream)
                    assert kind == 0x82
                    observed["subscribe"] = subscribe
                    stream.sendall(b"\x90" + (b"\x04" + subscribe[:2] + b"\x00\x00" if version == 5 else b"\x03" + subscribe[:2] + b"\x00"))
                    topic, payload = b"factory/m1/state", b'{"employee":"0021113185","qty":0}'
                    body = len(topic).to_bytes(2, "big") + topic + (b"\x00" if version == 5 else b"") + payload
                    stream.sendall(b"\x30" + bytes([len(body)]) + body)
                    try:
                        observed['after_subscribe_kind'], _ = _packet(stream)  # Clean disconnect, never publish.
                    except EOFError:
                        pass
            except Exception as exc:
                errors.append(exc)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        try:
            yield observed
        finally:
            listener.close()
            thread.join(4)
            if errors:
                raise errors[0]
            assert not thread.is_alive(), "Protocol fixture did not close."

    return serve


@pytest.fixture
def tls_broker(tmp_path):
    from datetime import datetime, timedelta, timezone
    from ipaddress import ip_address
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Protocol test broker")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                   .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
                   .not_valid_after(now + timedelta(days=1))
                   .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                   .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address("127.0.0.1"))]), critical=False)
                   .sign(key, hashes.SHA256()))
    cert_pem = certificate.public_bytes(serialization.Encoding.PEM)
    cert_file, key_file = tmp_path / "broker.pem", tmp_path / "broker-key.pem"
    cert_file.write_bytes(cert_pem)
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_file, key_file)
    return {"context": context, "ca_pem": cert_pem.decode()}


@pytest.fixture
def http_source():
    class Source(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"speed":42.5,"employee":"0021113185","qty":0,"running":false,"stop":null}')

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Source)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1]
    server.shutdown()
    server.server_close()
    thread.join(2)


@pytest.fixture
def modbus_source():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(3)
    port = listener.getsockname()[1]
    errors = []

    def run():
        try:
            with listener.accept()[0] as stream:
                stream.settimeout(3)
                while True:
                    try:
                        header = _exact(stream, 7)
                    except EOFError:
                        break
                    request = _exact(stream, int.from_bytes(header[4:6], "big") - 1)
                    # Register 0..1 = IEEE754 float32 42.0, other addresses reject.
                    function, address, count = request[0], int.from_bytes(request[1:3], "big"), int.from_bytes(request[3:5], "big")
                    if function in {3, 4} and address == 0 and count == 2:
                        response = bytes([function, 4]) + b"\x42\x28\x00\x00"
                    else:
                        response = bytes([function | 0x80, 2])
                    stream.sendall(header[:4] + (len(response) + 1).to_bytes(2, "big") + header[6:7] + response)
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    yield port
    listener.close()
    thread.join(4)
    if errors:
        raise errors[0]
    assert not thread.is_alive()


@pytest.fixture
def unused_loopback_port():
    with socket.socket() as stream:
        stream.bind(("127.0.0.1", 0))
        return stream.getsockname()[1]


@pytest.fixture
def http_capture():
    requests = []

    class Source(BaseHTTPRequestHandler):
        def respond(self):
            requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers),
                             "body": self.rfile.read(int(self.headers.get("Content-Length", 0)))})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"speed":42.5,"source_timestamp":"2026-11-02T01:45:12Z"}')

        do_GET = respond
        do_POST = respond

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Source)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield {"port": server.server_address[1], "requests": requests}
    server.shutdown()
    server.server_close()
    thread.join(2)
