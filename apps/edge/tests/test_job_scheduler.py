"""Unit tests for independent per-job scheduler cadence (R4-12 / S2.4)."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
import pytest

from factorix_edge.runtime import EdgeRuntime


@pytest.mark.asyncio
async def test_scheduler_independent_job_intervals() -> None:
    """SCHED-01: Jobs on the same connection run at their own intervals, not clamped to min(interval)."""
    outbox = MagicMock()
    runtime = EdgeRuntime(MagicMock(), "cred", ["127.0.0.1:502"], outbox)

    async def _mock_read(protocol, connection, fields, mode):
        return [(f["id"], 42.0, "GOOD") for f in fields]

    runtime._read = AsyncMock(side_effect=_mock_read)

    conn_id = str(uuid4())
    job_fast_id = str(uuid4())
    job_slow_id = str(uuid4())

    snapshot = {
        "connections": [
            {"id": conn_id, "protocol": "modbus_tcp", "status": "ACTIVE", "config_json": {}},
        ],
        "jobs": [
            {"id": job_fast_id, "connection_id": conn_id, "enabled": True, "mode": "POLL", "interval_ms": 200},
            {"id": job_slow_id, "connection_id": conn_id, "enabled": True, "mode": "POLL", "interval_ms": 60000},
        ],
        "source_fields": [
            {"id": "f_fast", "acquisition_job_id": job_fast_id, "address_json": {"offset": 0}},
            {"id": "f_slow", "acquisition_job_id": job_slow_id, "address_json": {"offset": 10}},
        ],
        "signal_bindings": [
            {"source_field_id": "f_fast", "signal_id": str(uuid4()), "resource_id": str(uuid4()), "data_type": "float64"},
            {"source_field_id": "f_slow", "signal_id": str(uuid4()), "resource_id": str(uuid4()), "data_type": "float64"},
        ],
    }

    # First cycle at t=100.0: both jobs are due and should run
    with patch("time.monotonic", return_value=100.0):
        await runtime._collect(snapshot, revision=1)
        assert runtime._read.call_count == 2
        # Fast job is due again at 100.2
        assert runtime._due[job_fast_id] == 100.2
        # Slow job is due again at 160.0
        assert runtime._due[job_slow_id] == 160.0

    # Second cycle at t=100.25: fast job is due, slow job is NOT due!
    runtime._read.reset_mock()
    with patch("time.monotonic", return_value=100.25):
        await runtime._collect(snapshot, revision=1)
        assert runtime._read.call_count == 1
        called_fields = runtime._read.call_args[0][2]
        assert len(called_fields) == 1
        assert called_fields[0]["id"] == "f_fast"
