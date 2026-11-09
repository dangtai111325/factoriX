"""Data Model v2 service: CRUD, validation, live preview, duplication, signal catalog and usage.

Models live in ``output_groups`` (``spec_json``, ``sample_ms``, ``state``, ``description``;
``status`` ACTIVE/ARCHIVED). ``model_refs`` indexes every signal/resource a model references
(maintained on save) for usage and impact lookups. Sampling is done by
:mod:`factorix.modules.models_engine`; this module only notifies it after commit.
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from collections.abc import Iterable
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain import body as B
from factorix.domain import rules as R
from factorix.domain.signal_state import evaluate_signal_state
from factorix.modules import models_engine as E
from factorix.modules.common import as_uuid, audit, execute, execute_rowcount, fetch_all, fetch_one, iso_ms, jsonb, parse_uuid, utcnow
from factorix.platform.errors import AppError

log = logging.getLogger(__name__)

STATES = ("RUNNING", "PAUSED")
MAX_NAME_LEN = 200
MAX_DESCRIPTION_LEN = 2000
MAX_TARGETS = 100
PREVIEW_TTL_S = 300.0
PREVIEW_SESSIONS = 256
SNAPSHOT_LIMIT = 100
_DEFAULT_EMIT = {"republish_ms": None, "max_events": 1000, "snapshot_grace_ms": 0}


class DataModelIn(BaseModel):
    name: str
    description: str = ""
    sample_ms: int = E.DEFAULT_SAMPLE_MS
    state: str = "RUNNING"
    spec: dict[str, Any] = Field(default_factory=B.empty_spec)


class DataModelPatch(BaseModel):
    version: int
    name: str | None = None
    description: str | None = None
    sample_ms: int | None = None
    spec: dict[str, Any] | None = None


class StateChangeIn(BaseModel):
    version: int | None = None


class SpecIn(BaseModel):
    spec: dict[str, Any]
    model_id: str | None = None
    session_id: str | None = Field(default=None, max_length=64)


class RetargetPair(BaseModel):
    from_resource_id: str
    to_resource_id: str


class DuplicateIn(BaseModel):
    name: str | None = None
    retarget: list[RetargetPair] = Field(default_factory=list)
    targets: list[str] = Field(default_factory=list)
    source_resource_id: str | None = None
    state: str | None = None
    dry_run: bool = False
    # R4-DM-15: a copy whose references cannot all be re-pointed would keep reading the source
    # machine. With skip_unmatched those targets are not created (reported with skipped: true).
    skip_unmatched: bool = False


# ============================================================================================
# Helpers
# ============================================================================================


def _spec_of(row: dict[str, Any]) -> dict[str, Any]:
    spec = E._json(row.get("spec_json"))
    return spec if isinstance(spec, dict) else B.empty_spec()


def _name(raw: str) -> str:
    name = (raw or "").strip()
    if not name:
        raise AppError(422, "NAME_REQUIRED", "Enter a model name.", field_errors=[{"path": "name", "code": "REQUIRED"}])
    if len(name) > MAX_NAME_LEN:
        raise AppError(422, "NAME_TOO_LONG", f"Names are limited to {MAX_NAME_LEN} characters.", field_errors=[{"path": "name", "code": "TOO_LONG"}])
    return name


def _sample_ms(value: int) -> int:
    if not isinstance(value, int) or not E.MIN_SAMPLE_MS <= value <= E.MAX_SAMPLE_MS:
        raise AppError(
            422,
            "INVALID_SAMPLE_MS",
            f"The sampling rate must be between {E.MIN_SAMPLE_MS} ms and {E.MAX_SAMPLE_MS // 60000} minutes.",
            field_errors=[{"path": "sample_ms", "code": "RANGE"}],
        )
    return value


def _state(value: str | None, default: str = "RUNNING") -> str:
    state = (value or default).upper()
    if state not in STATES:
        raise AppError(422, "INVALID_STATE", "state must be RUNNING or PAUSED.", field_errors=[{"path": "state", "code": "INVALID"}])
    return state


def _description(value: str | None) -> str:
    text = (value or "").strip()
    if len(text) > MAX_DESCRIPTION_LEN:
        raise AppError(422, "DESCRIPTION_TOO_LONG", f"Descriptions are limited to {MAX_DESCRIPTION_LEN} characters.")
    return text


async def _name_taken(session: AsyncSession, tenant_id: UUID, name: str, exclude: UUID | None = None) -> bool:
    row = await fetch_one(
        session,
        """
        SELECT id FROM output_groups
        WHERE tenant_id = :tenant_id AND status <> 'ARCHIVED' AND lower(display_name) = lower(:name)
          AND (CAST(:exclude AS uuid) IS NULL OR id <> CAST(:exclude AS uuid))
        LIMIT 1
        """,
        {"tenant_id": tenant_id, "name": name, "exclude": exclude},
    )
    return row is not None


def _duplicate_name() -> AppError:
    return AppError(409, "DUPLICATE_NAME", "A data model with this name already exists.", field_errors=[{"path": "name", "code": "DUPLICATE"}])


async def _model_row(session: AsyncSession, tenant_id: UUID, model_id: UUID, *, lock: bool = False) -> dict[str, Any]:
    row = await fetch_one(
        session,
        f"""
        SELECT id, tenant_id, display_name, description, sample_ms, state, status, version, spec_json, created_at, updated_at
        FROM output_groups
        WHERE id = :id AND tenant_id = :tenant_id AND status <> 'ARCHIVED'
        {"FOR UPDATE" if lock else ""}
        """,
        {"id": model_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Data model not found.")
    return row


def _spec_error(issues: list[dict[str, Any]]) -> AppError:
    errors = [item for item in issues if item.get("severity", "error") == "error"]
    first = errors[0] if errors else {"message": "The body definition is invalid."}
    return AppError(
        422,
        "INVALID_SPEC",
        f"{len(errors)} problem(s) in the body definition. First: {first.get('path') or 'body'}: {first['message']}",
        field_errors=errors,
    )


def involved(stored: dict[str, Any], catalog: R.Catalog) -> tuple[list[str], list[str], int]:
    """(machine names, machine ids, reference count) of a stored spec.

    A referenced resource counts as its nearest machine (itself or an ancestor), else as itself.
    """
    signals, resources = B.spec_refs(stored)
    owners: list[str] = []
    for sid in sorted(signals):
        sig = catalog.signal(sid)
        if sig is not None:
            owners.append(sig.resource_id)
    owners.extend(sorted(resources))
    machines: dict[str, str] = {}
    for rid in owners:
        res = catalog.resource(rid)
        if res is None:
            continue
        machine = catalog.nearest_of_type(rid, "machine") or res
        machines.setdefault(machine.id, machine.name)
    ordered = sorted(machines.items(), key=lambda item: (item[1].lower(), item[0]))
    return [name for _id, name in ordered], [mid for mid, _name in ordered], len(signals) + len(resources)


async def _write_refs(session: AsyncSession, tenant_id: UUID, model_id: UUID, stored: dict[str, Any]) -> None:
    signals, resources = B.spec_refs(stored)
    await execute(session, "DELETE FROM model_refs WHERE model_id = :id", {"id": model_id})
    pairs = [("signal", s) for s in sorted(signals)] + [("resource", r) for r in sorted(resources)]
    if not pairs:
        return
    await execute(
        session,
        """
        INSERT INTO model_refs (model_id, tenant_id, ref_kind, ref_id)
        SELECT CAST(:model_id AS uuid), CAST(:tenant_id AS uuid), t.kind, t.ref
        FROM unnest(CAST(:kinds AS text[]), CAST(:refs AS uuid[])) AS t(kind, ref)
        ON CONFLICT DO NOTHING
        """,
        {"model_id": model_id, "tenant_id": tenant_id, "kinds": [k for k, _ in pairs], "refs": [UUID(r) for _, r in pairs]},
    )


async def _signal_meta(session: AsyncSession, signal_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    ids = E._uuids(signal_ids)
    if not ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT DISTINCT ON (b.signal_id) b.signal_id, c.id AS connection_id, c.name AS connection_name, c.protocol
        FROM signal_bindings b
        JOIN source_fields f ON f.id = b.source_field_id
        JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
        JOIN connections c ON c.id = j.connection_id
        WHERE b.signal_id = ANY(:ids) AND b.valid_to IS NULL
        ORDER BY b.signal_id, b.enabled DESC, b.valid_from DESC
        """,
        {"ids": ids},
    )
    return {
        str(row["signal_id"]).lower(): {
            "connection_id": str(row["connection_id"]),
            "connection_name": row.get("connection_name"),
            "protocol": row.get("protocol"),
        }
        for row in rows
    }


