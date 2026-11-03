"""HTTP transaction lifecycle must deliver committed events, never rolled-back ones."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from factorix.platform import after_commit


@pytest.fixture
def transaction(monkeypatch):
    # Database I/O is the boundary replaced here; the real request dependency is exercised.
    from factorix.transport import app as transport

    class Session:
        def __init__(self):
            self.info = {}
            self.committed = False
            self.rolled_back = False

        async def commit(self):
            self.committed = True

        async def rollback(self):
            self.rolled_back = True

    session = Session()
    received = []

    @asynccontextmanager
    async def factory():
        yield session

    async def listener(events):
        assert session.committed
        received.extend(events)

    monkeypatch.setattr(transport, "session_factory", lambda: factory)
    monkeypatch.setattr(after_commit, "_listeners", [listener])
    return SimpleNamespace(session=session, received=received, dependency=transport.db_session)


@pytest.mark.asyncio
async def test_request_flushes_events_only_after_successful_commit(transaction):
    dependency = transaction.dependency()
    session = await anext(dependency)
    after_commit.queue(session, {"kind": "latest", "value": 42})
    assert transaction.received == []
    with pytest.raises(StopAsyncIteration):
        await anext(dependency)
    assert transaction.received == [{"kind": "latest", "value": 42}]


@pytest.mark.asyncio
async def test_request_rollback_never_publishes_events(transaction):
    dependency = transaction.dependency()
    session = await anext(dependency)
    after_commit.queue(session, {"kind": "latest", "value": 42})
    with pytest.raises(ValueError, match="rejected"):
        await dependency.athrow(ValueError("rejected"))
    assert transaction.session.rolled_back
    assert transaction.received == []


@pytest.mark.asyncio
async def test_stream_delivery_failure_cannot_turn_a_committed_write_into_failure(transaction, monkeypatch):
    async def disconnected(events):
        raise ConnectionError("viewer disconnected")

    monkeypatch.setattr(after_commit, "_listeners", [disconnected])
    after_commit.queue(transaction.session, {"kind": "latest", "value": 42})
    transaction.session.committed = True
    await after_commit.flush(transaction.session)
    assert not transaction.session.rolled_back
    assert transaction.session.info.get("fx_events", []) == []


@pytest.mark.asyncio
async def test_private_effect_runs_after_commit_without_entering_broadcast_events(transaction):
    dependency = transaction.dependency()
    session = await anext(dependency)
    applied = []

    async def effect():
        assert session.committed
        applied.append("delivered")

    after_commit.defer(session, effect)
    assert applied == []
    with pytest.raises(StopAsyncIteration):
        await anext(dependency)
    assert applied == ["delivered"]
    assert transaction.received == []


@pytest.mark.asyncio
async def test_rollback_discards_private_effects_and_events_even_if_session_is_reused(transaction):
    dependency = transaction.dependency()
    session = await anext(dependency)
    applied = []

    async def effect():
        applied.append("must not happen")

    after_commit.defer(session, effect)
    after_commit.queue(session, {"kind": "must not broadcast"})
    with pytest.raises(ValueError, match="rejected"):
        await dependency.athrow(ValueError("rejected"))
    await after_commit.flush(session)
    assert applied == []
    assert transaction.received == []
