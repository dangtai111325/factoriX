"""Pytest fixtures for live PostgreSQL + RabbitMQ + 5-protocol OT Simulator Acquisition integration tests."""

from __future__ import annotations

import sys
from pathlib import Path

import asyncpg
import pytest_asyncio

_INT_DIR = str(Path(__file__).resolve().parent)
if _INT_DIR not in sys.path:
    sys.path.insert(0, _INT_DIR)

from acq_int_helpers import assert_isolated_test_env, reset_ephemeral_pg  # noqa: E402
from tests.simulators.ot_simulators import SimulatorSuite  # noqa: E402


@pytest_asyncio.fixture
async def pg_pool():
    asyncpg_dsn, _amqp, _mgmt, _key = assert_isolated_test_env()
    pool = await asyncpg.create_pool(asyncpg_dsn, min_size=1, max_size=8)
    await reset_ephemeral_pg(pool)
    try:
        yield pool, asyncpg_dsn
    finally:
        await reset_ephemeral_pg(pool)
        await pool.close()


@pytest_asyncio.fixture
async def sim_suite():
    suite = SimulatorSuite(tick_interval_s=0.15)
    endpoints = await suite.start()
    try:
        yield suite, endpoints
    finally:
        await suite.stop()
