"""Connections, signals, formulas, output groups, releases and edge enrollment."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.formula import FormulaError, bind, detect_cycles, evaluate, output_quality, parse_expression
from factorix.domain.jsonpath import MappingError, apply_cardinality, compile_path, evaluate as eval_path, suggest_type
from factorix.domain.units import add_units
from factorix.domain.uns import TopicError, render_topic
from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.modules.protocols import accept_connection, parse_config, public_protocol, redacted_endpoint
from factorix.platform.errors import AppError
from factorix.platform.security import encrypt_secret, new_token, hash_token

CAPABILITIES = {
    "modbus_tcp": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
    "opcua": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": True, "can_write": False},
    "mqtt": {"can_test": True, "can_discover": True, "can_poll": False, "can_subscribe": True, "can_write": False},
    "http": {"can_test": True, "can_discover": True, "can_poll": True, "can_subscribe": False, "can_write": False},
}


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    site_id: str
    edge_id: str
    protocol: str
    config: dict[str, Any]
    secret_input: str | None = None


class ConnectionPatch(BaseModel):
    version: int
    name: str | None = None
    config: dict[str, Any] | None = None
    secret_input: str | None = None


class JobIn(BaseModel):
    connection_id: str
    mode: str
    interval_ms: int | None = 1000
    timeout_ms: int = 3000
    enabled: bool = True


class SignalBulkItem(BaseModel):
    key: str
    name: str
    data_type: str
    unit: str | None = None
    expected_interval_ms: int | None = None
    source_field: dict[str, Any] | None = None


class SignalBulkIn(BaseModel):
    resource_id: str
    items: list[SignalBulkItem]
    atomic: bool = True


class SignalPatch(BaseModel):
    version: int
    display_name: str | None = None
    description: str | None = None
    unit: str | None = None
    expected_interval_ms: int | None = None


class FormulaIn(BaseModel):
    signal_id: str | None = None
    resource_id: str | None = None
    key: str | None = None
    display_name: str | None = None
    expression: str
    aliases: dict[str, str]
    unit: str | None = None
    temporal_policy: dict[str, Any] = Field(default_factory=lambda: {"mode": "LATEST_WITH_MAX_AGE", "max_age_ms": 10000})

    @field_validator("temporal_policy", mode="before")
    @classmethod
    def _temporal_policy(cls, value: Any) -> Any:
        if value == "LATEST":
            return {"mode": "LATEST_WITH_MAX_AGE", "max_age_ms": 10000}
        if isinstance(value, str) and value:
            return {"mode": value}
        return value


class PreviewIn(BaseModel):
    expression: str
    values: dict[str, Any] = Field(default_factory=dict)
    qualities: dict[str, str] = Field(default_factory=dict)
    aliases: dict[str, str] = Field(default_factory=dict)


class MappingPreviewIn(BaseModel):
    expression: str
    document: Any
    cardinality: str = "REJECT_MULTI"
    missing: str = "NULL"
    samples: list[Any] = Field(default_factory=list)


class OutputGroupIn(BaseModel):
    resource_id: str
    key: str
    display_name: str
    topic_template: str = "fx/v1/{enterprise}/{site}/{plant}/{zone}/{line}/{resource}/{group}"
    members: list[dict[str, Any]]
    projection_policy: dict[str, Any] = Field(default_factory=lambda: {"mode": "rich", "missing": "null"})


class EdgeIn(BaseModel):
    name: str
    site_id: str


class ReleaseIn(BaseModel):
    edge_id: str


async def _owned_edge(session: AsyncSession, tenant_id: UUID, edge_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM edge_nodes WHERE id = :id AND tenant_id = :tenant_id",
        {"id": edge_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy Edge.")
    row.pop("credential_hash", None)
    return row


async def create_edge(session: AsyncSession, tenant_id: UUID, actor: UUID, body: EdgeIn, correlation_id: str) -> dict[str, Any]:
    edge_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO edge_nodes (
            id, tenant_id, site_id, name, enrollment_status, desired_revision, active_revision, health, created_at
        ) VALUES (
            :id, :tenant_id, :site_id, :name, 'UNENROLLED', 0, 0, 'UNKNOWN', :now
        )
        """,
        {"id": edge_id, "tenant_id": tenant_id, "site_id": parse_uuid(body.site_id), "name": body.name.strip(), "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="EDGE_CREATE", actor_id=actor, entity_type="edge", entity_id=edge_id, before=None, after={"name": body.name.strip()}, correlation_id=correlation_id)
    row = await _owned_edge(session, tenant_id, edge_id)
    row.pop("credential_hash", None)
    return row


async def issue_enrollment(session: AsyncSession, tenant_id: UUID, edge_id: UUID, actor: UUID, correlation_id: str) -> dict[str, Any]:
    await _owned_edge(session, tenant_id, edge_id)
    token = new_token()
    expires = utcnow() + timedelta(minutes=30)
    await execute(
        session,
        """
        INSERT INTO edge_enrollment_tokens (id, edge_id, token_hash, expires_at)
        VALUES (:id, :edge_id, :token_hash, :expires_at)
        """,
        {"id": uuid4(), "edge_id": edge_id, "token_hash": hash_token(token), "expires_at": expires},
    )
    await audit(session, tenant_id=tenant_id, event_type="EDGE_ENROLL_TOKEN", actor_id=actor, entity_type="edge", entity_id=edge_id, before=None, after={"ttl_minutes": 30}, correlation_id=correlation_id)
    return {
        "enrollment_token": token,
        "expires_in_seconds": 1800,
        "expires_at": expires.isoformat().replace("+00:00", "Z"),
        "edge_id": str(edge_id),
    }


async def create_connection(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: ConnectionIn,
    *,
    data_key: str,
    correlation_id: str,
) -> dict[str, Any]:
    protocol, raw_config, interval_override = accept_connection(body.protocol, body.config)
    config = parse_config(protocol, raw_config)
    edge = await _owned_edge(session, tenant_id, parse_uuid(body.edge_id))
    if str(edge["site_id"]) != body.site_id:
        raise AppError(422, "SCOPE", "Edge không thuộc site đã chọn.")
    secret_ref = None
    if body.secret_input:
        if len(body.secret_input) > 4096:
            raise AppError(422, "SECRET", "Bí mật quá dài.")
        secret_ref = uuid4()
        await execute(
            session,
            """
            INSERT INTO secret_store (id, tenant_id, ciphertext, created_at)
            VALUES (:id, :tenant_id, :ciphertext, :now)
            """,
            {"id": secret_ref, "tenant_id": tenant_id, "ciphertext": encrypt_secret(data_key, body.secret_input), "now": utcnow()},
        )
    connection_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO connections (
            id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, secret_ref,
            config_json, status, health, version, created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :site_id, :edge_id, :protocol, :name, :endpoint, :secret_ref,
            CAST(:config AS jsonb), 'DRAFT', 'UNKNOWN', 1, :now, :now
        )
        """,
        {
            "id": connection_id,
            "tenant_id": tenant_id,
            "site_id": parse_uuid(body.site_id),
            "edge_id": as_uuid(edge["id"]),
            "protocol": protocol,
            "name": body.name.strip(),
            "endpoint": redacted_endpoint(protocol, config),
            "secret_ref": secret_ref,
            "config": jsonb(config),
            "now": now,
        },
    )
    mode = "SUBSCRIBE" if protocol == "mqtt" else "POLL"
    interval = interval_override if interval_override is not None else (None if mode == "SUBSCRIBE" else 1000)
    await execute(
        session,
        """
        INSERT INTO acquisition_jobs (
            id, connection_id, mode, interval_ms, timeout_ms, enabled, concurrency_limit, config_revision, version
        ) VALUES (:id, :connection_id, :mode, :interval_ms, 3000, TRUE, 1, 1, 1)
        """,
        {"id": uuid4(), "connection_id": connection_id, "mode": mode, "interval_ms": interval},
    )
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_CREATE", actor_id=actor, entity_type="connection", entity_id=connection_id, before=None, after={"name": body.name.strip(), "protocol": body.protocol}, correlation_id=correlation_id)
    return await get_connection(session, tenant_id, connection_id)


async def get_connection(session: AsyncSession, tenant_id: UUID, connection_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        """
        SELECT id, tenant_id, site_id, edge_id, protocol, name, endpoint_redacted, secret_ref IS NOT NULL AS secret_configured,
               config_json, status, health, last_error, last_success_at, version, created_at, updated_at
        FROM connections WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"id": connection_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy kết nối.")
    row["jobs"] = await fetch_all(
        session,
        "SELECT id, mode, interval_ms, timeout_ms, enabled, version FROM acquisition_jobs WHERE connection_id = :id",
        {"id": connection_id},
    )
    row["protocol"] = public_protocol(str(row["protocol"]))
    row["config"] = row.get("config_json") or {}
    return row


async def list_connections(session: AsyncSession, tenant_id: UUID, *, protocol: str | None, site_id: str | None, status: str | None) -> list[dict[str, Any]]:
    where = ["tenant_id = :tenant_id", "status <> 'ARCHIVED'"]
    params: dict[str, Any] = {"tenant_id": tenant_id}
    if protocol:
        stored, _config, _interval = accept_connection(protocol, {})
        where.append("protocol = :protocol")
        params["protocol"] = stored
    if site_id:
        where.append("site_id = :site_id")
        params["site_id"] = parse_uuid(site_id)
    if status:
        where.append("status = :status")
        params["status"] = status
    rows = await fetch_all(
        session,
        f"""
        SELECT id, name, protocol, endpoint_redacted, edge_id, site_id, health, status, last_error, version, secret_ref IS NOT NULL AS secret_configured
        FROM connections WHERE {' AND '.join(where)} ORDER BY name
        """,
        params,
    )
    for row in rows:
        row["protocol"] = public_protocol(str(row["protocol"]))
    return rows


def _signal_type(value: str) -> str:
    return "bool" if value == "boolean" else value


async def pause_connection(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID, correlation_id: str) -> dict[str, Any]:
    current = await get_connection(session, tenant_id, connection_id)
    await execute(
        session,
        "UPDATE connections SET status = 'PAUSED', health = 'PAUSED', version = version + 1, updated_at = :now WHERE id = :id",
        {"now": utcnow(), "id": connection_id},
    )
    await audit(session, tenant_id=tenant_id, event_type="CONNECTION_PAUSE", actor_id=actor, entity_type="connection", entity_id=connection_id, before={"status": current["status"]}, after={"status": "PAUSED"}, correlation_id=correlation_id)
    return await get_connection(session, tenant_id, connection_id)


async def bulk_signals(
    session: AsyncSession,
    tenant_id: UUID,
    actor: UUID,
    body: SignalBulkIn,
    correlation_id: str,
) -> dict[str, Any]:
    if not body.items or len(body.items) > 500:
        raise AppError(422, "LIMIT", "Mỗi lần tạo từ 1 đến 500 tín hiệu.")
    resource_id = parse_uuid(body.resource_id)
    resource = await fetch_one(session, "SELECT id, archived_at FROM resources WHERE id = :id AND tenant_id = :tenant_id", {"id": resource_id, "tenant_id": tenant_id})
    if resource is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    if resource["archived_at"] is not None:
        raise AppError(409, "ARCHIVED", "Không thêm tín hiệu vào tài nguyên đã lưu trữ.")
    errors: list[dict[str, str]] = []
    prepared: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(body.items):
        key = item.key.strip()
        if not key or len(key) > 64 or key in seen:
            errors.append({"path": f"items[{index}].key", "code": "INVALID"})
            continue
        data_type = _signal_type(item.data_type)
        if data_type not in {"bool", "int64", "float64", "string", "enum", "json"}:
            errors.append({"path": f"items[{index}].data_type", "code": "INVALID"})
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
        raise AppError(422, "BULK_REJECTED", "Không tạo tín hiệu nào vì có dòng lỗi.", field_errors=errors)
    created: list[str] = []
    now = utcnow()
    for item in prepared:
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
                raise AppError(422, "JOB", "Acquisition job không thuộc tenant.")
            field_id = uuid4()
            await execute(
                session,
                """
                INSERT INTO source_fields (id, acquisition_job_id, address_kind, address_json, native_datatype, decode_json, ordinal)
                VALUES (:id, :job_id, :kind, CAST(:address AS jsonb), :native, CAST(:decode AS jsonb), 0)
                """,
                {
                    "id": field_id,
                    "job_id": job_id,
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
    await audit(session, tenant_id=tenant_id, event_type="SIGNAL_BULK", actor_id=actor, entity_type="resource", entity_id=resource_id, before=None, after={"created": len(created)}, correlation_id=correlation_id)
    return {"created": created, "count": len(created)}


async def patch_signal(session: AsyncSession, tenant_id: UUID, actor: UUID, signal_id: UUID, body: SignalPatch, correlation_id: str) -> dict[str, Any]:
    current = await _signal(session, tenant_id, signal_id)
    if int(current["version"]) != body.version:
        raise AppError(409, "RESOURCE_VERSION_CONFLICT", "Tín hiệu đã được chỉnh sửa ở nơi khác.")
    await execute(
        session,
        """
        UPDATE signal_definitions
        SET display_name = :display_name, description = :description, unit = :unit,
            expected_interval_ms = :interval, version = version + 1, updated_at = :now
        WHERE id = :id
        """,
        {
            "display_name": body.display_name or current["display_name"],
            "description": body.description if body.description is not None else current["description"],
            "unit": body.unit if body.unit is not None else current["unit"],
            "interval": body.expected_interval_ms if body.expected_interval_ms is not None else current["expected_interval_ms"],
            "now": utcnow(),
            "id": signal_id,
        },
    )
    await audit(session, tenant_id=tenant_id, event_type="SIGNAL_RENAME", actor_id=actor, entity_type="signal", entity_id=signal_id, before={"display_name": current["display_name"]}, after={"display_name": body.display_name or current["display_name"]}, correlation_id=correlation_id)
    return await _signal(session, tenant_id, signal_id)


async def _signal(session: AsyncSession, tenant_id: UUID, signal_id: UUID) -> dict[str, Any]:
    row = await fetch_one(
        session,
        "SELECT * FROM signal_definitions WHERE id = :id AND tenant_id = :tenant_id",
        {"id": signal_id, "tenant_id": tenant_id},
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tín hiệu.")
    return row


async def list_signals(session: AsyncSession, tenant_id: UUID, *, resource_id: str | None, query: str | None, limit: int) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"tenant_id": tenant_id, "limit": min(max(limit, 1), 1000)}
    where = ["s.tenant_id = :tenant_id", "s.status = 'ACTIVE'"]
    if resource_id:
        where.append("s.resource_id = :resource_id")
        params["resource_id"] = parse_uuid(resource_id)
    if query:
        where.append("(s.display_name ILIKE :q OR s.key ILIKE :q)")
        params["q"] = f"%{query.strip()}%"
    rows = await fetch_all(
        session,
        f"""
        SELECT s.id, s.key, s.display_name, s.data_type, s.unit, s.category, s.resource_id, s.version, s.expected_interval_ms,
               r.code AS resource_code, r.name AS resource_name
        FROM signal_definitions s JOIN resources r ON r.id = s.resource_id
        WHERE {' AND '.join(where)}
        ORDER BY r.code, s.key
        LIMIT :limit
        """,
        params,
    )
    for row in rows:
        if row.get("data_type") == "bool":
            row["data_type"] = "boolean"
    return rows


def validate_mapping(body: MappingPreviewIn) -> dict[str, Any]:
    try:
        compile_path(body.expression)
        matches = eval_path(body.expression, body.document)
        result = apply_cardinality(matches, cardinality=body.cardinality, missing=body.missing)  # type: ignore[arg-type]
    except MappingError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    return {
        "present": result.present,
        "value": result.value,
        "match_count": result.match_count,
        "quality_override": result.quality_override,
        "suggested_type": suggest_type(body.samples or matches),
    }


async def save_formula(session: AsyncSession, tenant_id: UUID, actor: UUID, body: FormulaIn, correlation_id: str) -> dict[str, Any]:
    try:
        program = parse_expression(body.expression)
        alias_ids = {name: parse_uuid(signal_id) for name, signal_id in body.aliases.items()}
        bind(program, alias_ids)
    except FormulaError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    for signal_id in alias_ids.values():
        await _signal(session, tenant_id, signal_id)
    if body.unit and len(alias_ids) >= 2 and "/" not in body.expression and "+" in body.expression:
        units = []
        for signal_id in alias_ids.values():
            row = await _signal(session, tenant_id, signal_id)
            units.append(row["unit"])
        if len(units) >= 2:
            check = add_units(units[0], units[1])
            if not check.compatible:
                raise AppError(422, "UNIT", check.reason)
    signal_id: UUID
    if body.signal_id:
        signal_id = parse_uuid(body.signal_id)
        await _signal(session, tenant_id, signal_id)
    else:
        if not body.resource_id or not body.key or not body.display_name:
            raise AppError(422, "SIGNAL", "Cần resource, key và tên cho tín hiệu tính toán.")
        signal_id = uuid4()
        now = utcnow()
        await execute(
            session,
            """
            INSERT INTO signal_definitions (
                id, tenant_id, resource_id, key, display_name, data_type, unit, category, status, version, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :resource_id, :key, :name, 'float64', :unit, 'CALCULATED', 'ACTIVE', 1, :now, :now
            )
            """,
            {
                "id": signal_id,
                "tenant_id": tenant_id,
                "resource_id": parse_uuid(body.resource_id),
                "key": body.key.strip(),
                "name": body.display_name.strip(),
                "unit": body.unit,
                "now": now,
            },
        )
    formula_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO formula_definitions (
            id, signal_id, expression_source, ast_json, unit, temporal_policy_json, revision, status
        ) VALUES (
            :id, :signal_id, :expression, CAST(:ast AS jsonb), :unit, CAST(:policy AS jsonb), 1, 'DRAFT'
        )
        ON CONFLICT (signal_id) DO UPDATE SET
            expression_source = EXCLUDED.expression_source,
            ast_json = EXCLUDED.ast_json,
            unit = EXCLUDED.unit,
            temporal_policy_json = EXCLUDED.temporal_policy_json,
            revision = formula_definitions.revision + 1,
            status = 'DRAFT'
        """,
        {
            "id": formula_id,
            "signal_id": signal_id,
            "expression": body.expression,
            "ast": jsonb({"normalized": program.analysis.normalized, "names": list(program.analysis.names)}),
            "unit": body.unit,
            "policy": jsonb(body.temporal_policy),
        },
    )
    stored = await fetch_one(session, "SELECT id FROM formula_definitions WHERE signal_id = :signal_id", {"signal_id": signal_id})
    assert stored is not None
    await execute(session, "DELETE FROM formula_dependencies WHERE formula_id = :id", {"id": as_uuid(stored["id"])})
    for alias, dep in alias_ids.items():
        await execute(
            session,
            """
            INSERT INTO formula_dependencies (formula_id, variable_alias, dependency_signal_id)
            VALUES (:formula_id, :alias, :dep)
            """,
            {"formula_id": as_uuid(stored["id"]), "alias": alias, "dep": dep},
        )
    await audit(session, tenant_id=tenant_id, event_type="FORMULA_DRAFT", actor_id=actor, entity_type="formula", entity_id=as_uuid(stored["id"]), before=None, after={"signal_id": str(signal_id)}, correlation_id=correlation_id)
    return {"id": stored["id"], "signal_id": str(signal_id), "status": "DRAFT", "warnings": list(program.analysis.warnings)}


async def publish_formula(session: AsyncSession, tenant_id: UUID, actor: UUID, formula_id: UUID, correlation_id: str) -> dict[str, Any]:
    formula = await fetch_one(
        session,
        """
        SELECT f.*, s.tenant_id FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        WHERE f.id = :id AND s.tenant_id = :tenant_id
        """,
        {"id": formula_id, "tenant_id": tenant_id},
    )
    if formula is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy công thức.")
    graph = await _formula_graph(session, tenant_id)
    deps = await fetch_all(
        session,
        "SELECT dependency_signal_id FROM formula_dependencies WHERE formula_id = :id",
        {"id": formula_id},
    )
    graph[as_uuid(formula["signal_id"])] = {as_uuid(item["dependency_signal_id"]) for item in deps}
    try:
        detect_cycles(graph)
    except FormulaError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    await execute(session, "UPDATE formula_definitions SET status = 'PUBLISHED', revision = revision + 1 WHERE id = :id", {"id": formula_id})
    await audit(session, tenant_id=tenant_id, event_type="FORMULA_PUBLISH", actor_id=actor, entity_type="formula", entity_id=formula_id, before={"status": formula["status"]}, after={"status": "PUBLISHED"}, correlation_id=correlation_id)
    return {"id": str(formula_id), "status": "PUBLISHED"}


async def _formula_graph(session: AsyncSession, tenant_id: UUID) -> dict[UUID, set[UUID]]:
    rows = await fetch_all(
        session,
        """
        SELECT f.signal_id, d.dependency_signal_id
        FROM formula_definitions f
        JOIN signal_definitions s ON s.id = f.signal_id
        LEFT JOIN formula_dependencies d ON d.formula_id = f.id
        WHERE s.tenant_id = :tenant_id AND f.status = 'PUBLISHED'
        """,
        {"tenant_id": tenant_id},
    )
    graph: dict[UUID, set[UUID]] = {}
    for row in rows:
        node = as_uuid(row["signal_id"])
        graph.setdefault(node, set())
        if row["dependency_signal_id"]:
            graph[node].add(as_uuid(row["dependency_signal_id"]))
    return graph


def preview_formula(body: PreviewIn) -> dict[str, Any]:
    try:
        program = parse_expression(body.expression)
        if body.aliases:
            bind(program, {name: parse_uuid(value) for name, value in body.aliases.items()})
        value = evaluate(program, body.values)
    except FormulaError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    qualities = [body.qualities.get(name, "GOOD") for name in program.analysis.names]
    return {
        "value": value,
        "quality": output_quality(qualities, value),
        "warnings": list(program.analysis.warnings),
        "dependencies": list(program.analysis.names),
    }


async def create_output_group(session: AsyncSession, tenant_id: UUID, actor: UUID, body: OutputGroupIn, correlation_id: str) -> dict[str, Any]:
    resource = await fetch_one(session, "SELECT id, code, name FROM resources WHERE id = :id AND tenant_id = :tenant_id", {"id": parse_uuid(body.resource_id), "tenant_id": tenant_id})
    if resource is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")
    aliases = [str(member["alias"]) for member in body.members]
    if len(aliases) != len(set(aliases)):
        raise AppError(422, "ALIAS", "Alias trong nhóm bị trùng.")
    try:
        render_topic(body.topic_template, {"enterprise": "e", "site": "s", "plant": "p", "zone": None, "line": None, "resource": resource["code"], "group": body.key})
    except TopicError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    group_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO output_groups (
            id, tenant_id, resource_id, key, display_name, topic_template, projection_policy_json, version, status
        ) VALUES (
            :id, :tenant_id, :resource_id, :key, :name, :topic, CAST(:policy AS jsonb), 1, 'DRAFT'
        )
        """,
        {
            "id": group_id,
            "tenant_id": tenant_id,
            "resource_id": as_uuid(resource["id"]),
            "key": body.key.strip(),
            "name": body.display_name.strip(),
            "topic": body.topic_template,
            "policy": jsonb(body.projection_policy),
        },
    )
    for ordinal, member in enumerate(body.members):
        signal = await _signal(session, tenant_id, parse_uuid(str(member["signal_id"])))
        await execute(
            session,
            """
            INSERT INTO output_group_members (output_group_id, signal_id, output_alias, ordinal)
            VALUES (:group_id, :signal_id, :alias, :ordinal)
            """,
            {"group_id": group_id, "signal_id": as_uuid(signal["id"]), "alias": member["alias"], "ordinal": ordinal},
        )
    await audit(session, tenant_id=tenant_id, event_type="OUTPUT_GROUP_DRAFT", actor_id=actor, entity_type="output_group", entity_id=group_id, before=None, after={"key": body.key}, correlation_id=correlation_id)
    return {"id": str(group_id), "status": "DRAFT"}


async def preview_output_group(session: AsyncSession, tenant_id: UUID, group_id: UUID) -> dict[str, Any]:
    group = await fetch_one(
        session,
        """
        SELECT g.*, r.code AS resource_code, r.name AS resource_name
        FROM output_groups g JOIN resources r ON r.id = g.resource_id
        WHERE g.id = :id AND g.tenant_id = :tenant_id
        """,
        {"id": group_id, "tenant_id": tenant_id},
    )
    if group is None:
        raise AppError(404, "NOT_FOUND", "Không tìm thấy nhóm đầu ra.")
    members = await fetch_all(
        session,
        """
        SELECT m.output_alias, m.signal_id, l.value_json, l.quality, l.event_time, l.unit
        FROM output_group_members m
        LEFT JOIN latest_signal_state l ON l.signal_id = m.signal_id AND l.tenant_id = :tenant_id
        WHERE m.output_group_id = :id
        ORDER BY m.ordinal
        """,
        {"id": group_id, "tenant_id": tenant_id},
    )
    policy = group["projection_policy_json"] or {"mode": "rich", "missing": "null"}
    values: dict[str, Any] = {}
    for member in members:
        raw = None if member["value_json"] is None else member["value_json"].get("v")
        if raw is None and policy.get("missing") == "omit":
            continue
        if policy.get("mode") == "compact":
            values[member["output_alias"]] = raw
        else:
            values[member["output_alias"]] = {
                "value": raw,
                "unit": member["unit"],
                "quality": member["quality"] or "BAD",
                "observed_at": member["event_time"],
            }
    path = await _resource_path(session, tenant_id, as_uuid(group["resource_id"]))
    try:
        topic = render_topic(group["topic_template"], {**path, "resource": group["resource_code"], "group": group["key"]})
    except TopicError as exc:
        raise AppError(422, exc.code, str(exc)) from exc
    return {
        "schema_version": "fx.output.v1",
        "resource": {"id": group["resource_id"], "code": group["resource_code"], "name": group["resource_name"]},
        "group": group["key"],
        "topic": topic,
        "values": values,
        "freshness": "UNKNOWN" if not members else "SEE_VALUES",
    }


async def _resource_path(session: AsyncSession, tenant_id: UUID, resource_id: UUID) -> dict[str, str | None]:
    from factorix.modules.resources import breadcrumb

    chain = await breadcrumb(session, tenant_id, resource_id)
    roles = ["enterprise", "site", "plant", "zone", "line"]
    context: dict[str, str | None] = {role: None for role in roles}
    detailed = await fetch_all(
        session,
        """
        SELECT r.id, t.key FROM resources r JOIN resource_types t ON t.id = r.type_id
        WHERE r.tenant_id = :tenant_id AND r.id = ANY(:ids)
        """,
        {"tenant_id": tenant_id, "ids": [as_uuid(item["id"]) for item in chain]},
    )
    by_id = {item["id"]: item["key"] for item in detailed}
    for item in chain:
        key = by_id.get(item["id"])
        if key in context:
            context[key] = item["code"]
    return context


async def publish_release(session: AsyncSession, tenant_id: UUID, actor: UUID, body: ReleaseIn, correlation_id: str) -> dict[str, Any]:
    edge = await _owned_edge(session, tenant_id, parse_uuid(body.edge_id))
    connections = await fetch_all(
        session,
        """
        SELECT id, protocol, name, endpoint_redacted, config_json, status, secret_ref
        FROM connections
        WHERE edge_id = :edge_id AND tenant_id = :tenant_id AND status <> 'ARCHIVED'
        """,
        {"edge_id": as_uuid(edge["id"]), "tenant_id": tenant_id},
    )
    jobs = []
    fields = []
    if connections:
        jobs = await fetch_all(
            session,
            "SELECT * FROM acquisition_jobs WHERE connection_id = ANY(:ids)",
            {"ids": [as_uuid(item["id"]) for item in connections]},
        )
    if jobs:
        fields = await fetch_all(
            session,
            "SELECT * FROM source_fields WHERE acquisition_job_id = ANY(:ids)",
            {"ids": [as_uuid(item["id"]) for item in jobs]},
        )
    bindings = await fetch_all(
        session,
        """
        SELECT b.signal_id, b.source_field_id, b.transform_chain_json, s.key, s.resource_id, s.data_type, s.unit
        FROM signal_bindings b
        JOIN signal_definitions s ON s.id = b.signal_id
        WHERE s.tenant_id = :tenant_id AND b.enabled = TRUE AND b.valid_to IS NULL
        """,
        {"tenant_id": tenant_id},
    )
    formulas = await fetch_all(
        session,
        """
        SELECT f.signal_id, f.expression_source, f.revision, f.temporal_policy_json
        FROM formula_definitions f JOIN signal_definitions s ON s.id = f.signal_id
        WHERE s.tenant_id = :tenant_id AND f.status = 'PUBLISHED'
        """,
        {"tenant_id": tenant_id},
    )
    revision = int(edge["desired_revision"]) + 1
    payload = {
        "schema_version": "fx.edge.config.v1",
        "edge_id": edge["id"],
        "revision": revision,
        "issued_at": utcnow().isoformat().replace("+00:00", "Z"),
        "connections": [{**item, "secret_ref": item["secret_ref"]} for item in connections],
        "jobs": jobs,
        "source_fields": fields,
        "signal_bindings": bindings,
        "formulas": formulas,
        "security_policy_revision": 1,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()
    digest = hashlib.sha256(canonical).hexdigest()
    payload["checksum_sha256"] = digest
    await execute(
        session,
        """
        INSERT INTO configuration_releases (
            id, tenant_id, edge_id, revision, content_hash, snapshot_json, published_at, published_by, status
        ) VALUES (
            :id, :tenant_id, :edge_id, :revision, :content_hash, CAST(:snapshot AS jsonb), :now, :actor, 'PUBLISHED'
        )
        """,
        {
            "id": uuid4(),
            "tenant_id": tenant_id,
            "edge_id": as_uuid(edge["id"]),
            "revision": revision,
            "content_hash": digest,
            "snapshot": jsonb(payload),
            "now": utcnow(),
            "actor": actor,
        },
    )
    await execute(
        session,
        "UPDATE edge_nodes SET desired_revision = :revision, health = 'CONFIG_PENDING' WHERE id = :id",
        {"revision": revision, "id": as_uuid(edge["id"])},
    )
    await execute(
        session,
        """
        INSERT INTO deployment_events (id, edge_id, revision, state, diagnostic_redacted, at)
        VALUES (:id, :edge_id, :revision, 'PUBLISHED', '', :now)
        """,
        {"id": uuid4(), "edge_id": as_uuid(edge["id"]), "revision": revision, "now": utcnow()},
    )
    await audit(session, tenant_id=tenant_id, event_type="CONFIG_PUBLISH", actor_id=actor, entity_type="edge", entity_id=as_uuid(edge["id"]), before={"desired": edge["desired_revision"]}, after={"desired": revision, "active": edge["active_revision"]}, correlation_id=correlation_id)
    return {"edge_id": edge["id"], "revision": revision, "status": "PUBLISHED", "active_revision": edge["active_revision"], "checksum_sha256": digest}


async def request_commission(session: AsyncSession, tenant_id: UUID, actor: UUID, connection_id: UUID, correlation_id: str) -> dict[str, Any]:
    connection = await get_connection(session, tenant_id, connection_id)
    stages = [
        {"stage": name, "status": "PENDING", "duration_ms": None, "detail": ""}
        for name in ("NETWORK", "AUTH", "PROTOCOL", "READ_OR_SUBSCRIBE", "DECODE", "MAPPING", "VALIDATION")
    ]
    job_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO commissioning_jobs (
            id, tenant_id, connection_id, requested_by, stages_json, status, diagnostic
        ) VALUES (
            :id, :tenant_id, :connection_id, :actor, CAST(:stages AS jsonb), 'PENDING', ''
        )
        """,
        {"id": job_id, "tenant_id": tenant_id, "connection_id": connection_id, "actor": actor, "stages": jsonb(stages)},
    )
    await audit(session, tenant_id=tenant_id, event_type="COMMISSION_REQUEST", actor_id=actor, entity_type="connection", entity_id=connection_id, before=None, after={"job_id": str(job_id), "protocol": connection["protocol"]}, correlation_id=correlation_id)
    return {"job_id": str(job_id), "status": "PENDING"}
