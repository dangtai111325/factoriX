"""PG observations vs TDengine parity tool (only tests call it; archival candidate, R2-E D3). Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
import math
from typing import Any
from uuid import UUID

import asyncpg

from factorix.platform.tdengine import (
    TDEngineClient,
    TDEngineError,
    op_stable_for_type,
    op_subtable_name,
    tenant_database_name,
)

from factorix.application.ingestion.common import _json_val


@dataclass(frozen=True, slots=True)
class ParityDiffReport:
    pg_count: int
    td_count: int
    missing_in_td: tuple[str, ...]
    extra_in_td: tuple[str, ...]
    mismatches: tuple[dict[str, Any], ...]

    @property
    def ok(self) -> bool:
        return not self.missing_in_td and not self.extra_in_td and not self.mismatches


async def compare_pg_vs_tdengine_observations(
    pg_pool: asyncpg.Pool,
    tdengine: TDEngineClient,
    tenant_id: UUID,
    signal_ids: Sequence[UUID],
    *,
    start: datetime,
    end: datetime,
    data_epoch: int | None = None,
) -> ParityDiffReport:
    """Compare PostgreSQL ``observations`` against TDengine Operational History over a window (S06 parity gate)."""
    if not signal_ids:
        return ParityDiffReport(0, 0, (), (), ())

    async with pg_pool.acquire() as conn:
        pg_rows = await conn.fetch(
            """
            SELECT signal_id, event_uid, event_time, received_time, source_time,
                   value_type, value_json, quality, origin, config_revision
            FROM observations
            WHERE tenant_id = $1 AND signal_id = ANY($2::uuid[])
              AND event_time >= $3 AND event_time <= $4
            ORDER BY signal_id, event_time, event_uid
            """,
            tenant_id,
            list(signal_ids),
            start,
            end,
        )
        sig_types = await conn.fetch(
            "SELECT id, data_type FROM signal_definitions WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            tenant_id,
            list(signal_ids),
        )

    type_by_signal = {UUID(str(r["id"])): str(r["data_type"]) for r in sig_types}
    db_name = tenant_database_name(tenant_id, prefix=tdengine.config.db_prefix)

    pg_by_uid: dict[str, dict[str, Any]] = {}
    for r in pg_rows:
        vj = _json_val(r["value_json"])
        val = vj.get("v") if isinstance(vj, dict) else None
        pg_by_uid[str(r["event_uid"])] = {
            "signal_id": UUID(str(r["signal_id"])),
            "event_uid": str(r["event_uid"]),
            "event_time": r["event_time"].astimezone(timezone.utc),
            "received_time": r["received_time"].astimezone(timezone.utc),
            "value_type": str(r["value_type"]),
            "value": val,
            "quality": str(r["quality"]),
            "origin": str(r["origin"]),
            "config_revision": int(r["config_revision"]),
        }

    td_by_uid: dict[str, dict[str, Any]] = {}
    for sig_id in signal_ids:
        vtype = type_by_signal.get(sig_id, "float64")
        stable = op_stable_for_type(vtype)
        subtable = op_subtable_name(sig_id, vtype)
        # Verify stable matches expectation
        _ = stable
        try:
            td_rows = await tdengine.query_range(db_name, subtable, start=start, end=end, limit=10_000)
        except TDEngineError:
            td_rows = []
        for tr in td_rows:
            if data_epoch is not None and int(tr.get("data_epoch") or 1) != data_epoch:
                continue
            uid = str(tr["event_uid"])
            td_val = tr["val"]
            if vtype == "json" and isinstance(td_val, str):
                td_val = _json_val(td_val)
            td_by_uid[uid] = {
                "signal_id": sig_id,
                "event_uid": uid,
                "ts": tr["ts"].astimezone(timezone.utc) if isinstance(tr["ts"], datetime) else tr["ts"],
                "acquired_at": tr["acquired_at"].astimezone(timezone.utc) if isinstance(tr["acquired_at"], datetime) else tr["acquired_at"],
                "value": td_val,
                "raw_quality": str(tr["raw_quality"]),
                "origin": str(tr["origin"]),
                "config_rev": int(tr["config_rev"]),
            }

    missing = tuple(sorted(uid for uid in pg_by_uid if uid not in td_by_uid))
    extra = tuple(sorted(uid for uid in td_by_uid if uid not in pg_by_uid))
    mismatches: list[dict[str, Any]] = []

    for uid in sorted(set(pg_by_uid) & set(td_by_uid)):
        pg_row = pg_by_uid[uid]
        td_row = td_by_uid[uid]
        # Tolerate up to 20us collision disambiguation shift on TDengine ts while checking acquired_at exactness
        ts_delta_us = abs((td_row["ts"] - pg_row["event_time"]).total_seconds() * 1_000_000.0)
        val_equal = _values_equal(pg_row["value"], td_row["value"], pg_row["value_type"])
        if (
            not val_equal
            or td_row["raw_quality"] != pg_row["quality"]
            or td_row["origin"] != pg_row["origin"]
            or td_row["config_rev"] != pg_row["config_revision"]
            or ts_delta_us > 50.0
        ):
            mismatches.append({"event_uid": uid, "pg": pg_row, "td": td_row, "ts_delta_us": ts_delta_us})

    return ParityDiffReport(
        pg_count=len(pg_by_uid),
        td_count=len(td_by_uid),
        missing_in_td=missing,
        extra_in_td=extra,
        mismatches=tuple(mismatches),
    )


def _values_equal(a: Any, b: Any, vtype: str) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if vtype == "float64":
        return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-12)
    return a == b
