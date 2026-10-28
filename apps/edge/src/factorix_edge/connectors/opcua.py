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
                data = await self.client.get_node(node_id).read_data_value()
            except Exception as exc:
                raise ConnectorError("ADDRESS", "Không đọc được node OPC UA.") from exc
            rows.append(
                {
                    "node_id": node_id,
                    "value": _plain(data.Value.Value),
                    "quality": "GOOD" if _good(data.StatusCode) else "BAD",
                    "source_time": getattr(data, "SourceTimestamp", None),
                }
            )
        return rows

    async def subscribe_values(self, node_ids: list[str], timeout_s: float = 2.0) -> list[dict[str, Any]]:
        import asyncio

        class _Changes:
            def __init__(self) -> None:
                self.rows: list[dict[str, Any]] = []

            def datachange_notification(self, node: object, val: object, data: object) -> None:
                del data
                status = getattr(getattr(node, "status", None), "StatusCode", None)
                self.rows.append(
                    {
                        "node_id": str(getattr(node, "nodeid", "")),
                        "value": _plain(val),
                        "quality": "GOOD" if status is None or _good(status) else "BAD",
                        "source_time": None,
                    }
                )

        handler = _Changes()
        subscription = await self.client.create_subscription(500, handler)
        nodes = [self.client.get_node(node_id) for node_id in node_ids]
        await subscription.subscribe_data_change(nodes)
        await asyncio.sleep(timeout_s)
        await subscription.delete()
        if len(handler.rows) < len(node_ids):
            raise ConnectorError("SUBSCRIBE", "OPC UA chưa giao đủ MonitoredItem.")
        return handler.rows[: len(node_ids)]

    async def close(self) -> None:
        await self.client.disconnect()


def _good(status: object) -> bool:
    if hasattr(status, "is_good"):
        try:
            return bool(status.is_good())  # type: ignore[operator]
        except Exception:
            return False
    return "Good" in str(status)


def _plain(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
