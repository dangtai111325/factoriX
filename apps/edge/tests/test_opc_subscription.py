"""Notifications are keyed by NodeId, never by delivery position."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from asyncua import ua

from factorix_edge.connectors import opcua
from factorix_edge.samples import ReadSample


@pytest.mark.asyncio
async def test_subscription_keeps_latest_per_node_status_and_source_time(monkeypatch):
    opened = set()
    timestamp = datetime(2026, 11, 2, 1, 45, tzinfo=timezone.utc)

    class ClientBoundary:
        def __init__(self, **_):
            pass

        async def connect(self):
            opened.add(self)

        async def disconnect(self):
            opened.discard(self)

        def get_node(self, node_id):
            return SimpleNamespace(nodeid=ua.NodeId.from_string(node_id))

        async def create_subscription(self, interval, handler):
            class Subscription:
                async def subscribe_data_change(self, nodes):
                    for node, value, status in [(nodes[1], 22, ua.StatusCodes.Good), (nodes[1], 23, ua.StatusCodes.Good), (nodes[0], 11, ua.StatusCodes.BadSensorFailure)]:
                        data_value = ua.DataValue(ua.Variant(value), StatusCode=ua.StatusCode(status), SourceTimestamp=timestamp)
                        handler.datachange_notification(node, value, SimpleNamespace(monitored_item=SimpleNamespace(Value=data_value)))

                async def delete(self):
                    pass

            return Subscription()

    monkeypatch.setattr(opcua, "Client", ClientBoundary)
    from factorix.domain.network import AllowedEndpoint
    connector = opcua.OpcUaConnector("opc.tcp://127.0.0.1:4840", [AllowedEndpoint("127.0.0.1", 4840)])
    await connector.connect()
    try:
        values = await connector.subscribe_values(["ns=2;s=first", "ns=2;s=second"], timeout_s=0.01)
    finally:
        await connector.close()
    assert {item["node_id"]: (item["value"], item["quality"], item["source_time"]) for item in values} == {
        "ns=2;s=first": (11, "BAD", timestamp), "ns=2;s=second": (23, "GOOD", timestamp),
    }
    assert not opened


@pytest.mark.asyncio
async def test_runtime_joins_opc_values_by_node_and_closes_subscribe_session(monkeypatch, probe_runtime):
    from factorix_edge import runtime as runtime_module

    opened = set()

    class ConnectorBoundary:
        def __init__(self, *_):
            pass

        async def connect(self):
            opened.add(self)

        async def subscribe_values(self, _):
            return [{"node_id": "ns=2;s=second", "value": 23, "quality": "GOOD", "source_time": datetime(2026, 11, 2, tzinfo=timezone.utc)},
                    {"node_id": "ns=2;s=first", "value": 11, "quality": "GOOD", "source_time": None}]

        async def close(self):
            opened.discard(self)

    monkeypatch.setattr(runtime_module, "OpcUaConnector", ConnectorBoundary)
    rows = await probe_runtime._read_opc({"endpoint": "opc.tcp://127.0.0.1:4840"}, [
        {"id": "a", "address_json": {"node_id": "ns=2;s=first"}},
        {"id": "b", "address_json": {"node_id": "ns=2;s=second"}},
    ], "SUBSCRIBE")
    assert {row[0]: row[1] for row in rows} == {"a": 11, "b": 23}
    assert isinstance(rows[1], ReadSample) and rows[1].source_time == "2026-11-02T00:00:00Z"
    assert not opened
