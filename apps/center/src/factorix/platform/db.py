"""Async database session. Schema changes happen only through Alembic."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import date

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from factorix.platform.settings import get_settings

_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine():
    global _engine, _session_factory
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_size=10, max_overflow=20)
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def session_factory() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _session_factory is not None
    return _session_factory


async def session_scope() -> AsyncIterator[AsyncSession]:
    factory = session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def ensure_observation_partitions(session: AsyncSession, *, today: date | None = None) -> list[str]:
    """Create the previous, current and next month partitions if they are missing."""
    anchor = today or date.today()
    months = [_shift_month(anchor, -1), _month_start(anchor), _shift_month(anchor, 1)]
    created: list[str] = []
    for start in months:
        end = _shift_month(start, 1)
        name = f"observations_{start.year}_{start.month:02d}"
        if not name.startswith("observations_"):
            raise RuntimeError("partition name")
        exists = await session.execute(text("SELECT to_regclass(:name)"), {"name": f"public.{name}"})
        if exists.scalar() is not None:
            continue
        await session.execute(
            text(
                f"CREATE TABLE {name} PARTITION OF observations "
                "FOR VALUES FROM (:start) TO (:end)"
            ),
            {"start": start.isoformat(), "end": end.isoformat()},
        )
        created.append(name)
    return created


def _month_start(value: date) -> date:
    return date(value.year, value.month, 1)


def _shift_month(value: date, delta: int) -> date:
    month = value.month - 1 + delta
    year = value.year + month // 12
    month = month % 12 + 1
    return date(year, month, 1)
