"""OPC UA read-only client. Write services are not exposed."""

from __future__ import annotations

from typing import Any

from asyncua import Client, ua

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
                self.rows: dict[str, dict[str, Any]] = {}
                self.complete = asyncio.Event()

            def datachange_notification(self, node: object, val: object, data: object) -> None:
                node_id = node.nodeid.to_string()
                if node_id not in expected:
                    return
                value = getattr(getattr(data, "monitored_item", None), "Value", None)
                status = getattr(value, "StatusCode", None)
                self.rows[node_id] = {
                    "node_id": node_id, "value": _plain(val),
                    "quality": "GOOD" if status is not None and _good(status) else "BAD",
                    "source_time": getattr(value, "SourceTimestamp", None),
                }
                if expected <= self.rows.keys():
                    self.complete.set()

        expected = {normalize_node_id(node_id) for node_id in node_ids}
        handler = _Changes()
        subscription = await self.client.create_subscription(500, handler)
        try:
            nodes = [self.client.get_node(node_id) for node_id in node_ids]
            await subscription.subscribe_data_change(nodes)
            await asyncio.wait_for(handler.complete.wait(), timeout_s)
        except TimeoutError as exc:
            raise ConnectorError("SUBSCRIBE", "Not every requested OPC UA node produced a notification.") from exc
        finally:
            await subscription.delete()
        return [handler.rows[normalize_node_id(node_id)] for node_id in node_ids]

    async def close(self) -> None:
        await self.client.disconnect()


def _good(status: object) -> bool:
    if hasattr(status, "is_good"):
        try:
            return bool(status.is_good())  # type: ignore[operator]
        except Exception:
            return False
    return "Good" in str(status)


def normalize_node_id(value: str) -> str:
    return ua.NodeId.from_string(value).to_string()


def _plain(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
