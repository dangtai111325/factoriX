"""Edge and connection health rules. Pure domain: no framework, database or network imports.

Edge liveness comes only from the heartbeat age. Connection health comes from evidence: the
per-connection state reported by the edge in its heartbeat, decoded samples arriving at Center,
or a sustained absence of samples while the edge is online and the connection has active bindings.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

HEARTBEAT_PERIOD_S = 5
EDGE_OFFLINE_AFTER_S = 3 * HEARTBEAT_PERIOD_S
NO_DATA_MIN_S = 30
NO_DATA_INTERVAL_MULTIPLIER = 3
NO_DATA_PREFIX = "No samples received"

EDGE_STATES = ("NOT_ENROLLED", "OFFLINE", "DEGRADED", "ONLINE")
CONNECTION_STATES = ("HEALTHY", "DEGRADED", "IDLE", "PAUSED", "UNKNOWN", "ARCHIVED")

_REPORT_STATES = {"UP", "DOWN", "RATE_LIMITED", "AUTH_FAILED", "IDLE"}


def _utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def heartbeat_fresh(last_heartbeat: Any, now: datetime) -> bool:
    beat = _utc(last_heartbeat)
    if beat is None:
        return False
    return (_utc(now) or now) - beat <= timedelta(seconds=EDGE_OFFLINE_AFTER_S)


def effective_edge_health(row: Mapping[str, Any], now: datetime) -> str:
    """Single source of truth for edge health shown by /edges, /overview and the UI.

    NOT_ENROLLED: the edge never completed enrollment (or was revoked).
    OFFLINE: no heartbeat for more than 3 heartbeat periods.
    DEGRADED: the edge reports itself degraded (for example it cannot read its configuration).
    ONLINE: heartbeat is fresh; CONFIG_PENDING / CONFIG_VALIDATED are ONLINE sub-states.
    """
    if str(row.get("enrollment_status") or "") != "ENROLLED":
        return "NOT_ENROLLED"
    if not heartbeat_fresh(row.get("last_heartbeat"), now):
        return "OFFLINE"
    raw = str(row.get("health") or "UNKNOWN").upper()
    if raw == "DEGRADED":
        return "DEGRADED"
    return "ONLINE"


def edge_config_state(row: Mapping[str, Any]) -> str:
    """IN_SYNC when the edge runs the desired release, PENDING while a newer one is being applied."""
    desired = int(row.get("desired_revision") or 0)
    active = int(row.get("active_revision") or 0)
    if desired == 0 and active == 0:
        return "NONE"
    return "IN_SYNC" if active >= desired else "PENDING"


def effective_connection_health(
    *,
    status: str | None,
    health: str | None,
    active_bindings: int,
    edge_health: str | None,
) -> str:
    """Connection health as shown to operators.

    A connection without active bindings is IDLE (never DEGRADED or "Disconnected"). When the
    edge is not online there is no evidence about the source, so the result is UNKNOWN.
    """
    state = str(status or "").upper()
    if state == "ARCHIVED":
        return "ARCHIVED"
    if state == "PAUSED":
        return "PAUSED"
    if int(active_bindings or 0) <= 0:
        return "IDLE"
    if state != "ACTIVE":
        return "UNKNOWN"
    if edge_health is not None and edge_health not in {"ONLINE", "DEGRADED"}:
        return "UNKNOWN"
    raw = str(health or "UNKNOWN").upper()
    if raw in {"HEALTHY", "DEGRADED"}:
        return raw
    return "UNKNOWN"


def no_data_threshold_s(interval_ms: int | None) -> float:
    interval_s = max(int(interval_ms or 1000), 1) / 1000.0
    return max(NO_DATA_INTERVAL_MULTIPLIER * interval_s, float(NO_DATA_MIN_S))


def no_data_message(interval_ms: int | None) -> str:
    return f"{NO_DATA_PREFIX} for {int(no_data_threshold_s(interval_ms))} s."


def is_no_data_message(text: str | None) -> bool:
    return bool(text) and str(text).startswith(NO_DATA_PREFIX)


def connection_no_data_due(
    *,
    last_success_at: Any,
    since: Any,
    interval_ms: int | None,
    now: datetime,
) -> bool:
    """True when a connection with active bindings has produced no sample for the threshold.

    The reference is the most recent of last_success_at and ``since`` (the moment the current
    bindings/configuration became effective), so a freshly added binding is not degraded before
    the edge had a chance to read it. Without any reference there is no evidence: False.
    """
    refs = [moment for moment in (_utc(last_success_at), _utc(since)) if moment is not None]
    if not refs:
        return False
    reference = max(refs)
    current = _utc(now) or now
    return (current - reference).total_seconds() > no_data_threshold_s(interval_ms)


@dataclass(frozen=True)
class ConnectionUpdate:
    health: str
    last_error: str | None
    last_success_at: datetime | None


def _report_error(report: Mapping[str, Any], default: str) -> str:
    code = str(report.get("last_error_code") or "").strip()
    text = str(report.get("last_error") or "").strip()
    if code and text and not text.startswith(code):
        message = f"{code}: {text}"
    else:
        message = text or code or default
    return message[:500]


def apply_connection_report(
    current: Mapping[str, Any],
    report: Mapping[str, Any],
    now: datetime,
) -> ConnectionUpdate | None:
    """Translate one edge-reported connection state into stored connection columns.

    UP            -> HEALTHY, last_error cleared.
    RATE_LIMITED  -> HEALTHY, last_error keeps the rate-limit text (warning, not an outage).
    DOWN/AUTH_FAILED -> DEGRADED with the real error text reported by the edge.
    IDLE          -> UNKNOWN (neutral): the edge runs no job for it; effective health is IDLE.
    last_success_at only moves forward and never into the future.
    Returns None when nothing changes or the report is unusable.
    """
    if str(current.get("status") or "").upper() != "ACTIVE":
        return None
    state = str(report.get("state") or "").upper()
    if state not in _REPORT_STATES:
        return None
    current_now = _utc(now) or now
    previous_ok = _utc(current.get("last_success_at"))
    reported_ok = _utc(report.get("last_ok_at"))
    if reported_ok is not None and reported_ok > current_now:
        reported_ok = current_now
    last_ok = previous_ok
    if reported_ok is not None and (previous_ok is None or reported_ok > previous_ok):
        last_ok = reported_ok
    advanced = last_ok is not None and (previous_ok is None or last_ok > previous_ok)
    if state in {"UP", "RATE_LIMITED"} and is_no_data_message(current.get("last_error")) and not advanced:
        # Center saw no samples for the threshold. A transport that is merely connected (for
        # example an MQTT session with a silent publisher) does not clear that evidence; only a
        # newer successful read does. Prevents DEGRADED/HEALTHY flapping every heartbeat.
        return None
    if state == "UP":
        health, error = "HEALTHY", None
    elif state == "RATE_LIMITED":
        health, error = "HEALTHY", _report_error(report, "Rate limited by the source; requests are being slowed down.")
    elif state in {"DOWN", "AUTH_FAILED"}:
        default = "Authentication failed." if state == "AUTH_FAILED" else "Source is unreachable."
        health, error = "DEGRADED", _report_error(report, default)
    else:
        health, error = "UNKNOWN", None
    if (
        str(current.get("health") or "") == health
        and (current.get("last_error") or None) == error
        and previous_ok == last_ok
    ):
        return None
    return ConnectionUpdate(health=health, last_error=error, last_success_at=last_ok)


def appliance_needs_enrollment(
    *,
    edge: Mapping[str, Any] | None,
    credential_file_present: bool,
    token_file_state: str,
    now: datetime,
) -> bool:
    """Decide whether the appliance must write a fresh enrollment token for its local edge.

    token_file_state: VALID (unused, unexpired token for this edge), MISSING, or INVALID.
    A token is needed when an edge exists that is not genuinely enrolled (no credential issued,
    not ENROLLED), or when the local credential file is gone and the edge stopped heartbeating
    (for example after the edge discarded a rejected credential).
    """
    if edge is None:
        return False
    if str(edge.get("enrollment_status") or "") == "REVOKED":
        return False
    if token_file_state == "VALID":
        return False
    if str(edge.get("enrollment_status") or "") != "ENROLLED" or not edge.get("has_credential"):
        return True
    if not credential_file_present and not heartbeat_fresh(edge.get("last_heartbeat"), now):
        return True
    return False


def collector_status(edge_states: list[str]) -> str:
    """Overall collector pill: NONE (no edge configured yet) | ONLINE | DEGRADED | NOT_ENROLLED | OFFLINE."""
    if not edge_states:
        return "NONE"
    if "ONLINE" in edge_states:
        return "ONLINE"
    if "DEGRADED" in edge_states:
        return "DEGRADED"
    if all(state == "NOT_ENROLLED" for state in edge_states):
        return "NOT_ENROLLED"
    return "OFFLINE"


def data_collection_status(connection_states: list[str]) -> str:
    """Overall data-collection pill from effective connection health.

    NOT_CONFIGURED: no connection. PAUSED: every connection paused. IDLE: no connection has
    signals bound. DEGRADED: at least one has real evidence of failure. PENDING: waiting for the
    first evidence. HEALTHY: every connection with signals is healthy.
    """
    states = [state for state in connection_states if state != "ARCHIVED"]
    if not states:
        return "NOT_CONFIGURED"
    running = [state for state in states if state != "PAUSED"]
    if not running:
        return "PAUSED"
    working = [state for state in running if state != "IDLE"]
    if not working:
        return "IDLE"
    if "DEGRADED" in working:
        return "DEGRADED"
    if "UNKNOWN" in working:
        return "PENDING"
    return "HEALTHY"
