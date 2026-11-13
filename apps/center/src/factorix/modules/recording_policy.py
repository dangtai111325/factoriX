"""Deterministic Managed Recording Policy Engine for Operational & Managed TDengine writes (S07).

Implements §5.3 and `RecordingPolicyEvaluator`:
- `ON_CHANGE`: baseline on first sample/epoch/revision, mandatory quality & reason transitions,
  deterministic canonical equality across bool/int64/float64(finite, -0.0==0.0)/NFKC string/enum/
  key-sorted json/UTC timestamp, explicit numeric deadband (`absolute` / `percent`) anchored against
  the last *recorded* value, and optional `maxCheckpointInterval` keepalive (`record_kind='checkpoint'`).
- `EVERY_ACQUISITION`: every distinct `event_uid` persisted (`event_stream` & full-fidelity datasets).
- `INTERVAL`: UTC-aligned epoch buckets `[k*I, (k+1)*I)` with `lateTolerance` backfill, mandatory
  intra-bucket quality transitions, and deterministic empty-interval `GAP_MARKER` / `NULL` /
  `HOLD_LAST_WITH_QUALITY` materialization without fabricating fake GOOD values.
- Safe scalar transforms via AST whitelist (`validate_safe_transform` / `eval_safe_transform`),
  classifying arithmetic/type errors cleanly as `BAD` / `TRANSFORM_ERROR`.
"""

from __future__ import annotations

import ast
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import json
import math
import os
from typing import Any, Literal
import unicodedata
from uuid import UUID

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.quality import Origin
from factorix.modules.providers import (
    LiveSignalRecord,
    ManagedWriteDirective,
    RecordingDecision,
    RecordingMode,
    SkipReason,
)
from factorix.modules.storage_dsl import (
    eval_safe_transform,
    parse_duration_ms,
    validate_safe_transform,
)
from factorix.platform.tdengine import (
    SubtableWriteItem,
    to_td_timestamp_us,
    to_utc_datetime,
)

MAX_INTERVAL_GAPS_PER_STEP = 1000
_DEFAULT_STRING_MAX_LEN = 1024
_DEFAULT_JSON_MAX_LEN = 16384


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _json_obj(raw: Any) -> Any:
    if isinstance(raw, str):
        stripped = raw.strip()
        if not stripped:
            return {}
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return {}
    return raw


@dataclass(frozen=True, slots=True)
class ManagedBindingTarget:
    """Active Managed dataset field binding & recording policy metadata for a signal or model field."""

    design_id: UUID
    design_version_id: UUID | None
    dataset_id: UUID
    tag_dataset_id: str
    dataset_key: str
    design_status: str
    dataset_status: str
    registry_status: str
    semantics: str
    time_axis: Literal["acquired_at", "source_time"]
    td_database: str
    td_stable: str
    td_subtable: str
    series_key: str
    field_key: str
    value_type: str
    max_length: int | None
    nullable: bool
    required: bool
    signal_id: UUID | None
    model_id: UUID | None
    model_field_path: str | None
    resource_id: UUID | None
    source_revision: int
    transform_expr: str | None
    transform_ast: ast.Expression | None
    mode: RecordingMode
    quality_transitions: bool = True
    deadband_kind: Literal["absolute", "percent"] | None = None
    deadband_value: float | None = None
    max_checkpoint_interval_ms: int | None = None
    interval_ms: int | None = None
    late_tolerance_ms: int | None = None
    missing_policy: Literal["GAP_MARKER", "NULL", "HOLD_LAST_WITH_QUALITY"] = "GAP_MARKER"
    policy_version: int = 1
    policy_enabled: bool = True
    custom_tags: tuple[tuple[str, str], ...] = ()

    @property
    def is_paused(self) -> bool:
        return (
            not self.policy_enabled
            or self.design_status.upper() == "PAUSED"
            or self.dataset_status.upper() == "PAUSED"
            or self.registry_status.upper() == "PAUSED"
        )

    @property
    def is_active_or_paused(self) -> bool:
        return (
            self.design_status.upper() in {"RUNNING", "PAUSED"}
            and self.dataset_status.upper() in {"RUNNING", "PAUSED"}
            and self.registry_status.upper() in {"ACTIVE", "PAUSED"}
        )

    def build_tags_tuple(self) -> tuple[Any, ...]:
        return (
            self.tag_dataset_id,
            self.series_key,
            str(self.resource_id) if self.resource_id is not None else "",
            *(val for _k, val in self.custom_tags),
        )


