"""Ingestion pipeline: synchronous formula evaluation (depth <= MAX_FORMULA_DEPTH). Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import math
from typing import Any
from uuid import UUID, uuid4

from factorix.domain.canonical import CanonicalObservation
from factorix.domain.formula import FormulaError, bind, evaluate, output_quality, parse_expression
from factorix.domain.quality import Origin, Quality

from factorix.application.ingestion.common import MAX_FORMULA_DEPTH, _WorkerStoppingRetry, _deterministic_calc_uid
from factorix.application.ingestion.envelope import _PreparedObs
from factorix.application.ingestion.catalog import TenantCatalog


class _FormulaStage:
    """IngestionWorker part: formula evaluation."""

    @staticmethod
    def _build_calc_obs(tenant_id: UUID, rec: Mapping[str, Any]) -> CanonicalObservation:
        vtype = str(rec.get("value_type") or "float64")
        val = rec.get("value")
        qual_str = str(rec.get("raw_quality") or "GOOD").upper()
        reason = str(rec["reason_code"]) if rec.get("reason_code") else None
        if vtype == "float64" and isinstance(val, (int, float)) and not isinstance(val, bool):
            fval = float(val)
            if not math.isfinite(fval):
                val = None
                qual_str = "BAD"
                reason = reason or "NON_FINITE"
        return CanonicalObservation(
            event_uid=str(rec["event_uid"]),
            tenant_id=tenant_id,
            site_id=None,
            connection_id=None,
            acquisition_job_id=None,
            source_field_id=None,
            signal_id=UUID(str(rec["signal_id"])),
            resource_id=UUID(str(rec["resource_id"])),
            source_time=rec.get("source_time"),
            acquired_at=rec["acquired_at"],
            value_type=vtype,
            value=val,
            unit=rec.get("unit"),
            quality=Quality(qual_str),
            quality_reason=reason,
            origin=Origin.CALCULATED,
            data_epoch=int(rec.get("data_epoch") or 1),
            config_revision=max(1, int(rec.get("config_revision") or 1)),
            source_sequence=None,
        )

    async def _evaluate_formulas(
        self,
        tenant_id: UUID,
        cat: TenantCatalog,
        triggers: list[_PreparedObs],
        overlay_latest: Mapping[UUID, dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], dict[UUID, dict[str, Any]], list[dict[str, Any]], bool]:
        """Compute published formulas up to depth 4 in causal chronological order and persist to TDengine."""
        # Seed pre-batch cache ONLY from already-committed live state (never future values in this batch!)
        trigger_sigs = {p.obs.signal_id for p in triggers}
        state_cache: dict[UUID, tuple[Any, str, datetime]] = {}
        live_t = self._live_cache.get(tenant_id, {})
        for sid, rec in live_t.items():
            if rec.data_epoch == cat.active_epoch:
                state_cache[sid] = (rec.value, str(rec.raw_quality), rec.last_acquired_at)

        # Pre-collect all alias signal IDs needed by potentially reachable formulas up to depth 4
        frontier_sigs = set(trigger_sigs)
        needed_aliases: set[UUID] = set()
        seen_fids: set[UUID] = set()
        scan_sigs = set(frontier_sigs)
        for _depth in range(MAX_FORMULA_DEPTH + 1):
            next_sigs: set[UUID] = set()
            for sig in scan_sigs:
                for f in cat.formulas_by_dep.get(sig, []):
                    fid = UUID(str(f["formula_id"]))
                    if fid in seen_fids:
                        continue
                    seen_fids.add(fid)
                    out_sig = UUID(str(f["output_id"]))
                    next_sigs.add(out_sig)
                    for al in cat.formula_aliases.get(fid, []):
                        needed_aliases.add(UUID(str(al["dependency_signal_id"])))
            if not next_sigs:
                break
            scan_sigs = next_sigs

        missing_from_cache = [sid for sid in needed_aliases if sid not in state_cache]
        if missing_from_cache:
            try:
                pg_latest = await self._retry_pg_op(
                    lambda: self.pg.fetch_latest_values(tenant_id, missing_from_cache)
                )
            except _WorkerStoppingRetry:
                return [], {}, [], True
            for sid, data in pg_latest.items():
                if data["data_epoch"] == cat.active_epoch:
                    state_cache[sid] = (data["value"], data["quality"], data["received_time"])

        for sid, row in overlay_latest.items():
            if sid not in trigger_sigs and sid not in state_cache:
                state_cache[sid] = (row["value"], str(row["quality"]), row["received_time"])

        calc_td_records: list[dict[str, Any]] = []
        calc_latest_rows: dict[UUID, dict[str, Any]] = {}
        calc_shadow_rows: list[dict[str, Any]] = []

        ordered_triggers = sorted(
            triggers,
            key=lambda p: (
                p.obs.data_epoch,
                p.received_time,
                p.obs.source_sequence if p.obs.source_sequence is not None else -1,
                p.obs.event_uid,
            ),
        )
        visited_evals: set[tuple[UUID, str]] = set()
        for trig_prep in ordered_triggers:
            # Raw history has already accepted this sample. A late delivery
            # cannot rewind the state used by subsequent formula triggers.
            previous_input = state_cache.get(trig_prep.obs.signal_id)
            if previous_input is not None and previous_input[2] > trig_prep.received_time:
                continue
            state_cache[trig_prep.obs.signal_id] = (
                trig_prep.obs.value,
                trig_prep.norm_quality,
                trig_prep.received_time,
            )
            queue: list[tuple[UUID, datetime, datetime, int, str, int]] = [
                (
                    trig_prep.obs.signal_id,
                    trig_prep.event_time,
                    trig_prep.received_time,
                    trig_prep.obs.data_epoch,
                    trig_prep.obs.event_uid,
                    0,
                )
            ]
            while queue:
                trig_sig, ev_time, rx_time, data_epoch, trig_uid, depth = queue.pop(0)
                if depth >= MAX_FORMULA_DEPTH:
                    continue
                for formula in cat.formulas_by_dep.get(trig_sig, []):
                    fid = UUID(str(formula["formula_id"]))
                    if (fid, trig_uid) in visited_evals:
                        continue
                    visited_evals.add((fid, trig_uid))
                    aliases = cat.formula_aliases.get(fid, [])
                    if not aliases:
                        continue
                    values: dict[str, Any] = {}
                    qualities: list[str] = []
                    alias_ids: dict[str, UUID] = {}
                    ready = True
                    for al in aliases:
                        dep_id = UUID(str(al["dependency_signal_id"]))
                        dep_state = state_cache.get(dep_id)
                        if dep_state is None or dep_state[2] > rx_time:
                            ready = False
                            break
                        values[str(al["variable_alias"])] = dep_state[0]
                        qualities.append(dep_state[1])
                        alias_ids[str(al["variable_alias"])] = dep_id
                    if not ready:
                        continue
                    try:
                        rev = int(formula.get("revision") or 1)
                        cache_key = (fid, rev)
                        program = self._formula_ast_cache.get(cache_key)
                        if program is None:
                            ast = parse_expression(str(formula["expression_source"]))
                            program = bind(ast, alias_ids)
                            if len(self._formula_ast_cache) >= 5000:
                                self._formula_ast_cache.pop(next(iter(self._formula_ast_cache)))
                            self._formula_ast_cache[cache_key] = program
                        val = evaluate(program, values)
                    except (FormulaError, ZeroDivisionError, OverflowError, ValueError):
                        continue
                    qual = output_quality(qualities, val)
                    output_id = UUID(str(formula["output_id"]))
                    resource_id = UUID(str(formula["resource_id"]))
                    site_id = UUID(str(formula["site_id"])) if formula.get("site_id") else None
                    rev = int(formula["revision"] or 1)
                    vtype = str(formula["data_type"])
                    calc_uid = _deterministic_calc_uid(fid, rev, output_id, trig_uid)
                    obs_id = uuid4()

                    calc_td_records.append(
                        {
                            "event_uid": calc_uid,
                            "signal_id": output_id,
                            "resource_id": resource_id,
                            "connection_id": None,
                            "value_type": vtype,
                            "value": val,
                            "unit": formula.get("unit"),
                            "raw_quality": qual,
                            "reason_code": None,
                            "origin": Origin.CALCULATED.value,
                            "event_time": ev_time,
                            "acquired_at": rx_time,
                            "source_time": None,
                            "config_revision": rev,
                            "data_epoch": data_epoch,
                            "source_seq": None,
                        }
                    )
                    previous_output = state_cache.get(output_id)
                    if previous_output is None or previous_output[2] <= rx_time:
                        state_cache[output_id] = (val, qual, rx_time)
                    cand_sort_key = (data_epoch, rx_time, -1, calc_uid)
                    prev_latest = calc_latest_rows.get(output_id)
                    if prev_latest is None or cand_sort_key > prev_latest["_sort_key"]:
                        calc_latest_rows[output_id] = {
                            "_sort_key": cand_sort_key,
                            "signal_id": output_id,
                            "resource_id": resource_id,
                            "observation_id": obs_id,
                            "value_type": vtype,
                            "value": val,
                            "unit": formula.get("unit"),
                            "quality": qual,
                            "event_time": ev_time,
                            "received_time": rx_time,
                            "last_acquired_at": rx_time,
                            "source_time": None,
                            "config_revision": rev,
                            "origin": Origin.CALCULATED.value,
                            "data_epoch": data_epoch,
                            "source_sequence": None,
                            "reason_code": None,
                            "event_uid": calc_uid,
                            "expected_interval_ms": formula.get("expected_interval_ms"),
                            "nullable": False,
                        }
                    if self.shadow_pg:
                        calc_shadow_rows.append(
                            {
                                "observation_id": obs_id,
                                "site_id": site_id,
                                "resource_id": resource_id,
                                "signal_id": output_id,
                                "connection_id": None,
                                "event_uid": calc_uid,
                                "event_time": ev_time,
                                "received_time": rx_time,
                                "source_time": None,
                                "value_type": vtype,
                                "value": val,
                                "unit": formula.get("unit"),
                                "quality": qual,
                                "origin": Origin.CALCULATED.value,
                                "config_revision": rev,
                                "provenance": {"formula_id": str(fid), "formula_revision": rev},
                            }
                        )
                    if output_id in cat.formula_inputs and depth + 1 < MAX_FORMULA_DEPTH:
                        queue.append((output_id, ev_time, rx_time, data_epoch, calc_uid, depth + 1))

        if calc_td_records:
            _succ, _perm, aborted = await self._write_td_with_retry(
                tenant_id, calc_td_records, record_kind="RAW_OPERATIONAL"
            )
            if aborted:
                return [], {}, [], True

        return calc_td_records, calc_latest_rows, calc_shadow_rows, False
