"""Endpoint allowlist and SSRF checks used by Edge before any OT socket is opened."""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

BLOCKED_NETWORKS = (
    ipaddress.ip_network("169.254.169.254/32"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("255.255.255.255/32"),
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("ff00::/8"),
)

PRIVATE_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
)


class NetworkPolicyError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class AllowedEndpoint:
    host: str
    port: int
    scheme: str | None = None


def parse_allowlist(entries: list[str]) -> list[AllowedEndpoint]:
    parsed: list[AllowedEndpoint] = []
    for entry in entries:
        item = entry.strip()
        if not item:
            continue
        if "://" in item:
            url = urlparse(item)
            if not url.hostname or not url.port:
                raise NetworkPolicyError("ALLOWLIST", "Allowlist URL phải có host và port.")
            parsed.append(AllowedEndpoint(url.hostname, url.port, url.scheme))
            continue
        if ":" not in item:
            raise NetworkPolicyError("ALLOWLIST", "Allowlist phải có dạng host:port.")
        host, _, port_text = item.rpartition(":")
        if not host or not port_text.isdigit():
            raise NetworkPolicyError("ALLOWLIST", "Allowlist host:port không hợp lệ.")
        port = int(port_text)
        if port < 1 or port > 65535:
            raise NetworkPolicyError("ALLOWLIST", "Cổng không hợp lệ.")
        parsed.append(AllowedEndpoint(host.strip("[]"), port, None))
    return parsed


def assert_allowed(host: str, port: int, allowlist: list[AllowedEndpoint], *, scheme: str | None = None) -> None:
    if port < 1 or port > 65535:
        raise NetworkPolicyError("PORT", "Cổng không hợp lệ.")
    if not allowlist:
        raise NetworkPolicyError("ALLOWLIST", "Chưa cấu hình allowlist mạng OT.")
    normalized = host.strip().lower().rstrip(".")
    if normalized in {"localhost", "metadata.google.internal"} or normalized.endswith(".local"):
        matched = any(item.host.lower() == normalized and item.port == port for item in allowlist)
        if not matched:
            raise NetworkPolicyError("BLOCKED", "Host bị chặn bởi chính sách mạng.")
    addresses = _resolve(normalized)
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if any(ip in network for network in BLOCKED_NETWORKS):
            raise NetworkPolicyError("BLOCKED", "Địa chỉ nằm trong dải bị cấm.")
    permitted = [
        item
        for item in allowlist
        if item.host.lower() == normalized and item.port == port and (scheme is None or item.scheme in {None, scheme})
    ]
    if not permitted:
        raise NetworkPolicyError("NOT_ALLOWLISTED", "Endpoint không nằm trong allowlist của Edge.")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        private = any(ip in network for network in PRIVATE_NETWORKS)
        if private and not permitted:
            raise NetworkPolicyError("NOT_ALLOWLISTED", "Mạng riêng chưa được phép.")


def assert_url(url: str, allowlist: list[AllowedEndpoint]) -> tuple[str, int]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https", "opc.tcp", "mqtt", "mqtts", "tcp"}:
        raise NetworkPolicyError("SCHEME", "Giao thức URL không được phép.")
    if parsed.username or parsed.password:
        raise NetworkPolicyError("URL_SECRET", "Không đặt bí mật trong URL.")
    host = parsed.hostname
    port = parsed.port or _default_port(parsed.scheme)
    if not host or port is None:
        raise NetworkPolicyError("URL", "URL thiếu host hoặc cổng.")
    assert_allowed(host, port, allowlist, scheme=parsed.scheme)
    return host, port


def _default_port(scheme: str) -> int | None:
    return {"http": 80, "https": 443, "opc.tcp": 4840, "mqtt": 1883, "mqtts": 8883, "tcp": None}[scheme]


def _resolve(host: str) -> list[str]:
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise NetworkPolicyError("DNS", "Không phân giải được host.") from exc
    addresses = []
    for info in infos:
        addresses.append(info[4][0])
    if not addresses:
        raise NetworkPolicyError("DNS", "Không phân giải được host.")
    return addresses