def build_managed_target_from_row(row: Mapping[str, Any]) -> ManagedBindingTarget:
    """Construct a validated ``ManagedBindingTarget`` from a PostgreSQL catalog join row."""
    design_id = UUID(str(row["design_id"]))
    dataset_id = UUID(str(row["dataset_id"]))
    design_ver_raw = row.get("design_version_id")
    design_version_id = UUID(str(design_ver_raw)) if design_ver_raw else None

    reg_series_key = str(row["registry_series_key"])
    dataset_prefix = f"{dataset_id}:"
    design_prefix = f"{design_id}:"
    if reg_series_key.startswith(dataset_prefix):
        short_series_key = reg_series_key[len(dataset_prefix) :]
    elif reg_series_key.startswith(design_prefix):
        short_series_key = reg_series_key[len(design_prefix) :]
    else:
        short_series_key = reg_series_key

    transform_raw = _json_obj(row.get("transform_json"))
    transform_expr: str | None = None
    if isinstance(transform_raw, Mapping) and transform_raw.get("expr"):
        transform_expr = str(transform_raw["expr"]).strip() or None
    elif isinstance(transform_raw, str) and transform_raw.strip():
        transform_expr = transform_raw.strip()

    transform_ast: ast.Expression | None = None
    if transform_expr:
        compiled_ast, issues = validate_safe_transform(transform_expr)
        if compiled_ast is not None and not issues:
            transform_ast = compiled_ast

    policy_json = _json_obj(row.get("policy_json"))
    if not isinstance(policy_json, Mapping):
        policy_json = {}

    mode_str = str(row.get("recording_mode") or policy_json.get("mode") or "ON_CHANGE").upper()
    try:
        mode = RecordingMode(mode_str)
    except ValueError:
        mode = RecordingMode.ON_CHANGE

    db_raw = policy_json.get("deadband")
    deadband_kind: Literal["absolute", "percent"] | None = None
    deadband_value: float | None = None
    if isinstance(db_raw, Mapping):
        k = str(db_raw.get("kind") or "absolute").strip().lower()
        deadband_kind = "percent" if k == "percent" else "absolute"
        try:
            dv = float(db_raw.get("value") or 0.0)
            if math.isfinite(dv) and dv >= 0.0:
                deadband_value = dv
        except (TypeError, ValueError):
            deadband_value = None
    elif isinstance(db_raw, (int, float)) and not isinstance(db_raw, bool):
        dv = float(db_raw)
        if math.isfinite(dv) and dv >= 0.0:
            deadband_kind = "absolute"
            deadband_value = dv

    def _safe_dur_ms(raw_val: Any) -> int | None:
        if raw_val is None or raw_val == "":
            return None
        if isinstance(raw_val, (int, float)) and not isinstance(raw_val, bool):
            # Integer ms vs DSL helper: string durations use parse_duration_ms; raw numbers also follow DSL seconds.
            return max(0, int(round(float(raw_val) * 1000.0)))
        try:
            return parse_duration_ms(raw_val, allow_none=True)
        except Exception:  # noqa: BLE001
            return None

    cp_ms = (
        int(policy_json["max_checkpoint_interval_ms"])
        if policy_json.get("max_checkpoint_interval_ms") is not None
        else _safe_dur_ms(
            policy_json.get("maxCheckpointInterval", policy_json.get("max_checkpoint_interval"))
        )
    )
    intv_ms = (
        int(policy_json["interval_ms"])
        if policy_json.get("interval_ms") is not None
        else _safe_dur_ms(policy_json.get("interval"))
    )
    late_ms = (
        int(policy_json["late_tolerance_ms"])
        if policy_json.get("late_tolerance_ms") is not None
        else _safe_dur_ms(policy_json.get("lateTolerance", policy_json.get("late_tolerance")))
    )

    missing_raw = str(
        policy_json.get("missingPolicy") or policy_json.get("missing_policy") or "GAP_MARKER"
    ).strip().upper()
    if missing_raw not in {"GAP_MARKER", "NULL", "HOLD_LAST_WITH_QUALITY"}:
        missing_raw = "GAP_MARKER"

    tags_raw = _json_obj(row.get("tags_json"))
    custom_tags: list[tuple[str, str]] = []
    if isinstance(tags_raw, Sequence) and not isinstance(tags_raw, (str, bytes)):
        for t in tags_raw:
            if isinstance(t, Mapping) and t.get("key"):
                custom_tags.append((str(t["key"]), str(t.get("value") or "")))

    t_axis = str(row.get("time_axis") or "acquired_at").strip()
    time_axis: Literal["acquired_at", "source_time"] = (
        "source_time" if t_axis == "source_time" else "acquired_at"
    )

    return ManagedBindingTarget(
        design_id=design_id,
        design_version_id=design_version_id,
        dataset_id=dataset_id,
        tag_dataset_id=str(row.get("tag_dataset_id") or dataset_id),
        dataset_key=str(row["dataset_key"]),
        design_status=str(row.get("design_status") or "RUNNING"),
        dataset_status=str(row.get("dataset_status") or "RUNNING"),
        registry_status=str(row.get("registry_status") or "ACTIVE"),
        semantics=str(row.get("semantics") or "state_series"),
        time_axis=time_axis,
        td_database=str(row["td_database"]),
        td_stable=str(row["td_stable"]),
        td_subtable=str(row["td_subtable"]),
        series_key=short_series_key,
        field_key=str(row["field_key"]),
        value_type=str(row["value_type"]),
        max_length=int(row["max_length"]) if row.get("max_length") is not None else None,
        nullable=bool(row.get("nullable", True)),
        required=bool(row.get("required", False)),
        signal_id=UUID(str(row["signal_id"])) if row.get("signal_id") else None,
        model_id=UUID(str(row["model_id"])) if row.get("model_id") else None,
        model_field_path=str(row["model_field_path"]) if row.get("model_field_path") else None,
        resource_id=UUID(str(row["resource_id"])) if row.get("resource_id") else None,
        source_revision=int(row.get("source_revision") or 1),
        transform_expr=transform_expr,
        transform_ast=transform_ast,
        mode=mode,
        quality_transitions=True,
        deadband_kind=deadband_kind,
        deadband_value=deadband_value,
        max_checkpoint_interval_ms=cp_ms,
        interval_ms=intv_ms,
        late_tolerance_ms=late_ms,
        missing_policy=missing_raw,  # type: ignore[arg-type]
        policy_version=int(row.get("policy_version") or 1),
        policy_enabled=bool(row.get("policy_enabled", True)),
        custom_tags=tuple(custom_tags),
    )


@dataclass(slots=True)
class ManagedSeriesState:
    last_recorded_value: Any = None
    last_recorded_quality: str | None = None
    last_recorded_reason: str | None = None
    last_recorded_ts: datetime | None = None
    last_acquired_ts: datetime | None = None
    last_source_revision: int = 1
    last_data_epoch: int = 1
    last_policy_version: int = 1
    last_event_uid: str | None = None
    last_bucket_idx: int | None = None
    last_valid_value: Any = None
    last_valid_quality: str | None = None
    last_valid_ts: datetime | None = None
    has_baseline: bool = False


@dataclass(frozen=True, slots=True)
class ManagedSubtableWrite:
    target: ManagedBindingTarget
    ts: datetime
    acquired_at: datetime
    source_time: datetime | None
    raw_quality: str
    reason_code: str | None
    event_uid: str
    data_epoch: int
    record_kind: str
    value: Any
    value_type: str

    def to_subtable_item(self, *, ts_override: datetime | None = None) -> SubtableWriteItem:
        write_ts = ts_override or self.ts
        val_out = self.value
        norm_vtype = self.value_type
        if norm_vtype == "timestamp" and val_out is not None and not isinstance(val_out, datetime):
            val_out = to_utc_datetime(val_out)
        elif norm_vtype == "enum":
            norm_vtype = "string"
        return SubtableWriteItem(
            item_id=f"{self.target.dataset_id}:{self.target.series_key}:{self.event_uid}",
            stable=self.target.td_stable,
            subtable=self.target.td_subtable,
            tags=self.target.build_tags_tuple(),
            columns=(
                "ts",
                "acquired_at",
                "source_time",
                "raw_quality",
                "reason_code",
                "event_uid",
                "data_epoch",
                "record_kind",
                self.target.field_key,
            ),
            values=(
                write_ts,
                self.acquired_at,
                self.source_time,
                self.raw_quality[:16],
                self.reason_code[:64] if self.reason_code else None,
                self.event_uid[:64],
                int(self.data_epoch),
                self.record_kind[:24],
                val_out,
            ),
            value_types=(
                "timestamp",
                "timestamp",
                "timestamp",
                "string",
                "string",
                "string",
                "int64",
                "string",
                norm_vtype,
            ),
        )


