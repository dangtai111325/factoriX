"""TDengine 3.3.x Data Plane Client over WebSocket (``taos-ws-py``).

Design guarantees (ADR-002, ADR-003, ADR-005, §5.1, docs/storage/version-matrix.md):
- Runs in a bounded thread pool with per-worker persistent WS connections and transparent reconnect.
- Strict SQL identifier validation + backtick quoting; never interpolates unvalidated identifiers.
- Escapes ``\\`` before ``'`` in SQL string literals so JSON ``\\uXXXX`` and Unicode survive intact.
- Rejects non-finite floats (``NaN``, ``+/-Inf``) cleanly before SQL execution (TDengine rejects 0x0216).
- Uses ``conn.execute`` for writes/DDL to avoid PEP-249 ``Cursor.execute`` brace interpolation bugs
  on JSON payloads, and doubles literal braces in ``Cursor.execute`` reads so typed values preserve
  exact UTC ``datetime``, ``-0.0``, ``int64`` (up to ``2**63 - 1``), ``bool``, ``str``, and ``None``.
- Per-tenant physical database isolation (``fx_t_<tenant_hex>``), explicit subtable enumeration on
  deletes, partial-batch failure isolation down to individual rows, and verifiable Community SQL only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

import taosws

logger = logging.getLogger(__name__)

_EPOCH_UTC = datetime(1970, 1, 1, tzinfo=timezone.utc)
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_PREFIX_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,15}$")
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1

OP_STABLES: dict[str, str] = {
    "float64": "op_float64",
    "int64": "op_int64",
    "bool": "op_bool",
    "string": "op_string",
    "enum": "op_string",
    "json": "op_json",
    "timestamp": "op_int64",
}

OP_STABLE_COL_TYPES: dict[str, str] = {
    "op_float64": "DOUBLE",
    "op_int64": "BIGINT",
    "op_bool": "BOOL",
    "op_string": "NCHAR(4096)",
    "op_json": "VARCHAR(32768)",
}

MODEL_SNAPSHOTS_STABLE = "model_snapshots"


class TDEngineError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def validate_identifier(name: str, *, kind: str = "identifier") -> str:
    if not isinstance(name, str) or not _IDENT_RE.fullmatch(name):
        raise TDEngineError("INVALID_IDENTIFIER", f"Unsafe or invalid TDengine {kind}: {name!r}")
    return name


def quote_ident(name: str, *, kind: str = "identifier") -> str:
    return f"`{validate_identifier(name, kind=kind)}`"


def quote_fq_table(database: str, table: str) -> str:
    return f"{quote_ident(database, kind='database')}.{quote_ident(table, kind='table')}"


def quote_str(value: str) -> str:
    if "\x00" in value:
        raise TDEngineError("INVALID_STRING", "NUL byte is not allowed in TDengine string values.")
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def tenant_database_name(tenant_id: UUID | str, prefix: str = "fx_t_") -> str:
    if not _PREFIX_RE.fullmatch(prefix):
        raise TDEngineError("INVALID_PREFIX", f"Invalid database prefix: {prefix!r}")
    uid_hex = UUID(str(tenant_id)).hex
    return f"{prefix}{uid_hex}"


def op_stable_for_type(value_type: str) -> str:
    key = str(value_type or "").lower()
    if key not in OP_STABLES:
        raise TDEngineError("UNSUPPORTED_VALUE_TYPE", f"Unsupported telemetry value type: {value_type!r}")
    return OP_STABLES[key]


def op_subtable_name(signal_id: UUID | str, value_type: str) -> str:
    stable = op_stable_for_type(value_type)
    sig_hex = UUID(str(signal_id)).hex
    return f"{stable}_{sig_hex}"


def model_snapshot_subtable_name(group_id: UUID | str) -> str:
    return f"ms_{UUID(str(group_id)).hex}"


def to_td_timestamp_us(dt: datetime) -> int:
    if not isinstance(dt, datetime):
        raise TDEngineError("INVALID_TIMESTAMP", f"Expected datetime, got {type(dt).__name__}.")
    utc_dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
    if utc_dt.year < 1970 or utc_dt.year > 2262:
        raise TDEngineError("TIMESTAMP_OUT_OF_RANGE", f"Timestamp out of supported range: {utc_dt.isoformat()}")
    return (utc_dt - _EPOCH_UTC) // timedelta(microseconds=1)


def to_utc_datetime(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.replace(tzinfo=timezone.utc) if val.tzinfo is None else val.astimezone(timezone.utc)
    if isinstance(val, int):
        return _EPOCH_UTC + timedelta(microseconds=val)
    if isinstance(val, str):
        parsed = datetime.fromisoformat(val.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    raise TDEngineError("INVALID_TIMESTAMP", f"Cannot convert {val!r} to UTC datetime.")


def sql_literal(value: Any, *, value_type: str | None = None) -> str:
    if value is None:
        return "NULL"
    if value_type == "timestamp" or isinstance(value, datetime):
        if isinstance(value, str):
            dt = to_utc_datetime(value)
            assert dt is not None
            return str(to_td_timestamp_us(dt))
        return str(to_td_timestamp_us(value))
    if isinstance(value, bool) or value_type == "bool":
        if not isinstance(value, bool):
            raise TDEngineError("TYPE_MISMATCH", f"Expected bool value, got {type(value).__name__}.")
        return "true" if value else "false"
    if isinstance(value, int) and value_type != "float64":
        if value < _INT64_MIN or value > _INT64_MAX:
            raise TDEngineError("INT64_OVERFLOW", f"Integer {value} exceeds signed 64-bit bounds.")
        return str(value)
    if isinstance(value, (int, float)) or value_type == "float64":
        num = float(value)
        if math.isnan(num) or math.isinf(num):
            raise TDEngineError("NON_FINITE_FLOAT", "NaN and Infinity are not valid TDengine DOUBLE literals.")
        if num == 0.0:
            # Preserve -0.0 cleanly via repr(-0.0) == '-0.0'
            return "-0.0" if math.copysign(1.0, num) < 0 else "0.0"
        return repr(num)
    if isinstance(value, (dict, list)) or value_type == "json":
        payload = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        return quote_str(payload)
    if isinstance(value, str):
        return quote_str(value)
    return quote_str(str(value))


@dataclass(frozen=True, slots=True)
class TDEngineConfig:
    dsn: str
    db_prefix: str = "fx_t_"
    default_keep_days: int = 30
    default_cache_mb: int = 16
    default_vgroups: int | None = 1
    max_workers: int = 4
    batch_chunk_rows: int = 200
    max_sql_bytes: int = 240 * 1024
    connect_timeout_s: float = 10.0
    query_timeout_s: float = 15.0
    ddl_timeout_s: float = 45.0
    probe_timeout_s: float = 5.0


@dataclass(frozen=True, slots=True)
class SubtableWriteItem:
    item_id: str
    stable: str
    subtable: str
    tags: tuple[Any, ...]
    columns: tuple[str, ...]
    values: tuple[Any, ...]
    value_types: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class BatchWriteFailure:
    item_id: str
    subtable: str
    code: str
    message: str
    retryable: bool = False


@dataclass(frozen=True, slots=True)
class BatchWriteResult:
    succeeded_ids: tuple[str, ...]
    failures: tuple[BatchWriteFailure, ...]


@dataclass(frozen=True, slots=True)
class TDEngineHealth:
    reachable: bool
    server_version: str | None
    edition: str | None
    server_now_utc: datetime | None
    dnode_status: str | None
    tenant_db_count: int | None
    disk_used_bytes: int | None
    error: str | None = None


def _is_creating_or_warming_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(
        needle in text
        for needle in (
            "creating status",
            "database in creating",
            "0x0396",
            "database not ready",
            "vnode is not ready",
            "dnode is not ready",
            "mnode is not ready",
            "sync leader",
        )
    )


def _is_retryable_error(exc: BaseException) -> bool:
    if _is_creating_or_warming_error(exc):
        return True
    text = str(exc).lower()
    if any(
        needle in text
        for needle in (
            "connection",
            "websocket",
            "closed",
            "broken pipe",
            "reset by peer",
            "timed out",
            "timeout",
            "network",
            "broken",
            "eof",
            "pool",
            "database dropping",
        )
    ):
        return True
    return isinstance(exc, (ConnectionError, OSError, TimeoutError))


def _normalize_cell(val: Any) -> Any:
    if isinstance(val, datetime):
        return val.replace(tzinfo=timezone.utc) if val.tzinfo is None else val.astimezone(timezone.utc)
    return val


class TDEngineClient:
    """Async wrapper around ``taos-ws-py`` with thread-local WS connections and auto-reconnect."""

    def __init__(self, config: TDEngineConfig | str) -> None:
        if isinstance(config, str):
            config = TDEngineConfig(dsn=config)
        if not config.dsn:
            raise TDEngineError("MISSING_DSN", "FACTORIX_TDENGINE_DSN is empty.")
        self._config = config
        self._executor = ThreadPoolExecutor(max_workers=max(1, config.max_workers), thread_name_prefix="fx-td")
        self._probe_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fx-td-probe")
        self._local = threading.local()
        self._conns_lock = threading.Lock()
        self._conns: list[Any] = []
        self._closed = False

    @property
    def config(self) -> TDEngineConfig:
        return self._config

    def _get_conn(self) -> Any:
        if self._closed:
            raise TDEngineError("CLIENT_CLOSED", "TDEngineClient is closed.")
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            return conn
        try:
            conn = taosws.connect(self._config.dsn)
        except Exception as exc:
            raise TDEngineError("TDENGINE_CONNECT_FAILED", f"Failed to connect to TDengine: {exc}", retryable=True) from exc
        self._local.conn = conn
        with self._conns_lock:
            self._conns.append(conn)
        return conn

    def _drop_thread_conn(self) -> None:
        conn = getattr(self._local, "conn", None)
        self._local.conn = None
        if conn is not None:
            with self._conns_lock:
                try:
                    self._conns.remove(conn)
                except ValueError:
                    pass
            try:
                conn.close()
            except Exception:
                pass

    def _run_sync(self, fn: Callable[[Any], Any], *, allow_reconnect: bool = True) -> Any:
        attempts = 6 if allow_reconnect else 1
        last_exc: Exception | None = None
        for attempt in range(attempts):
            conn = self._get_conn()
            try:
                return fn(conn)
            except TDEngineError:
                raise
            except Exception as exc:
                last_exc = exc
                if attempt + 1 < attempts and _is_creating_or_warming_error(exc):
                    time.sleep(0.15 * (attempt + 1))
                    continue
                if attempt < 1 and allow_reconnect and _is_retryable_error(exc):
                    logger.warning("TDengine transport drop detected (%s); reconnecting.", exc)
                    self._drop_thread_conn()
                    continue
                retryable = _is_retryable_error(exc)
                raise TDEngineError("TDENGINE_QUERY_FAILED", str(exc), retryable=retryable) from exc
        assert last_exc is not None
        raise TDEngineError("TDENGINE_QUERY_FAILED", str(last_exc), retryable=True) from last_exc

    async def close(self) -> None:
        self._closed = True
        with self._conns_lock:
            conns = list(self._conns)
            self._conns.clear()
        for conn in conns:
            try:
                conn.close()
            except Exception:
                pass
        self._executor.shutdown(wait=False)
        self._probe_executor.shutdown(wait=False)

    async def __aenter__(self) -> TDEngineClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _effective_timeout(self, sql: str, timeout_s: float | None, *, use_probe_pool: bool = False) -> float:
        if timeout_s is not None:
            return max(0.5, float(timeout_s))
        if use_probe_pool:
            return max(0.5, float(self._config.probe_timeout_s))
        head = sql.lstrip()[:16].upper()
        if head.startswith(("CREATE ", "ALTER ", "DROP ")):
            return max(1.0, float(self._config.ddl_timeout_s))
        return max(1.0, float(self._config.query_timeout_s))

    async def _run_in_pool(
        self,
        fn: Callable[[Any], Any],
        *,
        timeout_s: float,
        use_probe_pool: bool = False,
    ) -> Any:
        loop = asyncio.get_running_loop()
        pool = self._probe_executor if use_probe_pool else self._executor
        try:
            return await asyncio.wait_for(loop.run_in_executor(pool, lambda: self._run_sync(fn)), timeout=timeout_s)
        except asyncio.TimeoutError as exc:
            raise TDEngineError(
                "TDENGINE_TIMEOUT",
                f"TDengine operation timed out after {timeout_s:.1f}s.",
                retryable=True,
            ) from exc

    async def execute_sql(self, sql: str, *, timeout_s: float | None = None, use_probe_pool: bool = False) -> int:
        def _exec(conn: Any) -> int:
            return int(conn.execute(sql) or 0)

        eff_timeout = self._effective_timeout(sql, timeout_s, use_probe_pool=use_probe_pool)
        return await self._run_in_pool(_exec, timeout_s=eff_timeout, use_probe_pool=use_probe_pool)

    async def query_rows(
        self,
        sql: str,
        *,
        timeout_s: float | None = None,
        use_probe_pool: bool = False,
    ) -> list[dict[str, Any]]:
        def _query(conn: Any) -> list[dict[str, Any]]:
            # Escape { / } so taosws.Cursor.execute does not run PEP-249 .format() on JSON strings in predicates.
            safe_sql = sql.replace("{", "{{").replace("}", "}}")
            cur = conn.cursor()
            try:
                cur.execute(safe_sql)
                desc = cur.description or []
                cols = [d[0] for d in desc]
                raw_rows = cur.fetchall() or []
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
            return [{col: _normalize_cell(val) for col, val in zip(cols, row, strict=True)} for row in raw_rows]

        eff_timeout = self._effective_timeout(sql, timeout_s, use_probe_pool=use_probe_pool)
        return await self._run_in_pool(_query, timeout_s=eff_timeout, use_probe_pool=use_probe_pool)

    # ------------------------------------------------------------------
    # Tenant DB & Operational History schema provisioning
    # ------------------------------------------------------------------

    async def ensure_tenant_database(
        self,
        tenant_id: UUID | str,
        *,
        keep_days: int | None = None,
        cache_mb: int | None = None,
        vgroups: int | None = None,
    ) -> str:
        db = tenant_database_name(tenant_id, prefix=self._config.db_prefix)
        keep = int(keep_days if keep_days is not None else self._config.default_keep_days)
        cache = int(cache_mb if cache_mb is not None else self._config.default_cache_mb)
        vg = vgroups if vgroups is not None else self._config.default_vgroups
        if not (1 <= keep <= 3650):
            raise TDEngineError("INVALID_KEEP_DAYS", f"keep_days must be in [1, 3650], got {keep}")
        if not (0 <= cache <= 4096):
            raise TDEngineError("INVALID_CACHE_MB", f"cache_mb must be in [0, 4096], got {cache}")
        vg_clause = ""
        if vg is not None:
            vg_int = int(vg)
            if not (1 <= vg_int <= 64):
                raise TDEngineError("INVALID_VGROUPS", f"vgroups must be in [1, 64], got {vg}")
            vg_clause = f" VGROUPS {vg_int}"
        await self.execute_sql(
            f"CREATE DATABASE IF NOT EXISTS {quote_ident(db)} PRECISION 'us' KEEP {keep}d CACHEMODEL 'last_row' CACHESIZE {cache}{vg_clause}"
        )
        return db

    async def ensure_operational_schema(
        self,
        tenant_id: UUID | str,
        *,
        keep_days: int | None = None,
        cache_mb: int | None = None,
        vgroups: int | None = None,
    ) -> str:
        db = await self.ensure_tenant_database(tenant_id, keep_days=keep_days, cache_mb=cache_mb, vgroups=vgroups)
        for stable, val_col_type in OP_STABLE_COL_TYPES.items():
            fq = quote_fq_table(db, stable)
            await self.execute_sql(
                f"CREATE STABLE IF NOT EXISTS {fq} ("
                "`ts` TIMESTAMP, "
                f"`val` {val_col_type}, "
                "`acquired_at` TIMESTAMP, "
                "`source_time` TIMESTAMP, "
                "`raw_quality` NCHAR(16), "
                "`reason_code` NCHAR(64), "
                "`origin` NCHAR(16), "
                "`unit` NCHAR(32), "
                "`event_uid` NCHAR(64), "
                "`config_rev` BIGINT, "
                "`data_epoch` BIGINT, "
                "`source_seq` BIGINT, "
                "`record_kind` NCHAR(24)"
                ") TAGS ("
                "`signal_id` NCHAR(36), "
                "`resource_id` NCHAR(36), "
                "`connection_id` NCHAR(36)"
                ")"
            )
        ms_fq = quote_fq_table(db, MODEL_SNAPSHOTS_STABLE)
        await self.execute_sql(
            f"CREATE STABLE IF NOT EXISTS {ms_fq} ("
            "`ts` TIMESTAMP, "
            "`body_text` VARCHAR(48000), "
            "`errors_json` VARCHAR(8192), "
            "`error_count` INT, "
            "`data_epoch` BIGINT"
            ") TAGS (`group_id` NCHAR(36))"
        )
        return db

    # ------------------------------------------------------------------
    # Batched writes with item-level partial-failure isolation
    # ------------------------------------------------------------------

    def _build_single_insert_clause(self, database: str, item: SubtableWriteItem) -> str:
        val_tuple = self._format_values_tuple(item)
        return self._format_subtable_header(database, item) + " VALUES " + val_tuple

    def _format_subtable_header(self, database: str, item: SubtableWriteItem) -> str:
        fq_sub = quote_fq_table(database, item.subtable)
        fq_st = quote_fq_table(database, item.stable)
        tag_sql = ", ".join(sql_literal(t) for t in item.tags)
        cols_sql = ", ".join(quote_ident(c, kind="column") for c in item.columns)
        return f"{fq_sub} ({cols_sql}) USING {fq_st} TAGS ({tag_sql})"

    def _format_values_tuple(self, item: SubtableWriteItem) -> str:
        if item.value_types:
            val_sql = ", ".join(
                sql_literal(v, value_type=vt) for v, vt in zip(item.values, item.value_types, strict=True)
            )
        else:
            val_sql = ", ".join(sql_literal(v) for v in item.values)
        return f"({val_sql})"

    async def write_batch(self, database: str, items: Sequence[SubtableWriteItem]) -> BatchWriteResult:
        """Write heterogeneous subtable items with grouped subtable VALUES chunking + per-item fallback."""
        validate_identifier(database, kind="database")
        if not items:
            return BatchWriteResult(succeeded_ids=(), failures=())

        succeeded: list[str] = []
        failures: list[BatchWriteFailure] = []
        prepared: list[tuple[SubtableWriteItem, str, str]] = []

        for item in items:
            try:
                header = self._format_subtable_header(database, item)
                val_tuple = self._format_values_tuple(item)
                prepared.append((item, header, val_tuple))
            except TDEngineError as exc:
                failures.append(BatchWriteFailure(item.item_id, item.subtable, exc.code, exc.message))

        # Group items by exact subtable header first (preserving per-subtable arrival order)
        # so multi-sample bursts emit one ``USING ... TAGS (...) VALUES (...), (...)`` per subtable.
        grouped_prepared: dict[str, list[tuple[SubtableWriteItem, str]]] = {}
        for item, header, val_tuple in prepared:
            grouped_prepared.setdefault(header, []).append((item, val_tuple))

        chunks: list[tuple[list[SubtableWriteItem], dict[str, list[str]], list[tuple[SubtableWriteItem, str, str]]]] = []
        max_rows = max(1, int(self._config.batch_chunk_rows))
        max_bytes = max(1024, int(self._config.max_sql_bytes))

        cur_items: list[SubtableWriteItem] = []
        cur_groups: dict[str, list[str]] = {}
        cur_flat: list[tuple[SubtableWriteItem, str, str]] = []
        approx_len = len("INSERT INTO ")

        for header, rows in grouped_prepared.items():
            hdr_overhead = len(header) + 9  # " " + " VALUES "
            for item, val_tuple in rows:
                is_new_hdr = header not in cur_groups
                add_len = (hdr_overhead if is_new_hdr else 2) + len(val_tuple)
                if cur_items and (len(cur_items) >= max_rows or approx_len + add_len > max_bytes):
                    chunks.append((cur_items, cur_groups, cur_flat))
                    cur_items = []
                    cur_groups = {}
                    cur_flat = []
                    approx_len = len("INSERT INTO ")
                    is_new_hdr = True
                    add_len = hdr_overhead + len(val_tuple)
                cur_items.append(item)
                cur_groups.setdefault(header, []).append(val_tuple)
                cur_flat.append((item, header, val_tuple))
                approx_len += add_len
        if cur_items:
            chunks.append((cur_items, cur_groups, cur_flat))

        for chunk_items, grouped, flat_chunk in chunks:
            stmt = "INSERT INTO " + " ".join(f"{hdr} VALUES {', '.join(vals)}" for hdr, vals in grouped.items())

            try:
                await self.execute_sql(stmt)
                succeeded.extend(it.item_id for it in chunk_items)
            except TDEngineError as exc:
                if len(flat_chunk) == 1:
                    only_item = flat_chunk[0][0]
                    failures.append(
                        BatchWriteFailure(
                            only_item.item_id,
                            only_item.subtable,
                            exc.code,
                            exc.message,
                            retryable=exc.retryable,
                        )
                    )
                    continue
                for sub_item, hdr, val_tuple in flat_chunk:
                    try:
                        await self.execute_sql(f"INSERT INTO {hdr} VALUES {val_tuple}")
                        succeeded.append(sub_item.item_id)
                    except TDEngineError as item_exc:
                        failures.append(
                            BatchWriteFailure(
                                sub_item.item_id,
                                sub_item.subtable,
                                item_exc.code,
                                item_exc.message,
                                retryable=item_exc.retryable,
                            )
                        )

        return BatchWriteResult(succeeded_ids=tuple(succeeded), failures=tuple(failures))

    async def write_operational_observations(
        self,
        tenant_id: UUID | str,
        records: Sequence[Mapping[str, Any]],
        *,
        record_kind: str = "RAW_OPERATIONAL",
    ) -> BatchWriteResult:
        """Persist canonical observations into the tenant's typed Operational History STables."""
        db = tenant_database_name(tenant_id, prefix=self._config.db_prefix)
        items: list[SubtableWriteItem] = []
        cols = (
            "ts",
            "val",
            "acquired_at",
            "source_time",
            "raw_quality",
            "reason_code",
            "origin",
            "unit",
            "event_uid",
            "config_rev",
            "data_epoch",
            "source_seq",
            "record_kind",
        )
        seen_ts: dict[str, dict[int, str]] = {}
        for rec in records:
            vtype = str(rec["value_type"])
            stable = op_stable_for_type(vtype)
            sig_id = str(UUID(str(rec["signal_id"])))
            res_id = str(UUID(str(rec["resource_id"])))
            conn_id = str(UUID(str(rec["connection_id"]))) if rec.get("connection_id") else ""
            subtable = op_subtable_name(sig_id, vtype)
            ev_ts = to_utc_datetime(rec["event_time"])
            assert ev_ts is not None
            ev_uid = str(rec["event_uid"])[:64]
            # Disambiguate intra-batch microsecond collisions ONLY across distinct event_uids, preserving replay idempotency.
            sub_seen = seen_ts.setdefault(subtable, {})
            ts_us = to_td_timestamp_us(ev_ts)
            while ts_us in sub_seen and sub_seen[ts_us] != ev_uid:
                ts_us += 1
            sub_seen[ts_us] = ev_uid
            ev_ts = to_utc_datetime(ts_us)
            acq_ts = to_utc_datetime(rec.get("acquired_at") or rec["event_time"])
            src_ts = to_utc_datetime(rec.get("source_time")) if rec.get("source_time") is not None else None
            val = rec.get("value")
            norm_vtype = vtype
            if vtype == "timestamp" and isinstance(val, datetime):
                val = to_td_timestamp_us(val)
                norm_vtype = "int64"
            items.append(
                SubtableWriteItem(
                    item_id=str(rec["event_uid"]),
                    stable=stable,
                    subtable=subtable,
                    tags=(sig_id, res_id, conn_id),
                    columns=cols,
                    values=(
                        ev_ts,
                        val,
                        acq_ts,
                        src_ts,
                        str(rec.get("raw_quality") or "GOOD")[:16],
                        str(rec["reason_code"])[:64] if rec.get("reason_code") else None,
                        str(rec.get("origin") or "LIVE")[:16],
                        str(rec["unit"])[:32] if rec.get("unit") is not None else None,
                        str(rec["event_uid"])[:64],
                        int(rec.get("config_revision") or 1),
                        int(rec.get("data_epoch") or 1),
                        int(rec["source_seq"]) if rec.get("source_seq") is not None else None,
                        record_kind[:24],
                    ),
                    value_types=(
                        "timestamp",
                        norm_vtype,
                        "timestamp",
                        "timestamp",
                        "string",
                        "string",
                        "string",
                        "string",
                        "string",
                        "int64",
                        "int64",
                        "int64",
                        "string",
                    ),
                )
            )
        return await self.write_batch(db, items)

    # ------------------------------------------------------------------
    # Queries: LAST_ROW, range, value_at (ASOF), aggregates
    # ------------------------------------------------------------------

    async def query_last_row(self, database: str, subtable: str) -> dict[str, Any] | None:
        fq = quote_fq_table(database, subtable)
        # Note: LAST_ROW(*) requires explicit column list in some queries or returns full schema
        rows = await self.query_rows(f"SELECT LAST_ROW(*) FROM {fq}")
        if not rows:
            return None
        row = rows[0]
        # TDengine prefixes LAST_ROW(*) columns as "last_row(col)"
        normalized: dict[str, Any] = {}
        for k, v in row.items():
            if k.startswith("last_row(") and k.endswith(")"):
                normalized[k[9:-1]] = v
            else:
                normalized[k] = v
        return normalized

    async def query_range(
        self,
        database: str,
        table: str,
        *,
        start: datetime,
        end: datetime,
        limit: int = 500,
        ascending: bool = True,
        cursor_ts: datetime | None = None,
        columns: Sequence[str] = (
            "ts",
            "val",
            "acquired_at",
            "source_time",
            "raw_quality",
            "reason_code",
            "origin",
            "unit",
            "event_uid",
            "config_rev",
            "data_epoch",
            "source_seq",
            "record_kind",
        ),
    ) -> list[dict[str, Any]]:
        fq = quote_fq_table(database, table)
        cols_sql = ", ".join(quote_ident(c, kind="column") for c in columns)
        start_us = to_td_timestamp_us(start)
        end_us = to_td_timestamp_us(end)
        where = f"`ts` >= {start_us} AND `ts` <= {end_us}"
        if cursor_ts is not None:
            cur_us = to_td_timestamp_us(cursor_ts)
            where += f" AND `ts` {'>' if ascending else '<'} {cur_us}"
        order = "ASC" if ascending else "DESC"
        bounded_limit = min(max(1, int(limit)), 10_000)
        return await self.query_rows(f"SELECT {cols_sql} FROM {fq} WHERE {where} ORDER BY `ts` {order} LIMIT {bounded_limit}")

    async def query_value_at(
        self,
        database: str,
        table: str,
        *,
        at: datetime,
        axis: Literal["event", "source"] = "event",
        lookback_ms: int = 86_400_000,
    ) -> dict[str, Any] | None:
        fq = quote_fq_table(database, table)
        at_us = to_td_timestamp_us(at)
        min_us = max(0, at_us - int(lookback_ms) * 1000)
        if axis == "source":
            rows = await self.query_rows(
                f"SELECT `ts`, `val`, `raw_quality`, `reason_code`, `source_time`, `acquired_at`, `data_epoch` "
                f"FROM {fq} WHERE `source_time` IS NOT NULL AND `source_time` <= {at_us} "
                f"AND `source_time` >= {min_us} AND `ts` >= {min_us} "
                "ORDER BY `source_time` DESC, `ts` DESC LIMIT 1"
            )
        else:
            rows = await self.query_rows(
                f"SELECT `ts`, `val`, `raw_quality`, `reason_code`, `source_time`, `acquired_at`, `data_epoch` "
                f"FROM {fq} WHERE `ts` >= {min_us} AND `ts` <= {at_us} "
                "ORDER BY `ts` DESC LIMIT 1"
            )
        return rows[0] if rows else None

    async def query_aggregate(
        self,
        database: str,
        table: str,
        *,
        start: datetime,
        end: datetime,
        bucket_ms: int,
        fn: Literal["min", "max", "avg", "count", "sum"],
    ) -> list[dict[str, Any]]:
        if fn not in {"min", "max", "avg", "count", "sum"}:
            raise TDEngineError("INVALID_AGGREGATE", f"Unsupported aggregate function: {fn!r}")
        bms = max(100, int(bucket_ms))
        fq = quote_fq_table(database, table)
        start_us = to_td_timestamp_us(start)
        end_us = to_td_timestamp_us(end)
        fn_sql = f"{fn.upper()}(`val`)"
        return await self.query_rows(
            f"SELECT _WSTART AS `bucket_start`, {fn_sql} AS `agg_val`, COUNT(`val`) AS `sample_count` "
            f"FROM {fq} WHERE `ts` >= {start_us} AND `ts` <= {end_us} "
            f"INTERVAL({bms}a) FILL(NONE) ORDER BY `bucket_start` ASC"
        )

    # ------------------------------------------------------------------
    # Explicit scoped deletion, table listing, DB management & health
    # ------------------------------------------------------------------

    async def list_subtables(self, database: str, *, stable: str | None = None) -> list[str]:
        validate_identifier(database, kind="database")
        sql = f"SELECT `table_name` FROM information_schema.ins_tables WHERE db_name = {quote_str(database)}"
        if stable is not None:
            validate_identifier(stable, kind="stable")
            sql += f" AND stable_name = {quote_str(stable)}"
        rows = await self.query_rows(sql)
        return [str(r["table_name"]) for r in rows]

    async def clear_subtables_up_to(
        self,
        database: str,
        subtables: Sequence[str],
        *,
        up_to_ts: datetime,
    ) -> dict[str, Any]:
        """Delete points <= ``up_to_ts`` ONLY from explicitly enumerated subtables in ``database``."""
        validate_identifier(database, kind="database")
        if not subtables:
            return {"deleted_rows": 0, "subtables_cleared": 0, "verified_zero": True}
        cutoff_us = to_td_timestamp_us(up_to_ts)
        existing = set(await self.list_subtables(database))
        total_deleted = 0
        cleared = 0
        for sub in subtables:
            validate_identifier(sub, kind="subtable")
            if sub not in existing:
                continue
            fq = quote_fq_table(database, sub)
            deleted = await self.execute_sql(f"DELETE FROM {fq} WHERE `ts` <= {cutoff_us}")
            total_deleted += deleted
            cleared += 1
            check = await self.query_rows(f"SELECT COUNT(*) AS cnt FROM {fq} WHERE `ts` <= {cutoff_us}")
            rem = int((check[0] if check else {}).get("cnt") or 0)
            if rem != 0:
                raise TDEngineError(
                    "DELETE_VERIFICATION_FAILED",
                    f"Subtable {database}.{sub} still contains {rem} row(s) <= cutoff after DELETE.",
                )
        return {"deleted_rows": total_deleted, "subtables_cleared": cleared, "verified_zero": True}

    async def drop_database(self, database: str, *, confirm: bool = False) -> None:
        if not confirm:
            raise TDEngineError("CONFIRM_REQUIRED", "Explicit confirm=True required to DROP DATABASE.")
        validate_identifier(database, kind="database")
        await self.execute_sql(f"DROP DATABASE IF EXISTS {quote_ident(database)}")

    async def health_probe(self) -> TDEngineHealth:
        try:
            ver_rows = await self.query_rows("SELECT SERVER_VERSION() AS ver, NOW() AS now_ts", use_probe_pool=True)
            server_version = str(ver_rows[0]["ver"]) if ver_rows else None
            server_now = to_utc_datetime(ver_rows[0]["now_ts"]) if ver_rows else None
            cluster_rows = await self.query_rows("SELECT version AS edition FROM information_schema.ins_cluster", use_probe_pool=True)
            edition = str(cluster_rows[0]["edition"]) if cluster_rows else None
            dnode_rows = await self.query_rows("SELECT status FROM information_schema.ins_dnodes", use_probe_pool=True)
            dnode_status = str(dnode_rows[0]["status"]) if dnode_rows else None
            db_rows = await self.query_rows(
                f"SELECT COUNT(*) AS cnt FROM information_schema.ins_databases WHERE name LIKE {quote_str(self._config.db_prefix + '%')}",
                use_probe_pool=True,
            )
            tenant_db_count = int(db_rows[0]["cnt"]) if db_rows else 0
            disk_used: int | None = None
            try:
                disk_rows = await self.query_rows(
                    "SELECT wal, data1, data2, data3, cache_rdb, table_meta FROM information_schema.ins_disk_usage",
                    use_probe_pool=True,
                )
                used_kb = sum(
                    int(row.get(col) or 0)
                    for row in disk_rows
                    for col in ("wal", "data1", "data2", "data3", "cache_rdb", "table_meta")
                )
                disk_used = used_kb * 1024
            except Exception:
                disk_used = None
            return TDEngineHealth(
                reachable=True,
                server_version=server_version,
                edition=edition,
                server_now_utc=server_now,
                dnode_status=dnode_status,
                tenant_db_count=tenant_db_count,
                disk_used_bytes=disk_used,
            )
        except Exception as exc:
            return TDEngineHealth(
                reachable=False,
                server_version=None,
                edition=None,
                server_now_utc=None,
                dnode_status=None,
                tenant_db_count=None,
                disk_used_bytes=None,
                error=str(exc),
            )


def build_taosdump_commands(database: str, output_dir: str, *, host: str = "127.0.0.1", port: int = 6030) -> dict[str, list[str]]:
    """Build safe argument arrays for ``taosdump`` backup & restore (no shell interpolation)."""
    validate_identifier(database, kind="database")
    return {
        "backup": ["taosdump", "-h", host, "-P", str(int(port)), "-D", database, "-o", output_dir],
        "restore": ["taosdump", "-h", host, "-P", str(int(port)), "-i", output_dir],
    }
