"""Data Model body composition. Pure: no framework, database or network imports.

A data model (output group) is an ordered list of members. Each member produces one key of the
clean body, in member order:

* ``signal``   - latest value of a signal of the model's resource
* ``snapshot`` - value of a signal captured at the trigger instant (EVENT models only)
* ``context``  - a name/code from the resource breadcrumb (``zone.name``, ``line.name`` ...)
* ``constant`` - a fixed JSON value
* ``system``   - ``source_timestamp`` or ``publish_timestamp``

``source_timestamp`` is the latest raw-group timestamp among the signal members that contribute
(``contributes_ts``) and have a latest row. A signal carries its raw group timestamp as
``source_time``; when the source reports none, ``received_time`` is used instead. A latest row whose
value is null still contributes; a signal with no latest row does not. Context, constants,
snapshots and ``publish_timestamp`` never contribute.

The body is emitted as ordered JSON text (never JSONB, which reorders keys).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

MEMBER_KINDS = ("signal", "snapshot", "context", "constant", "system")
SYSTEM_FIELDS = ("source_timestamp", "publish_timestamp")
MODEL_KINDS = ("STATE", "EVENT")
CONTEXT_LEVELS = ("self", "enterprise", "site", "plant", "area", "zone", "workshop", "line", "cell", "machine")
CONTEXT_ATTRS = ("name", "code")
CONTEXT_REFS = tuple(f"{level}.{attr}" for level in CONTEXT_LEVELS for attr in CONTEXT_ATTRS)
ALIAS_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
PROJECTION_MODES = ("compact", "rich")
MISSING_POLICIES = ("null", "omit")

DEFAULT_EMIT_POLICY: dict[str, Any] = {"republish_ms": None, "max_events": 1000, "snapshot_grace_ms": 0}
MIN_REPUBLISH_MS = 1000
MAX_REPUBLISH_MS = 86_400_000
MAX_EVENTS_LIMIT = 100_000
MAX_SNAPSHOT_GRACE_MS = 600_000


class BodyError(ValueError):
    """A member list or policy violates the data model rules. ``code`` is the API error code."""

    def __init__(self, code: str, message: str, *, alias: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.alias = alias


@dataclass(frozen=True)
class Member:
    kind: str
    alias: str
    signal_id: str | None = None
    signal_key: str | None = None
    context_ref: str | None = None
    value: Any = None
    field: str | None = None
    contributes_ts: bool = False
    is_trigger: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "alias": self.alias,
            "signal_id": self.signal_id,
            "signal_key": self.signal_key,
            "context_ref": self.context_ref,
            "value": self.value,
            "field": self.field,
            "contributes_ts": self.contributes_ts,
            "is_trigger": self.is_trigger,
        }


# --------------------------------------------------------------------------------------------
# Timestamps
# --------------------------------------------------------------------------------------------


def as_utc(value: Any) -> datetime | None:
    """Accept a datetime or an ISO-8601 string; naive datetimes are UTC."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, str):
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def fmt_ms(value: Any) -> str | None:
    """``YYYY-MM-DDTHH:mm:ss.SSSZ`` (UTC, exactly three fraction digits, truncated)."""
    moment = as_utc(value)
    if moment is None:
        return None
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


def dumps_ordered(body: Mapping[str, Any]) -> str:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str)


# --------------------------------------------------------------------------------------------
# Member normalisation / validation (pure part; database checks live in the service)
# --------------------------------------------------------------------------------------------


def _flag(raw: Mapping[str, Any], key: str) -> bool | None:
    if key not in raw or raw[key] is None:
        return None
    value = raw[key]
    if isinstance(value, bool):
        return value
    raise BodyError("MEMBER_INVALID", f"'{key}' must be true or false.", alias=str(raw.get("alias") or ""))


