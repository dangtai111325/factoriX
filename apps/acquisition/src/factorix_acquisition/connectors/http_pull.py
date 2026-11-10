"""HTTP pull with a persistent client and a per-host request budget.

Redirects stay off so a 3xx cannot leave the allowlist. All requests to one host share
a token bucket (``rate_limit_per_min``) so acquisition never exceeds the source's limit,
and a 429 ``Retry-After`` pauses every request to that host.
"""

from __future__ import annotations

import asyncio
import json
import logging
import ssl
import threading
import time
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from factorix.domain.network import AllowedEndpoint, assert_url
from factorix_acquisition.connectors.errors import ConnectorError

logger = logging.getLogger(__name__)

DEFAULT_RATE_PER_MIN = 60

_SSL_CTX_LOCK = threading.Lock()
_DEFAULT_SSL_CONTEXT: ssl.SSLContext | None = None


def _get_default_ssl_context() -> ssl.SSLContext:
    """Build and cache the default CA SSLContext off the asyncio event loop."""
    global _DEFAULT_SSL_CONTEXT
    if _DEFAULT_SSL_CONTEXT is not None:
        return _DEFAULT_SSL_CONTEXT
    with _SSL_CTX_LOCK:
        if _DEFAULT_SSL_CONTEXT is None:
            import certifi  # noqa: PLC0415
            import httpcore  # noqa: F401, PLC0415

            _DEFAULT_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
        return _DEFAULT_SSL_CONTEXT


