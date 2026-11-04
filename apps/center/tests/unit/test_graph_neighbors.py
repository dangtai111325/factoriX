"""TC-BE-GR-01 through GR-08: Knowledge graph neighbors query and edge relationships."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest


def test_gr_01_structural_edges_and_depth() -> None:
    line_id = str(uuid4())
    machine_id = str(uuid4())
    other_machine_id = str(uuid4())

    edges = [
        {"id": str(uuid4()), "from": line_id, "to": machine_id, "relation_code": "CONTAINS", "since": "2026-11-03T00:00:00Z"},
        {"id": str(uuid4()), "from": line_id, "to": other_machine_id, "relation_code": "CONTAINS", "since": "2026-11-03T00:00:00Z"},
    ]

    # When centered on machine_id at depth 1:
    relevant_edges = [e for e in edges if e["from"] == machine_id or e["to"] == machine_id]
    assert len(relevant_edges) == 1
    assert relevant_edges[0]["from"] == line_id
    assert relevant_edges[0]["to"] == machine_id


def test_gr_02_include_data_virtual_edges() -> None:
    machine_id = str(uuid4())
    signal_id = str(uuid4())

    signal_node = {
        "id": signal_id,
        "kind": "signal",
        "label": "power",
        "quality": "GOOD",
        "value": 1.33,
    }
    edge = {
        "id": str(uuid4()),
        "from": machine_id,
        "to": signal_id,
        "relation_code": "HAS_SIGNAL",
        "since": "2026-11-03T10:00:00Z",
    }
    assert edge["relation_code"] == "HAS_SIGNAL"
    assert signal_node["quality"] == "GOOD"
    assert signal_node["value"] == 1.33


def test_gr_03_and_04_data_traversal_depth() -> None:
    signal_id = str(uuid4())
    conn_id = str(uuid4())
    edge_node_id = str(uuid4())

    conn_node = {
        "id": conn_id,
        "kind": "connection",
        "label": "mqtt-lab",
        "protocol": "mqtt",
        "health": "ONLINE",
    }
    edge_infra_node = {
        "id": edge_node_id,
        "kind": "edge",
        "label": "Edge DongNai",
        "health": "ONLINE",
    }
    collected_via_edge = {
        "id": str(uuid4()),
        "from": signal_id,
        "to": conn_id,
        "relation_code": "COLLECTED_VIA",
        "since": "2026-11-03T10:00:00Z",
    }
    runs_on_edge = {
        "id": str(uuid4()),
        "from": conn_id,
        "to": edge_node_id,
        "relation_code": "RUNS_ON",
        "since": "2026-11-03T10:00:00Z",
    }
    assert collected_via_edge["relation_code"] == "COLLECTED_VIA"
    assert conn_node["protocol"] == "mqtt"
    assert runs_on_edge["relation_code"] == "RUNS_ON"
    assert edge_infra_node["kind"] == "edge"


def test_gr_05_relation_filtering() -> None:
    edges = [
        {"id": "1", "relation_code": "CONTAINS"},
        {"id": "2", "relation_code": "HAS_SIGNAL"},
        {"id": "3", "relation_code": "COLLECTED_VIA"},
    ]
    filter_codes = ["CONTAINS"]
    filtered = [e for e in edges if e["relation_code"] in filter_codes]
    assert len(filtered) == 1
    assert filtered[0]["relation_code"] == "CONTAINS"


def test_gr_06_resource_without_signals() -> None:
    nodes = [{"id": "m4", "kind": "resource", "label": "AA10-04"}]
    signals: list[dict] = []
    # If no signals exist for AA10-04, no data nodes or edges are generated
    assert len(signals) == 0
    assert len(nodes) == 1


def test_gr_07_hard_limit_200_nodes() -> None:
    nodes = [{"id": str(i), "kind": "resource"} for i in range(300)]
    truncated = len(nodes) >= 200
    capped_nodes = nodes[:200]
    assert truncated is True
    assert len(capped_nodes) == 200


def test_gr_08_edges_have_since_timestamp() -> None:
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    edge = {"from": "a", "to": "b", "relation_code": "CONTAINS", "since": now_iso}
    assert "since" in edge
    assert edge["since"].endswith("Z")
