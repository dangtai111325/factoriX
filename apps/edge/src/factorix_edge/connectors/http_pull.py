"""HTTP pull. Redirects stay off so a 3xx cannot leave the allowlist."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urljoin

import httpx

from factorix.domain.network import AllowedEndpoint, assert_url
from factorix_edge.connectors.errors import ConnectorError


class HttpPullConnector:
    can_write = False

    def __init__(self, base_url: str, allowlist: list[AllowedEndpoint], timeout_s: float = 5.0) -> None:
        if "://" not in base_url:
            raise ConnectorError("CONFIG", "HTTP base URL phải có scheme.")
        assert_url(base_url, allowlist)
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout_s = timeout_s

    async def get_json(self, path: str, headers: dict[str, str] | None = None) -> Any:
        if "://" in path or path.startswith("//"):
            raise ConnectorError("CONFIG", "Đường dẫn HTTP phải tương đối.")
        url = urljoin(self.base_url, path.lstrip("/"))
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s, follow_redirects=False) as client:
                response = await client.get(url, headers=headers or {})
        except httpx.HTTPError as exc:
            raise ConnectorError("NETWORK", "HTTP pull không kết nối được.") from exc
        if 300 <= response.status_code < 400:
            raise ConnectorError("REDIRECT", "HTTP redirect bị từ chối.")
        if response.status_code == 401:
            raise ConnectorError("AUTH", "HTTP từ chối xác thực.")
        if response.status_code == 429:
            raise ConnectorError("RATE_LIMIT", "HTTP báo giới hạn tần suất.")
        if response.status_code >= 400:
            raise ConnectorError("PROTOCOL", f"HTTP trả mã {response.status_code}.")
        try:
            return response.json()
        except json.JSONDecodeError as exc:
            raise ConnectorError("DECODE", "HTTP không trả JSON.") from exc
