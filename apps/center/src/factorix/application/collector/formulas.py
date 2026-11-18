"""Mappings and formulas: validate, preview, save, publish. Moved verbatim from ``factorix.modules.collect`` (R2-E B6, move-only)."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.domain.formula import FormulaError, bind, detect_cycles, evaluate, output_quality, parse_expression
from factorix.domain.jsonpath import MappingError, apply_cardinality, compile_path, evaluate as eval_path, suggest_type
from factorix.domain.units import add_units
from factorix.modules.common import as_uuid, audit, execute, fetch_all, fetch_one, jsonb, parse_uuid, utcnow
from factorix.platform.errors import AppError

from factorix.application.collector.schemas import FormulaIn, MappingPreviewIn, PreviewIn
from factorix.application.legacy_edge.fleet import _notify_config_changed
from factorix.application.collector.signals import _signal


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
            raise AppError(422, "SIGNAL", "Calculated signals require a resource, key, and name.")
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
        raise AppError(404, "NOT_FOUND", "Formula not found.")
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
    await _notify_config_changed(session, tenant_id)
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