def member_from_dict(raw: Mapping[str, Any]) -> Member:
    """Normalise one API/template member. A member without ``kind`` but with a signal is a signal."""
    alias = str(raw.get("alias") or raw.get("output_alias") or "")
    kind = str(raw.get("kind") or raw.get("member_kind") or "").strip().lower()
    if not kind:
        kind = "signal" if (raw.get("signal_id") or raw.get("signal_key")) else ""
    if kind not in MEMBER_KINDS:
        raise BodyError("MEMBER_KIND", f"Member '{alias}' has an unknown kind '{kind}'.", alias=alias)
    contributes = _flag(raw, "contributes_ts")
    trigger = _flag(raw, "is_trigger")
    signal_id = raw.get("signal_id")
    signal_key = raw.get("signal_key")
    return Member(
        kind=kind,
        alias=alias,
        signal_id=str(signal_id) if signal_id not in (None, "") else None,
        signal_key=str(signal_key).strip() if signal_key not in (None, "") else None,
        context_ref=(str(raw["context_ref"]).strip() if raw.get("context_ref") not in (None, "") else None),
        value=raw.get("value"),
        field=(str(raw.get("field") or raw.get("system_field") or "").strip() or None),
        contributes_ts=(kind == "signal") if contributes is None else contributes,
        is_trigger=bool(trigger),
    )


def validate_aliases(members: Sequence[Mapping[str, Any] | Member]) -> None:
    aliases = [m.alias if isinstance(m, Member) else str(m.get("alias") or m.get("output_alias") or "") for m in members]
    lowered = [a.lower() for a in aliases]
    if len(lowered) != len(set(lowered)):
        raise BodyError("ALIAS_DUPLICATE", "Member aliases must be unique (case-insensitive).")
    for alias in aliases:
        if not alias or not ALIAS_RE.match(alias):
            raise BodyError("ALIAS_INVALID", f"Invalid alias '{alias}'.", alias=alias)


def normalize_members(model_kind: str, raw_members: Sequence[Mapping[str, Any]], *, require_signal_ids: bool = True) -> list[Member]:
    """Structure rules shared by create, patch, templates and apply.

    * aliases valid and unique case-insensitively
    * exactly one ``system source_timestamp``, at most one ``system publish_timestamp``
    * ``snapshot`` only on EVENT models, never contributes to the timestamp
    * only ``signal`` members contribute to the timestamp or trigger
    * EVENT models need at least one trigger signal; STATE models have none
    """
    kind = str(model_kind or "STATE").upper()
    if kind not in MODEL_KINDS:
        raise BodyError("MODEL_KIND", f"Unknown model kind '{model_kind}'.")
    validate_aliases(raw_members)
    members = [member_from_dict(raw) for raw in raw_members]
    system_count = {name: 0 for name in SYSTEM_FIELDS}
    triggers = 0
    for member in members:
        if member.kind in ("signal", "snapshot"):
            if require_signal_ids and not member.signal_id:
                raise BodyError("MEMBER_SIGNAL_REQUIRED", f"Member '{member.alias}' needs a signal.", alias=member.alias)
            if not member.signal_id and not member.signal_key:
                raise BodyError("MEMBER_SIGNAL_REQUIRED", f"Member '{member.alias}' needs a signal or a signal key.", alias=member.alias)
        if member.kind == "snapshot":
            if kind != "EVENT":
                raise BodyError("SNAPSHOT_STATE", f"Snapshot member '{member.alias}' is only allowed on EVENT models.", alias=member.alias)
            if member.contributes_ts:
                raise BodyError("SNAPSHOT_TS", f"Snapshot member '{member.alias}' cannot contribute to source_timestamp.", alias=member.alias)
        if member.kind != "signal":
            if member.contributes_ts:
                raise BodyError("CONTRIBUTES_TS_INVALID", f"Only signal members contribute to source_timestamp ('{member.alias}').", alias=member.alias)
            if member.is_trigger:
                raise BodyError("TRIGGER_INVALID", f"Only signal members can be triggers ('{member.alias}').", alias=member.alias)
        if member.kind == "context" and member.context_ref not in CONTEXT_REFS:
            raise BodyError("CONTEXT_REF", f"Member '{member.alias}' has an unknown context reference '{member.context_ref}'.", alias=member.alias)
        if member.kind == "system":
            if member.field not in SYSTEM_FIELDS:
                raise BodyError("SYSTEM_FIELD", f"Member '{member.alias}' has an unknown system field '{member.field}'.", alias=member.alias)
            system_count[member.field] += 1
        if member.kind == "constant":
            try:
                json.dumps(member.value)
            except (TypeError, ValueError) as exc:
                raise BodyError("CONSTANT_INVALID", f"Constant '{member.alias}' is not JSON.", alias=member.alias) from exc
        if member.is_trigger:
            if kind != "EVENT":
                raise BodyError("TRIGGER_STATE", f"Trigger member '{member.alias}' is only allowed on EVENT models.", alias=member.alias)
            triggers += 1
    if system_count["source_timestamp"] != 1:
        raise BodyError("SOURCE_TIMESTAMP_REQUIRED", "A data model needs exactly one system source_timestamp member.")
    if system_count["publish_timestamp"] > 1:
        raise BodyError("PUBLISH_TIMESTAMP_DUPLICATE", "A data model has at most one system publish_timestamp member.")
    if kind == "EVENT" and triggers == 0:
        raise BodyError("TRIGGER_REQUIRED", "An EVENT model needs at least one trigger signal.")
    return members


