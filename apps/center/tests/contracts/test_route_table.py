"""Characterization: the HTTP/WS route table of the API process (contract contracts/internal-http.md).

``golden/routes.txt`` is the reviewed list of (METHOD, path) pairs. Adding, removing or renaming a route is a
contract change for the web client: update the snapshot deliberately with

    FACTORIX_UPDATE_CONTRACT_SNAPSHOTS=1 python -m pytest apps/center/tests/contracts/test_route_table.py

and mention the route change in the report of the change.
"""

from __future__ import annotations

import os
from collections import Counter
from pathlib import Path

import pytest

from factorix.transport.app import app

SNAPSHOT = Path(__file__).parent / "golden" / "routes.txt"


def route_pairs() -> list[tuple[str, str]]:
    """(METHOD, path) for every mounted route, including routes of included routers (FastAPI >= 0.16x)."""
    try:
        from fastapi.routing import iter_route_contexts

        routes = [ctx.route for ctx in iter_route_contexts(app.routes)]
    except ImportError:  # older FastAPI: included routes are flattened into app.routes
        routes = list(app.routes)
    pairs: list[tuple[str, str]] = []
    for route in routes:
        path = getattr(route, "path", None)
        if not path:
            continue
        methods = getattr(route, "methods", None)
        if methods:
            pairs.extend((m, path) for m in sorted(methods) if m != "HEAD")
        elif type(route).__name__ == "APIWebSocketRoute":
            pairs.append(("WS", path))
        else:
            pairs.append(("MOUNT", path))
    return pairs


def _render(pairs: list[tuple[str, str]]) -> str:
    return "\n".join(f"{m} {p}" for m, p in sorted(set(pairs), key=lambda mp: (mp[1], mp[0]))) + "\n"


def test_route_table_snapshot() -> None:
    current = _render(route_pairs())
    if os.environ.get("FACTORIX_UPDATE_CONTRACT_SNAPSHOTS") == "1":
        SNAPSHOT.write_text(current, encoding="utf-8")
    expected = SNAPSHOT.read_text(encoding="utf-8").replace("\r\n", "\n")
    cur, exp = set(current.splitlines()), set(expected.splitlines())
    assert cur == exp, (
        f"Route table changed. Added: {sorted(cur - exp)} Removed: {sorted(exp - cur)}. "
        "If intended, regenerate golden/routes.txt (see module docstring)."
    )


def test_no_duplicate_method_path() -> None:
    dupes = {pair: n for pair, n in Counter(route_pairs()).items() if n > 1}
    assert dupes == {}


def test_edge_sync_surface_is_the_known_legacy_set() -> None:
    """The legacy Edge machine-to-machine surface (guarded by A4(b): 410 Gone in acquisition mode)."""
    edge_sync = sorted(((m, p) for m, p in route_pairs() if p.startswith("/api/v1/edge-sync")), key=lambda mp: (mp[1], mp[0]))
    assert edge_sync == [
        ("POST", "/api/v1/edge-sync/ack"),
        ("GET", "/api/v1/edge-sync/commands"),
        ("POST", "/api/v1/edge-sync/commands/{job_id}"),
        ("GET", "/api/v1/edge-sync/config"),
        ("POST", "/api/v1/edge-sync/enroll"),
        ("POST", "/api/v1/edge-sync/heartbeat"),
        ("POST", "/api/v1/edge-sync/observations"),
        ("GET", "/api/v1/edge-sync/secrets/{secret_id}"),
    ]


def test_process_probes_exist() -> None:
    pairs = set(route_pairs())
    assert {("GET", "/health/live"), ("GET", "/health/ready"), ("WS", "/stream")} <= pairs
