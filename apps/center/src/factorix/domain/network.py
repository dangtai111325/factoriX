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
            parsed.append(endpoint_from_url(item))
            continue
        if ":" not in item:
            raise NetworkPolicyError("ALLOWLIST", "Allowlist must be in host:port format.")
        host, _, port_text = item.rpartition(":")
        if not host or not port_text.isdigit():
            raise NetworkPolicyError("ALLOWLIST", "Allowlist host:port is invalid.")
        port = int(port_text)
        if port < 1 or port > 65535:
            raise NetworkPolicyError("ALLOWLIST", "Invalid port.")
        parsed.append(AllowedEndpoint(host.strip("[]"), port, None))
    return parsed


def assert_allowed(host: str, port: int, allowlist: list[AllowedEndpoint], *, scheme: str | None = None) -> None:
    if port < 1 or port > 65535:
        raise NetworkPolicyError("PORT", "Invalid port.")
    if not allowlist:
        raise NetworkPolicyError("ALLOWLIST", "OT network allowlist is not configured.")
    normalized = host.strip().lower().rstrip(".")
    if normalized in {"localhost", "metadata.google.internal"} or normalized.endswith(".local"):
        matched = any(item.host.lower() == normalized and item.port == port for item in allowlist)
        if not matched:
            raise NetworkPolicyError("BLOCKED", "Host is blocked by network policy.")
    addresses = _resolve(normalized)
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if any(ip in network for network in BLOCKED_NETWORKS):
            raise NetworkPolicyError("BLOCKED", "Address is in blocked range.")
    permitted = [
        item
        for item in allowlist
        if item.host.lower() == normalized and item.port == port and (scheme is None or item.scheme in {None, scheme})
    ]
    if not permitted:
        raise NetworkPolicyError("NOT_ALLOWLISTED", "Endpoint is not in edge allowlist.")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        private = any(ip in network for network in PRIVATE_NETWORKS)
        if private and not permitted:
            raise NetworkPolicyError("NOT_ALLOWLISTED", "Private network is not permitted.")


DEFAULT_PORTS: dict[str, int | None] = {
    "http": 80,
    "https": 443,
    "ws": 80,
    "wss": 443,
    "opc.tcp": 4840,
    "mqtt": 1883,
    "mqtts": 8883,
    "modbus": 502,
    "tcp": None,
}


def endpoint_from_url(url: str) -> AllowedEndpoint:
    """Parse ``scheme://host[:port][/path]`` into an endpoint, using the scheme's default port."""
    try:
        parsed = urlparse(url.strip())
        port = parsed.port
    except ValueError as exc:
        raise NetworkPolicyError("URL", "URL has an invalid port.") from exc
    scheme = parsed.scheme.lower()
    if scheme not in DEFAULT_PORTS:
        raise NetworkPolicyError("SCHEME", "URL scheme is not permitted.")
    if parsed.username or parsed.password:
        raise NetworkPolicyError("URL_SECRET", "Do not put secrets in the URL.")
    port = port or DEFAULT_PORTS[scheme]
    if not parsed.hostname or port is None:
        raise NetworkPolicyError("URL", "URL is missing host or port.")
    return AllowedEndpoint(parsed.hostname, port, scheme)


def assert_url(url: str, allowlist: list[AllowedEndpoint]) -> tuple[str, int]:
    endpoint = endpoint_from_url(url)
    assert_allowed(endpoint.host, endpoint.port, allowlist, scheme=endpoint.scheme)
    return endpoint.host, endpoint.port


def _resolve(host: str) -> list[str]:
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise NetworkPolicyError("DNS", "Could not resolve the host.") from exc
    addresses = []
    for info in infos:
        addresses.append(info[4][0])
    if not addresses:
        raise NetworkPolicyError("DNS", "Could not resolve the host.")
    return addresses
