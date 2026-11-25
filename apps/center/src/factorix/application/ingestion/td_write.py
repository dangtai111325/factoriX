"""Ingestion pipeline stage 'tdengine write': operational and managed TDengine writes with retry. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from factorix.modules.recording_policy import ManagedSubtableWrite
from factorix.platform.tdengine import (
    BatchWriteFailure,
    BatchWriteResult,
    SubtableWriteItem,
    TDEngineError,
    op_subtable_name,
    td_error_is_schema_missing,
    to_td_timestamp_us,
    to_utc_datetime,
)

from factorix.application.ingestion.common import logger


class _TdWriteStage:
    """IngestionWorker part: TDengine writes with retry."""

    async def _write_td_with_retry(
        self,
        tenant_id: UUID,
        td_records: list[dict[str, Any]],
        *,
        record_kind: str = "RAW_OPERATIONAL",
    ) -> tuple[set[str], dict[str, BatchWriteFailure], bool]:
        """Write to TDengine with backoff on retryable/schema errors; never exhaust x-delivery-limit=5."""
        if not td_records:
            return set(), {}, False
        pending = list(td_records)
        succeeded_all: set[str] = set()
        perm_failures: dict[str, BatchWriteFailure] = {}
        delay = 0.25
        schema_retries = 0

        while pending:
            try:
                if tenant_id not in self._ensured_tenants:
                    await self.td.ensure_operational_schema(tenant_id)
                    self._ensured_tenants.add(tenant_id)
                res: BatchWriteResult = await self.td.write_operational_observations(
                    tenant_id, pending, record_kind=record_kind
                )
            except TDEngineError as exc:
                schema_missing = self._handle_possible_schema_error(tenant_id, exc.message)
                if schema_missing and schema_retries < 2:
                    schema_retries += 1
                    logger.warning(
                        "TDengine schema missing for tenant %s; re-ensuring schema (attempt %d)",
                        tenant_id,
                        schema_retries,
                    )
                    continue
                if not exc.retryable:
                    self.metrics.tdengine_permanent_errors += len(pending)
                    self.metrics.last_error = f"TDengine permanent error: {exc.message}"[:300]
                    for r in pending:
                        perm_failures[str(r["event_uid"])] = BatchWriteFailure(
                            str(r["event_uid"]),
                            op_subtable_name(r["signal_id"], r["value_type"]),
                            exc.code,
                            exc.message,
                            retryable=False,
                        )
                    return succeeded_all, perm_failures, False

                self.metrics.tdengine_retryable_errors += 1
                self.metrics.last_error = f"TDengine unavailable: {exc.message}"[:300]
                if self._stopping:
                    return succeeded_all, perm_failures, True
                logger.warning("TDengine write failed cleanly (%s); retrying %d records in %.2fs", exc.code, len(pending), delay)
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                    return succeeded_all, perm_failures, True
                except asyncio.TimeoutError:
                    pass
                delay = min(5.0, delay * 2.0)
                continue

            succeeded_all.update(res.succeeded_ids)
            retry_ids: set[str] = set()
            saw_schema_missing = False
            for fail in res.failures:
                schema_missing = self._handle_possible_schema_error(tenant_id, fail.message)
                if fail.retryable or (schema_missing and schema_retries < 2):
                    retry_ids.add(fail.item_id)
                    if schema_missing:
                        saw_schema_missing = True
                else:
                    self.metrics.tdengine_permanent_errors += 1
                    perm_failures[fail.item_id] = fail
            if saw_schema_missing:
                schema_retries += 1

            if not retry_ids:
                break
            pending = [r for r in pending if str(r["event_uid"]) in retry_ids]
            self.metrics.tdengine_retryable_errors += len(pending)
            self.metrics.last_error = f"TDengine partial retryable error on {len(pending)} item(s)"
            if self._stopping:
                return succeeded_all, perm_failures, True
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                return succeeded_all, perm_failures, True
            except asyncio.TimeoutError:
                pass
            delay = min(5.0, delay * 2.0)

        return succeeded_all, perm_failures, False

    def _handle_possible_schema_error(self, tenant_id: UUID, message: str) -> bool:
        # Classified by TDengine native code ([0x0388]/[0x0362]/[0x2603]); text only for code-less errors.
        if td_error_is_schema_missing(message):
            self._ensured_tenants.discard(tenant_id)
            return True
        return False

    async def _write_managed_td_with_retry(
        self,
        tenant_id: UUID,
        writes: Sequence[ManagedSubtableWrite],
    ) -> tuple[set[str], dict[str, BatchWriteFailure], bool]:
        """Write Managed dataset rows cleanly via ``TDEngineClient.write_batch`` with retry isolation."""
        if not writes or not hasattr(self.td, "write_batch"):
            return set(), {}, False

        seen_ts: dict[tuple[str, str], dict[int, str]] = {}
        by_db: dict[str, list[SubtableWriteItem]] = {}
        for w in writes:
            sub_key = (w.target.td_database, w.target.td_subtable)
            sub_seen = seen_ts.setdefault(sub_key, {})
            ts_us = to_td_timestamp_us(w.ts)
            while ts_us in sub_seen and sub_seen[ts_us] != w.event_uid:
                ts_us += 1
            sub_seen[ts_us] = w.event_uid
            item = w.to_subtable_item(ts_override=to_utc_datetime(ts_us))
            by_db.setdefault(w.target.td_database, []).append(item)

        succeeded_all: set[str] = set()
        perm_failures: dict[str, BatchWriteFailure] = {}
        for db_name, db_items in by_db.items():
            pending = list(db_items)
            delay = 0.25
            while pending:
                try:
                    res: BatchWriteResult = await self.td.write_batch(db_name, pending)
                except TDEngineError as exc:
                    if not exc.retryable:
                        self.metrics.managed_write_errors += len(pending)
                        self.metrics.last_error = f"Managed TDengine write error: {exc.message}"[:300]
                        for it in pending:
                            perm_failures[it.item_id] = BatchWriteFailure(
                                it.item_id,
                                it.subtable,
                                exc.code,
                                exc.message,
                                retryable=False,
                            )
                        break
                    self.metrics.tdengine_retryable_errors += 1
                    self.metrics.last_error = f"Managed TDengine unavailable: {exc.message}"[:300]
                    if self._stopping:
                        return succeeded_all, perm_failures, True
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                        return succeeded_all, perm_failures, True
                    except asyncio.TimeoutError:
                        pass
                    delay = min(5.0, delay * 2.0)
                    continue

                succeeded_all.update(res.succeeded_ids)
                retry_ids: set[str] = set()
                for fail in res.failures:
                    if fail.retryable:
                        retry_ids.add(fail.item_id)
                    else:
                        self.metrics.managed_write_errors += 1
                        self.metrics.last_error = f"Managed write rejected ({fail.code}): {fail.message}"[:300]
                        perm_failures[fail.item_id] = fail

                if not retry_ids:
                    break
                pending = [it for it in pending if it.item_id in retry_ids]
                self.metrics.tdengine_retryable_errors += len(pending)
                if self._stopping:
                    return succeeded_all, perm_failures, True
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
                    return succeeded_all, perm_failures, True
                except asyncio.TimeoutError:
                    pass
                delay = min(5.0, delay * 2.0)

        return succeeded_all, perm_failures, False