class TokenBucket:
    """Requests per minute with a small burst. Capacity = max(1, rate // 4)."""

    def __init__(self, rate_per_min: float, *, clock: Any = time.monotonic) -> None:
        self.clock = clock
        self.rate_per_min = 0.0
        self.capacity = 1.0
        self.tokens = 1.0
        self.updated = clock()
        self.blocked_until = 0.0
        self.set_rate(rate_per_min)
        self.tokens = self.capacity

    def set_rate(self, rate_per_min: float) -> None:
        rate = float(rate_per_min) if rate_per_min and float(rate_per_min) > 0 else float(DEFAULT_RATE_PER_MIN)
        self._refill()
        self.rate_per_min = rate
        self.capacity = max(1.0, float(int(rate // 4)))
        self.tokens = min(self.tokens, self.capacity)

    def _refill(self) -> None:
        now = self.clock()
        if self.rate_per_min:
            self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate_per_min / 60.0)
        self.updated = now

    def block(self, seconds: float) -> None:
        self.blocked_until = max(self.blocked_until, self.clock() + max(0.0, seconds))
        self.tokens = 0.0

    def delay(self) -> float:
        """Seconds until one request may be sent (0 when a token is available now)."""
        self._refill()
        now = self.clock()
        wait = max(0.0, self.blocked_until - now)
        if self.tokens >= 1.0:
            return wait
        return max(wait, (1.0 - self.tokens) * 60.0 / self.rate_per_min)

    def try_take(self) -> bool:
        if self.delay() > 0:
            return False
        self.tokens -= 1.0
        return True

    async def acquire(self, max_wait_s: float) -> None:
        """Take a token, waiting at most ``max_wait_s``. Raises RATE_LIMITED otherwise."""
        deadline = self.clock() + max_wait_s
        while not self.try_take():
            wait = self.delay()
            if self.clock() + wait > deadline:
                raise ConnectorError(
                    "RATE_LIMITED",
                    f"Request budget of {self.rate_per_min:g}/min to this host is used up; next slot in {wait:.1f} s.",
                    retry_after=wait,
                )
            await asyncio.sleep(wait)


_BUCKETS: dict[str, TokenBucket] = {}


def bucket_for(host_key: str, rate_per_min: float) -> TokenBucket:
    """One bucket per host:port shared by all connections; the strictest rate wins."""
    bucket = _BUCKETS.get(host_key)
    if bucket is None:
        bucket = _BUCKETS[host_key] = TokenBucket(rate_per_min)
    elif rate_per_min and float(rate_per_min) < bucket.rate_per_min:
        bucket.set_rate(rate_per_min)
    return bucket


def parse_retry_after(value: str | None, default_s: float = 60.0) -> float:
    if not value:
        return default_s
    text = value.strip()
    if text.isdigit():
        return float(text)
    try:
        moment = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return default_s
    return max(0.0, moment.timestamp() - time.time())


class HttpPullConnector:
    can_write = False

    def __init__(
        self,
        base_url: str,
        allowlist: list[AllowedEndpoint],
        timeout_s: float = 5.0,
        *,
        headers: dict[str, str] | None = None,
        query: dict[str, str] | None = None,
        rate_limit_per_min: float | None = None,
    ) -> None:
        if "://" not in base_url:
            raise ConnectorError("CONFIG", "HTTP base URL must include scheme.")
        host, port = assert_url(base_url, allowlist)
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout_s = timeout_s
        self.headers = dict(headers or {})
        self.query = dict(query or {})
        self.bucket = bucket_for(f"{host.lower()}:{port}", rate_limit_per_min or DEFAULT_RATE_PER_MIN)
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            verify: ssl.SSLContext | bool = _DEFAULT_SSL_CONTEXT if _DEFAULT_SSL_CONTEXT is not None else True
            self._client = httpx.AsyncClient(
                timeout=self.timeout_s,
                follow_redirects=False,
                verify=verify,
                limits=httpx.Limits(max_connections=16, max_keepalive_connections=16),
            )
        return self._client

    async def _ensure_http(self) -> httpx.AsyncClient:
        if _DEFAULT_SSL_CONTEXT is None:
            await asyncio.to_thread(_get_default_ssl_context)
        return self._http()

    def url_for(self, path: str) -> str:
        if "://" in path or path.startswith("//"):
            raise ConnectorError("CONFIG", "HTTP path must be relative.")
        return urljoin(self.base_url, path.lstrip("/"))

    async def request_json(
        self,
        method: str,
        path: str,
        headers: dict[str, str] | None = None,
        body: Any = None,
        *,
        max_wait_s: float | None = None,
    ) -> Any:
        document, _text = await self.request_json_text(method, path, headers, body, max_wait_s=max_wait_s)
        return document

    async def request_json_text(
        self,
        method: str,
        path: str,
        headers: dict[str, str] | None = None,
        body: Any = None,
        *,
        max_wait_s: float | None = None,
    ) -> tuple[Any, str]:
        """Like ``request_json`` but also returns the body text exactly as received."""
        url = self.url_for(path)
        m = method.upper()
        if m not in {"GET", "POST"}:
            raise ConnectorError("CONFIG", f"Unsupported HTTP method: {method}")
        await self.bucket.acquire(self.timeout_s if max_wait_s is None else max_wait_s)
        merged = {**self.headers, **(headers or {})}
        params = self.query or None
        for attempt in range(2):
            client = await self._ensure_http()
            try:
                if m == "POST":
                    content = body if isinstance(body, (str, bytes)) else None
                    response = await client.post(url, headers=merged, params=params, json=None if content is not None else body, content=content)
                else:
                    response = await client.get(url, headers=merged, params=params)
                break
            except (httpx.RemoteProtocolError, httpx.ReadError):
                if attempt == 0:
                    continue
                raise ConnectorError("NETWORK", "Cannot connect to HTTP endpoint.")
            except httpx.TimeoutException as exc:
                raise ConnectorError("TIMEOUT", f"HTTP {urlparse(url).path} did not answer within {self.timeout_s:g} s.") from exc
            except httpx.HTTPError as exc:
                raise ConnectorError("NETWORK", "Cannot connect to HTTP endpoint.") from exc
        status = response.status_code
        if 300 <= status < 400:
            raise ConnectorError("REDIRECT", "HTTP redirect was rejected.")
        if status in {401, 403}:
            raise ConnectorError("AUTH", f"HTTP authentication failed (status {status}).")
        if status == 429:
            retry_after = parse_retry_after(response.headers.get("Retry-After"))
            self.bucket.block(retry_after)
            raise ConnectorError("RATE_LIMITED", f"HTTP source rate limit reached; retry after {retry_after:.0f} s.", retry_after=retry_after)
        if status >= 400:
            raise ConnectorError("PROTOCOL", f"HTTP returned status code {status}.")
        try:
            text = response.text
            return json.loads(text), text
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ConnectorError("DECODE", "HTTP response is not JSON.") from exc

    async def get_json(self, path: str, headers: dict[str, str] | None = None, *, max_wait_s: float | None = None) -> Any:
        return await self.request_json("GET", path, headers=headers, max_wait_s=max_wait_s)

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()
