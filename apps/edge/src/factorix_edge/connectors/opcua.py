"""OPC UA read-only client. Write services are not exposed."""

from __future__ import annotations

from typing import Any

from asyncua import Client

from factorix.domain.network import AllowedEndpoint, assert_url
from factorix_edge.connectors.errors import ConnectorError


class OpcUaConnector:
    can_write = False

    def __init__(self, endpoint: str, allowlist: list[AllowedEndpoint], timeout_s: float = 8.0) -> None:
        assert_url(endpoint, allowlist)
        self.endpoint = endpoint
        self.client = Client(url=endpoint, timeout=timeout_s)

    async def connect(self) -> None:
        try:
            await self.client.connect()
        except Exception as exc:
            raise ConnectorError("PROTOCOL", "Không mở được phiên OPC UA.") from exc

    async def read_values(self, node_ids: list[str]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for node_id in node_ids:
            try:
                value = await self.client.get_node(node_id).read_value()
            except Exception as exc:
                raise ConnectorError("ADDRESS", "Không đọc được node OPC UA.") from exc
            rows.append({"node_id": node_id, "value": _plain(value)})
        return rows

    async def close(self) -> None:
        await self.client.disconnect()


def _plain(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