def _latest_out(row: dict[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {"body": None, "sampled_at": None, "errors": []}
    errors = E._json(row.get("errors_json"))
    return {"body": row.get("body_text"), "sampled_at": iso_ms(row.get("sampled_at")), "errors": errors if isinstance(errors, list) else []}


async def signal_states(session: AsyncSession, tenant_id: UUID, signal_ids: Iterable[str]) -> dict[str, B.SignalStatus]:
    """Effective status (GOOD / STALE / PAUSED / …, canonical rules of signal_state) of each signal (R4-DM-08)."""
    ids = E._uuids(signal_ids)
    if not ids:
        return {}
    rows = await fetch_all(
        session,
        """
        SELECT s.id AS signal_id, s.status AS signal_status, s.expected_interval_ms,
               l.signal_id AS has_obs, l.quality, l.value_json, l.event_time, l.received_time,
               l.last_good_value_json, l.last_good_event_time,
               nb.nullable, nb.enabled, nb.connection_status, nb.connection_id, nb.connection_name
        FROM signal_definitions s
        LEFT JOIN latest_signal_state l ON l.tenant_id = s.tenant_id AND l.signal_id = s.id
        LEFT JOIN LATERAL (
            SELECT COALESCE((f.address_json->>'nullable') = 'true', FALSE) AS nullable, b.enabled,
                   c.status AS connection_status, c.id AS connection_id, c.name AS connection_name
            FROM signal_bindings b
            JOIN source_fields f ON f.id = b.source_field_id
            LEFT JOIN acquisition_jobs j ON j.id = f.acquisition_job_id
            LEFT JOIN connections c ON c.id = j.connection_id
            WHERE b.signal_id = s.id AND b.valid_to IS NULL
            ORDER BY b.enabled DESC, b.valid_from DESC
            LIMIT 1
        ) nb ON TRUE
        WHERE s.tenant_id = :tenant_id AND s.id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": ids},
    )
    now = utcnow()
    out: dict[str, B.SignalStatus] = {}
    for row in rows:
        value_json = E._json(row.get("value_json"))
        good_json = E._json(row.get("last_good_value_json"))
        result = evaluate_signal_state(
            has_observation=row.get("has_obs") is not None,
            raw_quality=row.get("quality"),
            raw_value=value_json.get("v") if isinstance(value_json, dict) else None,
            event_time=row.get("event_time"),
            last_acquired_at=row.get("received_time"),
            expected_interval_ms=row.get("expected_interval_ms"),
            last_good_value=good_json.get("v") if isinstance(good_json, dict) else None,
            last_good_time=row.get("last_good_event_time"),
            null_allowed=bool(row.get("nullable")),
            binding_enabled=row.get("enabled") is not False and str(row.get("signal_status") or "ACTIVE") == "ACTIVE",
            connection_paused=str(row.get("connection_status") or "") == "PAUSED",
            now=now,
        )
        out[str(row["signal_id"]).lower()] = B.SignalStatus(
            status=result.effective_status,
            reason=result.reason_code,
            connection_id=str(row["connection_id"]) if row.get("connection_id") else None,
            connection_name=row.get("connection_name"),
        )
    return out


async def _quality_of(session: AsyncSession, tenant_id: UUID, compiled: B.CompiledSpec, catalog: R.Catalog) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    states = await signal_states(session, tenant_id, compiled.signal_ids)
    return B.field_qualities(compiled, states, catalog)


def _summary(row: dict[str, Any], catalog: R.Catalog, state_row: dict[str, Any] | None) -> dict[str, Any]:
    stored = _spec_of(row)
    machines, machine_ids, ref_count = involved(stored, catalog)
    return {
        "id": str(row["id"]),
        "name": row["display_name"],
        "description": row.get("description") or "",
        "sample_ms": int(row.get("sample_ms") or E.DEFAULT_SAMPLE_MS),
        "state": row.get("state") or "RUNNING",
        "version": int(row.get("version") or 1),
        "field_count": B.field_count(stored),
        "ref_count": ref_count,
        "machines": machines,
        "machine_ids": machine_ids,
        "created_at": iso_ms(row.get("created_at")),
        "updated_at": iso_ms(row.get("updated_at")),
        "last_sampled_at": iso_ms(state_row.get("sampled_at")) if state_row else None,
        "error_count": int(state_row.get("error_count") or 0) if state_row else 0,
    }


def _changed(session: AsyncSession, tenant_id: UUID, model_id: UUID) -> None:
    E.notify_changed(session, tenant_id, model_id)


# ============================================================================================
# Read
# ============================================================================================


async def list_models(session: AsyncSession, tenant_id: UUID, *, q: str | None = None, state: str | None = None, machine: str | None = None) -> list[dict[str, Any]]:
    rows = await fetch_all(
        session,
        """
        SELECT g.id, g.display_name, g.description, g.sample_ms, g.state, g.version, g.spec_json, g.created_at, g.updated_at,
               s.body_text, s.sampled_at, s.error_count
        FROM output_groups g
        LEFT JOIN model_state s ON s.group_id = g.id
        WHERE g.tenant_id = :tenant_id AND g.status <> 'ARCHIVED'
        ORDER BY lower(g.display_name), g.id
        """,
        {"tenant_id": tenant_id},
    )
    catalog = await E.load_catalog(session, tenant_id)
    needle = (q or "").strip().lower()
    wanted_state = (state or "").strip().upper()
    machine_filter = (machine or "").strip().lower()
    out: list[dict[str, Any]] = []
    for row in rows:
        item = _summary(row, catalog, row if row.get("sampled_at") else None)
        if needle and needle not in item["name"].lower() and needle not in item["description"].lower():
            continue
        if wanted_state and item["state"] != wanted_state:
            continue
        if machine_filter and machine_filter not in {m.lower() for m in item["machines"]} | {m.lower() for m in item["machine_ids"]}:
            continue
        item["body"] = row.get("body_text")
        out.append(item)
    return out


async def get_model(session: AsyncSession, tenant_id: UUID, model_id: UUID) -> dict[str, Any]:
    row = await _model_row(session, tenant_id, model_id)
    catalog = await E.load_catalog(session, tenant_id)
    state_row = await fetch_one(session, "SELECT body_text, sampled_at, errors_json, error_count FROM model_state WHERE group_id = :id", {"id": model_id})
    stored = _spec_of(row)
    signals, _resources = B.spec_refs(stored)
    rendered, issues = B.render_spec(stored, catalog, await _signal_meta(session, signals))
    out = _summary(row, catalog, state_row)
    out["spec"] = rendered
    out["issues"] = issues
    out["latest"] = _latest_out(state_row)
    out["latest"]["fields"], out["latest"]["quality"] = await _quality_of(session, tenant_id, B.compile_spec(stored), catalog)
    return out


async def latest(session: AsyncSession, tenant_id: UUID, model_id: UUID) -> dict[str, Any]:
    """Latest body + per-field data quality (good / stale / paused / missing …) of its sources."""
    model = await _model_row(session, tenant_id, model_id)
    row = await fetch_one(session, "SELECT body_text, sampled_at, errors_json FROM model_state WHERE group_id = :id", {"id": model_id})
    out = _latest_out(row)
    compiled = B.compile_spec(_spec_of(model))
    catalog = await E.load_catalog(session, tenant_id, compiled.signal_ids)
    out["fields"], out["quality"] = await _quality_of(session, tenant_id, compiled, catalog)
    return out


async def snapshots(session: AsyncSession, tenant_id: UUID, model_id: UUID, *, limit: int = 20) -> list[dict[str, Any]]:
    await _model_row(session, tenant_id, model_id)
    rows = await fetch_all(
        session,
        """
        SELECT sampled_at, body_text, errors_json, error_count FROM model_snapshots
        WHERE group_id = :id ORDER BY id DESC LIMIT :limit
        """,
        {"id": model_id, "limit": min(max(int(limit), 1), SNAPSHOT_LIMIT)},
    )
    out = []
    for row in rows:
        errors = E._json(row.get("errors_json"))
        out.append(
            {
                "sampled_at": iso_ms(row["sampled_at"]),
                "body": row["body_text"],
                "errors": errors if isinstance(errors, list) else [],
                "error_count": int(row.get("error_count") or 0),
            }
        )
    return out


# ============================================================================================
# Write
# ============================================================================================


async def _insert(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    name: str,
    description: str,
    sample_ms: int,
    state: str,
    stored: dict[str, Any],
) -> UUID:
    model_id = uuid4()
    now = utcnow()
    try:
        await execute(
            session,
            """
            INSERT INTO output_groups (
                id, tenant_id, resource_id, key, display_name, topic_template, projection_policy_json, version, status,
                kind, emit_policy_json, created_at, updated_at, spec_json, sample_ms, state, description
            ) VALUES (
                :id, :tenant_id, NULL, :key, :name, '', CAST('{}' AS jsonb), 1, 'ACTIVE',
                'STATE', CAST(:emit AS jsonb), :now, :now, CAST(:spec AS jsonb), :sample_ms, :state, :description
            )
            """,
            {
                "id": model_id,
                "tenant_id": tenant_id,
                "key": f"dm-{model_id.hex[:12]}",
                "name": name,
                "emit": jsonb(_DEFAULT_EMIT),
                "now": now,
                "spec": jsonb(stored),
                "sample_ms": sample_ms,
                "state": state,
                "description": description,
            },
        )
    except IntegrityError as exc:
        raise _duplicate_name() from exc
    await _write_refs(session, tenant_id, model_id, stored)
    return model_id


async def create_model(session: AsyncSession, tenant_id: UUID, actor: UUID, body: DataModelIn, correlation_id: str) -> dict[str, Any]:
    name = _name(body.name)
    sample_ms = _sample_ms(body.sample_ms)
    state = _state(body.state)
    description = _description(body.description)
    catalog = await E.load_catalog(session, tenant_id)
    stored, issues = B.resolve_spec(body.spec, catalog)
    if B.has_errors(issues):
        raise _spec_error(issues)
    if await _name_taken(session, tenant_id, name):
        raise _duplicate_name()
    model_id = await _insert(session, tenant_id, name=name, description=description, sample_ms=sample_ms, state=state, stored=stored)
    await audit(
        session,
        tenant_id=tenant_id,
        event_type="DATA_MODEL_CREATED",
        actor_id=actor,
        entity_type="data_model",
        entity_id=model_id,
        before=None,
        after={"name": name, "sample_ms": sample_ms, "state": state, "fields": B.field_count(stored)},
        correlation_id=correlation_id,
    )
    _changed(session, tenant_id, model_id)
    return await get_model(session, tenant_id, model_id)


def _version_conflict(current: int) -> AppError:
    return AppError(
        409,
        "VERSION_CONFLICT",
        "This model was changed by someone else. Reload it and try again.",
        extra={"current_version": current},
    )


async def patch_model(session: AsyncSession, tenant_id: UUID, actor: UUID, model_id: UUID, body: DataModelPatch, correlation_id: str) -> dict[str, Any]:
    current = await _model_row(session, tenant_id, model_id, lock=True)
    if int(current["version"]) != body.version:
        raise _version_conflict(int(current["version"]))
    name = _name(body.name) if body.name is not None else current["display_name"]
    if name.lower() != str(current["display_name"]).lower() and await _name_taken(session, tenant_id, name, exclude=model_id):
        raise _duplicate_name()
    sample_ms = _sample_ms(body.sample_ms) if body.sample_ms is not None else int(current["sample_ms"])
    description = _description(body.description) if body.description is not None else (current.get("description") or "")
    stored = _spec_of(current)
    if body.spec is not None:
        catalog = await E.load_catalog(session, tenant_id)
        stored, issues = B.resolve_spec(body.spec, catalog, B.refresh_labels(stored.get("labels") or {}, catalog))
        if B.has_errors(issues):
            raise _spec_error(issues)
    try:
        updated = await execute_rowcount(
            session,
            """
            UPDATE output_groups
            SET display_name = :name, description = :description, sample_ms = :sample_ms, spec_json = CAST(:spec AS jsonb),
                version = version + 1, updated_at = :now
            WHERE id = :id AND tenant_id = :tenant_id AND version = :version AND status <> 'ARCHIVED'
            """,
            {
                "name": name,
                "description": description,
                "sample_ms": sample_ms,
                "spec": jsonb(stored),
                "now": utcnow(),
                "id": model_id,
                "tenant_id": tenant_id,
                "version": body.version,
            },
        )
    except IntegrityError as exc:
        raise _duplicate_name() from exc
    if updated != 1:
        raise _version_conflict(int(current["version"]))
    if body.spec is not None:
        await _write_refs(session, tenant_id, model_id, stored)
    await audit(
        session,
        tenant_id=tenant_id,
        event_type="DATA_MODEL_UPDATED",
        actor_id=actor,
        entity_type="data_model",
        entity_id=model_id,
        before={"version": int(current["version"]), "name": current["display_name"], "sample_ms": int(current["sample_ms"])},
        after={"version": int(current["version"]) + 1, "name": name, "sample_ms": sample_ms, "spec_changed": body.spec is not None},
        correlation_id=correlation_id,
    )
    _changed(session, tenant_id, model_id)
    return await get_model(session, tenant_id, model_id)


async def _archive(session: AsyncSession, tenant_id: UUID, actor: UUID | None, row: dict[str, Any], correlation_id: str, *, reason: str | None = None) -> None:
    await execute(
        session,
        "UPDATE output_groups SET status = 'ARCHIVED', version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
        {"now": utcnow(), "id": row["id"], "tenant_id": tenant_id},
    )
    await execute(session, "DELETE FROM model_snapshots WHERE group_id = :id", {"id": row["id"]})
    await execute(session, "DELETE FROM model_state WHERE group_id = :id", {"id": row["id"]})
    await audit(
        session,
        tenant_id=tenant_id,
        event_type="DATA_MODEL_DELETED",
        actor_id=actor,
        entity_type="data_model",
        entity_id=as_uuid(row["id"]),
        before={"name": row["display_name"], "state": row.get("state"), "version": int(row["version"])},
        after={"status": "ARCHIVED", **({"reason": reason} if reason else {})},
        correlation_id=correlation_id,
    )
    _changed(session, tenant_id, as_uuid(row["id"]))


async def delete_model(session: AsyncSession, tenant_id: UUID, actor: UUID, model_id: UUID, correlation_id: str, *, version: int | None = None) -> dict[str, Any]:
    current = await _model_row(session, tenant_id, model_id, lock=True)
    if version is not None and int(current["version"]) != version:
        raise _version_conflict(int(current["version"]))
    await _archive(session, tenant_id, actor, current, correlation_id)
    return {"id": str(model_id), "deleted": True}


async def set_state(session: AsyncSession, tenant_id: UUID, actor: UUID, model_id: UUID, state: str, body: StateChangeIn | None, correlation_id: str) -> dict[str, Any]:
    current = await _model_row(session, tenant_id, model_id, lock=True)
    if body is not None and body.version is not None and int(current["version"]) != body.version:
        raise _version_conflict(int(current["version"]))
    if current["state"] != state:
        await execute(
            session,
            "UPDATE output_groups SET state = :state, version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
            {"state": state, "now": utcnow(), "id": model_id, "tenant_id": tenant_id},
        )
        await audit(
            session,
            tenant_id=tenant_id,
            event_type="DATA_MODEL_PAUSED" if state == "PAUSED" else "DATA_MODEL_RESUMED",
            actor_id=actor,
            entity_type="data_model",
            entity_id=model_id,
            before={"state": current["state"], "version": int(current["version"])},
            after={"state": state, "version": int(current["version"]) + 1},
            correlation_id=correlation_id,
        )
        _changed(session, tenant_id, model_id)
    return await get_model(session, tenant_id, model_id)


# ============================================================================================
# Validate / preview
# ============================================================================================


async def _labels_of(session: AsyncSession, tenant_id: UUID, model_id: str | None, catalog: R.Catalog) -> dict[str, str]:
    if not model_id:
        return {}
    row = await fetch_one(
        session,
        "SELECT spec_json FROM output_groups WHERE id = :id AND tenant_id = :tenant_id",
        {"id": parse_uuid(model_id), "tenant_id": tenant_id},
    )
    # Refreshed like the rendered spec, so a typed $⚠missing[<current label>] maps back (R4-DM-12).
    return B.refresh_labels(_spec_of(row).get("labels") or {}, catalog) if row else {}


async def validate(session: AsyncSession, tenant_id: UUID, body: SpecIn) -> dict[str, Any]:
    catalog = await E.load_catalog(session, tenant_id)
    stored, issues = B.resolve_spec(body.spec, catalog, await _labels_of(session, tenant_id, body.model_id, catalog))
    signals, _resources = B.spec_refs(stored)
    rendered, _missing = B.render_spec(stored, catalog, await _signal_meta(session, signals))
    machines, machine_ids, ref_count = involved(stored, catalog)
    return {
        "valid": not B.has_errors(issues),
        "errors": issues,
        "spec": rendered,
        "field_count": B.field_count(stored),
        "ref_count": ref_count,
        "machines": machines,
        "machine_ids": machine_ids,
    }


_preview_states: OrderedDict[tuple[str, str], tuple[float, dict[Any, Any]]] = OrderedDict()


def _preview_state(tenant_id: UUID, session_id: str | None) -> R.FilterState:
    if not session_id:
        return R.FilterState()
    now = time.monotonic()
    for key in [k for k, (used, _s) in _preview_states.items() if now - used > PREVIEW_TTL_S]:
        _preview_states.pop(key, None)
    key = (str(tenant_id), session_id)
    _used, base = _preview_states.get(key, (now, {}))
    _preview_states[key] = (now, base)
    _preview_states.move_to_end(key)
    while len(_preview_states) > PREVIEW_SESSIONS:
        _preview_states.popitem(last=False)
    return R.FilterState(base)


async def preview(session: AsyncSession, tenant_id: UUID, body: SpecIn) -> dict[str, Any]:
    """Evaluate an unsaved spec once against current data (the editor's live preview)."""
    now = utcnow()
    catalog = await E.load_catalog(session, tenant_id)
    stored, issues = B.resolve_spec(body.spec, catalog, await _labels_of(session, tenant_id, body.model_id, catalog))
    if any(item["code"] == "INVALID_SPEC" for item in issues):
        return {"body": None, "sampled_at": iso_ms(now), "errors": issues, "fields": [], "quality": None}
    compiled = B.compile_spec(stored)
    result = await E.evaluate_once(session, tenant_id, compiled, catalog, now, _preview_state(tenant_id, body.session_id))
    blocking: dict[str, dict[str, Any]] = {}
    for item in issues:
        if item.get("severity", "error") == "error":
            blocking.setdefault(item["path"], item)
    errors = [item for item in issues if item.get("severity", "error") == "error"]
    errors.extend(err for err in result.errors if err["path"] not in blocking)
    quality_rows, quality = await _quality_of(session, tenant_id, compiled, catalog)
    fields = []
    for row, q in zip(result.fields, quality_rows):
        if row["path"] in blocking:
            row = {**row, "value": None, "error": blocking[row["path"]]["message"]}
        fields.append({**row, "quality": q["quality"], "quality_reason": q.get("reason")})
    return {"body": result.text, "sampled_at": iso_ms(now), "errors": errors, "fields": fields, "quality": quality}


def functions() -> dict[str, Any]:
    return {"functions": R.function_catalog(), "examples": R.EXAMPLES}


# ============================================================================================
# Duplicate (with retargeting)
# ============================================================================================


def _relative_path(catalog: R.Catalog, ancestor_id: str, resource_id: str) -> list[R.ResourceInfo] | None:
    """Resources from just below ``ancestor_id`` down to ``resource_id``; None when not below it."""
    if resource_id == ancestor_id:
        return []
    chain: list[R.ResourceInfo] = []
    for item in catalog.lineage(resource_id):
        if item.id == ancestor_id:
            return list(reversed(chain))
        chain.append(item)
    return None


def _follow(catalog: R.Catalog, start_id: str, path: list[R.ResourceInfo]) -> R.ResourceInfo | None:
    current = catalog.resource(start_id)
    for step in path:
        if current is None:
            return None
        kids = [r for r in catalog.children(current.id) if r.active and r.type_key == step.type_key]
        match = [r for r in kids if r.name == step.name] or [r for r in kids if r.code == step.code]
        current = match[0] if len(match) == 1 else None
    return current


def retarget_plan(stored: dict[str, Any], catalog: R.Catalog, pairs: list[tuple[str, str]]) -> tuple[dict[str, str], list[dict[str, Any]], int]:
    """Token mapping for re-pointing references from resource A to B (pure).

    Returns ``(mapping, unmatched, replaced)``; ``mapping`` is ``{"sig:<old>": "<new>", "res:<old>": "<new>"}``.
    """
    mapping: dict[str, str] = {}
    unmatched: list[dict[str, Any]] = []
    by_ref: dict[str, dict[str, Any]] = {}  # one entry per unmatched reference, listing every field using it (R4-DM-15)
    labels = stored.get("labels") or {}

    def miss(key: str, path: str, node: dict[str, Any], label: str, reason: str) -> None:
        entry = by_ref.get(key)
        if entry is None:
            entry = {"path": path, **({"node_id": node["id"]} if node.get("id") else {}), "ref": label, "reason": reason, "paths": [], "count": 0}
            by_ref[key] = entry
            unmatched.append(entry)
        if path not in entry["paths"]:
            entry["paths"].append(path)
            entry["count"] = len(entry["paths"])

    failed: set[str] = set()
    for path_parts, node in B.iter_fields(stored):
        path = B.pointer(path_parts)
        if node.get("mode") == "mapping":
            sid = (node.get("ref") or {}).get("signal_id")
            tokens = [("sig", sid)] if sid else []
        else:
            tokens = [(t.kind, t.id) for t in R.token_refs(str(node.get("expr") or ""))]
        for kind, ident in tokens:
            key = f"{kind}:{ident}"
            if key in mapping:
                continue
            if key in failed:
                miss(key, path, node, by_ref[key]["ref"], by_ref[key]["reason"])
                continue
            owner = catalog.signal(ident).resource_id if kind == "sig" and catalog.signal(ident) else (ident if kind == "res" else None)
            if owner is None:
                continue
            for source, target in pairs:
                rel = _relative_path(catalog, source, owner)
                if rel is None:
                    continue
                target_res = _follow(catalog, target, rel)
                label = R.current_label(catalog, kind, ident) or labels.get(key) or key
                target_info = catalog.resource(target)
                target_name = target_info.name if target_info else target
                if target_res is None:
                    miss(key, path, node, label, f"No resource {' › '.join(r.name for r in rel)} under {target_name}")
                    failed.add(key)
                    break
                if kind == "res":
                    mapping[key] = target_res.id
                    break
                sig = catalog.signal(ident)
                assert sig is not None
                new = catalog.signal_by_key(target_res.id, sig.key)
                if new is None:
                    miss(key, path, node, label, f"No signal '{sig.key}' under {target_res.name}")
                    failed.add(key)
                else:
                    mapping[key] = new.id
                break
    return mapping, unmatched, len(mapping)


def copy_name(name: str, source_name: str | None, target_name: str | None) -> str:
    if target_name is None:
        return f"{name} (copy)"
    if source_name and source_name in name:
        return name.replace(source_name, target_name)
    return f"{name} - {target_name}"


async def _free_name(session: AsyncSession, tenant_id: UUID, base: str, reserved: set[str]) -> str:
    name, n = base[:MAX_NAME_LEN], 2
    while name.lower() in reserved or await _name_taken(session, tenant_id, name):
        name = f"{base[: MAX_NAME_LEN - 6]} ({n})"
        n += 1
    reserved.add(name.lower())
    return name


async def duplicate(session: AsyncSession, tenant_id: UUID, actor: UUID, model_id: UUID, body: DuplicateIn, correlation_id: str) -> dict[str, Any]:
    source = await _model_row(session, tenant_id, model_id)
    catalog = await E.load_catalog(session, tenant_id)
    stored = _spec_of(source)
    extra = [(str(parse_uuid(p.from_resource_id)), str(parse_uuid(p.to_resource_id))) for p in body.retarget]
    for _from, to in extra:
        if not catalog.resource_live(to):
            raise AppError(422, "INVALID_TARGET", "A retarget resource does not exist or is archived.")
    targets = [str(parse_uuid(t)) for t in dict.fromkeys(body.targets)]
    if len(targets) > MAX_TARGETS:
        raise AppError(422, "LIMIT", f"Duplicate to at most {MAX_TARGETS} resources at once.")
    state = _state(body.state, default=source.get("state") or "RUNNING")
    plans: list[tuple[str | None, list[tuple[str, str]], str | None]] = []  # (target id, pairs, explicit name)
    source_name: str | None = None
    if targets:
        if body.source_resource_id:
            source_resource = str(parse_uuid(body.source_resource_id))
        else:
            _machines, machine_ids, _n = involved(stored, catalog)
            if len(machine_ids) != 1:
                raise AppError(
                    422,
                    "SOURCE_REQUIRED",
                    "This model uses several machines; choose which one each target replaces.",
                    field_errors=[{"path": "source_resource_id", "code": "REQUIRED"}],
                )
            source_resource = machine_ids[0]
        src = catalog.resource(source_resource)
        source_name = src.name if src else None
        for target in targets:
            if not catalog.resource_live(target):
                raise AppError(422, "INVALID_TARGET", "A target resource does not exist or is archived.")
            plans.append((target, [(source_resource, target), *extra], None))
    else:
        plans.append((None, extra, body.name.strip() if body.name and body.name.strip() else None))
    reserved: set[str] = set()
    created: list[dict[str, Any]] = []
    for target, pairs, explicit in plans:
        mapping, unmatched, replaced = retarget_plan(stored, catalog, pairs)
        skipped = bool(body.skip_unmatched and target is not None and unmatched)
        copy_spec = B.retarget_spec(stored, mapping)
        copy_spec, _issues = B.resolve_spec(copy_spec, catalog, stored.get("labels") or {})
        target_info = catalog.resource(target) if target else None
        if explicit is not None:
            name = _name(explicit)
            if name.lower() in reserved or await _name_taken(session, tenant_id, name):
                raise _duplicate_name()
            reserved.add(name.lower())
        else:
            name = await _free_name(session, tenant_id, copy_name(source["display_name"], source_name, target_info.name if target_info else None), reserved)
        new_id: UUID | None = None
        if skipped:
            reserved.discard(name.lower())
        if not body.dry_run and not skipped:
            new_id = await _insert(
                session,
                tenant_id,
                name=name,
                description=source.get("description") or "",
                sample_ms=int(source["sample_ms"]),
                state=state,
                stored=copy_spec,
            )
            await audit(
                session,
                tenant_id=tenant_id,
                event_type="DATA_MODEL_DUPLICATED",
                actor_id=actor,
                entity_type="data_model",
                entity_id=new_id,
                before={"source_id": str(model_id), "name": source["display_name"]},
                after={"name": name, "target_resource_id": target, "replaced": replaced, "unmatched": len(unmatched)},
                correlation_id=correlation_id,
            )
            _changed(session, tenant_id, new_id)
        created.append(
            {
                "id": str(new_id) if new_id else None,
                "name": name,
                "target_resource_id": target,
                "replaced": replaced,
                "unmatched": unmatched,
                "unmatched_fields": sum(int(u.get("count") or 1) for u in unmatched),
                "skipped": skipped,
            }
        )
    return {"created": created}


# ============================================================================================
# Catalog (signal picker tree)
# ============================================================================================


async def catalog_tree(session: AsyncSession, tenant_id: UUID, *, resource_id: str | None = None, q: str | None = None) -> dict[str, Any]:
    catalog = await E.load_catalog(session, tenant_id)
    type_rows = await fetch_all(session, "SELECT key, name FROM resource_types WHERE tenant_id = :tenant_id ORDER BY key", {"tenant_id": tenant_id})
    type_names = {str(r["key"]): str(r["name"]) for r in type_rows}
    active = [r for r in catalog.resources.values() if r.active]
    if resource_id:
        root = str(parse_uuid(resource_id))
        if not catalog.resource_live(root):
            raise AppError(404, "NOT_FOUND", "Resource not found.")
        scope = {root} | {r.id for r in catalog.descendants(root) if r.active}
    else:
        scope = {r.id for r in active}
    needle = (q or "").strip().lower()
    signals_by_res: dict[str, list[R.SignalInfo]] = {}
    for rid in scope:
        sigs = catalog.signals_of(rid)
        if needle:
            res = catalog.resource(rid)
            res_hit = res is not None and (needle in res.name.lower() or needle in res.code.lower())
            sigs = sigs if res_hit else [s for s in sigs if needle in s.key.lower() or needle in s.name.lower()]
        if sigs:
            signals_by_res[rid] = sorted(sigs, key=lambda s: s.key)
    include = set(signals_by_res)
    if not needle:
        include |= scope
    for rid in list(include):
        include |= {a.id for a in catalog.ancestors(rid)}
    all_signal_ids = [s.id for sigs in signals_by_res.values() for s in sigs]
    samples, qualities = await E.load_samples(session, tenant_id, all_signal_ids)
    meta = await _signal_meta(session, all_signal_ids)
    latest_rows = await fetch_all(
        session,
        "SELECT signal_id, source_time, received_time FROM latest_signal_state WHERE tenant_id = :tenant_id AND signal_id = ANY(:ids)",
        {"tenant_id": tenant_id, "ids": E._uuids(all_signal_ids)},
    ) if all_signal_ids else []
    times = {str(r["signal_id"]).lower(): r for r in latest_rows}
    resources_out = []
    ordered = [r for r in (catalog.resource(rid) for rid in include) if r is not None and r.active]
    for res in sorted(ordered, key=lambda r: (len(catalog.ancestors(r.id)), r.name.lower(), r.id)):
        sigs = signals_by_res.get(res.id, []) if res.id in scope else []
        signal_rows = []
        for sig in sigs:
            sample = samples.get(sig.id)
            info = meta.get(sig.id, {})
            t = times.get(sig.id, {})
            signal_rows.append(
                {
                    "id": sig.id,
                    "key": sig.key,
                    "name": sig.name,
                    "data_type": "boolean" if sig.data_type == "bool" else sig.data_type,
                    "unit": sig.unit,
                    "ref": catalog.signal_text(sig.id),
                    "value": None if sample is None else sample.value,
                    "quality": qualities.get(sig.id),
                    "source_time": iso_ms(t.get("source_time")) if t else None,
                    "received_time": iso_ms(t.get("received_time")) if t else None,
                    "protocol": info.get("protocol"),
                    "connection_id": info.get("connection_id"),
                    "connection_name": info.get("connection_name"),
                }
            )
        resources_out.append(
            {
                "id": res.id,
                "parent_id": res.parent_id,
                "type_key": res.type_key,
                "type_name": type_names.get(res.type_key, res.type_key),
                "name": res.name,
                "code": res.code,
                "path": catalog.path_names(res.id),
                "ref": catalog.resource_path_text(res.id),
                "signal_count": len(catalog.signals_of(res.id)),
                "signals": signal_rows,
            }
        )
    return {"types": [{"key": k, "name": v} for k, v in type_names.items()], "resources": resources_out}


# ============================================================================================
# Usage (impact of disabling/deleting signals and archiving resources)
# ============================================================================================


def _usage_out(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"id": str(r["id"]), "name": r["display_name"], "display_name": r["display_name"], "status": r["state"], "state": r["state"]}
        for r in rows
    ]


async def models_using_signals(session: AsyncSession, tenant_id: UUID, signal_ids: Iterable[Any]) -> list[dict[str, Any]]:
    ids = E._uuids(signal_ids)
    if not ids:
        return []
    rows = await fetch_all(
        session,
        """
        SELECT DISTINCT g.id, g.display_name, g.state
        FROM model_refs r JOIN output_groups g ON g.id = r.model_id
        WHERE r.tenant_id = :tenant_id AND r.ref_kind = 'signal' AND r.ref_id = ANY(:ids) AND g.status = 'ACTIVE'
        ORDER BY g.display_name, g.id
        """,
        {"tenant_id": tenant_id, "ids": ids},
    )
    return _usage_out(rows)


async def models_using_resource(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> list[dict[str, Any]]:
    """Models referencing the resource, a descendant, or a signal of either."""
    rows = await fetch_all(
        session,
        """
        WITH RECURSIVE tree (id, depth) AS (
            SELECT CAST(:resource_id AS uuid), 0
            UNION ALL
            SELECT r.id, tree.depth + 1 FROM resources r JOIN tree ON r.parent_id = tree.id
            WHERE r.tenant_id = :tenant_id AND tree.depth < 32
        ),
        targets AS (
            SELECT 'resource' AS kind, id FROM tree
            UNION ALL
            SELECT 'signal', s.id FROM signal_definitions s JOIN tree ON s.resource_id = tree.id
        )
        SELECT DISTINCT g.id, g.display_name, g.state
        FROM targets t
        JOIN model_refs r ON r.tenant_id = :tenant_id AND r.ref_kind = t.kind AND r.ref_id = t.id
        JOIN output_groups g ON g.id = r.model_id AND g.status = 'ACTIVE'
        ORDER BY g.display_name, g.id
        """,
        {"tenant_id": tenant_id, "resource_id": resource_id},
    )
    return _usage_out(rows)


async def archive_models(session: AsyncSession, tenant_id: UUID, actor: UUID | None, models: list[dict[str, Any]], correlation_id: str, *, reason: str | None = None) -> list[dict[str, Any]]:
    """Archive (soft delete) the given models, as DELETE /data-models/{id} does."""
    out: list[dict[str, Any]] = []
    for model in sorted(models, key=lambda m: str(m["id"])):
        row = await fetch_one(
            session,
            "SELECT id, display_name, state, version FROM output_groups WHERE id = :id AND tenant_id = :tenant_id AND status <> 'ARCHIVED' FOR UPDATE",
            {"id": as_uuid(model["id"]), "tenant_id": tenant_id},
        )
        if row is None:
            continue
        await _archive(session, tenant_id, actor, row, correlation_id, reason=reason)
        out.append({"id": str(row["id"]), "name": row["display_name"], "display_name": row["display_name"], "status": "ARCHIVED", "state": row["state"]})
    return out

