"""R2-E C3: HistoryQueryService is the one entry point for history reads; the legacy PostgreSQL
``observations`` fallback sits behind ``FACTORIX_PG_TELEMETRY_FALLBACK`` (unset = Edge mode only)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest

from factorix.application.history import query_service as QS
from factorix.modules import models_engine, telemetry

T0 = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
TENANT = uuid4()


@pytest.mark.parametrize(
    ("explicit", "mode", "expected"),
    [(None, "edge", True), (None, "acquisition", False), (True, "acquisition", True), (False, "edge", False)],
)
def test_pg_fallback_setting(explicit: bool | None, mode: str, expected: bool) -> None:
    assert QS.pg_fallback_enabled(SimpleNamespace(pg_telemetry_fallback=explicit, collector_mode=mode)) is expected


def test_setting_is_declared() -> None:
    from factorix.platform.settings import Settings

    assert "pg_telemetry_fallback" in Settings.model_fields
    assert Settings.model_fields["pg_telemetry_fallback"].default is None


@pytest.fixture()
def captured(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def fetch_all(_session: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        calls.append((sql, params))
        if "FROM observations" in sql and "ORDER BY event_time DESC" in sql:
            return [{"id": uuid4(), "event_time": T0 - timedelta(seconds=i), "value_json": {"v": float(i)}} for i in range(3)]
        return []

    monkeypatch.setattr(QS, "fetch_all", fetch_all)
    return calls


async def test_fallback_off_reads_no_observations(monkeypatch: pytest.MonkeyPatch, captured: list[Any]) -> None:
    monkeypatch.setattr(QS, "pg_fallback_enabled", lambda settings=None: False)
    page = await telemetry.history(object(), TENANT, signal_id=uuid4(), start=T0 - timedelta(minutes=15), end=T0,  # type: ignore[arg-type]
                                   limit=30, cursor=None)
    agg = await telemetry.aggregate(object(), TENANT, signal_ids=[uuid4()], start=T0 - timedelta(hours=1), end=T0,  # type: ignore[arg-type]
                                    bucket_ms=60_000, fn="avg")
    at = await models_engine.fetch_value_at(object(), TENANT, [(str(uuid4()), T0, "s")])  # type: ignore[arg-type]
    assert captured == []
    assert page["items"] == [] and "fallback is disabled" in page["coverage_notes"][0]
    assert agg["buckets"] == [] and list(at.values()) == [None]


async def test_order_newest_returns_the_latest_rows_ascending(monkeypatch: pytest.MonkeyPatch, captured: list[Any]) -> None:
    monkeypatch.setattr(QS, "pg_fallback_enabled", lambda settings=None: True)
    page = await telemetry.history(object(), TENANT, signal_id=uuid4(), start=T0 - timedelta(minutes=15), end=T0,  # type: ignore[arg-type]
                                   limit=3, cursor=None, order="newest")
    (sql, params) = captured[0]
    assert "ORDER BY event_time DESC, id DESC" in sql and params["limit"] == 4
    assert [row["value"] for row in page["items"]] == [2.0, 1.0, 0.0]  # oldest -> newest of the last 3
    assert page["next_cursor"] is None


async def test_order_newest_cannot_be_paged() -> None:
    from factorix.platform.errors import AppError

    with pytest.raises(AppError):
        await QS.HistoryQueryService(pg_fallback=True).history(
            object(), TENANT, QS.HistoryQuery(signal_id=uuid4(), start=T0 - timedelta(minutes=1), end=T0, cursor="x|y", order="newest")  # type: ignore[arg-type]
        )