def normalize_emit_policy(raw: Mapping[str, Any] | None, base: Mapping[str, Any] | None = None) -> dict[str, Any]:
    policy = dict(DEFAULT_EMIT_POLICY)
    if base:
        policy.update({key: base[key] for key in DEFAULT_EMIT_POLICY if key in base})
    if raw:
        unknown = set(raw) - set(DEFAULT_EMIT_POLICY) - {"on_change"}
        if unknown:
            raise BodyError("EMIT_POLICY", f"Unknown emit policy keys: {', '.join(sorted(unknown))}.")
        policy.update({key: raw[key] for key in DEFAULT_EMIT_POLICY if key in raw})
    republish = policy.get("republish_ms")
    if republish is not None:
        if isinstance(republish, bool) or not isinstance(republish, int) or not MIN_REPUBLISH_MS <= republish <= MAX_REPUBLISH_MS:
            raise BodyError("EMIT_POLICY", f"republish_ms must be null or between {MIN_REPUBLISH_MS} and {MAX_REPUBLISH_MS}.")
    max_events = policy.get("max_events")
    if isinstance(max_events, bool) or not isinstance(max_events, int) or not 1 <= max_events <= MAX_EVENTS_LIMIT:
        raise BodyError("EMIT_POLICY", f"max_events must be between 1 and {MAX_EVENTS_LIMIT}.")
    grace = policy.get("snapshot_grace_ms")
    if isinstance(grace, bool) or not isinstance(grace, int) or not 0 <= grace <= MAX_SNAPSHOT_GRACE_MS:
        raise BodyError("EMIT_POLICY", f"snapshot_grace_ms must be between 0 and {MAX_SNAPSHOT_GRACE_MS}.")
    return policy


