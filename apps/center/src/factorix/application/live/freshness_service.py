"""FreshnessService: the one evaluator of freshness / effective status (R2-E C1, contract freshness.md).

Every surface that turns a stored latest value into "GOOD / DELAYED / STALE ..." goes through this
module: REST latest (with and without the live cache), the live push (bridge dispatch + 5 s hub
sweep), Data Models signal states, the model engine (live cache and PostgreSQL fallback), the
Historian source catalog badge and the Historian quality segments / gap threshold, and the
ingestion commit payload.

The rule itself stays in ``domain.signal_state`` (``evaluate_signal_state`` / ``classify_freshness``
/ ``canonical_stale_after_ms``). What this service owns is the *evidence* every caller must pass:

* the threshold interval: signal ``expected_interval_ms`` -> the acquisition job ``interval_ms``
  of the signal's connection -> the API process mapping (``PipelineEvidence.signal_interval``)
  -> 1000 ms (only when nothing at all is known);
* the pipeline evidence that separates DELAYED (source still read by acquisition, value in transit)
  from STALE (source silent): ``source_ok_at`` / ``source_reported_at`` / ``delivered_at``;
* the connection health used to explain a stale value (``CONNECTION_OFFLINE``, CT-12).

``PipelineEvidence`` lives here (moved from ``modules.live_state``, which re-exports it). It is pure
in-memory state of the API process, refreshed from PostgreSQL by the health loop. Other processes
(ingestion) get an empty evidence object: they evaluate with the job interval but cannot tell
DELAYED from STALE; the API re-evaluates every pushed message at dispatch time.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from factorix.domain.signal_state import (
    EffectiveStatus,
    Freshness,
    FreshnessVerdict,
    ReasonCode,
    SignalEvaluationResult,
    canonical_stale_after_ms,
    classify_freshness,
    evaluate_signal_state,
    stale_reason_code,
)
from factorix_core.time import utcnow as _utcnow

__all__ = [
    "DEFAULT_INTERVAL_MS",
    "FreshnessService",
    "PipelineEvidence",
    "freshness_service",
    "get_pipeline_evidence",
    "resolve_interval_ms",
]

# Used only when neither the signal, its acquisition job nor the API mapping knows an interval.
DEFAULT_INTERVAL_MS = 1000

def _utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return None


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def resolve_interval_ms(expected_interval_ms: Any = None, job_interval_ms: Any = None) -> int | None:
    """Signal interval, falling back to the acquisition job interval (v6_contracts Q2). ``None`` = unknown."""
    return _positive_int(expected_interval_ms) or _positive_int(job_interval_ms)


class PipelineEvidence:
    """Per-connection evidence that separates a silent source from a late pipeline (WS-Q).

    * ``source_ok`` / ``source_reported_at``: acquisition's own last successful read of each
      connection (``connections.last_success_at``) and its heartbeat time - written by acquisition
      straight to PostgreSQL, independent of RabbitMQ / ingestion.
    * ``connection_health``: ``connections.health`` of each connection (explains STALE, CT-12).
    * ``delivered``: newest acquisition time Center has received per connection (from every live
      event that passes the hub).
    * ``signal_connection`` / ``signal_interval``: signal -> connection and expected interval
      (signal ``expected_interval_ms`` falling back to the job ``interval_ms``).

    Pure in-memory state of the API process; refreshed from PostgreSQL by the health loop.
    """

    def __init__(self) -> None:
        self.signal_connection: dict[str, str] = {}
        self.signal_interval: dict[str, int] = {}
        self.source_ok: dict[str, datetime] = {}
        self.source_reported_at: datetime | None = None
        self.connection_health: dict[str, str] = {}
        self.delivered: dict[str, datetime] = {}
        self.mapping_loaded_at: datetime | None = None

    def connection_of(self, signal_id: Any) -> str | None:
        return self.signal_connection.get(str(signal_id).lower())

    def interval_of(self, signal_id: Any) -> int | None:
        return self.signal_interval.get(str(signal_id).lower())

    def health_of(self, connection_id: Any) -> str | None:
        if connection_id is None:
            return None
        return self.connection_health.get(str(connection_id).lower())

    def set_mapping(self, rows: Sequence[Mapping[str, Any]], *, now: datetime | None = None) -> None:
        mapping: dict[str, str] = {}
        intervals: dict[str, int] = {}
        for row in rows:
            sid = str(row.get("signal_id") or "").lower()
            cid = row.get("connection_id")
            if not sid or cid is None:
                continue
            mapping[sid] = str(cid).lower()
            interval = row.get("expected_interval_ms") or row.get("interval_ms")
            if interval:
                try:
                    intervals[sid] = int(interval)
                except (TypeError, ValueError):
                    pass
        self.signal_connection = mapping
        self.signal_interval = intervals
        self.mapping_loaded_at = now or _utcnow()

    def note_signal(self, signal_id: Any, connection_id: Any, interval_ms: Any = None) -> None:
        if signal_id is None or connection_id is None:
            return
        sid = str(signal_id).lower()
        self.signal_connection[sid] = str(connection_id).lower()
        if interval_ms:
            try:
                self.signal_interval[sid] = int(interval_ms)
            except (TypeError, ValueError):
                pass

    def set_source(self, rows: Sequence[Mapping[str, Any]], reported_at: Any) -> None:
        for row in rows:
            cid = row.get("id") or row.get("connection_id")
            if cid is None:
                continue
            key = str(cid).lower()
            if row.get("health") is not None:
                self.connection_health[key] = str(row["health"]).upper()
            ok = _utc(row.get("last_success_at"))
            if ok is not None:
                prev = self.source_ok.get(key)
                if prev is None or ok > prev:
                    self.source_ok[key] = ok
        reported = _utc(reported_at)
        if reported is not None and (self.source_reported_at is None or reported > self.source_reported_at):
            self.source_reported_at = reported

    def note_source(self, connection_id: Any, last_success_at: Any, health: Any = None) -> None:
        if connection_id is None:
            return
        key = str(connection_id).lower()
        if health is not None:
            self.connection_health[key] = str(health).upper()
        ok = _utc(last_success_at) if last_success_at is not None else None
        if ok is None:
            return
        prev = self.source_ok.get(key)
        if prev is None or ok > prev:
            self.source_ok[key] = ok

    def note_delivery(self, signal_id: Any, acquired_at: Any, connection_id: Any = None) -> str | None:
        cid = str(connection_id).lower() if connection_id else self.connection_of(signal_id)
        acquired = _utc(acquired_at) if acquired_at is not None else None
        if cid is None or acquired is None:
            return cid
        prev = self.delivered.get(cid)
        if prev is None or acquired > prev:
            self.delivered[cid] = acquired
        return cid

    def evidence_for(self, signal_id: Any, connection_id: Any = None) -> dict[str, Any]:
        cid = str(connection_id).lower() if connection_id else self.connection_of(signal_id)
        if cid is None:
            return {}
        return {
            "source_ok_at": self.source_ok.get(cid),
            "source_reported_at": self.source_reported_at,
            "delivered_at": self.delivered.get(cid),
        }

    def pipeline_summary(self, now: datetime | None = None) -> dict[str, dict[str, Any]]:
        """Per connection: source evidence and newest delivered acquisition time (for the stream heartbeat)."""
        current = now or _utcnow()
        out: dict[str, dict[str, Any]] = {}
        for cid in set(self.source_ok) | set(self.delivered):
            delivered = self.delivered.get(cid)
            out[cid] = {
                "source_ok_at": _iso(self.source_ok.get(cid)),
                "delivered_at": _iso(delivered),
                "delivery_lag_ms": int((current - delivered).total_seconds() * 1000) if delivered else None,
            }
        return out


_PIPELINE_EVIDENCE = PipelineEvidence()


def get_pipeline_evidence() -> PipelineEvidence:
    """Evidence of this process (populated only in the API process by the health loop / bridge)."""
    return _PIPELINE_EVIDENCE


_TIME_REASONS = {
    str(ReasonCode.NO_FRESH_ACQUISITION),
    str(ReasonCode.DELIVERY_DELAYED),
    str(ReasonCode.DELIVERY_STALLED),
    str(ReasonCode.CONNECTION_OFFLINE),
}


class FreshnessService:
    """Canonical freshness / quality evaluation with the evidence every caller must pass.

    ``evidence=None`` binds the process evidence (API: populated; other processes: empty).
    ``use_evidence=False`` evaluates with intervals only (no DELAYED, no evidence mutation): the
    ingestion process uses it for the provisional commit payload that the API re-evaluates.
    """

    def __init__(self, evidence: PipelineEvidence | None = None, *, use_evidence: bool = True) -> None:
        self._evidence = evidence
        self.use_evidence = use_evidence

    @property
    def evidence(self) -> PipelineEvidence:
        return self._evidence if self._evidence is not None else _PIPELINE_EVIDENCE

    # ------------------------------------------------------------------ thresholds

    def interval_ms(self, signal_id: Any = None, *, expected_interval_ms: Any = None, job_interval_ms: Any = None) -> int | None:
        interval = resolve_interval_ms(expected_interval_ms, job_interval_ms)
        if interval is None and self.use_evidence and signal_id is not None:
            interval = self.evidence.interval_of(signal_id)
        return interval

    def stale_after_ms(self, signal_id: Any = None, *, expected_interval_ms: Any = None, job_interval_ms: Any = None) -> int:
        """``max(2 x interval, 12 s)``; also the Historian gap threshold for operational series."""
        interval = self.interval_ms(signal_id, expected_interval_ms=expected_interval_ms, job_interval_ms=job_interval_ms)
        return canonical_stale_after_ms(interval or DEFAULT_INTERVAL_MS)

    # ------------------------------------------------------------------ evidence

    def _source_evidence(self, signal_id: Any, connection_id: Any) -> dict[str, Any]:
        if not self.use_evidence:
            return {}
        return self.evidence.evidence_for(signal_id, connection_id)

    def connection_of(self, signal_id: Any, connection_id: Any = None) -> str | None:
        if connection_id:
            return str(connection_id).lower()
        return self.evidence.connection_of(signal_id) if self.use_evidence else None

    def _register(self, signal_id: Any, connection_id: Any, interval: int | None) -> None:
        if self.use_evidence and signal_id is not None and connection_id is not None:
            self.evidence.note_signal(signal_id, connection_id, interval)

    def _connection_health(self, connection_health: Any, connection_id: Any) -> str | None:
        if connection_health is not None:
            return str(connection_health).upper()
        if self.use_evidence and connection_id is not None:
            return self.evidence.health_of(connection_id)
        return None

    # ------------------------------------------------------------------ evaluation

    def evaluate(
        self,
        *,
        signal_id: Any = None,
        has_observation: bool = True,
        raw_quality: str | None,
        raw_value: Any,
        event_time: datetime | None = None,
        last_acquired_at: datetime | None = None,
        expected_interval_ms: Any = None,
        job_interval_ms: Any = None,
        connection_id: Any = None,
        connection_health: str | None = None,
        now: datetime | None = None,
        binding_enabled: bool = True,
        resource_archived: bool = False,
        last_good_value: Any = None,
        last_good_time: datetime | None = None,
        raw_reason_code: str | None = None,
        null_allowed: bool = False,
        connection_paused: bool = False,
        restored_unverified: bool = False,
    ) -> SignalEvaluationResult:
        """``evaluate_signal_state`` with the resolved interval, pipeline evidence and connection health."""
        interval = self.interval_ms(signal_id, expected_interval_ms=expected_interval_ms, job_interval_ms=job_interval_ms)
        cid = self.connection_of(signal_id, connection_id)
        self._register(signal_id, cid if connection_id else None, resolve_interval_ms(expected_interval_ms, job_interval_ms))
        evid = self._source_evidence(signal_id, cid) if has_observation else {}
        return evaluate_signal_state(
            has_observation=has_observation,
            raw_quality=raw_quality,
            raw_value=raw_value,
            event_time=_utc(event_time) if isinstance(event_time, str) else event_time,
            last_acquired_at=_utc(last_acquired_at) if isinstance(last_acquired_at, str) else last_acquired_at,
            expected_interval_ms=interval,
            now=now or _utcnow(),
            binding_enabled=binding_enabled,
            resource_archived=resource_archived,
            connection_health=self._connection_health(connection_health, cid),
            last_good_value=last_good_value,
            last_good_time=last_good_time,
            raw_reason_code=raw_reason_code,
            null_allowed=null_allowed,
            connection_paused=connection_paused,
            restored_unverified=restored_unverified,
            source_ok_at=evid.get("source_ok_at"),
            source_reported_at=evid.get("source_reported_at"),
            delivered_at=evid.get("delivered_at"),
        )

    def evaluate_latest_row(
        self,
        row: Mapping[str, Any],
        *,
        now: datetime | None = None,
        has_observation: bool = True,
        binding_enabled: bool = True,
        connection_paused: bool | None = None,
        raw_value: Any = None,
        last_good_value: Any = None,
    ) -> SignalEvaluationResult:
        """Evaluate a PostgreSQL ``latest_signal_state`` row joined with its signal / job / connection.

        Recognised keys: ``signal_id``, ``quality`` (or ``raw_quality``), ``event_time``,
        ``received_time``, ``last_acquired_at``, ``expected_interval_ms``, ``job_interval_ms``,
        ``connection_id``, ``connection_health``, ``connection_status``, ``nullable``,
        ``reason_code``, ``last_good_event_time``. Values are passed in by the caller because each
        surface decodes ``value_json`` its own way.
        """
        paused = connection_paused if connection_paused is not None else str(row.get("connection_status") or "") == "PAUSED"
        return self.evaluate(
            signal_id=row.get("signal_id"),
            has_observation=has_observation,
            raw_quality=row.get("raw_quality") or row.get("quality"),
            raw_value=raw_value,
            event_time=row.get("event_time") or row.get("received_time"),
            last_acquired_at=row.get("last_acquired_at") or row.get("received_time"),
            expected_interval_ms=row.get("expected_interval_ms"),
            job_interval_ms=row.get("job_interval_ms"),
            connection_id=row.get("connection_id"),
            connection_health=row.get("connection_health"),
            now=now,
            binding_enabled=binding_enabled,
            last_good_value=last_good_value,
            last_good_time=row.get("last_good_event_time"),
            raw_reason_code=row.get("reason_code") or row.get("raw_reason"),
            null_allowed=bool(row.get("nullable")),
            connection_paused=paused,
        )

    def classify(
        self,
        *,
        signal_id: Any = None,
        last_acquired_at: Any,
        now: datetime | None = None,
        expected_interval_ms: Any = None,
        job_interval_ms: Any = None,
        connection_id: Any = None,
    ) -> str:
        """Time-only verdict for a badge: ``NO_DATA | FRESH | DELAYED | STALE`` (Historian catalog)."""
        acquired = _utc(last_acquired_at)
        if acquired is None:
            return str(Freshness.NO_DATA)
        verdict = self.verdict(
            signal_id=signal_id, last_acquired_at=acquired, now=now, expected_interval_ms=expected_interval_ms,
            job_interval_ms=job_interval_ms, connection_id=connection_id,
        )
        return verdict.freshness

    def verdict(
        self,
        *,
        signal_id: Any = None,
        last_acquired_at: datetime,
        now: datetime | None = None,
        expected_interval_ms: Any = None,
        job_interval_ms: Any = None,
        connection_id: Any = None,
        stale_after_ms: int | None = None,
    ) -> FreshnessVerdict:
        stale_after = stale_after_ms or self.stale_after_ms(
            signal_id, expected_interval_ms=expected_interval_ms, job_interval_ms=job_interval_ms
        )
        cid = self.connection_of(signal_id, connection_id)
        return classify_freshness(
            last_acquired_at=last_acquired_at,
            now=now or _utcnow(),
            stale_after_ms=stale_after,
            **self._source_evidence(signal_id, cid),
        )

    def delayed_connections(self, now: datetime | None = None) -> dict[str, int]:
        """Connections whose data is late in the pipeline (R2-02): acquisition keeps reading them (fresh
        heartbeat evidence) but the newest value Center received is older than the connection's stale
        threshold. ``{connection_id: delivery_lag_ms}``. A silent source (acquisition itself has no
        recent read) is not "delayed". Same rule as the per-signal DELAYED verdict."""
        if not self.use_evidence:
            return {}
        ev = self.evidence
        current = now or _utcnow()
        reported = ev.source_reported_at
        if reported is None:
            return {}
        intervals: dict[str, int] = {}
        for sid, cid in ev.signal_connection.items():
            interval = ev.signal_interval.get(sid)
            if interval and (cid not in intervals or interval < intervals[cid]):
                intervals[cid] = interval
        out: dict[str, int] = {}
        for cid, delivered in ev.delivered.items():
            stale_after = canonical_stale_after_ms(intervals.get(cid) or DEFAULT_INTERVAL_MS)
            verdict = classify_freshness(
                last_acquired_at=delivered, now=current, stale_after_ms=stale_after,
                source_ok_at=ev.source_ok.get(cid), source_reported_at=reported, delivered_at=delivered,
            )
            if verdict.freshness == Freshness.DELAYED:
                out[cid] = verdict.age_ms
        return out

    def refresh_message(self, message: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        """Re-evaluate the time-based part of a ``latest`` push message at dispatch / sweep time.

        Ingestion evaluates at commit time without pipeline evidence, so a value that is only late in
        the pipeline arrives as STALE. GOOD/STALE/DELAYED is decided here. Non time-based states
        (BAD, UNCERTAIN, PAUSED, DISABLED, NO_DATA, restored-unverified) keep their status; only
        ``freshness`` is annotated. Returns the same dict when nothing changed, a new dict otherwise.
        """
        acquired = _utc(message.get("last_acquired_at") or message.get("received_time"))
        if acquired is None:
            return message
        status = str(message.get("effective_status") or "").upper()
        reason = str(message.get("reason_code") or "").upper()
        if status in {"DISABLED", "PAUSED", "NO_DATA"}:
            return message
        raw_quality = str(message.get("quality") or "GOOD").upper()
        sid = message.get("signal_id")
        interval = self.interval_ms(sid)
        stale_after = (
            canonical_stale_after_ms(interval)
            if interval
            else int(message.get("stale_after_ms") or canonical_stale_after_ms(None))
        )
        current = now or _utcnow()
        cid = self.connection_of(sid, message.get("connection_id"))
        verdict = classify_freshness(
            last_acquired_at=acquired, now=current, stale_after_ms=stale_after, **self._source_evidence(sid, cid)
        )
        out = dict(message)
        out["stale_after_ms"] = stale_after
        out["freshness"] = verdict.freshness
        out["age_ms"] = verdict.age_ms
        out["evaluated_at"] = _iso(current)
        if cid:
            out["connection_id"] = cid
        if verdict.delivery_lag_ms is not None:
            out["delivery_lag_ms"] = verdict.delivery_lag_ms
        else:
            out.pop("delivery_lag_ms", None)
        time_based = (
            raw_quality == "GOOD"
            and status in {"GOOD", "STALE"}
            and reason != str(ReasonCode.UNVERIFIED_AFTER_RESTART)
        )
        if time_based:
            if verdict.freshness == Freshness.FRESH:
                out["effective_status"] = str(EffectiveStatus.GOOD)
                if reason in _TIME_REASONS:
                    out["reason_code"] = str(ReasonCode.OK)
            elif verdict.freshness == Freshness.DELAYED:
                out["effective_status"] = str(EffectiveStatus.GOOD)
                out["reason_code"] = str(ReasonCode.DELIVERY_DELAYED)
            else:
                out["effective_status"] = str(EffectiveStatus.STALE)
                out["reason_code"] = stale_reason_code(verdict.reason_code, self._connection_health(None, cid))
        return out


_PROCESS_SERVICE = FreshnessService()


def freshness_service() -> FreshnessService:
    """The service bound to this process's evidence."""
    return _PROCESS_SERVICE
