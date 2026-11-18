"""Ingestion pipeline: tenant catalog (signals, bindings, storage targets, epoch) and its cache/invalidation. Moved verbatim from ``factorix.modules.ingestion_worker`` (R2-E B4, move-only)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
import json
import time
from typing import Any
from uuid import UUID

import asyncpg

from factorix.domain.canonical import CanonicalObservation, intern_uuid
from factorix.modules.recording_policy import (
    ManagedBindingTarget,
    build_managed_target_from_row,
    build_managed_target_from_storage_binding,
)
from factorix.application.live.latest_api import select_binding

from factorix.application.ingestion.common import logger


@dataclass(slots=True)
class TenantCatalog:
    tenant_id: UUID
    active_epoch: int = 1
    lifecycle_state: str = "ACTIVE"
    bindings: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    formula_inputs: set[UUID] = field(default_factory=set)
    formulas_by_dep: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    formula_aliases: dict[UUID, list[dict[str, Any]]] = field(default_factory=dict)
    managed_targets_by_signal: dict[UUID, list[ManagedBindingTarget]] = field(default_factory=dict)
    managed_targets_by_model: dict[tuple[UUID, str], list[ManagedBindingTarget]] = field(default_factory=dict)
    all_managed_targets: tuple[ManagedBindingTarget, ...] = ()
    loaded_at: float = 0.0
    epoch_loaded_at: float = 0.0
    last_miss_refresh_at: float = 0.0


def _default_owned_check(catalog: TenantCatalog, obs: CanonicalObservation, received_time: datetime) -> dict[str, Any] | None:
    row = select_binding(catalog.bindings.get(obs.signal_id, []), received_time)
    if row is None:
        return None
    if obs.resource_id != intern_uuid(row["resource_id"]):
        return None
    if obs.connection_id is not None and obs.connection_id != intern_uuid(row["connection_id"]):
        return None
    if obs.source_field_id is not None and obs.source_field_id != intern_uuid(row["source_field_id"]):
        return None
    if obs.provenance and obs.provenance.source_field_id is not None:
        if obs.provenance.source_field_id != intern_uuid(row["source_field_id"]):
            return None
    row_site = row.get("site_id")
    if obs.site_id is not None and row_site is not None and obs.site_id != intern_uuid(row_site):
        return None
    return row


class _CatalogStore:
    """PgIngestionStore part: tenant epoch and catalog queries."""

    async def fetch_tenant_epoch(self, tenant_id: UUID) -> tuple[int, str]:
        assert self._pool is not None
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT active_epoch, lifecycle_state FROM telemetry_generations WHERE tenant_id = $1",
                tenant_id,
            )
        if row is None:
            return 1, "ACTIVE"
        return max(1, int(row["active_epoch"] or 1)), str(row["lifecycle_state"] or "ACTIVE")

    async def load_tenant_catalog(self, tenant_id: UUID) -> TenantCatalog:
        assert self._pool is not None
        now_mono = time.monotonic()
        async with self._pool.acquire() as conn:
            async with conn.transaction(isolation="repeatable_read", readonly=True):
                gen_row = await conn.fetchrow(
                    "SELECT active_epoch, lifecycle_state FROM telemetry_generations WHERE tenant_id = $1",
                    tenant_id,
                )
                active_epoch = max(1, int(gen_row["active_epoch"] or 1)) if gen_row else 1
                lifecycle_state = str(gen_row["lifecycle_state"] or "ACTIVE") if gen_row else "ACTIVE"

                binding_rows = await conn.fetch(
                    """
                    SELECT b.signal_id, b.valid_from, b.valid_to, s.resource_id, s.expected_interval_ms, r.site_id,
                           c.id AS connection_id, f.id AS source_field_id,
                           COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable
                    FROM signal_bindings b
                    JOIN signal_definitions s ON s.id = b.signal_id
                    JOIN resources r ON r.id = s.resource_id
                    JOIN source_fields f ON f.id = b.source_field_id
                    JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
                    JOIN connections c ON c.id = j.connection_id
                    WHERE s.tenant_id = $1 AND c.tenant_id = $1 AND b.enabled = TRUE AND s.status = 'ACTIVE'
                    """,
                    tenant_id,
                )
                bindings: dict[UUID, list[dict[str, Any]]] = {}
                for r in binding_rows:
                    d = dict(r)
                    sig = UUID(str(d["signal_id"]))
                    bindings.setdefault(sig, []).append(d)

                formula_rows = await conn.fetch(
                    """
                    SELECT d.dependency_signal_id, f.id AS formula_id, f.signal_id AS output_id,
                           f.expression_source, f.revision, s.resource_id, s.data_type, s.unit,
                           s.expected_interval_ms, r.site_id
                    FROM formula_dependencies d
                    JOIN formula_definitions f ON f.id = d.formula_id
                    JOIN signal_definitions s ON s.id = f.signal_id
                    JOIN resources r ON r.id = s.resource_id
                    WHERE f.status = 'PUBLISHED' AND s.tenant_id = $1
                    """,
                    tenant_id,
                )
                formula_inputs: set[UUID] = set()
                formulas_by_dep: dict[UUID, list[dict[str, Any]]] = {}
                formula_ids: set[UUID] = set()
                for r in formula_rows:
                    d = dict(r)
                    dep_sig = UUID(str(d["dependency_signal_id"]))
                    fid = UUID(str(d["formula_id"]))
                    formula_inputs.add(dep_sig)
                    formula_ids.add(fid)
                    existing = formulas_by_dep.setdefault(dep_sig, [])
                    if not any(UUID(str(x["formula_id"])) == fid for x in existing):
                        existing.append(d)

                formula_aliases: dict[UUID, list[dict[str, Any]]] = {}
                if formula_ids:
                    alias_rows = await conn.fetch(
                        """
                        SELECT formula_id, variable_alias, dependency_signal_id
                        FROM formula_dependencies
                        WHERE formula_id = ANY($1::uuid[])
                        """,
                        list(formula_ids),
                    )
                    for r in alias_rows:
                        fid = UUID(str(r["formula_id"]))
                        formula_aliases.setdefault(fid, []).append(dict(r))

                managed_rows = await conn.fetch(
                    """
                    SELECT d.id AS design_id,
                           d.status AS design_status,
                           ds.id AS dataset_id,
                           ds.dataset_key,
                           ds.semantics,
                           ds.time_axis,
                           ds.tags_json,
                           ds.status AS dataset_status,
                           fb.field_key,
                           fb.value_type,
                           fb.max_length,
                           fb.source_kind AS field_source_kind,
                           fb.signal_id,
                           fb.model_id,
                           fb.model_field_path,
                           fb.resource_id,
                           fb.source_revision,
                           fb.transform_json,
                           fb.nullable,
                           fb.required,
                           COALESCE(rp.mode, 'ON_CHANGE') AS recording_mode,
                           COALESCE(rp.policy_json, '{}'::jsonb) AS policy_json,
                           COALESCE(rp.version, 1) AS policy_version,
                           COALESCE(rp.enabled, TRUE) AS policy_enabled,
                           pr.design_version_id,
                           pr.td_database,
                           pr.td_stable,
                           pr.td_subtable,
                           pr.series_key AS registry_series_key,
                           pr.status AS registry_status
                    FROM storage_datasets ds
                    JOIN storage_designs d ON d.id = ds.design_id
                    JOIN storage_field_bindings fb ON fb.dataset_id = ds.id
                    LEFT JOIN storage_recording_policies rp ON rp.dataset_id = ds.id
                    JOIN storage_physical_registry pr
                      ON pr.tenant_id = ds.tenant_id
                     AND pr.tier = 'MANAGED'
                     AND pr.dataset_id = ds.id
                     AND (
                          (fb.signal_id IS NOT NULL AND pr.series_key IN (
                              concat(CAST(ds.id AS text), ':sig:', lower(CAST(fb.signal_id AS text))),
                              concat(CAST(d.id AS text), ':sig:', lower(CAST(fb.signal_id AS text)))
                          ))
                          OR (fb.model_id IS NOT NULL AND pr.series_key IN (
                              concat(CAST(ds.id AS text), ':mod:', lower(CAST(fb.model_id AS text)), ':', COALESCE(NULLIF(fb.model_field_path, ''), fb.field_key)),
                              concat(CAST(d.id AS text), ':mod:', lower(CAST(fb.model_id AS text)), ':', COALESCE(NULLIF(fb.model_field_path, ''), fb.field_key))
                          ))
                          OR (fb.signal_id IS NULL AND fb.model_id IS NULL AND pr.series_key IN (
                              concat(CAST(ds.id AS text), ':fld:', ds.dataset_key, ':', fb.field_key),
                              concat(CAST(d.id AS text), ':fld:', ds.dataset_key, ':', fb.field_key)
                          ))
                     )
                    WHERE ds.tenant_id = $1
                      AND d.status IN ('RUNNING', 'PAUSED')
                      AND ds.status IN ('RUNNING', 'PAUSED')
                      AND pr.status IN ('ACTIVE', 'PAUSED')
                    ORDER BY ds.id, fb.ordinal, fb.field_key
                    """,
                    tenant_id,
                )
                managed_by_signal: dict[UUID, list[ManagedBindingTarget]] = {}
                managed_by_model: dict[tuple[UUID, str], list[ManagedBindingTarget]] = {}
                all_managed: list[ManagedBindingTarget] = []
                for r in managed_rows:
                    target = build_managed_target_from_row(dict(r))
                    all_managed.append(target)
                    if target.signal_id is not None:
                        managed_by_signal.setdefault(target.signal_id, []).append(target)
                    if target.model_id is not None and target.model_field_path:
                        managed_by_model.setdefault((target.model_id, target.model_field_path), []).append(target)

                # Modern storage_bindings metadata
                sb_rows = await conn.fetch(
                    """
                    SELECT sb.id AS binding_id,
                           sb.tenant_id,
                           sb.physical_db,
                           sb.physical_subtable,
                           sb.target_column,
                           sb.signal_id,
                           sb.model_id,
                           sb.model_field_path,
                           sb.row_assembly_policy,
                           sb.policy_config_json,
                           sb.binding_revision,
                           sb.status AS binding_status,
                           COALESCE(so.parent_name, pr.td_stable, '') AS td_stable,
                           s.data_type,
                           s.resource_id,
                           so.tags_json AS subtable_tags_json,
                           pso.tags_json AS stable_tags_json,
                           pso.schema_json AS stable_columns_json
                    FROM storage_bindings sb
                    LEFT JOIN storage_objects so
                      ON so.tenant_id = sb.tenant_id
                     AND so.physical_db = sb.physical_db
                     AND so.physical_name = sb.physical_subtable
                    LEFT JOIN storage_objects pso
                      ON pso.tenant_id = sb.tenant_id
                     AND pso.object_type = 'stable'
                     AND pso.physical_db = sb.physical_db
                     AND pso.physical_name = so.parent_name
                    LEFT JOIN storage_physical_registry pr
                      ON pr.tenant_id = sb.tenant_id
                     AND pr.td_database = sb.physical_db
                     AND pr.td_subtable = sb.physical_subtable
                    LEFT JOIN signal_definitions s ON s.id = sb.signal_id
                    WHERE sb.tenant_id = $1 AND sb.status = 'ACTIVE' AND sb.source_kind = 'signal'
                    """,
                    tenant_id,
                )
                for r in sb_rows:
                    try:
                        target = build_managed_target_from_storage_binding(dict(r))
                    except Exception as exc:  # noqa: BLE001 - one bad binding must not poison the tenant catalog
                        logger.warning(
                            "Skipping storage binding %s: invalid definition (%s)", r.get("binding_id"), type(exc).__name__
                        )
                        continue
                    all_managed.append(target)
                    if target.signal_id is not None:
                        managed_by_signal.setdefault(target.signal_id, []).append(target)
                    if target.model_id is not None and target.model_field_path:
                        managed_by_model.setdefault((target.model_id, target.model_field_path), []).append(target)

        return TenantCatalog(
            tenant_id=tenant_id,
            active_epoch=active_epoch,
            lifecycle_state=lifecycle_state,
            bindings=bindings,
            formula_inputs=formula_inputs,
            formulas_by_dep=formulas_by_dep,
            formula_aliases=formula_aliases,
            managed_targets_by_signal=managed_by_signal,
            managed_targets_by_model=managed_by_model,
            all_managed_targets=tuple(all_managed),
            loaded_at=now_mono,
            epoch_loaded_at=now_mono,
            last_miss_refresh_at=0.0,
        )


class _CatalogStage:
    """IngestionWorker part: catalog cache, config/epoch NOTIFY listener."""

    def invalidate_tenant_cache(self, tenant_id: UUID | None = None, *, epoch_changed: bool = False) -> None:
        if tenant_id is None:
            self._catalogs.clear()
            self._live_cache.clear()
            if epoch_changed:
                if hasattr(self.recording_evaluator, "invalidate_tenant"):
                    self.recording_evaluator.invalidate_tenant(None)
                self.live_provider.invalidate_epoch_sync(None, 1)
            return
        cat = self._catalogs.get(tenant_id)
        if cat is not None:
            cat.loaded_at = 0.0
            cat.epoch_loaded_at = 0.0
        self._live_cache.pop(tenant_id, None)
        if epoch_changed:
            if hasattr(self.recording_evaluator, "invalidate_tenant"):
                self.recording_evaluator.invalidate_tenant(tenant_id)
            next_ep = (cat.active_epoch + 1) if cat is not None else 1
            self.live_provider.invalidate_epoch_sync(tenant_id, next_ep)

    async def _get_catalog(self, tenant_id: UUID, *, need_signal: UUID | None = None) -> TenantCatalog:
        lock = self._catalog_locks.setdefault(tenant_id, asyncio.Lock())
        async with lock:
            now_mono = time.monotonic()
            prev_cat = self._catalogs.get(tenant_id)
            prev_epoch = prev_cat.active_epoch if prev_cat is not None else None
            if prev_cat is None or prev_cat.loaded_at <= 0.0 or (now_mono - prev_cat.loaded_at) > 30.0:
                cat = await self._retry_pg_op(lambda: self.pg.load_tenant_catalog(tenant_id))
                if prev_epoch is not None and cat.active_epoch > prev_epoch:
                    self.recent_uids.clear_tenant(tenant_id)
                    self._live_cache.pop(tenant_id, None)
                    if hasattr(self.recording_evaluator, "invalidate_tenant"):
                        self.recording_evaluator.invalidate_tenant(tenant_id)
                    await self.live_provider.invalidate_epoch(tenant_id, cat.active_epoch)
                else:
                    self.live_provider.set_active_epoch(tenant_id, cat.active_epoch)
                self._catalogs[tenant_id] = cat
                return cat
            cat = prev_cat
            if cat.epoch_loaded_at <= 0.0 or (now_mono - cat.epoch_loaded_at) > 2.0:
                epoch, state = await self._retry_pg_op(lambda: self.pg.fetch_tenant_epoch(tenant_id))
                if epoch > cat.active_epoch:
                    self.recent_uids.clear_tenant(tenant_id)
                    self._live_cache.pop(tenant_id, None)
                    if hasattr(self.recording_evaluator, "invalidate_tenant"):
                        self.recording_evaluator.invalidate_tenant(tenant_id)
                    await self.live_provider.invalidate_epoch(tenant_id, epoch)
                cat.active_epoch = epoch
                cat.lifecycle_state = state
                cat.epoch_loaded_at = now_mono
            if need_signal is not None and need_signal not in cat.bindings:
                if (now_mono - cat.last_miss_refresh_at) >= 2.0:
                    cat = await self._retry_pg_op(lambda: self.pg.load_tenant_catalog(tenant_id))
                    if prev_epoch is not None and cat.active_epoch > prev_epoch:
                        self.recent_uids.clear_tenant(tenant_id)
                        self._live_cache.pop(tenant_id, None)
                        if hasattr(self.recording_evaluator, "invalidate_tenant"):
                            self.recording_evaluator.invalidate_tenant(tenant_id)
                        await self.live_provider.invalidate_epoch(tenant_id, cat.active_epoch)
                    cat.last_miss_refresh_at = now_mono
                    self._catalogs[tenant_id] = cat
            return cat

    def _on_pg_notify(self, _conn: Any, _pid: int, channel: str, payload: str) -> None:
        tid: UUID | None = None
        if payload:
            try:
                obj = json.loads(payload)
                if isinstance(obj, dict) and obj.get("tenant_id"):
                    tid = UUID(str(obj["tenant_id"]))
            except (ValueError, json.JSONDecodeError):
                tid = None
        is_epoch = channel == "factorix_epoch_changed"
        self.invalidate_tenant_cache(tid, epoch_changed=is_epoch)
        if is_epoch and tid is not None:
            self.recent_uids.clear_tenant(tid)

    async def _notify_loop(self) -> None:
        assert self._notify_dsn is not None
        backoff = 0.5
        while not self._stop_event.is_set():
            try:
                conn = await asyncpg.connect(self._notify_dsn, timeout=5.0)
                self._notify_conn = conn
                await conn.add_listener("factorix_config_changed", self._on_pg_notify)
                await conn.add_listener("factorix_epoch_changed", self._on_pg_notify)
                self.invalidate_tenant_cache(None)
                backoff = 0.5
                while not self._stop_event.is_set() and not conn.is_closed():
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        await conn.execute("SELECT 1")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Ingestion PG LISTEN/NOTIFY connection lost (%r); reconnecting", exc)
                if self._notify_conn is not None and not self._notify_conn.is_closed():
                    try:
                        await self._notify_conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._notify_conn = None
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(10.0, backoff * 2.0)