@dataclass(frozen=True, slots=True)
class DetailedRecordingResult:
    decision: RecordingDecision
    writes: tuple[ManagedSubtableWrite, ...] = ()


@dataclass(slots=True)
class PolicyMetricsCounter:
    acquired_evaluated: int = 0
    operational_written: int = 0
    managed_written: int = 0
    managed_checkpoints: int = 0
    managed_gap_markers: int = 0
    managed_skipped_by_reason: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def record_decision(
        self,
        decision: RecordingDecision,
        writes: Sequence[ManagedSubtableWrite] = (),
    ) -> None:
        self.acquired_evaluated += 1
        if decision.write_operational:
            self.operational_written += 1
        for d in decision.managed_directives:
            if d.write_row:
                self.managed_written += 1
                if d.keepalive_triggered:
                    self.managed_checkpoints += 1
            elif d.skip_reason != SkipReason.NONE:
                self.managed_skipped_by_reason[d.skip_reason.value] += 1
        for w in writes:
            if w.record_kind in {"gap_marker", "interval_null", "interval_held"}:
                self.managed_gap_markers += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "acquired_evaluated": self.acquired_evaluated,
            "operational_written": self.operational_written,
            "managed_written": self.managed_written,
            "managed_checkpoints": self.managed_checkpoints,
            "managed_gap_markers": self.managed_gap_markers,
            "managed_skipped_by_reason": dict(self.managed_skipped_by_reason),
        }


def _coerce_field_value(
    value: Any,
    value_type: str,
    *,
    max_length: int | None,
    nullable: bool,
    raw_quality: str,
    reason_code: str | None,
) -> tuple[Any, str, str | None, bool]:
    """Normalize value to canonical Managed column representation with deterministic validation."""
    qual = str(raw_quality or "GOOD").upper()
    reason = reason_code
    if value is None:
        if not nullable and qual == "GOOD":
            return None, "BAD", reason or "NULL_VALUE", False
        return None, qual, reason, False

    vt = str(value_type or "float64").lower()
    if vt == "bool":
        if isinstance(value, bool):
            return value, qual, reason, False
        return None, "BAD", "TYPE_MISMATCH", True

    if vt == "int64":
        if isinstance(value, bool):
            return None, "BAD", "TYPE_MISMATCH", True
        if isinstance(value, int):
            if value < -(2**63) or value > (2**63 - 1):
                return None, "BAD", "INT64_OVERFLOW", True
            return value, qual, reason, False
        if isinstance(value, float):
            if not math.isfinite(value):
                return None, "BAD", "NON_FINITE_FLOAT", True
            iv = int(value)
            if iv < -(2**63) or iv > (2**63 - 1):
                return None, "BAD", "INT64_OVERFLOW", True
            return iv, qual, reason, False
        return None, "BAD", "TYPE_MISMATCH", True

    if vt == "float64":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, "BAD", "TYPE_MISMATCH", True
        num = float(value)
        if not math.isfinite(num):
            return None, "BAD", "NON_FINITE_FLOAT", True
        return num, qual, reason, False

    if vt in {"string", "enum"}:
        norm_text = unicodedata.normalize("NFKC", str(value))
        if "\x00" in norm_text:
            return None, "BAD", "INVALID_STRING", True
        limit = max_length if max_length is not None else _DEFAULT_STRING_MAX_LEN
        if len(norm_text) > limit:
            return None, "BAD", "VALUE_TOO_LONG", True
        return norm_text, qual, reason, False

    if vt == "json":
        parsed = value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                parsed = value
        try:
            encoded = json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError):
            return None, "BAD", "INVALID_JSON", True
        limit = max_length if max_length is not None else _DEFAULT_JSON_MAX_LEN
        if len(encoded) > limit:
            return None, "BAD", "VALUE_TOO_LONG", True
        return parsed, qual, reason, False

    if vt == "timestamp":
        try:
            dt = to_utc_datetime(value)
            if dt is None:
                return None, "BAD", "INVALID_TIMESTAMP", True
            _ = to_td_timestamp_us(dt)
            return dt, qual, reason, False
        except Exception:  # noqa: BLE001
            return None, "BAD", "INVALID_TIMESTAMP", True

    return None, "BAD", "UNSUPPORTED_TYPE", True


def _canonical_json_str(value: Any) -> str:
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value
    return json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_values_compare(
    old_val: Any,
    new_val: Any,
    *,
    value_type: str,
    deadband_kind: Literal["absolute", "percent"] | None = None,
    deadband_value: float | None = None,
) -> tuple[bool, bool]:
    """Compare two normalized typed values cleanly.

    Returns ``(is_unchanged_or_within_deadband, skipped_due_to_deadband)``.
    """
    if old_val is None or new_val is None:
        return (old_val is None and new_val is None), False

    vt = str(value_type or "float64").lower()
    if vt == "bool":
        return (bool(old_val) is bool(new_val)), False

    if vt in {"string", "enum"}:
        return (
            unicodedata.normalize("NFKC", str(old_val))
            == unicodedata.normalize("NFKC", str(new_val))
        ), False

    if vt == "json":
        return (_canonical_json_str(old_val) == _canonical_json_str(new_val)), False

    if vt == "timestamp":
        dt_a = to_utc_datetime(old_val)
        dt_b = to_utc_datetime(new_val)
        if dt_a is None or dt_b is None:
            return (dt_a is None and dt_b is None), False
        return (to_td_timestamp_us(dt_a) == to_td_timestamp_us(dt_b)), False

    if vt == "int64":
        try:
            ia = int(old_val)
            ib = int(new_val)
        except (TypeError, ValueError):
            return False, False
        if ia == ib:
            return True, False
        if deadband_value is not None and deadband_value > 0.0:
            db = float(deadband_value)
            if deadband_kind == "percent":
                if ia == 0:
                    return False, False
                pct = (abs(ib - ia) / abs(ia)) * 100.0
                eps = 1e-12 * max(1.0, pct, db)
                within = (pct - db) <= eps
                return within, within
            within = float(abs(ib - ia)) <= db
            return within, within
        return False, False

    if vt == "float64":
        try:
            fa = float(old_val)
            fb = float(new_val)
        except (TypeError, ValueError):
            return False, False
        if not (math.isfinite(fa) and math.isfinite(fb)):
            return False, False
        # Handles signed zero deterministically (-0.0 == 0.0)
        if fa == fb:
            return True, False
        if deadband_value is not None and deadband_value > 0.0:
            db = float(deadband_value)
            if deadband_kind == "percent":
                if fa == 0.0:
                    return False, False
                pct = (abs(fb - fa) / abs(fa)) * 100.0
                eps = 1e-12 * max(1.0, pct, db)
                within = (pct - db) <= eps
                return within, within
            diff = abs(fb - fa)
            eps = 1e-12 * max(1.0, abs(fa), abs(fb), db)
            within = (diff - db) <= eps
            return within, within
        return False, False

    return (old_val == new_val), False


