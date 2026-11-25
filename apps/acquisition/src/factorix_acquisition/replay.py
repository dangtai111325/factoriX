"""Spool replay for Acquisition: an adaptive, live-first drain of the outage spool.

Two cohesive parts:

* :class:`ReplayController` decides **how fast** replay may go. It is an AIMD rate limiter
  driven by live-path health only: live RAM backlog/age, live publish confirm latency, recent
  live publish failures, and (when the broker adapter exposes it) the depth of the RabbitMQ
  live and replay queues, i.e. whether Center keeps up. Healthy → additive increase up to
  ``max_rate``; congested → multiplicative decrease; a live failure → pause with cooldown.
  Replay therefore uses spare capacity only and can never push the live path into timeouts.
* :class:`ReplayPump` does **the work**: read a slice from the spool (newest-per-signal lane,
  then FIFO history), publish it through the same broker adapter, mark confirmed rows ACKED.
  It never deletes or DEADs a pending row because of slowness or backpressure; rows stay
  PENDING until RabbitMQ confirmed them (at-least-once; Center is idempotent by event_uid).

The pump runs either inline (``ObservationPublisher.flush_once`` after the live lane, used by
unit tests and when no event loop task is wanted) or as its own background task
(``ObservationPublisher(background_replay=True)``, production), so a replay slice that waits on
confirms or on the spool lock never delays live publishing.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.observation import ObservationError
from factorix.platform.broker import BrokerBackpressureError, BrokerTimeoutError

if TYPE_CHECKING:  # pragma: no cover
    from factorix_acquisition.publisher import ObservationPublisher

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ReplayLimits:
    """Tunables of the replay controller (all have environment overrides in ``publisher.py``)."""

    max_rate: float = 2000.0  # obs/s ceiling
    min_rate: float = 50.0  # floor while healthy (a congested controller pauses instead)
    initial_rate: float = 500.0
    additive_step: float = 250.0  # obs/s gained per healthy second
    decrease_factor: float = 0.5
    failure_pause_s: float = 15.0
    congestion_pause_s: float = 2.0
    live_head_age_max_s: float = 2.0  # oldest unpublished live observation
    live_backlog_max: int = 1000  # live observations waiting in RAM
    live_confirm_max_s: float = 1.0  # EWMA of live publish (confirm) duration
    live_queue_max: int = 20  # ready messages in the live queue (Center behind on live)
    legacy_queue_max: int = 10  # ready replay envelopes already queued for Center
    depth_probe_interval_s: float = 2.0


@dataclass(slots=True)
class ReplayController:
    limits: ReplayLimits = field(default_factory=ReplayLimits)
    rate: float = 0.0
    tokens: float = 0.0
    paused_until: float = 0.0
    last_tick: float = 0.0
    live_confirm_ewma_s: float = 0.0
    queue_depths: dict[str, int] | None = None
    depths_at: float = 0.0
    reason: str = "start"
    decreases: int = 0
    pauses: int = 0
    # Monotonic clock of every rate / pause decision; tests inject a fake one (B-15: the token bucket
    # refilled with real elapsed time between two calls, so a slow CI host saw one replay row too many).
    clock: Callable[[], float] = field(default=time.monotonic, repr=False)

    def __post_init__(self) -> None:
        self.rate = min(self.limits.max_rate, max(self.limits.min_rate, self.limits.initial_rate))
        self.tokens = self.capacity()
        self.last_tick = self.clock()

    def capacity(self) -> float:
        # Bucket holds about one second of the current rate (at least a few envelopes' worth).
        return max(1000.0, self.rate)

    # ---------------------------------------------------------------- live-health inputs

    def note_live_publish(self, duration_s: float) -> None:
        alpha = 0.3
        self.live_confirm_ewma_s = duration_s if self.live_confirm_ewma_s <= 0 else (
            alpha * duration_s + (1 - alpha) * self.live_confirm_ewma_s
        )

    def note_live_failure(self, reason: str) -> None:
        """A live publish failed or timed out: replay stops for a cooldown and restarts slowly."""
        now = self.clock()
        self.paused_until = max(self.paused_until, now + self.limits.failure_pause_s)
        self.rate = max(self.limits.min_rate, self.rate * self.limits.decrease_factor)
        self.tokens = 0.0
        self.reason = f"live {reason}"
        self.pauses += 1

    def congestion(self, publisher: "ObservationPublisher") -> str | None:
        lim = self.limits
        if publisher.fast_buffered > lim.live_backlog_max:
            return f"live backlog {publisher.fast_buffered}"
        head_age = publisher.fast_head_age_s()
        if head_age is not None and head_age > lim.live_head_age_max_s:
            return f"live head age {head_age:.1f}s"
        if self.live_confirm_ewma_s > lim.live_confirm_max_s:
            return f"live confirm {self.live_confirm_ewma_s:.2f}s"
        if publisher.ingest_backpressure or publisher.broker_slow:
            return "broker backpressure"
        depths = self.queue_depths
        if depths is not None:
            if depths.get("live", 0) > lim.live_queue_max:
                return f"Center behind on live ({depths['live']} queued)"
            if depths.get("legacy", 0) > lim.legacy_queue_max:
                return f"Center behind on replay ({depths['legacy']} queued)"
        return None

    async def refresh_queue_depths(self, broker: Any) -> None:
        probe = getattr(broker, "queue_depths", None)
        now = self.clock()
        if probe is None or now - self.depths_at < self.limits.depth_probe_interval_s:
            return
        self.depths_at = now
        try:
            self.queue_depths = await probe()
        except Exception:  # noqa: BLE001 - advisory
            self.queue_depths = None

    # ---------------------------------------------------------------- decision

    def allowance(self, publisher: "ObservationPublisher", wanted: int) -> int:
        """How many rows replay may send now (0 = wait). Updates the AIMD rate."""
        now = self.clock()
        elapsed = max(0.0, now - self.last_tick)
        self.last_tick = now
        if now < self.paused_until:
            return 0
        congested = self.congestion(publisher)
        if congested is not None:
            if self.reason != congested:
                logger.info("Replay slowing down: %s (rate %.0f obs/s)", congested, self.rate)
            self.reason = congested
            self.rate = max(self.limits.min_rate, self.rate * self.limits.decrease_factor)
            self.paused_until = now + self.limits.congestion_pause_s
            self.tokens = 0.0
            self.decreases += 1
            return 0
        self.reason = "healthy"
        self.rate = min(self.limits.max_rate, self.rate + self.limits.additive_step * min(elapsed, 1.0))
        self.tokens = min(self.capacity(), self.tokens + elapsed * self.rate)
        return max(0, min(int(wanted), int(self.tokens)))

    def consume(self, rows: int) -> None:
        self.tokens = max(0.0, self.tokens - rows)

    def seconds_until(self, rows: float) -> float:
        now = self.clock()
        if now < self.paused_until:
            return self.paused_until - now
        missing = max(0.0, rows - self.tokens)
        return missing / max(1.0, self.rate)

    def snapshot(self) -> dict[str, Any]:
        now = self.clock()
        return {
            "rate_obs_s": round(self.rate, 1),
            "paused_s": round(max(0.0, self.paused_until - now), 2),
            "reason": self.reason,
            "live_confirm_ewma_ms": round(self.live_confirm_ewma_s * 1000.0, 1),
            "queue_depths": self.queue_depths,
            "decreases": self.decreases,
            "pauses": self.pauses,
        }


class ReplayPump:
    """Reads spool slices and republishes them under the controller's allowance."""

    def __init__(self, owner: "ObservationPublisher", controller: ReplayController) -> None:
        self.owner = owner
        self.controller = controller
        self.task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._stopping = False

    # ---------------------------------------------------------------- one step

    async def replay_once(self, wanted: int) -> tuple[int, bool, bool]:
        """Send at most one newest-per-signal slice and one FIFO slice.

        Returns ``(published, ok, attempted)``; ``ok`` False means the broker failed the
        slice (the caller backs off); ``attempted`` False means the controller said wait.
        """
        owner = self.owner
        spool = owner.spool
        if spool.pending_count() <= 0:
            return 0, True, False
        await self.controller.refresh_queue_depths(owner.broker)
        limit = self.controller.allowance(owner, wanted)
        if limit <= 0:
            return 0, True, False
        lanes: list[list[Any]] = []
        read_started = time.monotonic()
        latest = await asyncio.to_thread(spool.latest_pending, limit)
        owner._record_stage("spool_read", read_started)
        if latest:
            lanes.append(latest)
            self.controller.consume(len(latest))
        history_limit = self.controller.allowance(owner, wanted)
        if history_limit > 0:
            read_started = time.monotonic()
            history = await asyncio.to_thread(spool.pending, history_limit, {int(r["seq"]) for r in latest})
            owner._record_stage("spool_read", read_started)
            if history:
                lanes.append(history)
                self.controller.consume(len(history))
        published = 0
        for rows in lanes:
            count, ok = await self.replay_rows(rows)
            published += count
            if not ok:
                return published, False, True
        return published, True, bool(lanes)

    async def replay_rows(self, rows: list[Any]) -> tuple[int, bool]:
        owner = self.owner
        broker = owner.broker
        gen = owner._broker_gen
        if broker is None:
            owner._broker_down = True
            owner.broker_ok = False
            return 0, False
        valid_obs: list[CanonicalObservation] = []
        corrupt_uids: list[str] = []
        stale_epochs = False
        decode_started = time.monotonic()
        for row in rows:
            uid = str(row["event_uid"])
            tid = str(row["tenant_id"])
            if int(row["data_epoch"]) < owner.active_epoch(tid):
                stale_epochs = True
                continue
            try:
                obs = CanonicalObservation.from_json_bytes(row["payload"])
            except ObservationError:
                corrupt_uids.append(uid)
                continue
            if obs.data_epoch < owner.active_epoch(str(obs.tenant_id)):
                stale_epochs = True
                continue
            valid_obs.append(obs)
        owner._record_stage("replay_decode", decode_started)
        if corrupt_uids:
            await asyncio.to_thread(owner.spool.mark_state, corrupt_uids, "QUARANTINED")
        if stale_epochs:
            await asyncio.to_thread(owner.spool.purge_old_epochs, owner._tenant_epochs)
        if not valid_obs:
            return 0, True

        publish_started = time.monotonic()
        confirmed, failed = await broker.publish_observations_partial(valid_obs)
        owner._record_stage("replay_publish", publish_started)
        owner._note_publish_failures(failed, lane="replay")
        if confirmed:
            mark_started = time.monotonic()
            await asyncio.to_thread(owner.spool.mark_sent, confirmed)
            owner._record_stage("spool_mark_sent", mark_started)
            owner.published_replay += len(confirmed)
        same_gen = gen == owner._broker_gen
        if not failed:
            if same_gen:
                owner._broker_down = False
                owner.broker_ok = True
                owner._clear_backpressure()
            return len(confirmed), (same_gen or owner.broker is not None)

        backpressure_uids = [obs.event_uid for obs, err in failed if isinstance(err, BrokerBackpressureError)]
        timed_out = [obs for obs, err in failed if isinstance(err, BrokerTimeoutError)]
        unavailable = len(failed) - len(backpressure_uids) - len(timed_out)
        if backpressure_uids:
            # Count the attempt for diagnostics, but a full queue never turns a pending row DEAD.
            owner._note_backpressure()
            await asyncio.to_thread(owner.spool.note_attempt, backpressure_uids, None)
        if timed_out:
            # Slow broker: rows stay PENDING, replay backs off (live keeps priority).
            self.controller.note_live_failure("replay confirm timeout")
        if unavailable and same_gen:
            owner.broker_ok = bool(confirmed)
            owner._broker_down = not owner.broker_ok
        # Unconfirmed rows remain PENDING without counting against max_attempts.
        return len(confirmed), False

    # ---------------------------------------------------------------- background loop

    def wake(self) -> None:
        self._wake.set()

    def start(self) -> None:
        if self.task is None or self.task.done():
            self._stopping = False
            self.task = asyncio.create_task(self._run(), name="acquisition-replay")

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        task, self.task = self.task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _sleep(self, seconds: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=max(0.01, seconds))
        except asyncio.TimeoutError:
            pass

    async def _run(self) -> None:
        from factorix_acquisition.publisher import BATCH_ROWS  # local import: avoid a cycle

        backoff = 0.5
        while not self._stopping:
            owner = self.owner
            try:
                if owner.spool.pending_count() <= 0:
                    await self._sleep(5.0)
                    continue
                if owner.broker is None or owner._broker_down:
                    # The live path owns outage detection; probe slowly with replay.
                    await self._sleep(min(30.0, backoff))
                    backoff = min(30.0, backoff * 2)
                    _published, ok, _attempted = await self.replay_once(min(BATCH_ROWS, 50))
                    if ok:
                        backoff = 0.5
                    continue
                await owner._maybe_expire()
                published, ok, attempted = await self.replay_once(BATCH_ROWS)
                if not ok:
                    await self._sleep(min(10.0, backoff))
                    backoff = min(10.0, backoff * 2)
                    continue
                backoff = 0.5
                if not attempted or published == 0:
                    await self._sleep(min(2.0, max(0.05, self.controller.seconds_until(BATCH_ROWS // 4))))
                else:
                    await asyncio.sleep(0)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the pump must survive and retry
                logger.exception("Replay pump step failed; retrying")
                await self._sleep(min(10.0, backoff))
                backoff = min(10.0, backoff * 2)