def normalize_projection(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    policy = {"mode": "compact", "missing": "null"}
    if raw:
        policy.update({key: raw[key] for key in ("mode", "missing") if key in raw})
    if policy["mode"] not in PROJECTION_MODES:
        raise BodyError("PROJECTION", f"Projection mode must be one of {', '.join(PROJECTION_MODES)}.")
    if policy["missing"] not in MISSING_POLICIES:
        raise BodyError("PROJECTION", f"Missing policy must be one of {', '.join(MISSING_POLICIES)}.")
    return policy


# --------------------------------------------------------------------------------------------
# Context
# --------------------------------------------------------------------------------------------


def resolve_context(chain: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Map context refs to values from a breadcrumb.

    ``chain`` is ordered from the model's own resource (index 0) up to the root; each item has
    ``type_key``, ``name`` and ``code``. ``<type>.name`` resolves to the nearest resource of that
    type key (the resource itself included); ``self.*`` is the model's resource.
    """
    context: dict[str, Any] = {ref: None for ref in CONTEXT_REFS}
    if not chain:
        return context
    own = chain[0]
    context["self.name"] = own.get("name")
    context["self.code"] = own.get("code")
    for item in chain:
        level = str(item.get("type_key") or "")
        if level not in CONTEXT_LEVELS or level == "self":
            continue
        if context.get(f"{level}.name") is None and context.get(f"{level}.code") is None:
            context[f"{level}.name"] = item.get("name")
            context[f"{level}.code"] = item.get("code")
    return context


# --------------------------------------------------------------------------------------------
# Composition
# --------------------------------------------------------------------------------------------


def _member(raw: Member | Mapping[str, Any]) -> Member:
    return raw if isinstance(raw, Member) else member_from_dict(raw)


def _row_ts(row: Mapping[str, Any]) -> tuple[datetime | None, bool]:
    """(timestamp, from_received) for a latest row: source_time, else received_time."""
    source = as_utc(row.get("source_time"))
    if source is not None:
        return source, False
    received = as_utc(row.get("received_time"))
    return received, received is not None


def content_hash(body: Mapping[str, Any], publish_aliases: Iterable[str]) -> str:
    """Hash of the ordered body with publish_timestamp blanked, so re-publishing never looks like a change."""
    blanked = dict(body)
    for alias in publish_aliases:
        if alias in blanked:
            blanked[alias] = None
    return hashlib.sha256(dumps_ordered(blanked).encode("utf-8")).hexdigest()


def compose_body(
    members: Sequence[Member | Mapping[str, Any]],
    latest_by_signal: Mapping[str, Mapping[str, Any]],
    context: Mapping[str, Any],
    now: datetime,
    snapshot: Mapping[str, Any] | None = None,
    *,
    projection: Mapping[str, Any] | None = None,
) -> tuple[str, dict[str, Any], datetime | None, str | None, str]:
    """Compose one clean body.

    ``latest_by_signal`` maps signal id (str) to ``{value, source_time, received_time, quality?, unit?}``.
    ``snapshot`` maps signal id (str) to the value captured at the trigger instant; snapshot members
    whose signal id is absent from it fall back to their latest value.

    Returns ``(body_text, body_dict, source_ts, ts_from_alias, content_hash_without_publish_ts)``.
    """
    policy = normalize_projection(projection)
    rich = policy["mode"] == "rich"
    omit_missing = policy["missing"] == "omit"
    snapshot = snapshot or {}
    normalized = [_member(item) for item in members]

    body: dict[str, Any] = {}
    source_aliases: list[str] = []
    publish_aliases: list[str] = []
    best_ts: datetime | None = None
    best_alias: str | None = None

    for member in normalized:
        if member.kind == "system":
            if member.field == "source_timestamp":
                source_aliases.append(member.alias)
                body[member.alias] = None  # filled once every contributor is known
            else:
                publish_aliases.append(member.alias)
                body[member.alias] = fmt_ms(now)
            continue
        if member.kind == "context":
            body[member.alias] = context.get(member.context_ref or "")
            continue
        if member.kind == "constant":
            body[member.alias] = member.value
            continue

        key = str(member.signal_id) if member.signal_id else ""
        row = latest_by_signal.get(key)
        if member.kind == "snapshot" and key in snapshot:
            value: Any = snapshot[key]
        elif row is not None:
            value = row.get("value")
        else:
            value = None
        if row is None and member.kind == "signal" and omit_missing:
            continue
        if rich and member.kind in ("signal", "snapshot"):
            ts, _ = _row_ts(row) if row is not None else (None, False)
            body[member.alias] = {
                "value": value,
                "unit": None if row is None else row.get("unit"),
                "quality": None if row is None else row.get("quality"),
                "source_time": fmt_ms(ts),
            }
        else:
            body[member.alias] = value
        if member.kind == "signal" and member.contributes_ts and row is not None:
            ts, _ = _row_ts(row)
            if ts is not None and (best_ts is None or ts > best_ts):
                best_ts, best_alias = ts, member.alias

    stamp = fmt_ms(best_ts)
    for alias in source_aliases:
        body[alias] = stamp
    digest = content_hash(body, publish_aliases)
    return dumps_ordered(body), body, best_ts, best_alias, digest


def publish_aliases_of(members: Sequence[Member | Mapping[str, Any]]) -> list[str]:
    return [m.alias for m in (_member(x) for x in members) if m.kind == "system" and m.field == "publish_timestamp"]


def republish_body(body_text: str, publish_aliases: Sequence[str], now: datetime) -> str:
    """Re-emit an unchanged body: only publish_timestamp moves, key order and source_timestamp stay."""
    body = json.loads(body_text)
    if not isinstance(body, dict):
        raise BodyError("BODY_INVALID", "Stored body is not a JSON object.")
    stamp = fmt_ms(now)
    for alias in publish_aliases:
        if alias in body:
            body[alias] = stamp
    return dumps_ordered(body)


# --------------------------------------------------------------------------------------------
# EVENT models
# --------------------------------------------------------------------------------------------


def row_at(history: Iterable[Mapping[str, Any]], at: Any) -> dict[str, Any] | None:
    """Row of a signal active at instant ``at``: the newest row whose timestamp
    (source_time, else received_time) is at or before ``at``; ties go to the latest received.
    Rows stamped after ``at`` (e.g. an order that started after a completion) never win.
    """
    target = as_utc(at)
    if target is None:
        return None
    best: tuple[datetime, datetime] | None = None
    best_row: Mapping[str, Any] | None = None
    for row in history:
        ts, _ = _row_ts(row)
        if ts is None or ts > target:
            continue
        received = as_utc(row.get("received_time")) or ts
        rank = (ts, received)
        if best is None or rank > best:
            best, best_row = rank, row
    return None if best_row is None else dict(best_row)


def snapshot_value_at(history: Iterable[Mapping[str, Any]], at: Any) -> tuple[bool, Any]:
    """``(found, value)`` of the row active at ``at`` (see :func:`row_at`)."""
    row = row_at(history, at)
    return (row is not None), (None if row is None else row.get("value"))


def event_dedupe_key(trigger_ts: datetime | None, trigger_values: Sequence[Any] = ()) -> str:
    """Trigger instant when the source reports one; otherwise the trigger values themselves."""
    if trigger_ts is not None:
        return f"ts:{fmt_ms(trigger_ts)}"
    digest = hashlib.sha256(dumps_ordered({"v": list(trigger_values)}).encode("utf-8")).hexdigest()
    return f"v:{digest[:32]}"


def new_trigger_times(candidates: Iterable[Any], last_ts: Any, *, limit: int = 50) -> list[datetime]:
    """Distinct trigger instants newer than the last event, oldest first.

    Without any previous event only the newest instant counts (the current completion), so
    publishing a model never replays the whole history.
    """
    last = as_utc(last_ts)
    unique = sorted({ts for ts in (as_utc(c) for c in candidates) if ts is not None})
    if last is None:
        return unique[-1:]
    return [ts for ts in unique if ts > last][:limit]


# --------------------------------------------------------------------------------------------
# Built-in templates (data_clean.md, exact key order)
# --------------------------------------------------------------------------------------------

DEFAULT_TEMPLATE_TOPIC = "{enterprise}/{site}/{area}/{zone}/{line}/{machine}/{group}"


def _ctx(alias: str, ref: str) -> dict[str, Any]:
    return {"kind": "context", "alias": alias, "context_ref": ref}


def _sys(alias: str) -> dict[str, Any]:
    return {"kind": "system", "alias": alias, "field": alias}


def _sig(key: str, *, trigger: bool = False) -> dict[str, Any]:
    spec: dict[str, Any] = {"kind": "signal", "alias": key, "signal_key": key, "contributes_ts": True}
    if trigger:
        spec["is_trigger"] = True
    return spec


def _snap(key: str) -> dict[str, Any]:
    return {"kind": "snapshot", "alias": key, "signal_key": key, "contributes_ts": False}


def _head(with_machine: bool) -> list[dict[str, Any]]:
    head = [_ctx("zone_name", "zone.name"), _ctx("line_name", "line.name")]
    if with_machine:
        head.append(_ctx("machine_name", "machine.name"))
    return head + [_sys("source_timestamp"), _sys("publish_timestamp")]


def _numbered(prefix: str, count: int) -> list[str]:
    return [f"{prefix}_{index}" for index in range(1, count + 1)]


BUILTIN_TEMPLATES: tuple[dict[str, Any], ...] = (
    {
        "key": "state",
        "display_name": "State",
        "description": "Machine state with operator.",
        "kind": "STATE",
        # Re-publish unchanged bodies so consumers see a live stream (new publish_timestamp,
        # same source_timestamp) even while a machine is stopped.
        "emit_policy": {"republish_ms": 5000},
        "fields": _head(True) + [_sig(k) for k in ("status", "mode", "stop_error", "employee")],
    },
    {
        "key": "process",
        "display_name": "Process",
        "description": "Speeds, program and uptime.",
        "kind": "STATE",
        # Re-publish unchanged bodies so consumers see a live stream (new publish_timestamp,
        # same source_timestamp) even while a machine is stopped.
        "emit_policy": {"republish_ms": 5000},
        "fields": _head(True)
        + [_sig(k) for k in ("speed_1", "speed_2", "program_name", "program_no", "uptime_1", "uptime_2", "status", "employee")],
    },
    {
        "key": "energy",
        "display_name": "Energy",
        "description": "Electrical measurements with machine status.",
        "kind": "STATE",
        # Re-publish unchanged bodies so consumers see a live stream (new publish_timestamp,
        # same source_timestamp) even while a machine is stopped.
        "emit_policy": {"republish_ms": 5000},
        "fields": _head(True)
        + [
            _sig(k)
            for k in _numbered("voltage", 4)
            + _numbered("current", 4)
            + ["power", "frequency", "energy_1", "energy_2", "harmonic", "status"]
        ],
    },
    {
        "key": "condition",
        "display_name": "Condition",
        "description": "Temperatures, pressures, vibration and environment with machine status.",
        "kind": "STATE",
        # Re-publish unchanged bodies so consumers see a live stream (new publish_timestamp,
        # same source_timestamp) even while a machine is stopped.
        "emit_policy": {"republish_ms": 5000},
        "fields": _head(True)
        + [
            _sig(k)
            for k in _numbered("machine_temp", 7)
            + ["ambient_temp"]
            + _numbered("pressure", 7)
            + ["liquid_level"]
            + _numbered("vibration", 6)
            + ["noise", "humidity", "status"]
        ],
    },
    {
        "key": "order",
        "display_name": "Order",
        "description": "Production order with operator.",
        "kind": "STATE",
        # Re-publish unchanged bodies so consumers see a live stream (new publish_timestamp,
        # same source_timestamp) even while a machine is stopped.
        "emit_policy": {"republish_ms": 5000},
        "fields": _head(False) + [_sig(k) for k in ("so", "wo", "item", "order_qty", "cycle_time", "motor_no", "employee")],
    },
    {
        "key": "order_progress",
        "display_name": "Order progress",
        "description": "One event per completion with the order active at that instant.",
        "kind": "EVENT",
        "fields": _head(False) + [_snap("so"), _snap("wo"), _sig("qty", trigger=True), _sig("lot_serial", trigger=True)],
    },
)
