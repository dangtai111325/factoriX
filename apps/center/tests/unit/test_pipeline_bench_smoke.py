"""Smoke-run the in-repo pipeline benchmark (tests/load/bench_pipeline.py) on a tiny load.

Keeps the harness from rotting and checks the end-to-end batched path: every observation is
published in few envelopes, ingested and ACKed, with one TDengine statement and one PostgreSQL
commit per lane batch.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

BENCH = Path(__file__).resolve().parents[4] / "tests" / "load" / "bench_pipeline.py"


def _load_bench():
    spec = importlib.util.spec_from_file_location("fx_bench_pipeline", BENCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["batch", "single"])
async def test_pipeline_benchmark_smoke(mode: str) -> None:
    bench = _load_bench()
    result = await bench.run(signals=40, cycles=3, mode=mode, confirm_latency_ms=0, td_latency_ms=0)
    assert result["published"] == result["observations"] == 120
    assert result["ingest_messages_acked"] == result["amqp_messages"]
    if mode == "batch":
        assert result["amqp_messages"] <= 2  # 120 observations in one or two envelopes
        assert result["td_statements"] == result["pg_commits"] == 1
        assert result["pg_latest_rows"] == 40  # one latest-state row per signal per batch
    else:
        assert result["amqp_messages"] == 120  # legacy wire format still ingests