def _choose_time_axis(obs: CanonicalObservation, target: ManagedBindingTarget) -> datetime:
    if target.time_axis == "source_time" and obs.source_time is not None:
        return to_utc_datetime(obs.source_time) or obs.acquired_at
    return to_utc_datetime(obs.acquired_at) or obs.acquired_at


def _apply_safe_transform(
    obs: CanonicalObservation,
    target: ManagedBindingTarget,
    raw_quality: str,
    reason_code: str | None,
) -> tuple[Any, str, str | None]:
    val = obs.value
    qual = str(raw_quality or "GOOD").upper()
    reason = reason_code
    if target.transform_ast is not None:
        if val is None:
            transformed = None
        else:
            try:
                transformed = eval_safe_transform(target.transform_ast, val)
                if transformed is None:
                    return None, "BAD", "TRANSFORM_ERROR"
            except (ArithmeticError, ValueError, TypeError):
                return None, "BAD", "TRANSFORM_ERROR"
        val = transformed

    coerced, eff_qual, eff_reason, had_err = _coerce_field_value(
        val,
        target.value_type,
        max_length=target.max_length,
        nullable=target.nullable,
        raw_quality=qual,
        reason_code=reason,
    )
    if had_err:
        return coerced, eff_qual, eff_reason
    return coerced, eff_qual, eff_reason


