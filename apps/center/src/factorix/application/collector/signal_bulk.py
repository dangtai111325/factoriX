"""Signals: bulk create, bulk address, bulk properties and bulk actions. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.source_address import AddressCheck
from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.platform.errors import AppError

from factorix.application.collector.schemas import (
    SignalBulkActionIn,
    SignalBulkAddressIn,
    SignalBulkIn,
    SignalBulkPropertiesIn,
)
from factorix.application.legacy_edge.fleet import _edges_of_signals, _notify_config_changed, bump_edge_release
from factorix.application.collector.connections import _signal_type
from factorix.application.collector.signals import (
    _current_sources,
    _readdress,
    _set_binding_enabled,
    _source_view,
    check_address_change,
)


async def bulk_signals(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: SignalBulkIn,
    correlation_id: str,
) -> dict[str, Any]:
    if not body.items or len(body.items) > 500:
        raise AppError(422, "LIMIT", "Create between 1 and 500 signals at a time.")
    resource_id = parse_uuid(body.resource_id)
    resource = await fetch_one(session, "SELECT id, archived_at, site_id FROM resources WHERE id = :id AND tenant_id = :tenant_id", {"id": resource_id, "tenant_id": tenant_id})
    if resource is None:
        raise AppError(404, "NOT_FOUND", "Resource not found.")
    if resource["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Cannot add signals to an archived resource.")
    errors: list[dict[str, str]] = []
    prepared: list[dict[str, Any]] = []
    seen: set[str] = set()
    has_site_mismatch = False

    for index, item in enumerate(body.items):
        key = item.key.strip()
        if not key or len(key) > 64:
            errors.append({"path": f"items[{index}].key", "code": "INVALID"})
            continue
        if key in seen:
            errors.append({"path": f"items[{index}].key", "code": "DUPLICATE"})
            continue
        raw_type = item.data_type.lower()
        if raw_type == "float32":
            data_type = "float64"
        else:
            data_type = _signal_type(raw_type)
        if data_type not in {"bool", "int64", "float64", "string", "enum", "json"}:
            errors.append({"path": f"items[{index}].data_type", "code": "INVALID"})
            continue

        source = item.source_field
        if source:
            address = source.get("address") or {}
            native_type = str(address.get("native_type", "")).lower()
            if data_type == "string" and native_type in {"uint16", "int16", "uint32", "int32", "float32", "float64"}:
                errors.append({"path": f"items[{index}].data_type", "code": "TYPE"})
                continue
            if source.get("address_kind") == "mqtt_jsonpath":
                jp = str(address.get("jsonpath", "")).strip()
                if not jp.startswith("$"):
                    errors.append({"path": f"items[{index}].source_field.address", "code": "INVALID_JSONPATH"})
                    continue
            if source.get("acquisition_job_id"):
                job_id = parse_uuid(str(source["acquisition_job_id"]))
                job_site = await fetch_one(
                    session,
                    """
                    SELECT c.site_id FROM acquisition_jobs j
                    JOIN connections c ON c.id = j.connection_id
                    WHERE j.id = :id AND c.tenant_id = :tenant_id
                    """,
                    {"id": job_id, "tenant_id": tenant_id},
                )
                if job_site is None:
                    errors.append({"path": f"items[{index}].source_field.acquisition_job_id", "code": "JOB"})
                    continue
                if resource.get("site_id") and job_site.get("site_id") and str(resource["site_id"]) != str(job_site["site_id"]):
                    has_site_mismatch = True
                    errors.append({"path": f"items[{index}].source_field.acquisition_job_id", "code": "SITE_MISMATCH"})
                    continue

        seen.add(key)
        exists = await fetch_one(
            session,
            "SELECT id FROM signal_definitions WHERE resource_id = :resource_id AND key = :key AND status = 'ACTIVE'",
            {"resource_id": resource_id, "key": key},
        )
        if exists:
            errors.append({"path": f"items[{index}].key", "code": "DUPLICATE"})
            continue
        dumped = item.model_dump()
        dumped["data_type"] = data_type
        prepared.append(dumped)

    if errors and body.atomic:
        if has_site_mismatch:
            raise AppError(422, "SITE_MISMATCH", "Resource and connection must belong to the same site.", field_errors=errors)
        raise AppError(422, "BULK_REJECTED", "No signals were created because some rows have errors.", field_errors=errors)
    created: list[str] = []
    now = utcnow()
    # R2-SG-02: the source field ordinal keeps the order of the request (= source order chosen in the
    # wizard); every signal of one request shares created_at, so it is the only stable ordering.
    for position, item in enumerate(prepared):
        signal_id = uuid4()
        await execute(
            session,
            """
            INSERT INTO signal_definitions (
                id, tenant_id, resource_id, key, display_name, data_type, unit, category,
                expected_interval_ms, status, version, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :resource_id, :key, :display_name, :data_type, :unit, 'COLLECTED',
                :interval, 'ACTIVE', 1, :now, :now
            )
            """,
            {
                "id": signal_id,
                "tenant_id": tenant_id,
                "resource_id": resource_id,
                "key": item["key"].strip(),
                "display_name": item["name"].strip(),
                "data_type": item["data_type"],
                "unit": item["unit"],
                "interval": item["expected_interval_ms"],
                "now": now,
            },
        )
        source = item.get("source_field")
        if source:
            job_id = parse_uuid(str(source["acquisition_job_id"]))
            job = await fetch_one(
                session,
                """
                SELECT j.id FROM acquisition_jobs j
                JOIN connections c ON c.id = j.connection_id
                WHERE j.id = :id AND c.tenant_id = :tenant_id
                """,
                {"id": job_id, "tenant_id": tenant_id},
            )
            if job is None:
                raise AppError(422, "JOB", "Acquisition job does not belong to the tenant.")
            field_id = uuid4()
            await execute(
                session,
                """
                INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
                VALUES (:id, :job_id, :kind, CAST(:address AS jsonb), :native, CAST(:decode AS jsonb), :ordinal)
                """,
                {
                    "id": field_id,
                    "job_id": job_id,
                    "ordinal": position,
                    "kind": source.get("address_kind", "modbus_register"),
                    "address": jsonb(source.get("address", {})),
                    "native": source.get("address", {}).get("native_type", item["data_type"]),
                    "decode": jsonb({"scale": source.get("scale", 1), "offset": source.get("offset", 0)}),
                },
            )
            await execute(
                session,
                """
                INSERT INTO signal_bindings (id, signal_id, source_field_id, transform_chain_json, enabled, revision, valid_from)
                VALUES (:id, :signal_id, :field_id, '[]'::jsonb, TRUE, 1, :now)
                """,
                {"id": uuid4(), "signal_id": signal_id, "field_id": field_id, "now": now},
            )
        created.append(str(signal_id))
    if created:
        await bump_edge_release(session, tenant_id, actor, correlation_id)
    await audit(session, tenant_id=tenant_id, event_type="SIGNAL_BULK", actor_id=actor, entity_type="resource", entity_id=resource_id, before=None, after={"created": len(created)}, correlation_id=correlation_id)
    return {"created": created, "count": len(created)}


async def bulk_address_signals(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SignalBulkAddressIn, correlation_id: str) -> dict[str, Any]:
    """Apply an address patch to many signals at once, all or nothing (R2-SG-03).

    Every item is validated first; if any item is invalid nothing is written and the 422 lists the
    errors per item. Otherwise each changed signal is re-addressed, its version is bumped and one
    configuration release per affected edge is published so the edge applies the new addresses.
    """
    if not body.items or len(body.items) > 1000:
        raise AppError(422, "LIMIT", "Send between 1 and 1000 items.")
    item_errors: list[dict[str, Any]] = []
    ids: list[UUID | None] = []
    seen: set[UUID] = set()
    for index, item in enumerate(body.items):
        try:
            signal_id = parse_uuid(item.signal_id)
        except AppError:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "INVALID_ID", "message": "Invalid signal id."})
            ids.append(None)
            continue
        if signal_id in seen:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "DUPLICATE", "message": "The signal appears more than once."})
        seen.add(signal_id)
        ids.append(signal_id)
    known = [sid for sid in ids if sid is not None]
    signals = {
        as_uuid(row["id"]): row
        for row in await fetch_all(
            session,
            "SELECT id, version, status, data_type, display_name FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": known},
        )
    } if known else {}
    sources = await _current_sources(session, tenant_id, known)
    planned: list[tuple[UUID, dict[str, Any], dict[str, Any], AddressCheck]] = []
    for index, (item, signal_id) in enumerate(zip(body.items, ids)):
        if signal_id is None:
            continue
        signal = signals.get(signal_id)
        if signal is None:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "NOT_FOUND", "message": "Signal not found."})
            continue
        if signal["status"] != "ACTIVE":
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "ARCHIVED", "message": "Archived signals cannot be modified."})
            continue
        if int(signal["version"]) != item.version:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "version", "code": "RESOURCE_VERSION_CONFLICT", "message": "This signal was modified elsewhere. Reload it and try again."})
            continue
        check = check_address_change(signal, sources.get(signal_id), item.address_patch)
        for error in check.errors:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": f"address_patch.{error['path']}", "code": error["code"], "message": error["message"]})
        if check.ok:
            planned.append((signal_id, signal, sources[signal_id], check))
    if item_errors:
        raise AppError(
            422,
            "BULK_ADDRESS_REJECTED",
            f"No signal was changed because {len({e['index'] for e in item_errors})} item(s) have errors.",
            field_errors=[{"path": f"items[{e['index']}].{e['path']}", "code": e["code"]} for e in item_errors],
            extra={"item_errors": item_errors},
        )
    updated: list[dict[str, Any]] = []
    unchanged: list[str] = []
    edges: set[UUID] = set()
    local_changed = False
    now = utcnow()
    for signal_id, signal, source, check in planned:
        before = source.get("address_json") or {}
        if check.address == before:
            unchanged.append(str(signal_id))
            continue
        bumped = await fetch_one(
            session,
            "UPDATE signal_definitions SET version = version + 1, updated_at = :now WHERE id = :id AND tenant_id = :tenant_id AND version = :version RETURNING version",
            {"now": now, "id": signal_id, "tenant_id": tenant_id, "version": int(signal["version"])},
        )
        if bumped is None:
            raise AppError(409, "RESOURCE_VERSION_CONFLICT", "A signal was modified elsewhere during the update. Nothing was changed; reload and try again.", extra={"signal_id": str(signal_id)})
        field_id = await _readdress(session, signal_id, source, check)
        if source.get("edge_id"):
            edges.add(as_uuid(source["edge_id"]))
        else:
            local_changed = True
        await audit(session, tenant_id=tenant_id, event_type="SIGNAL_ADDRESS_UPDATE", actor_id=actor, entity_type="signal", entity_id=signal_id, before={"address": before, "version": int(signal["version"])}, after={"address": check.address, "version": int(bumped["version"]), "bulk": True}, correlation_id=correlation_id)
        updated.append({"signal_id": str(signal_id), "version": int(bumped["version"]), "source": _source_view(source, address=check.address, field_id=field_id)})
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if local_changed and not edges:
        await _notify_config_changed(session, tenant_id)
    return {"updated": updated, "unchanged": unchanged, "count": len(updated)}


BULK_PROPERTY_KEYS = ("unit", "expected_interval_ms", "round_digits")
NUMERIC_SIGNAL_TYPES = frozenset({"int64", "float64"})


async def bulk_properties_signals(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SignalBulkPropertiesIn, correlation_id: str) -> dict[str, Any]:
    """Set unit, expected interval (Stale timeout) and/or round digits on many signals at once,
    all or nothing (R4-SG-02). Runs in the request transaction: every item is validated first and a
    422 lists the errors per item; otherwise each changed signal gets one version bump and one audit
    entry, a changed rounding re-addresses the source (as the single edit does) and one configuration
    release per affected edge is published."""
    sent = [key for key in BULK_PROPERTY_KEYS if key in body.model_fields_set]
    if not sent:
        raise AppError(422, "REQUIRED", "Choose at least one property to change.")
    if not body.items or len(body.items) > 1000:
        raise AppError(422, "LIMIT", "Send between 1 and 1000 signals.")
    if "unit" in sent and body.unit is not None and len(body.unit.strip()) > 32:
        raise AppError(422, "UNIT", "Unit must be at most 32 characters.", field_errors=[{"path": "unit", "code": "LENGTH"}])
    if "expected_interval_ms" in sent and (body.expected_interval_ms is None or not 100 <= body.expected_interval_ms <= 86_400_000):
        raise AppError(422, "INTERVAL", "Expected interval must be between 100 ms and one day.", field_errors=[{"path": "expected_interval_ms", "code": "RANGE"}])
    if "round_digits" in sent and body.round_digits is not None and not 0 <= body.round_digits <= 10:
        raise AppError(422, "RANGE", "Round digits must be a whole number from 0 to 10.", field_errors=[{"path": "round_digits", "code": "RANGE"}])
    unit = (body.unit or "").strip() if "unit" in sent else None

    item_errors: list[dict[str, Any]] = []
    ids: list[UUID | None] = []
    seen: set[UUID] = set()
    for index, item in enumerate(body.items):
        try:
            signal_id = parse_uuid(item.signal_id)
        except AppError:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "INVALID_ID", "message": "Invalid signal id."})
            ids.append(None)
            continue
        if signal_id in seen:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": "signal_id", "code": "DUPLICATE", "message": "The signal appears more than once."})
        seen.add(signal_id)
        ids.append(signal_id)
    known = [sid for sid in ids if sid is not None]
    signals = {
        as_uuid(row["id"]): row
        for row in await fetch_all(
            session,
            "SELECT id, version, status, data_type, display_name, unit, expected_interval_ms FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids)",
            {"tenant_id": tenant_id, "ids": known},
        )
    } if known else {}
    sources = await _current_sources(session, tenant_id, known) if "round_digits" in sent else {}
    planned: list[tuple[UUID, dict[str, Any], AddressCheck | None]] = []
    for index, (item, signal_id) in enumerate(zip(body.items, ids)):
        if signal_id is None:
            continue
        signal = signals.get(signal_id)
        label = (signal or {}).get("display_name") or item.signal_id

        def fail(path: str, code: str, message: str) -> None:
            item_errors.append({"index": index, "signal_id": item.signal_id, "path": path, "code": code, "message": f"{label}: {message}"})

        if signal is None:
            fail("signal_id", "NOT_FOUND", "Signal not found.")
            continue
        if signal["status"] != "ACTIVE":
            fail("signal_id", "ARCHIVED", "Archived signals cannot be modified.")
            continue
        if int(signal["version"]) != item.version:
            fail("version", "RESOURCE_VERSION_CONFLICT", "This signal was modified elsewhere. Reload it and try again.")
            continue
        check: AddressCheck | None = None
        if "round_digits" in sent:
            if str(signal.get("data_type")) not in NUMERIC_SIGNAL_TYPES:
                fail("round_digits", "TYPE", "Rounding applies to numeric signals only.")
                continue
            check = check_address_change(signal, sources.get(signal_id), {"round_digits": body.round_digits})
            for error in check.errors:
                fail(error["path"], error["code"], error["message"])
            if not check.ok:
                continue
            if check.address == (sources[signal_id].get("address_json") or {}):
                check = None
        planned.append((signal_id, signal, check))
    if item_errors:
        raise AppError(
            422,
            "BULK_PROPERTIES_REJECTED",
            f"No signal was changed because {len({e['index'] for e in item_errors})} signal(s) have errors.",
            field_errors=[{"path": f"items[{e['index']}].{e['path']}", "code": e["code"]} for e in item_errors],
            extra={"item_errors": item_errors},
        )

    updated: list[dict[str, Any]] = []
    unchanged: list[str] = []
    edges: set[UUID] = set()
    local_changed = False
    now = utcnow()
    for signal_id, signal, check in planned:
        before: dict[str, Any] = {}
        after: dict[str, Any] = {}
        if unit is not None and (signal.get("unit") or "") != unit:
            before["unit"], after["unit"] = signal.get("unit"), unit
        if "expected_interval_ms" in sent and signal.get("expected_interval_ms") != body.expected_interval_ms:
            before["expected_interval_ms"], after["expected_interval_ms"] = signal.get("expected_interval_ms"), body.expected_interval_ms
        if check is not None:
            before["round_digits"] = (sources[signal_id].get("address_json") or {}).get("round_digits")
            after["round_digits"] = body.round_digits
        if not after:
            unchanged.append(str(signal_id))
            continue
        bumped = await fetch_one(
            session,
            """
            UPDATE signal_definitions
            SET unit = :unit, expected_interval_ms = :interval, version = version + 1, updated_at = :now
            WHERE id = :id AND tenant_id = :tenant_id AND version = :version RETURNING version
            """,
            {
                "unit": after.get("unit", signal.get("unit")),
                "interval": after.get("expected_interval_ms", signal.get("expected_interval_ms")),
                "now": now,
                "id": signal_id,
                "tenant_id": tenant_id,
                "version": int(signal["version"]),
            },
        )
        if bumped is None:
            raise AppError(409, "RESOURCE_VERSION_CONFLICT", "A signal was modified elsewhere during the update. Nothing was changed; reload and try again.", extra={"signal_id": str(signal_id)})
        if check is not None:
            await _readdress(session, signal_id, sources[signal_id], check)
            if sources[signal_id].get("edge_id"):
                edges.add(as_uuid(sources[signal_id]["edge_id"]))
            else:
                local_changed = True
        before["version"], after["version"] = int(signal["version"]), int(bumped["version"])
        await audit(session, tenant_id=tenant_id, event_type="SIGNAL_UPDATE", actor_id=actor, entity_type="signal", entity_id=signal_id, before=before, after={**after, "bulk": True}, correlation_id=correlation_id)
        updated.append({"signal_id": str(signal_id), "version": int(bumped["version"]), "changed": sorted(k for k in after if k != "version")})
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if local_changed and not edges:
        await _notify_config_changed(session, tenant_id)
    return {"updated": updated, "unchanged": unchanged, "count": len(updated)}


async def bulk_action_signals(session: AsyncSession, tenant_id: UUID, actor: UUID, body: SignalBulkActionIn, correlation_id: str) -> dict[str, Any]:
    if not body.signal_ids:
        return {"affected": 0, "action": body.action.lower()}
    if len(body.signal_ids) > 1000:
        raise AppError(422, "LIMIT", "At most 1000 signals per bulk action.")
    action = body.action.lower()
    if action not in {"enable", "disable", "delete"}:
        raise AppError(422, "INVALID_ACTION", f"Unknown bulk action '{body.action}'.")
    requested = [parse_uuid(s) for s in body.signal_ids]
    owned = await fetch_all(
        session,
        "SELECT id FROM signal_definitions WHERE tenant_id = :tenant_id AND id = ANY(:ids) AND status = 'ACTIVE'",
        {"tenant_id": tenant_id, "ids": requested},
    )
    ids = [as_uuid(row["id"]) for row in owned]
    if not ids:
        return {"affected": 0, "action": action}
    now = utcnow()
    edges = await _edges_of_signals(session, ids)
    if action == "enable":
        await _set_binding_enabled(session, ids, True)
        await execute(session, "UPDATE signal_definitions SET version = version + 1, updated_at = :now WHERE id = ANY(:ids) AND tenant_id = :tenant_id", {"now": now, "ids": ids, "tenant_id": tenant_id})
    elif action == "disable":
        await _set_binding_enabled(session, ids, False)
        await execute(session, "UPDATE signal_definitions SET version = version + 1, updated_at = :now WHERE id = ANY(:ids) AND tenant_id = :tenant_id", {"now": now, "ids": ids, "tenant_id": tenant_id})
    else:
        await execute(session, "UPDATE signal_definitions SET status = 'ARCHIVED', version = version + 1, updated_at = :now WHERE id = ANY(:ids) AND tenant_id = :tenant_id", {"now": now, "ids": ids, "tenant_id": tenant_id})
        await _set_binding_enabled(session, ids, False)
    for edge_id in sorted(edges, key=str):
        await bump_edge_release(session, tenant_id, actor, correlation_id, edge_id=edge_id)
    if not edges:
        await _notify_config_changed(session, tenant_id)
    await audit(session, tenant_id=tenant_id, event_type=f"SIGNAL_BULK_{action.upper()}", actor_id=actor, entity_type="signal", entity_id=ids[0], before=None, after={"action": action, "count": len(ids), "ids": [str(item) for item in ids]}, correlation_id=correlation_id)
    return {"affected": len(ids), "action": action}
