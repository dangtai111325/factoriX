"""Ingestion pipeline stage 'latest-state': PG commit of latest_signal_state, connection liveness and NOTIFY in one transaction. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timezone
import json
from typing import Any
from uuid import UUID

import asyncpg

from factorix.domain.canonical import intern_uuid
from factorix.modules.common import iso_ms
from factorix.modules.providers import LiveSignalRecord
from factorix.application.health.health_service import note_samples_pg

from factorix.application.ingestion.common import _json_val
from factorix.application.ingestion.notify import (
    NOTIFY_CHANNEL_HEALTH,
    NOTIFY_CHANNEL_STREAM,
    _emit_chunked_notify,
    _latest_ids_payloads,
)


class _LatestStateStore:
    """PgIngestionStore part: latest-state reads and the batch metadata commit."""

    async def fetch_latest_values(self, tenant_id: UUID, signal_ids: Sequence[UUID]) -> dict[UUID, dict[str, Any]]:
        if self._pool is None or not signal_ids:
            return {}
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT signal_id, value_json, quality, received_time, data_epoch
                FROM latest_signal_state
                WHERE tenant_id = $1 AND signal_id = ANY($2::uuid[])
                """,
                tenant_id,
                list(signal_ids),
            )
        out: dict[UUID, dict[str, Any]] = {}
        for r in rows:
            sid = UUID(str(r["signal_id"]))
            vj = _json_val(r["value_json"])
            out[sid] = {
                "value": vj.get("v") if isinstance(vj, dict) else None,
                "quality": str(r["quality"]),
                "received_time": r["received_time"],
                "data_epoch": r["data_epoch"],
            }
        return out

    async def fetch_latest_states_for_eval(
        self, tenant_id: UUID, signal_ids: Sequence[UUID]
    ) -> dict[UUID, LiveSignalRecord]:
        if self._pool is None or not signal_ids:
            return {}
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT tenant_id, signal_id, resource_id, observation_id, event_uid, data_epoch,
                       value_type, value_json, unit, quality, reason_code,
                       event_time, last_acquired_at, last_value_changed_at, source_time,
                       config_revision, origin, last_good_value_json, last_good_event_time,
                       updated_at, received_time
                FROM latest_signal_state
                WHERE tenant_id = $1 AND signal_id = ANY($2::uuid[])
                """,
                tenant_id,
                list(signal_ids),
            )
        out: dict[UUID, LiveSignalRecord] = {}
        for r in rows:
            sid = UUID(str(r["signal_id"]))
            vj = _json_val(r["value_json"])
            gv = _json_val(r["last_good_value_json"])
            out[sid] = LiveSignalRecord(
                tenant_id=UUID(str(r["tenant_id"])),
                signal_id=sid,
                resource_id=UUID(str(r["resource_id"])),
                observation_id=UUID(str(r["observation_id"])) if r.get("observation_id") else None,
                event_uid=str(r["event_uid"]) if r.get("event_uid") else None,
                data_epoch=int(r.get("data_epoch") or 1),
                value_type=str(r["value_type"]),
                value=vj.get("v") if isinstance(vj, dict) else None,
                unit=r.get("unit"),
                raw_quality=str(r["quality"]),
                reason_code=r.get("reason_code"),
                event_time=r["event_time"],
                last_acquired_at=r.get("last_acquired_at") or r["received_time"],
                last_value_changed_at=r.get("last_value_changed_at") or r["event_time"],
                source_time=r.get("source_time"),
                config_revision=int(r.get("config_revision") or 1),
                origin=str(r.get("origin") or "LIVE"),
                last_good_value=gv.get("v") if isinstance(gv, dict) else None,
                last_good_at=r.get("last_good_event_time"),
                updated_at=r.get("updated_at"),
                received_time=r["received_time"],
            )
        return out

    async def commit_batch_metadata(
        self,
        *,
        tenant_id: UUID,
        latest_rows: Sequence[dict[str, Any]],
        connection_sample_times: Mapping[UUID, datetime],
        stream_events: list[dict[str, Any]],
        shadow_pg_rows: Sequence[dict[str, Any]],
        now: datetime,
        connection_ids_for_notify: Iterable[Any] | None = None,
    ) -> tuple[set[UUID], list[dict[str, Any]]]:
        """Atomically persist latest_signal_state + connection liveness + optional shadow PG + PG NOTIFY."""
        assert self._pool is not None
        replaced_signals: set[UUID] = set()
        health_events: list[dict[str, Any]] = []
        if not (latest_rows or connection_sample_times or stream_events or shadow_pg_rows):
            return replaced_signals, health_events

        async with self._pool.acquire() as conn:
            async with conn.transaction():
                if self.async_latest_commit and not shadow_pg_rows:
                    await conn.execute("SET LOCAL synchronous_commit = off")
                if shadow_pg_rows:
                    await self._insert_shadow_pg(conn, tenant_id, shadow_pg_rows, now)

                if latest_rows:
                    # Sorted by signal_id so concurrent ingestion transactions acquire row locks in deterministic order.
                    ordered = sorted(latest_rows, key=lambda r: str(r["signal_id"]))
                    sig_ids = [r["signal_id"] for r in ordered]
                    res_ids = [r["resource_id"] for r in ordered]
                    obs_ids = [r["observation_id"] for r in ordered]
                    val_types = [r["value_type"] for r in ordered]
                    val_jsons = [json.dumps({"v": r["value"]}, allow_nan=False) for r in ordered]
                    units = [r["unit"] for r in ordered]
                    qualities = [r["quality"] for r in ordered]
                    ev_times = [r["event_time"] for r in ordered]
                    rx_times = [r["received_time"] for r in ordered]
                    acq_times = [r["last_acquired_at"] for r in ordered]
                    src_times = [r["source_time"] for r in ordered]
                    revs = [int(r["config_revision"]) for r in ordered]
                    origins = [r["origin"] for r in ordered]
                    epochs = [int(r["data_epoch"]) for r in ordered]
                    seqs = [r["source_sequence"] for r in ordered]
                    reasons = [r["reason_code"] for r in ordered]
                    uids = [r["event_uid"][:256] for r in ordered]
                    goods = [
                        json.dumps({"v": r["value"]}, allow_nan=False) if (r["quality"] == "GOOD" and r["value"] is not None) else None
                        for r in ordered
                    ]
                    good_times = [
                        r["event_time"] if (r["quality"] == "GOOD" and r["value"] is not None) else None
                        for r in ordered
                    ]
                    with_ingested = self.has_ingested_at
                    ingested_col = ", ingested_at" if with_ingested else ""
                    ingested_val = ", t.ingested_at" if with_ingested else ""
                    ingested_arr = ", $22::timestamptz[]" if with_ingested else ""
                    ingested_set = "ingested_at = EXCLUDED.ingested_at," if with_ingested else ""
                    extra_args: list[Any] = [[r.get("ingested_at") for r in ordered]] if with_ingested else []

                    ret_rows = await conn.fetch(
                        f"""
                        INSERT INTO latest_signal_state (
                            tenant_id, signal_id, resource_id, observation_id, value_type, value_json, unit, quality,
                            event_time, received_time, source_time, config_revision, origin, last_good_value_json,
                            last_good_event_time, updated_at, last_acquired_at, last_value_changed_at,
                            data_epoch, source_sequence, reason_code, event_uid{ingested_col}
                        )
                        SELECT $1::uuid, t.signal_id, t.resource_id, t.observation_id, t.value_type, t.value_json::jsonb,
                               t.unit, t.quality, t.event_time, t.received_time, t.source_time, t.config_rev, t.origin,
                               t.good_json::jsonb, t.good_time, $2::timestamptz, t.last_acquired_at, t.event_time,
                               t.data_epoch, t.source_seq, t.reason_code, t.event_uid{ingested_val}
                        FROM unnest(
                            $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[],
                            $9::text[], $10::timestamptz[], $11::timestamptz[], $12::timestamptz[],
                            $13::timestamptz[], $14::bigint[], $15::text[], $16::bigint[], $17::bigint[],
                            $18::text[], $19::text[], $20::text[], $21::timestamptz[]{ingested_arr}
                        ) AS t(
                            signal_id, resource_id, observation_id, value_type, value_json, unit,
                            quality, event_time, received_time, last_acquired_at,
                            source_time, config_rev, origin, data_epoch, source_seq,
                            reason_code, event_uid, good_json, good_time{ingested_col}
                        )
                        ON CONFLICT (tenant_id, signal_id) DO UPDATE SET
                            {ingested_set}
                            resource_id = EXCLUDED.resource_id,
                            observation_id = EXCLUDED.observation_id,
                            value_type = EXCLUDED.value_type,
                            value_json = EXCLUDED.value_json,
                            unit = EXCLUDED.unit,
                            quality = EXCLUDED.quality,
                            event_time = EXCLUDED.event_time,
                            received_time = EXCLUDED.received_time,
                            source_time = EXCLUDED.source_time,
                            config_revision = EXCLUDED.config_revision,
                            origin = EXCLUDED.origin,
                            last_acquired_at = EXCLUDED.last_acquired_at,
                            last_value_changed_at = CASE
                                WHEN latest_signal_state.value_json IS DISTINCT FROM EXCLUDED.value_json
                                  OR latest_signal_state.quality IS DISTINCT FROM EXCLUDED.quality
                                  OR COALESCE(latest_signal_state.reason_code, '') IS DISTINCT FROM COALESCE(EXCLUDED.reason_code, '')
                                  OR EXCLUDED.data_epoch > latest_signal_state.data_epoch
                                THEN EXCLUDED.event_time
                                ELSE COALESCE(latest_signal_state.last_value_changed_at, latest_signal_state.event_time)
                            END,
                            data_epoch = EXCLUDED.data_epoch,
                            source_sequence = EXCLUDED.source_sequence,
                            reason_code = EXCLUDED.reason_code,
                            event_uid = EXCLUDED.event_uid,
                            last_good_value_json = CASE
                                WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.value_json
                                ELSE latest_signal_state.last_good_value_json
                            END,
                            last_good_event_time = CASE
                                WHEN EXCLUDED.quality = 'GOOD' AND EXCLUDED.value_json->>'v' IS NOT NULL THEN EXCLUDED.event_time
                                ELSE latest_signal_state.last_good_event_time
                            END,
                            updated_at = EXCLUDED.updated_at
                        WHERE EXCLUDED.data_epoch > latest_signal_state.data_epoch
                           OR (
                               EXCLUDED.data_epoch = latest_signal_state.data_epoch
                               AND (
                                   EXCLUDED.received_time,
                                   COALESCE(EXCLUDED.source_sequence, -1),
                                   EXCLUDED.event_uid
                               ) > (
                                   latest_signal_state.received_time,
                                   COALESCE(latest_signal_state.source_sequence, -1),
                                   COALESCE(NULLIF(latest_signal_state.event_uid, ''), latest_signal_state.observation_id::text)
                               )
                           )
                        RETURNING signal_id, last_acquired_at, last_value_changed_at, data_epoch
                        """,
                        tenant_id,
                        now,
                        sig_ids,
                        res_ids,
                        obs_ids,
                        val_types,
                        val_jsons,
                        units,
                        qualities,
                        ev_times,
                        rx_times,
                        acq_times,
                        src_times,
                        revs,
                        origins,
                        epochs,
                        seqs,
                        reasons,
                        uids,
                        goods,
                        good_times,
                        *extra_args,
                    )
                    returned_rows = {intern_uuid(r["signal_id"]): dict(r) for r in ret_rows}
                    replaced_signals = set(returned_rows.keys())
                else:
                    returned_rows = {}

                if connection_sample_times:
                    # Sample evidence -> HealthService, the single writer of connections.health (R2-E C2).
                    health_events.extend(await note_samples_pg(conn, tenant_id, connection_sample_times, now))

                if self.notify_format == "v2":
                    # Compact v2: committed signal ids only; the API bridge reads the rows itself
                    # (contract WS-Q Q1). One small NOTIFY per ~180 changed signals per batch.
                    changed_ids: list[str] = []
                    other_events: list[dict[str, Any]] = []
                    for ev in stream_events:
                        if ev.get("kind") != "latest":
                            other_events.append(ev)
                        elif intern_uuid(ev["signal_id"]) in replaced_signals:
                            changed_ids.append(str(ev["signal_id"]))
                    connection_ids = sorted({str(c) for c in connection_ids_for_notify or ()})
                    max_acquired = max(
                        (r["last_acquired_at"] for r in returned_rows.values() if r.get("last_acquired_at") is not None),
                        default=None,
                    )
                    payloads = _latest_ids_payloads(tenant_id, changed_ids, connection_ids, max_acquired)
                    if payloads:
                        await conn.execute(
                            "SELECT pg_notify($1, payload) FROM unnest($2::text[]) WITH ORDINALITY AS chunks(payload, position) ORDER BY position",
                            NOTIFY_CHANNEL_STREAM,
                            payloads,
                        )
                    # CT-05: health events only on the health channel (the bridge listens to both).
                    await _emit_chunked_notify(conn, NOTIFY_CHANNEL_STREAM, other_events)
                    if health_events:
                        await _emit_chunked_notify(conn, NOTIFY_CHANNEL_HEALTH, health_events)
                    return replaced_signals, health_events

                # Filter stream latest events to signals that actually advanced in latest_signal_state
                to_notify: list[dict[str, Any]] = []
                for ev in stream_events:
                    if ev.get("kind") != "latest":
                        to_notify.append(ev)
                        continue
                    sid = intern_uuid(ev["signal_id"])
                    if sid not in replaced_signals:
                        continue
                    meta_row = returned_rows.get(sid) or {}
                    payload = dict(ev.get("payload") or {})
                    if meta_row.get("last_value_changed_at") is not None:
                        payload["last_value_changed_at"] = iso_ms(meta_row["last_value_changed_at"])
                    if meta_row.get("last_acquired_at") is not None:
                        payload["last_acquired_at"] = iso_ms(meta_row["last_acquired_at"])
                    if meta_row.get("data_epoch") is not None:
                        payload["data_epoch"] = int(meta_row["data_epoch"])
                    to_notify.append({**ev, "payload": payload})
                # CT-05: health events only on the health channel (the bridge listens to both).
                await _emit_chunked_notify(conn, NOTIFY_CHANNEL_STREAM, to_notify)
                if health_events:
                    await _emit_chunked_notify(conn, NOTIFY_CHANNEL_HEALTH, health_events)

        return replaced_signals, health_events

    async def _insert_shadow_pg(
        self,
        conn: asyncpg.Connection,
        tenant_id: UUID,
        rows: Sequence[dict[str, Any]],
        now: datetime,
    ) -> None:
        """Optional dual-path shadow insert into PostgreSQL ``observations`` for S06 parity tests."""
        # Ensure partitions exist for each month referenced by shadow batch
        months = {(r["event_time"].year, r["event_time"].month) for r in rows}
        for year, month in sorted(months):
            part_start = datetime(year, month, 1, tzinfo=timezone.utc)
            part_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc) if month == 12 else datetime(year, month + 1, 1, tzinfo=timezone.utc)
            part_name = f"observations_{year}_{month:02d}"
            await conn.execute(
                f"CREATE TABLE IF NOT EXISTS {part_name} PARTITION OF observations "
                f"FOR VALUES FROM ('{part_start.isoformat()}') TO ('{part_end.isoformat()}')"
            )

        dedup_pairs = [(r["event_uid"], r.get("connection_id") or tenant_id) for r in rows]
        inserted_uids = await conn.fetch(
            """
            INSERT INTO ingest_dedup (tenant_id, edge_id, event_uid, first_seen_at)
            SELECT $1::uuid, t.edge_id, t.event_uid, $2::timestamptz
            FROM unnest($3::text[], $4::uuid[]) AS t(event_uid, edge_id)
            ON CONFLICT DO NOTHING
            RETURNING event_uid
            """,
            tenant_id,
            now,
            [u for u, _ in dedup_pairs],
            [e for _, e in dedup_pairs],
        )
        fresh_uids = {str(r["event_uid"]) for r in inserted_uids}
        new_rows = [r for r in rows if r["event_uid"] in fresh_uids]
        if not new_rows:
            return
        await conn.execute(
            """
            INSERT INTO observations (
                id, tenant_id, site_id, resource_id, signal_id, edge_id, connection_id, event_uid,
                event_time, received_time, source_time, value_type, value_json, unit, quality, origin,
                config_revision, provenance_json
            )
            SELECT t.id, $1::uuid, t.site_id, t.resource_id, t.signal_id, NULL, t.connection_id, t.event_uid,
                   t.event_time, t.received_time, t.source_time, t.value_type, t.value_json::jsonb, t.unit,
                   t.quality, t.origin, t.config_revision, t.provenance::jsonb
            FROM unnest(
                $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[],
                $8::timestamptz[], $9::timestamptz[], $10::timestamptz[], $11::text[],
                $12::text[], $13::text[], $14::text[], $15::text[], $16::bigint[], $17::text[]
            ) AS t(
                id, site_id, resource_id, signal_id, connection_id, event_uid,
                event_time, received_time, source_time, value_type,
                value_json, unit, quality, origin, config_revision, provenance
            )
            """,
            tenant_id,
            [r["observation_id"] for r in new_rows],
            [r.get("site_id") for r in new_rows],
            [r["resource_id"] for r in new_rows],
            [r["signal_id"] for r in new_rows],
            [r.get("connection_id") for r in new_rows],
            [r["event_uid"] for r in new_rows],
            [r["event_time"] for r in new_rows],
            [r["received_time"] for r in new_rows],
            [r.get("source_time") for r in new_rows],
            [r["value_type"] for r in new_rows],
            [json.dumps({"v": r["value"]}, allow_nan=False) for r in new_rows],
            [r.get("unit") for r in new_rows],
            [r["quality"] for r in new_rows],
            [r["origin"] for r in new_rows],
            [int(r["config_revision"]) for r in new_rows],
            [json.dumps(r.get("provenance") or {}, default=str) for r in new_rows],
        )