class DefaultRecordingPolicyEvaluator:
    """Stateful-per-worker recording policy evaluator backed by TDengine LAST_ROW recovery."""

    def __init__(
        self,
        *,
        targets_by_signal: Mapping[UUID, Sequence[ManagedBindingTarget]] | None = None,
        metrics: PolicyMetricsCounter | None = None,
        write_operational: bool | None = None,
    ) -> None:
        self._targets_by_signal: dict[UUID, tuple[ManagedBindingTarget, ...]] = (
            {sig: tuple(tlist) for sig, tlist in targets_by_signal.items()}
            if targets_by_signal
            else {}
        )
        # Keyed by (tenant_id, dataset_id, series_key)
        self._states: dict[tuple[UUID, UUID, str], ManagedSeriesState] = {}
        self.metrics = metrics or PolicyMetricsCounter()
        if write_operational is None:
            raw_env = os.environ.get("FACTORIX_RECORD_OPERATIONAL", "").strip().lower()
            env_mode = os.environ.get("FACTORIX_ENVIRONMENT", "").strip().lower()
            if env_mode == "test":
                self.write_operational = True
            elif raw_env in ("false", "0", "no"):
                self.write_operational = False
            else:
                self.write_operational = True
        else:
            self.write_operational = bool(write_operational)

    def set_targets(self, targets_by_signal: Mapping[UUID, Sequence[ManagedBindingTarget]]) -> None:
        self._targets_by_signal = {sig: tuple(tlist) for sig, tlist in targets_by_signal.items()}

    def has_series_state(self, tenant_id: UUID, dataset_id: UUID, series_key: str) -> bool:
        return (tenant_id, dataset_id, series_key) in self._states

    def seed_series_state_from_row(
        self,
        tenant_id: UUID,
        target: ManagedBindingTarget,
        row: Mapping[str, Any] | None,
        *,
        active_epoch: int,
    ) -> None:
        """Hydrate per-series Managed state from TDengine ``LAST_ROW`` on cold start."""
        key = (tenant_id, target.dataset_id, target.series_key)
        if row is None:
            self._states[key] = ManagedSeriesState(has_baseline=False)
            return

        row_epoch = int(row.get("data_epoch") or 1)
        if row_epoch != int(active_epoch):
            self._states[key] = ManagedSeriesState(has_baseline=False, last_data_epoch=row_epoch)
            return

        ts = to_utc_datetime(row.get("ts"))
        acq = to_utc_datetime(row.get("acquired_at")) or ts
        qual = str(row.get("raw_quality") or "GOOD").upper()
        reason = str(row["reason_code"]) if row.get("reason_code") else None
        raw_val = row.get(target.field_key)
        norm_val, _, _, had_err = _coerce_field_value(
            raw_val,
            target.value_type,
            max_length=target.max_length,
            nullable=target.nullable,
            raw_quality=qual,
            reason_code=reason,
        )
        if had_err:
            norm_val = None

        bucket_idx: int | None = None
        if target.mode == RecordingMode.INTERVAL and ts is not None:
            intv_us = max(100_000, int(target.interval_ms or 60_000) * 1000)
            bucket_idx = to_td_timestamp_us(ts) // intv_us

        self._states[key] = ManagedSeriesState(
            last_recorded_value=norm_val,
            last_recorded_quality=qual,
            last_recorded_reason=reason,
            last_recorded_ts=ts,
            last_acquired_ts=acq,
            last_source_revision=target.source_revision,
            last_data_epoch=row_epoch,
            last_policy_version=target.policy_version,
            last_event_uid=str(row["event_uid"]) if row.get("event_uid") else None,
            last_bucket_idx=bucket_idx,
            last_valid_value=norm_val if (norm_val is not None and qual == "GOOD") else None,
            last_valid_quality="GOOD" if (norm_val is not None and qual == "GOOD") else None,
            last_valid_ts=ts if (norm_val is not None and qual == "GOOD") else None,
            has_baseline=ts is not None,
        )

    def invalidate_tenant(self, tenant_id: UUID | None = None) -> None:
        if tenant_id is None:
            self._states.clear()
            return
        for k in [key for key in self._states if key[0] == tenant_id]:
            self._states.pop(k, None)

    def evaluate(
        self,
        obs: CanonicalObservation,
        *,
        previous_live: LiveSignalRecord | None,
        last_recorded_by_dataset: Mapping[UUID, tuple[Any, str, datetime]] | None = None,
    ) -> RecordingDecision:
        """``RecordingPolicyEvaluator`` protocol entrypoint."""
        targets = self._targets_by_signal.get(obs.signal_id, ())
        detailed = self.evaluate_for_targets(
            obs,
            targets=targets,
            previous_live=previous_live,
            last_recorded_by_dataset=last_recorded_by_dataset,
        )
        return detailed.decision

    def evaluate_for_targets(
        self,
        obs: CanonicalObservation,
        *,
        targets: Sequence[ManagedBindingTarget],
        previous_live: LiveSignalRecord | None = None,
        last_recorded_by_dataset: Mapping[UUID, tuple[Any, str, datetime]] | None = None,
        active_epoch: int | None = None,
        norm_quality: str | None = None,
        reason_code: str | None = None,
        update_metrics: bool = True,
    ) -> DetailedRecordingResult:
        """Evaluate Operational + Managed targets and produce both directives and write payloads."""
        if obs.origin == Origin.TEST:
            dec = RecordingDecision(write_operational=False, update_live_activity=False, managed_directives=())
            if update_metrics:
                self.metrics.record_decision(dec, ())
            return DetailedRecordingResult(decision=dec, writes=())

        if active_epoch is not None and obs.data_epoch < active_epoch:
            fenced_dirs = tuple(
                ManagedWriteDirective(
                    dataset_id=t.dataset_id,
                    dataset_version_id=t.design_version_id,
                    subtable=t.td_subtable,
                    write_row=False,
                    skip_reason=SkipReason.EPOCH_FENCED,
                    keepalive_triggered=False,
                )
                for t in targets
            )
            dec = RecordingDecision(write_operational=False, update_live_activity=False, managed_directives=fenced_dirs)
            if update_metrics:
                self.metrics.record_decision(dec, ())
            return DetailedRecordingResult(decision=dec, writes=())

        # Keep parameter explicit in protocol; Operational History always stores full-fidelity observations.
        _ = previous_live

        eff_input_quality = str(norm_quality or obs.quality.value or "GOOD").upper()
        eff_input_reason = reason_code if reason_code is not None else obs.quality_reason

        directives: list[ManagedWriteDirective] = []
        writes: list[ManagedSubtableWrite] = []

        for target in targets:
            if not target.is_active_or_paused:
                continue

            if target.is_paused:
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=False,
                        skip_reason=SkipReason.POLICY_PAUSED,
                        keepalive_triggered=False,
                    )
                )
                continue

            state_key = (obs.tenant_id, target.dataset_id, target.series_key)
            state = self._states.get(state_key)
            if state is None:
                state = ManagedSeriesState()
                self._states[state_key] = state

            if state.has_baseline and obs.data_epoch < state.last_data_epoch:
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=False,
                        skip_reason=SkipReason.EPOCH_FENCED,
                        keepalive_triggered=False,
                    )
                )
                continue

            if last_recorded_by_dataset and target.dataset_id in last_recorded_by_dataset and not state.has_baseline:
                ov_val, ov_qual, ov_ts = last_recorded_by_dataset[target.dataset_id]
                state.last_recorded_value = ov_val
                state.last_recorded_quality = str(ov_qual or "GOOD").upper()
                state.last_recorded_ts = to_utc_datetime(ov_ts)
                state.last_acquired_ts = state.last_recorded_ts
                state.last_source_revision = target.source_revision
                state.last_data_epoch = obs.data_epoch
                state.last_policy_version = target.policy_version
                state.has_baseline = state.last_recorded_ts is not None
                if target.mode == RecordingMode.INTERVAL and state.last_recorded_ts is not None:
                    intv_us = max(100_000, int(target.interval_ms or 60_000) * 1000)
                    state.last_bucket_idx = to_td_timestamp_us(state.last_recorded_ts) // intv_us

            eval_val, eval_qual, eval_reason = _apply_safe_transform(
                obs, target, eff_input_quality, eff_input_reason
            )
            sample_ts = _choose_time_axis(obs, target)
            acq_ts = to_utc_datetime(obs.acquired_at) or obs.acquired_at
            src_ts = to_utc_datetime(obs.source_time) if obs.source_time is not None else None

            if target.mode == RecordingMode.EVERY_ACQUISITION:
                self._eval_every_acquisition(
                    obs, target, state, eval_val, eval_qual, eval_reason,
                    sample_ts, acq_ts, src_ts, directives, writes,
                )
            elif target.mode == RecordingMode.INTERVAL:
                self._eval_interval(
                    obs, target, state, eval_val, eval_qual, eval_reason,
                    sample_ts, acq_ts, src_ts, directives, writes,
                )
            else:
                self._eval_on_change(
                    obs, target, state, eval_val, eval_qual, eval_reason,
                    sample_ts, acq_ts, src_ts, directives, writes,
                )

        dec = RecordingDecision(
            write_operational=self.write_operational,
            update_live_activity=True,
            managed_directives=tuple(directives),
        )
        if update_metrics:
            self.metrics.record_decision(dec, writes)
        return DetailedRecordingResult(decision=dec, writes=tuple(writes))

    def _update_valid_trackers(
        self,
        state: ManagedSeriesState,
        eval_val: Any,
        eval_qual: str,
        sample_ts: datetime,
    ) -> None:
        if eval_qual == "GOOD" and eval_val is not None:
            if state.last_valid_ts is None or sample_ts >= state.last_valid_ts:
                state.last_valid_value = eval_val
                state.last_valid_quality = "GOOD"
                state.last_valid_ts = sample_ts

    def _eval_every_acquisition(
        self,
        obs: CanonicalObservation,
        target: ManagedBindingTarget,
        state: ManagedSeriesState,
        eval_val: Any,
        eval_qual: str,
        eval_reason: str | None,
        sample_ts: datetime,
        acq_ts: datetime,
        src_ts: datetime | None,
        directives: list[ManagedWriteDirective],
        writes: list[ManagedSubtableWrite],
    ) -> None:
        writes.append(
            ManagedSubtableWrite(
                target=target,
                ts=sample_ts,
                acquired_at=acq_ts,
                source_time=src_ts,
                raw_quality=eval_qual,
                reason_code=eval_reason,
                event_uid=obs.event_uid,
                data_epoch=obs.data_epoch,
                record_kind="MANAGED_RECORDED",
                value=eval_val,
                value_type=target.value_type,
            )
        )
        directives.append(
            ManagedWriteDirective(
                dataset_id=target.dataset_id,
                dataset_version_id=target.design_version_id,
                subtable=target.td_subtable,
                write_row=True,
                skip_reason=SkipReason.NONE,
                keepalive_triggered=False,
            )
        )
        if not state.has_baseline or state.last_recorded_ts is None or sample_ts >= state.last_recorded_ts:
            state.last_recorded_value = eval_val
            state.last_recorded_quality = eval_qual
            state.last_recorded_reason = eval_reason
            state.last_recorded_ts = sample_ts
            state.last_acquired_ts = acq_ts
            state.last_source_revision = target.source_revision
            state.last_data_epoch = obs.data_epoch
            state.last_policy_version = target.policy_version
            state.last_event_uid = obs.event_uid
            state.has_baseline = True
        self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)

    def _eval_on_change(
        self,
        obs: CanonicalObservation,
        target: ManagedBindingTarget,
        state: ManagedSeriesState,
        eval_val: Any,
        eval_qual: str,
        eval_reason: str | None,
        sample_ts: datetime,
        acq_ts: datetime,
        src_ts: datetime | None,
        directives: list[ManagedWriteDirective],
        writes: list[ManagedSubtableWrite],
    ) -> None:
        lineage_reset = (
            not state.has_baseline
            or state.last_recorded_ts is None
            or obs.data_epoch > state.last_data_epoch
            or target.source_revision != state.last_source_revision
            or target.policy_version != state.last_policy_version
        )
        if lineage_reset:
            write_ts = sample_ts
            if state.has_baseline and state.last_recorded_ts == sample_ts:
                write_ts = sample_ts + timedelta(microseconds=1)
            writes.append(
                ManagedSubtableWrite(
                    target=target,
                    ts=write_ts,
                    acquired_at=acq_ts,
                    source_time=src_ts,
                    raw_quality=eval_qual,
                    reason_code=eval_reason,
                    event_uid=obs.event_uid,
                    data_epoch=obs.data_epoch,
                    record_kind="MANAGED_RECORDED",
                    value=eval_val,
                    value_type=target.value_type,
                )
            )
            directives.append(
                ManagedWriteDirective(
                    dataset_id=target.dataset_id,
                    dataset_version_id=target.design_version_id,
                    subtable=target.td_subtable,
                    write_row=True,
                    skip_reason=SkipReason.NONE,
                    keepalive_triggered=False,
                )
            )
            state.last_recorded_value = eval_val
            state.last_recorded_quality = eval_qual
            state.last_recorded_reason = eval_reason
            state.last_recorded_ts = write_ts
            state.last_acquired_ts = acq_ts
            state.last_source_revision = target.source_revision
            state.last_data_epoch = obs.data_epoch
            state.last_policy_version = target.policy_version
            state.last_event_uid = obs.event_uid
            state.has_baseline = True
            self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)
            return

        assert state.last_recorded_ts is not None

        # Out-of-order late arrival within tolerance writes historical point without rewinding frontier.
        if sample_ts < state.last_recorded_ts:
            age_ms = (state.last_recorded_ts - sample_ts).total_seconds() * 1000.0
            if target.late_tolerance_ms is not None and age_ms > float(target.late_tolerance_ms):
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=False,
                        skip_reason=SkipReason.INTERVAL_NOT_ELAPSED,
                        keepalive_triggered=False,
                    )
                )
                return
            writes.append(
                ManagedSubtableWrite(
                    target=target,
                    ts=sample_ts,
                    acquired_at=acq_ts,
                    source_time=src_ts,
                    raw_quality=eval_qual,
                    reason_code=eval_reason,
                    event_uid=obs.event_uid,
                    data_epoch=obs.data_epoch,
                    record_kind="MANAGED_RECORDED",
                    value=eval_val,
                    value_type=target.value_type,
                )
            )
            directives.append(
                ManagedWriteDirective(
                    dataset_id=target.dataset_id,
                    dataset_version_id=target.design_version_id,
                    subtable=target.td_subtable,
                    write_row=True,
                    skip_reason=SkipReason.NONE,
                    keepalive_triggered=False,
                )
            )
            return

        quality_changed = (
            eval_qual != (state.last_recorded_quality or "")
            or (eval_reason or "") != (state.last_recorded_reason or "")
        )
        val_unchanged, within_deadband = canonical_values_compare(
            state.last_recorded_value,
            eval_val,
            value_type=target.value_type,
            deadband_kind=target.deadband_kind,
            deadband_value=target.deadband_value,
        )

        if quality_changed or not val_unchanged:
            writes.append(
                ManagedSubtableWrite(
                    target=target,
                    ts=sample_ts,
                    acquired_at=acq_ts,
                    source_time=src_ts,
                    raw_quality=eval_qual,
                    reason_code=eval_reason,
                    event_uid=obs.event_uid,
                    data_epoch=obs.data_epoch,
                    record_kind="MANAGED_RECORDED",
                    value=eval_val,
                    value_type=target.value_type,
                )
            )
            directives.append(
                ManagedWriteDirective(
                    dataset_id=target.dataset_id,
                    dataset_version_id=target.design_version_id,
                    subtable=target.td_subtable,
                    write_row=True,
                    skip_reason=SkipReason.NONE,
                    keepalive_triggered=False,
                )
            )
            state.last_recorded_value = eval_val
            state.last_recorded_quality = eval_qual
            state.last_recorded_reason = eval_reason
            state.last_recorded_ts = sample_ts
            state.last_acquired_ts = acq_ts
            state.last_source_revision = target.source_revision
            state.last_data_epoch = obs.data_epoch
            state.last_policy_version = target.policy_version
            state.last_event_uid = obs.event_uid
            self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)
            return

        # Value unchanged (or within deadband) & quality unchanged -> check maxCheckpointInterval keepalive.
        if target.max_checkpoint_interval_ms is not None and target.max_checkpoint_interval_ms > 0:
            elapsed_ms = (sample_ts - state.last_recorded_ts).total_seconds() * 1000.0
            if elapsed_ms >= float(target.max_checkpoint_interval_ms):
                cp_val = state.last_recorded_value if within_deadband else eval_val
                writes.append(
                    ManagedSubtableWrite(
                        target=target,
                        ts=sample_ts,
                        acquired_at=acq_ts,
                        source_time=src_ts,
                        raw_quality=eval_qual,
                        reason_code=eval_reason,
                        event_uid=obs.event_uid,
                        data_epoch=obs.data_epoch,
                        record_kind="checkpoint",
                        value=cp_val,
                        value_type=target.value_type,
                    )
                )
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=True,
                        skip_reason=SkipReason.NONE,
                        keepalive_triggered=True,
                    )
                )
                state.last_recorded_value = cp_val
                state.last_recorded_ts = sample_ts
                state.last_acquired_ts = acq_ts
                state.last_event_uid = obs.event_uid
                self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)
                return

        state.last_acquired_ts = acq_ts
        self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)
        directives.append(
            ManagedWriteDirective(
                dataset_id=target.dataset_id,
                dataset_version_id=target.design_version_id,
                subtable=target.td_subtable,
                write_row=False,
                skip_reason=(SkipReason.WITHIN_DEADBAND if within_deadband else SkipReason.UNCHANGED_VALUE_AND_QUALITY),
                keepalive_triggered=False,
            )
        )

    def _build_missing_interval_write(
        self,
        target: ManagedBindingTarget,
        state: ManagedSeriesState,
        bucket_idx: int,
        interval_us: int,
        *,
        data_epoch: int,
    ) -> ManagedSubtableWrite:
        g_ts = to_utc_datetime(bucket_idx * interval_us)
        assert g_ts is not None
        gap_uid = f"gap:{target.dataset_id.hex[:8]}:{target.series_key[:24]}:{bucket_idx}"
        pol = target.missing_policy
        max_age_us = (
            int(target.max_checkpoint_interval_ms) * 1000
            if target.max_checkpoint_interval_ms is not None and target.max_checkpoint_interval_ms > 0
            else None
        )
        hold_age_ok = (
            state.last_valid_ts is not None
            and (max_age_us is None or (bucket_idx * interval_us - to_td_timestamp_us(state.last_valid_ts)) <= max_age_us)
        )
        if pol == "HOLD_LAST_WITH_QUALITY" and state.last_valid_value is not None and hold_age_ok:
            return ManagedSubtableWrite(
                target=target,
                ts=g_ts,
                acquired_at=g_ts,
                source_time=None,
                raw_quality="UNCERTAIN",
                reason_code="HELD_STALE_INTERVAL",
                event_uid=gap_uid,
                data_epoch=data_epoch,
                record_kind="interval_held",
                value=state.last_valid_value,
                value_type=target.value_type,
            )
        if pol == "NULL":
            return ManagedSubtableWrite(
                target=target,
                ts=g_ts,
                acquired_at=g_ts,
                source_time=None,
                raw_quality="BAD",
                reason_code="INTERVAL_MISSING",
                event_uid=gap_uid,
                data_epoch=data_epoch,
                record_kind="interval_null",
                value=None,
                value_type=target.value_type,
            )
        # Default GAP_MARKER
        return ManagedSubtableWrite(
            target=target,
            ts=g_ts,
            acquired_at=g_ts,
            source_time=None,
            raw_quality="BAD",
            reason_code="INTERVAL_GAP",
            event_uid=gap_uid,
            data_epoch=data_epoch,
            record_kind="gap_marker",
            value=None,
            value_type=target.value_type,
        )

    def _eval_interval(
        self,
        obs: CanonicalObservation,
        target: ManagedBindingTarget,
        state: ManagedSeriesState,
        eval_val: Any,
        eval_qual: str,
        eval_reason: str | None,
        sample_ts: datetime,
        acq_ts: datetime,
        src_ts: datetime | None,
        directives: list[ManagedWriteDirective],
        writes: list[ManagedSubtableWrite],
    ) -> None:
        intv_ms = max(100, int(target.interval_ms or 60_000))
        intv_us = intv_ms * 1000
        sample_us = to_td_timestamp_us(sample_ts)
        bucket_idx = sample_us // intv_us
        bucket_ts = to_utc_datetime(bucket_idx * intv_us)
        assert bucket_ts is not None

        lineage_reset = (
            not state.has_baseline
            or state.last_bucket_idx is None
            or obs.data_epoch > state.last_data_epoch
            or target.source_revision != state.last_source_revision
            or target.policy_version != state.last_policy_version
        )
        if lineage_reset:
            write_ts = bucket_ts
            if state.has_baseline and state.last_recorded_ts == bucket_ts:
                write_ts = sample_ts if sample_ts > bucket_ts else (bucket_ts + timedelta(microseconds=1))
            writes.append(
                ManagedSubtableWrite(
                    target=target,
                    ts=write_ts,
                    acquired_at=acq_ts,
                    source_time=src_ts,
                    raw_quality=eval_qual,
                    reason_code=eval_reason,
                    event_uid=obs.event_uid,
                    data_epoch=obs.data_epoch,
                    record_kind="MANAGED_RECORDED",
                    value=eval_val,
                    value_type=target.value_type,
                )
            )
            directives.append(
                ManagedWriteDirective(
                    dataset_id=target.dataset_id,
                    dataset_version_id=target.design_version_id,
                    subtable=target.td_subtable,
                    write_row=True,
                    skip_reason=SkipReason.NONE,
                    keepalive_triggered=False,
                )
            )
            state.last_recorded_value = eval_val
            state.last_recorded_quality = eval_qual
            state.last_recorded_reason = eval_reason
            state.last_recorded_ts = write_ts
            state.last_acquired_ts = acq_ts
            state.last_source_revision = target.source_revision
            state.last_data_epoch = obs.data_epoch
            state.last_policy_version = target.policy_version
            state.last_event_uid = obs.event_uid
            state.last_bucket_idx = bucket_idx
            state.has_baseline = True
            self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)
            return

        assert state.last_bucket_idx is not None

        if bucket_idx < state.last_bucket_idx:
            # Late historical backfill inside lateTolerance does not move current frontier.
            late_us = (state.last_bucket_idx - bucket_idx) * intv_us
            tol_us = (
                int(target.late_tolerance_ms) * 1000
                if target.late_tolerance_ms is not None
                else 300_000_000
            )
            if late_us <= tol_us:
                writes.append(
                    ManagedSubtableWrite(
                        target=target,
                        ts=bucket_ts,
                        acquired_at=acq_ts,
                        source_time=src_ts,
                        raw_quality=eval_qual,
                        reason_code=eval_reason,
                        event_uid=obs.event_uid,
                        data_epoch=obs.data_epoch,
                        record_kind="MANAGED_RECORDED",
                        value=eval_val,
                        value_type=target.value_type,
                    )
                )
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=True,
                        skip_reason=SkipReason.NONE,
                        keepalive_triggered=False,
                    )
                )
            else:
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=False,
                        skip_reason=SkipReason.INTERVAL_NOT_ELAPSED,
                        keepalive_triggered=False,
                    )
                )
            return

        if bucket_idx == state.last_bucket_idx:
            self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)
            state.last_acquired_ts = acq_ts
            quality_changed = (
                eval_qual != (state.last_recorded_quality or "")
                or (eval_reason or "") != (state.last_recorded_reason or "")
            )
            if quality_changed:
                trans_ts = sample_ts if sample_ts > bucket_ts else (bucket_ts + timedelta(microseconds=1))
                writes.append(
                    ManagedSubtableWrite(
                        target=target,
                        ts=trans_ts,
                        acquired_at=acq_ts,
                        source_time=src_ts,
                        raw_quality=eval_qual,
                        reason_code=eval_reason,
                        event_uid=obs.event_uid,
                        data_epoch=obs.data_epoch,
                        record_kind="MANAGED_RECORDED",
                        value=eval_val,
                        value_type=target.value_type,
                    )
                )
                directives.append(
                    ManagedWriteDirective(
                        dataset_id=target.dataset_id,
                        dataset_version_id=target.design_version_id,
                        subtable=target.td_subtable,
                        write_row=True,
                        skip_reason=SkipReason.NONE,
                        keepalive_triggered=False,
                    )
                )
                state.last_recorded_value = eval_val
                state.last_recorded_quality = eval_qual
                state.last_recorded_reason = eval_reason
                state.last_recorded_ts = trans_ts
                state.last_event_uid = obs.event_uid
                return

            directives.append(
                ManagedWriteDirective(
                    dataset_id=target.dataset_id,
                    dataset_version_id=target.design_version_id,
                    subtable=target.td_subtable,
                    write_row=False,
                    skip_reason=SkipReason.INTERVAL_NOT_ELAPSED,
                    keepalive_triggered=False,
                )
            )
            return

        # Entered a new bucket > last_bucket_idx: materialize any empty intermediate intervals first.
        gap_start = max(state.last_bucket_idx + 1, bucket_idx - MAX_INTERVAL_GAPS_PER_STEP)
        for g in range(gap_start, bucket_idx):
            writes.append(
                self._build_missing_interval_write(
                    target, state, g, intv_us, data_epoch=obs.data_epoch
                )
            )

        writes.append(
            ManagedSubtableWrite(
                target=target,
                ts=bucket_ts,
                acquired_at=acq_ts,
                source_time=src_ts,
                raw_quality=eval_qual,
                reason_code=eval_reason,
                event_uid=obs.event_uid,
                data_epoch=obs.data_epoch,
                record_kind="MANAGED_RECORDED",
                value=eval_val,
                value_type=target.value_type,
            )
        )
        directives.append(
            ManagedWriteDirective(
                dataset_id=target.dataset_id,
                dataset_version_id=target.design_version_id,
                subtable=target.td_subtable,
                write_row=True,
                skip_reason=SkipReason.NONE,
                keepalive_triggered=False,
            )
        )
        state.last_recorded_value = eval_val
        state.last_recorded_quality = eval_qual
        state.last_recorded_reason = eval_reason
        state.last_recorded_ts = bucket_ts
        state.last_acquired_ts = acq_ts
        state.last_source_revision = target.source_revision
        state.last_data_epoch = obs.data_epoch
        state.last_policy_version = target.policy_version
        state.last_event_uid = obs.event_uid
        state.last_bucket_idx = bucket_idx
        self._update_valid_trackers(state, eval_val, eval_qual, sample_ts)

    def sweep_interval_gaps(
        self,
        tenant_id: UUID,
        *,
        targets: Sequence[ManagedBindingTarget],
        active_epoch: int = 1,
        now: datetime | None = None,
    ) -> list[ManagedSubtableWrite]:
        """Materialize closed empty interval buckets for quiet/disconnected ``INTERVAL`` streams."""
        eval_now = to_utc_datetime(now) or _utcnow()
        now_us = to_td_timestamp_us(eval_now)
        out: list[ManagedSubtableWrite] = []
        seen_keys: set[tuple[UUID, str]] = set()
        for target in targets:
            if target.mode != RecordingMode.INTERVAL or target.is_paused or not target.is_active_or_paused:
                continue
            dedup_k = (target.dataset_id, target.series_key)
            if dedup_k in seen_keys:
                continue
            seen_keys.add(dedup_k)

            state = self._states.get((tenant_id, target.dataset_id, target.series_key))
            if state is None or not state.has_baseline or state.last_bucket_idx is None:
                continue
            intv_ms = max(100, int(target.interval_ms or 60_000))
            intv_us = intv_ms * 1000
            tol_us = max(0, int(target.late_tolerance_ms or 0) * 1000)
            if now_us <= tol_us:
                continue
            max_closed_idx = ((now_us - tol_us) // intv_us) - 1
            if max_closed_idx <= state.last_bucket_idx:
                continue
            g_start = max(state.last_bucket_idx + 1, max_closed_idx - MAX_INTERVAL_GAPS_PER_STEP + 1)
            g_end = min(max_closed_idx, state.last_bucket_idx + MAX_INTERVAL_GAPS_PER_STEP)
            for g in range(g_start, g_end + 1):
                out.append(
                    self._build_missing_interval_write(
                        target, state, g, intv_us, data_epoch=int(active_epoch)
                    )
                )
            state.last_bucket_idx = g_end
            state.last_recorded_ts = to_utc_datetime(g_end * intv_us)
            self.metrics.managed_gap_markers += (g_end - g_start + 1)
        return out
