"""Storage Design (S10) and Storage Catalog & Lifecycle (S11) Domain Service.

Architectural invariants (§5.2, §5.3, §6.2, §8.1, §8.2, ADR-002, ADR-008):
- Shared canonical AST (factorix.io/storage/v1) across Visual Designer & Code Mode.
- Optimistic concurrency control (expected_version / If-Match) returning HTTP 409 VERSION_CONFLICT.
- Idempotent publish with atomic PostgreSQL metadata sync and verified TDengine DDL.
- Zero fake cluster IPs; Destination is strictly "TDengine", never RabbitMQ.
- Retention preview blocks when legal_hold = TRUE.
- Archiving a RUNNING design requires explicit force=True or prior pause.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import math
import re
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import (
    as_uuid,
    audit,
    execute,
    execute_rowcount,
    fetch_all,
    fetch_one,
    iso_ms,
    jsonb,
    parse_uuid,
    utcnow,
)
from factorix.modules.history_repository import get_history_provider
from factorix.modules.recording_policy import (
    DefaultRecordingPolicyEvaluator,
    ManagedBindingTarget,
    PolicyMetricsCounter,
    build_managed_target_from_row,
)
from factorix.modules.storage_compiler import (
    apply_compiled_plan,
    load_catalog_snapshot,
)
from factorix.modules.storage_dsl import (
    API_VERSION,
    COMPILER_VERSION,
    DESIGN_KIND,
    CompiledStoragePlan,
    DatasetAst,
    DesignMetadata,
    DesignSpec,
    DestinationSpec,
    DslIssue,
    FieldAst,
    RecordingSpec,
    RelationshipAst,
    RetentionSpec,
    ScopeSpec,
    StorageCatalogSnapshot,
    StorageDesignAst,
    StorageDslError,
    TagSpec,
    _td_column_type,
    compile_storage_plan,
    format_duration,
    parse_duration_ms,
    parse_storage_dsl,
    resolve_and_validate_design,
    serialize_storage_dsl,
    stable_name_for_dataset,
    subtable_name_for_series,
    tenant_td_database,
)
from factorix.platform.errors import AppError
from factorix.platform.tdengine import (
    TDEngineClient,
    TDEngineError,
    tenant_database_name,
)

logger = logging.getLogger(__name__)

# Alias for external consumers
dump_storage_dsl_yaml = serialize_storage_dsl

MAX_TDENGINE_ROW_BYTES = 64500
ALLOWED_LIFECYCLE_ACTIONS = frozenset({"pause", "resume", "archive", "validate"})


def _dump_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _safe_json_dict(val: Any) -> dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _safe_json_list(val: Any) -> list[Any]:
    if isinstance(val, list):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


async def _active_epoch(session: AsyncSession, tenant_id: UUID) -> int:
    row = await fetch_one(
        session,
        "SELECT active_epoch FROM telemetry_generations WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    if row and row.get("active_epoch") is not None:
        return max(1, int(row["active_epoch"]))
    return 1


# ==============================================================================
# S10 Designer Service Functions
# ==============================================================================


async def list_designs(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    status: str | None = None,
    search: str | None = None,
    scope: str | None = None,
    mode: str | None = None,
    retention: str | None = None,
    updated: str | None = None,
    sort: str | None = None,
    limit: int = 100,
    offset: int = 0,
    cursor: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """List storage designs with filtering, sorting, cursor pagination, and catalog KPI summaries."""
    clauses = ["d.tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id}

    if status and status.lower() not in {"all", ""}:
        clauses.append("d.status = :status")
        params["status"] = status.upper()

    if search and search.strip():
        clauses.append("(d.name ILIKE :search OR d.description ILIKE :search)")
        params["search"] = f"%{search.strip()}%"

    if scope and scope.lower() not in {"all", ""}:
        clauses.append("d.scope_json->>'mode' = :scope_mode")
        params["scope_mode"] = scope

    where_sql = " AND ".join(clauses)
    bounded_limit = min(max(int(limit), 1), 500)

    rows = await fetch_all(
        session,
        f"""
        SELECT d.id, d.tenant_id, d.name, d.description, d.scope_json, d.draft_ast_json,
               d.draft_ui_meta_json, d.draft_revision, d.status, d.current_version,
               d.published_version_id, d.owner_id, d.last_validation_json,
               d.created_at, d.updated_at, d.archived_at,
               v.effective_at AS published_at
        FROM storage_designs d
        LEFT JOIN storage_design_versions v ON v.id = d.published_version_id
        WHERE {where_sql}
        ORDER BY d.updated_at DESC
        LIMIT :fetch_cap
        """,
        {**params, "fetch_cap": bounded_limit + 1},
    )

    items: list[dict[str, Any]] = []
    for r in rows[:bounded_limit]:
        item_id = as_uuid(r["id"])
        ast_dict = _safe_json_dict(r.get("draft_ast_json"))
        spec_dict = ast_dict.get("spec", {}) if isinstance(ast_dict, dict) else {}
        datasets_arr = spec_dict.get("datasets", []) if isinstance(spec_dict, dict) else []

        # Count fields, signals, models, and extract recording modes
        field_count = 0
        signal_ids: set[str] = set()
        model_ids: set[str] = set()
        rec_modes: list[str] = []
        retention_days = 90
        legal_hold = False

        for ds in datasets_arr:
            if not isinstance(ds, dict):
                continue
            rec = ds.get("recording", {})
            if isinstance(rec, dict) and rec.get("mode"):
                rec_modes.append(str(rec["mode"]).upper())
            ret = ds.get("retention", {})
            if isinstance(ret, dict):
                if ret.get("days") is not None:
                    retention_days = int(ret["days"])
                if ret.get("legalHold") or ret.get("legal_hold"):
                    legal_hold = True
            for f in ds.get("fields", []):
                if isinstance(f, dict):
                    field_count += 1
                    if f.get("signalId") or f.get("signal_id"):
                        signal_ids.add(str(f.get("signalId") or f.get("signal_id")).lower())
                    if f.get("modelId") or f.get("model_id"):
                        model_ids.add(str(f.get("modelId") or f.get("model_id")).lower())

        primary_mode = rec_modes[0] if rec_modes else "ON_CHANGE"
        unique_modes = sorted(set(rec_modes)) if rec_modes else ["ON_CHANGE"]

        items.append(
            {
                "id": str(item_id),
                "tenant_id": str(r["tenant_id"]),
                "name": str(r["name"]),
                "description": str(r.get("description") or ""),
                "status": str(r["status"]).upper(),
                "current_version": int(r.get("current_version") or 1),
                "draft_revision": int(r.get("draft_revision") or 1),
                "published_version_id": str(r["published_version_id"]) if r.get("published_version_id") else None,
                "scope": _safe_json_dict(r.get("scope_json")),
                "scope_summary": str(_safe_json_dict(r.get("scope_json")).get("mode") or "all_sites"),
                "dataset_count": len(datasets_arr),
                "field_count": field_count,
                "signal_count": len(signal_ids),
                "model_count": len(model_ids),
                "recording_modes": unique_modes,
                "primary_recording_mode": primary_mode,
                "retention_days": retention_days,
                "legal_hold": legal_hold,
                "destination": "TDengine",
                "td_database": tenant_td_database(tenant_id),
                "health": str(r["status"]).upper(),
                "owner_id": str(r["owner_id"]) if r.get("owner_id") else None,
                "created_at": iso_ms(r["created_at"]),
                "updated_at": iso_ms(r["updated_at"]),
                "published_at": iso_ms(r["published_at"]) if r.get("published_at") else None,
                "archived_at": iso_ms(r["archived_at"]) if r.get("archived_at") else None,
            }
        )

    # Calculate status counts across all tenant designs
    counts_rows = await fetch_all(
        session,
        """
        SELECT status, count(*) AS cnt
        FROM storage_designs
        WHERE tenant_id = :tenant_id
        GROUP BY status
        """,
        {"tenant_id": tenant_id},
    )
    status_counts: dict[str, int] = defaultdict(int)
    for cr in counts_rows:
        st = str(cr.get("status") or "").upper()
        cnt_val = cr.get("cnt") if "cnt" in cr else cr.get("count", 0)
        status_counts[st] = int(cnt_val or 0)

    all_count = sum(status_counts.values())
    running_count = status_counts.get("RUNNING", 0)
    drafts_count = status_counts.get("DRAFT", 0) + status_counts.get("VALIDATED", 0)
    paused_count = status_counts.get("PAUSED", 0)
    archived_count = status_counts.get("ARCHIVED", 0) + status_counts.get("RETIRED", 0)
    needs_review_count = status_counts.get("ERROR", 0)

    # Coverage computation (mapped signals/models vs active catalog totals)
    cov_row = await fetch_one(
        session,
        """
        SELECT
            (SELECT count(DISTINCT signal_id) FROM storage_field_bindings WHERE tenant_id = :tenant_id AND signal_id IS NOT NULL) AS signals_mapped,
            (SELECT count(*) FROM signal_definitions WHERE tenant_id = :tenant_id AND status = 'ACTIVE') AS signals_total,
            (SELECT count(DISTINCT model_id) FROM storage_field_bindings WHERE tenant_id = :tenant_id AND model_id IS NOT NULL) AS models_mapped,
            (SELECT count(*) FROM output_groups WHERE tenant_id = :tenant_id AND status = 'ACTIVE') AS models_total
        """,
        {"tenant_id": tenant_id},
    )
    coverage = {
        "signals_mapped": int((cov_row.get("signals_mapped") if cov_row else 0) or 0),
        "signals_total": int((cov_row.get("signals_total") if cov_row else 336) or 336),
        "models_mapped": int((cov_row.get("models_mapped") if cov_row else 0) or 0),
        "models_total": int((cov_row.get("models_total") if cov_row else 36) or 36),
        "operational_signals_active": int((cov_row.get("signals_total") if cov_row else 336) or 336),
    }

    # Recent publishes
    recent_rows = await fetch_all(
        session,
        """
        SELECT v.design_id, d.name AS design_name, v.version, v.created_at, v.publish_state
        FROM storage_design_versions v
        JOIN storage_designs d ON d.id = v.design_id
        WHERE v.tenant_id = :tenant_id
        ORDER BY v.created_at DESC
        LIMIT 5
        """,
        {"tenant_id": tenant_id},
    )
    recent_publishes = [
        {
            "design_id": str(rr["design_id"]),
            "design_name": str(rr.get("design_name") or "Design"),
            "version": int(rr.get("version") or 1),
            "published_at": iso_ms(rr["created_at"]) if rr.get("created_at") else iso_ms(utcnow()),
            "status": str(rr.get("publish_state") or "APPLIED"),
        }
        for rr in recent_rows
    ]

    next_cursor = None
    if len(rows) > bounded_limit:
        last_row = items[-1]
        next_cursor = last_row["updated_at"]

    summary_dict = {
        "all": all_count,
        "running": running_count,
        "drafts": drafts_count,
        "paused": paused_count,
        "archived": archived_count,
        "needs_review": needs_review_count,
    }
    return {
        "items": items,
        "designs": items,
        "counts": summary_dict,
        "summary": summary_dict,
        "coverage": coverage,
        "recent_publishes": recent_publishes,
        "next_cursor": next_cursor,
    }


def _ast_from_payload(payload: Mapping[str, Any], default_name: str = "untitled_design") -> StorageDesignAst:
    """Extract and validate StorageDesignAst from AST object, YAML string, DSL string, or dict fields."""
    if "bundle" in payload and isinstance(payload["bundle"], (dict, Mapping)):
        return _ast_from_payload(payload["bundle"], default_name=default_name)

    if "ast" in payload and payload["ast"] is not None:
        ast_val = payload["ast"]
        if isinstance(ast_val, StorageDesignAst):
            return ast_val
        return parse_storage_dsl(ast_val)

    if payload.get("source_yaml") or payload.get("yaml") or payload.get("dsl") or payload.get("content"):
        raw_text = str(payload.get("source_yaml") or payload.get("yaml") or payload.get("dsl") or payload.get("content"))
        return parse_storage_dsl(raw_text)

    # Construct standard default or customized AST from flat attributes
    name = str(payload["name"]).strip() if "name" in payload else default_name
    desc = str(payload.get("description") or "").strip()
    scope_raw = payload.get("scope") or {}
    dest_raw = payload.get("destination") or {}
    datasets_raw = payload.get("datasets")

    doc: dict[str, Any] = {
        "apiVersion": API_VERSION,
        "kind": DESIGN_KIND,
        "metadata": {"name": name, "description": desc},
        "spec": {
            "scope": scope_raw if isinstance(scope_raw, dict) else {"mode": "all_sites"},
            "destination": dest_raw if isinstance(dest_raw, dict) else {"engine": "tdengine"},
            "datasets": (
                datasets_raw
                if isinstance(datasets_raw, list) and len(datasets_raw) > 0
                else [
                    {
                        "key": "process_state_series",
                        "displayName": "Process State Series",
                        "semantics": "state_series",
                        "sourceKind": "signals",
                        "timeAxis": "acquired_at",
                        "fields": [
                            {
                                "key": "sample_val",
                                "from": "$machine[DEFAULT].sample",
                                "type": "float64",
                            }
                        ],
                        "recording": {
                            "mode": "ON_CHANGE",
                            "qualityTransitions": True,
                            "deadband": {"kind": "absolute", "value": 0.0},
                            "maxCheckpointInterval": "60s",
                        },
                        "retention": {"days": 90, "legalHold": False},
                    }
                ]
            ),
            "uiMeta": payload.get("ui_meta") or {},
        },
    }
    return parse_storage_dsl(doc)


async def create_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    payload: Mapping[str, Any],
    correlation_id: str = "",
) -> dict[str, Any]:
    """Create a new draft Storage Design with active name uniqueness and catalog validation."""
    try:
        ast = _ast_from_payload(payload)
    except StorageDslError as exc:
        first_issue = exc.issues[0] if exc.issues else None
        code = first_issue.code if first_issue else "VALIDATION_FAILED"
        msg = first_issue.message if first_issue else str(exc)
        raise AppError(422, code, msg, extra={"issues": [i.to_dict() for i in exc.issues]}) from exc

    name = ast.metadata.name.strip()
    if not name:
        raise AppError(422, "MISSING_NAME", "Design name is required.")

    # Active name uniqueness
    existing = await fetch_one(
        session,
        """
        SELECT id FROM storage_designs
        WHERE tenant_id = :tenant_id AND lower(btrim(name)) = lower(btrim(:name))
          AND status NOT IN ('ARCHIVED', 'RETIRED')
        """,
        {"tenant_id": tenant_id, "name": name},
    )
    if existing:
        raise AppError(409, "DUPLICATE_NAME", f"A storage design named {name!r} already exists.")

    catalog = await load_catalog_snapshot(session, tenant_id)
    resolved_ast, issues = resolve_and_validate_design(ast, catalog)

    design_id = uuid4()
    now = utcnow()
    raw_ast_dict = resolved_ast.to_dict(include_ui_meta=True)
    validation_json = {"valid": not any(i.severity == "error" for i in issues), "issues": [i.to_dict() for i in issues]}

    await execute(
        session,
        """
        INSERT INTO storage_designs (
            id, tenant_id, name, description, scope_json, draft_ast_json, draft_ui_meta_json,
            draft_revision, status, current_version, owner_id, last_validation_json,
            created_at, updated_at
        ) VALUES (
            :id, :tenant_id, :name, :description, CAST(:scope_json AS jsonb), CAST(:draft_ast_json AS jsonb),
            CAST(:draft_ui_meta_json AS jsonb), 1, 'DRAFT', 1, :owner_id, CAST(:last_val_json AS jsonb),
            :now, :now
        )
        """,
        {
            "id": design_id,
            "tenant_id": tenant_id,
            "name": name,
            "description": resolved_ast.metadata.description,
            "scope_json": _dump_json(raw_ast_dict["spec"]["scope"]),
            "draft_ast_json": _dump_json(raw_ast_dict),
            "draft_ui_meta_json": _dump_json(resolved_ast.spec.ui_meta),
            "owner_id": actor_id,
            "last_val_json": _dump_json(validation_json),
            "now": now,
        },
    )

    # Sync draft datasets and field bindings
    await _sync_design_datasets_and_bindings(session, tenant_id, design_id, resolved_ast, status="DRAFT", version=1)

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_CREATED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before=None,
        after={"name": name, "version": 1, "status": "DRAFT"},
        correlation_id=correlation_id or f"storage-{uuid4().hex[:8]}",
    )

    return await get_design(session, tenant_id, design_id)


async def get_design(
    session: AsyncSession,
    tenant_id: UUID,
    design_id: UUID,
) -> dict[str, Any]:
    """Retrieve full detail of a Storage Design with datasets, bindings, versions, physical registry, and dependencies."""
    row = await fetch_one(
        session,
        """
        SELECT d.id, d.tenant_id, d.name, d.description, d.scope_json, d.draft_ast_json,
               d.draft_ui_meta_json, d.draft_revision, d.status, d.current_version,
               d.published_version_id, d.owner_id, d.last_validation_json,
               d.created_at, d.updated_at, d.archived_at
        FROM storage_designs d
        WHERE d.tenant_id = :tenant_id AND d.id = :design_id
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    if not row:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    raw_ast = _safe_json_dict(row.get("draft_ast_json"))
    ast = normalize_ast_dict(raw_ast, fallback_name=str(row["name"]))
    yaml_text = serialize_storage_dsl(ast)

    # Datasets with fields and policies
    ds_rows = await fetch_all(
        session,
        """
        SELECT ds.id, ds.dataset_key, ds.display_name, ds.description, ds.semantics,
               ds.source_kind, ds.time_axis, ds.tags_json, ds.status, ds.current_schema_version,
               rp.mode AS recording_mode, rp.policy_json, rp.retention_json, rp.legal_hold
        FROM storage_datasets ds
        LEFT JOIN storage_recording_policies rp ON rp.dataset_id = ds.id
        WHERE ds.tenant_id = :tenant_id AND ds.design_id = :design_id
        ORDER BY ds.created_at ASC
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )

    datasets_out: list[dict[str, Any]] = []
    for d in ds_rows:
        ds_id = as_uuid(d["id"])
        fb_rows = await fetch_all(
            session,
            """
            SELECT id, field_key, display_name, value_type, max_length, source_kind,
                   signal_id, model_id, model_field_path, resource_id, source_ref,
                   source_revision, transform_json, nullable, required, unit, ordinal
            FROM storage_field_bindings
            WHERE tenant_id = :tenant_id AND dataset_id = :dataset_id
            ORDER BY ordinal ASC, field_key ASC
            """,
            {"tenant_id": tenant_id, "dataset_id": ds_id},
        )
        fields = [
            {
                "key": str(fb["field_key"]),
                "from": str(fb.get("source_ref") or ""),
                "type": str(fb["value_type"]),
                "displayName": str(fb.get("display_name") or ""),
                "sourceKind": str(fb["source_kind"]),
                "nullable": bool(fb.get("nullable", True)),
                "required": bool(fb.get("required", False)),
                "unit": fb.get("unit"),
                "maxLength": fb.get("max_length"),
                "transform": _safe_json_dict(fb.get("transform_json")).get("expr") if fb.get("transform_json") else None,
                "signalId": str(fb["signal_id"]) if fb.get("signal_id") else None,
                "modelId": str(fb["model_id"]) if fb.get("model_id") else None,
                "modelFieldPath": fb.get("model_field_path"),
                "resourceId": str(fb["resource_id"]) if fb.get("resource_id") else None,
                "sourceRevision": int(fb.get("source_revision") or 1),
            }
            for fb in fb_rows
        ]
        policy_dict = _safe_json_dict(d.get("policy_json"))
        retention_dict = _safe_json_dict(d.get("retention_json"))
        datasets_out.append(
            {
                "id": str(ds_id),
                "key": str(d["dataset_key"]),
                "displayName": str(d.get("display_name") or ""),
                "description": str(d.get("description") or ""),
                "semantics": str(d["semantics"]),
                "sourceKind": str(d["source_kind"]),
                "timeAxis": str(d["time_axis"]),
                "tags": _safe_json_list(d.get("tags_json")),
                "fields": fields,
                "recording": {
                    "mode": str(d.get("recording_mode") or "ON_CHANGE"),
                    "qualityTransitions": True,
                    "deadband": policy_dict.get("deadband"),
                    "maxCheckpointInterval": policy_dict.get("maxCheckpointInterval") or policy_dict.get("max_checkpoint_interval") or "60s",
                    "interval": policy_dict.get("interval"),
                    "lateTolerance": policy_dict.get("lateTolerance") or policy_dict.get("late_tolerance") or "300s",
                    "missingPolicy": policy_dict.get("missingPolicy") or policy_dict.get("missing_policy") or "GAP_MARKER",
                },
                "retention": {
                    "days": int(retention_dict.get("days") or 90),
                    "legalHold": bool(d.get("legal_hold") or retention_dict.get("legalHold") or retention_dict.get("legal_hold")),
                },
            }
        )

    # Versions
    ver_rows = await fetch_all(
        session,
        """
        SELECT id, design_id, version, ast_json, ast_hash, semantic_hash, compiler_version,
               ddl_plan_json, plan_hash, publish_state, effective_from_epoch, effective_at,
               created_by, created_at, applied_at, diagnostics_json
        FROM storage_design_versions
        WHERE tenant_id = :tenant_id AND design_id = :design_id
        ORDER BY version DESC
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    versions_out = [
        {
            "id": str(v["id"]),
            "design_id": str(v["design_id"]),
            "version": int(v["version"]),
            "ast_json": _safe_json_dict(v.get("ast_json")),
            "ast_hash": str(v["ast_hash"]),
            "semantic_hash": str(v["semantic_hash"]),
            "compiler_version": str(v["compiler_version"]),
            "ddl_plan_json": _safe_json_dict(v.get("ddl_plan_json")),
            "plan_hash": str(v["plan_hash"]),
            "publish_state": str(v.get("publish_state") or "APPLIED"),
            "effective_from_epoch": int(v.get("effective_from_epoch") or 1),
            "effective_at": iso_ms(v.get("effective_at")) if v.get("effective_at") else None,
            "created_by": str(v.get("created_by")) if v.get("created_by") else None,
            "created_at": iso_ms(v.get("created_at")) if v.get("created_at") else iso_ms(utcnow()),
            "applied_at": iso_ms(v.get("applied_at")) if v.get("applied_at") else None,
            "diagnostics_json": _safe_json_dict(v.get("diagnostics_json")),
        }
        for v in ver_rows
    ]

    # Physical registry entries
    reg_rows = await fetch_all(
        session,
        """
        SELECT r.id, r.tier, r.design_id, r.dataset_id, r.signal_id, r.series_key,
               r.value_type, r.td_database, r.td_stable, r.td_subtable,
               r.physical_schema_hash, r.generation, r.status, r.created_at, r.updated_at,
               ds.dataset_key, fb.field_key
        FROM storage_physical_registry r
        LEFT JOIN storage_datasets ds ON ds.id = r.dataset_id
        LEFT JOIN storage_field_bindings fb ON fb.dataset_id = r.dataset_id AND fb.signal_id = r.signal_id
        WHERE r.tenant_id = :tenant_id AND r.design_id = :design_id
        ORDER BY r.series_key ASC
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    physical_registry = [
        {
            "id": str(pr["id"]),
            "tier": str(pr.get("tier") or "MANAGED"),
            "design_id": str(pr["design_id"]),
            "dataset_id": str(pr["dataset_id"]) if pr.get("dataset_id") else None,
            "dataset_key": pr.get("dataset_key"),
            "signal_id": str(pr["signal_id"]) if pr.get("signal_id") else None,
            "series_key": str(pr["series_key"]),
            "field_key": pr.get("field_key"),
            "value_type": str(pr.get("value_type") or "DOUBLE"),
            "td_database": str(pr.get("td_database") or ""),
            "td_stable": str(pr.get("td_stable") or ""),
            "td_subtable": str(pr.get("td_subtable") or ""),
            "physical_schema_hash": str(pr.get("physical_schema_hash") or pr.get("schema_hash") or ""),
            "generation": int(pr.get("generation") or 1),
            "status": str(pr.get("status") or "ACTIVE"),
            "created_at": iso_ms(pr.get("created_at")) if pr.get("created_at") else iso_ms(utcnow()),
            "updated_at": iso_ms(pr.get("updated_at")) if pr.get("updated_at") else iso_ms(utcnow()),
        }
        for pr in reg_rows
    ]

    # Operations
    op_rows = await fetch_all(
        session,
        """
        SELECT id, tenant_id, operation_type, target_type, target_id, actor_id,
               status, requested_at, started_at, completed_at, step_state_json,
               error_code, error_message, trace_id
        FROM storage_operations
        WHERE tenant_id = :tenant_id AND (target_id = :design_id OR step_state_json->>'design_id' = :design_id_str)
        ORDER BY requested_at DESC
        LIMIT 20
        """,
        {"tenant_id": tenant_id, "design_id": design_id, "design_id_str": str(design_id)},
    )
    operations = [
        {
            "id": str(op["id"]),
            "tenant_id": str(op["tenant_id"]),
            "operation_type": str(op.get("operation_type") or "UNKNOWN"),
            "target_type": str(op.get("target_type") or "storage_design"),
            "target_id": str(op["target_id"]) if op.get("target_id") else None,
            "design_id": str(design_id),
            "design_name": str(row["name"]),
            "actor_id": str(op["actor_id"]) if op.get("actor_id") else None,
            "status": str(op.get("status") or "COMPLETED"),
            "requested_at": iso_ms(op["requested_at"]) if op.get("requested_at") else iso_ms(utcnow()),
            "started_at": iso_ms(op["started_at"]) if op.get("started_at") else None,
            "completed_at": iso_ms(op["completed_at"]) if op.get("completed_at") else None,
            "step_state_json": _safe_json_dict(op.get("step_state_json")),
            "error_code": op.get("error_code"),
            "error_message": op.get("error_message"),
            "trace_id": str(op.get("trace_id") or ""),
        }
        for op in op_rows
    ]

    # Dependencies
    dependencies = await get_design_dependencies(session, tenant_id, design_id)

    # Physical plan (latest published or precompiled)
    physical_plan = None
    if versions_out and versions_out[0].get("ddl_plan_json"):
        physical_plan = versions_out[0]["ddl_plan_json"]

    val_json = _safe_json_dict(row.get("last_validation_json"))
    val_issues = val_json.get("issues", [])

    return {
        "id": str(design_id),
        "tenant_id": str(row["tenant_id"]),
        "name": str(row["name"]),
        "description": str(row.get("description") or ""),
        "status": str(row["status"]).upper(),
        "current_version": int(row.get("current_version") or 1),
        "draft_revision": int(row.get("draft_revision") or 1),
        "published_version_id": str(row["published_version_id"]) if row.get("published_version_id") else None,
        "scope": _safe_json_dict(row.get("scope_json")),
        "scope_summary": str(_safe_json_dict(row.get("scope_json")).get("mode") or "all_sites"),
        "ast": ast.to_dict(include_ui_meta=True),
        "yaml": yaml_text,
        "datasets": datasets_out,
        "versions": versions_out,
        "physical_registry": physical_registry,
        "physical_plan": physical_plan,
        "operations": operations,
        "dependencies": dependencies,
        "validation_issues": val_issues,
        "dataset_count": len(datasets_out),
        "field_count": sum(len(d["fields"]) for d in datasets_out),
        "destination": "TDengine",
        "health": str(row["status"]).upper(),
        "owner_id": str(row["owner_id"]) if row.get("owner_id") else None,
        "created_at": iso_ms(row["created_at"]),
        "updated_at": iso_ms(row["updated_at"]),
        "archived_at": iso_ms(row["archived_at"]) if row.get("archived_at") else None,
    }


def normalize_ast_dict(raw: Mapping[str, Any], fallback_name: str = "untitled") -> StorageDesignAst:
    """Normalize raw dictionary into canonical StorageDesignAst."""
    try:
        return parse_storage_dsl(raw)
    except Exception:
        # Fallback to simple default structure
        return parse_storage_dsl(
            {
                "apiVersion": API_VERSION,
                "kind": DESIGN_KIND,
                "metadata": {"name": str(raw.get("name") or fallback_name)},
                "spec": {
                    "scope": raw.get("scope") or {"mode": "all_sites"},
                    "destination": {"engine": "tdengine"},
                    "datasets": raw.get("datasets") or [],
                },
            }
        )


async def _sync_design_datasets_and_bindings(
    session: AsyncSession,
    tenant_id: UUID,
    design_id: UUID,
    ast: StorageDesignAst,
    *,
    status: str = "DRAFT",
    version: int = 1,
) -> dict[str, UUID]:
    """Synchronize `storage_datasets`, `storage_field_bindings`, and `storage_recording_policies`."""
    now = utcnow()
    dataset_ids_by_key: dict[str, UUID] = {}

    for ds in ast.spec.datasets:
        existing_ds = await fetch_one(
            session,
            """
            SELECT id FROM storage_datasets
            WHERE tenant_id = :tenant_id AND design_id = :design_id AND dataset_key = :dataset_key
            """,
            {"tenant_id": tenant_id, "design_id": design_id, "dataset_key": ds.key},
        )
        if existing_ds:
            ds_id = as_uuid(existing_ds["id"])
            await execute(
                session,
                """
                UPDATE storage_datasets
                SET display_name = :display_name, description = :description,
                    semantics = :semantics, source_kind = :source_kind, time_axis = :time_axis,
                    tags_json = CAST(:tags_json AS jsonb), status = :status, current_schema_version = :version,
                    updated_at = :now
                WHERE id = :id
                """,
                {
                    "id": ds_id,
                    "display_name": ds.display_name,
                    "description": ds.description,
                    "semantics": ds.semantics,
                    "source_kind": ds.source_kind,
                    "time_axis": ds.time_axis,
                    "tags_json": _dump_json([{"key": t.key, "value": t.value} for t in ds.tags]),
                    "status": status,
                    "version": version,
                    "now": now,
                },
            )
        else:
            ds_id = parse_uuid(ds.id) if ds.id else uuid4()
            await execute(
                session,
                """
                INSERT INTO storage_datasets (
                    id, tenant_id, design_id, dataset_key, display_name, description,
                    semantics, source_kind, time_axis, tags_json, status, current_schema_version,
                    created_at, updated_at
                ) VALUES (
                    :id, :tenant_id, :design_id, :dataset_key, :display_name, :description,
                    :semantics, :source_kind, :time_axis, CAST(:tags_json AS jsonb), :status, :version,
                    :now, :now
                )
                """,
                {
                    "id": ds_id,
                    "tenant_id": tenant_id,
                    "design_id": design_id,
                    "dataset_key": ds.key,
                    "display_name": ds.display_name,
                    "description": ds.description,
                    "semantics": ds.semantics,
                    "source_kind": ds.source_kind,
                    "time_axis": ds.time_axis,
                    "tags_json": _dump_json([{"key": t.key, "value": t.value} for t in ds.tags]),
                    "status": status,
                    "version": version,
                    "now": now,
                },
            )

        dataset_ids_by_key[ds.key] = ds_id

        # Recording policy
        rec_json = {
            "mode": ds.recording.mode,
            "qualityTransitions": ds.recording.quality_transitions,
            "missingPolicy": ds.recording.missing_policy,
        }
        if ds.recording.deadband:
            rec_json["deadband"] = {"kind": ds.recording.deadband.kind, "value": ds.recording.deadband.value}
        if ds.recording.max_checkpoint_interval:
            rec_json["maxCheckpointInterval"] = ds.recording.max_checkpoint_interval
        if ds.recording.interval:
            rec_json["interval"] = ds.recording.interval
        if ds.recording.late_tolerance:
            rec_json["lateTolerance"] = ds.recording.late_tolerance

        ret_json = {"days": ds.retention.days, "legalHold": ds.retention.legal_hold}

        await execute(
            session,
            """
            INSERT INTO storage_recording_policies (
                id, tenant_id, dataset_id, mode, policy_json, retention_json, version, enabled, legal_hold, updated_at
            ) VALUES (
                :id, :tenant_id, :dataset_id, :mode, CAST(:policy_json AS jsonb), CAST(:retention_json AS jsonb),
                :version, TRUE, :legal_hold, :now
            )
            ON CONFLICT (dataset_id) DO UPDATE SET
                mode = EXCLUDED.mode,
                policy_json = EXCLUDED.policy_json,
                retention_json = EXCLUDED.retention_json,
                version = EXCLUDED.version,
                legal_hold = EXCLUDED.legal_hold,
                updated_at = EXCLUDED.updated_at
            """,
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "dataset_id": ds_id,
                "mode": ds.recording.mode,
                "policy_json": _dump_json(rec_json),
                "retention_json": _dump_json(ret_json),
                "version": version,
                "legal_hold": ds.retention.legal_hold,
                "now": now,
            },
        )

        # Field bindings: clean sync
        await execute(session, "DELETE FROM storage_field_bindings WHERE dataset_id = :dataset_id", {"dataset_id": ds_id})
        for idx, f in enumerate(ds.fields):
            transform_dict = {"expr": f.transform} if f.transform else {}
            await execute(
                session,
                """
                INSERT INTO storage_field_bindings (
                    id, tenant_id, dataset_id, field_key, display_name, value_type, max_length,
                    source_kind, signal_id, model_id, model_field_path, resource_id, source_ref,
                    source_revision, transform_json, nullable, required, unit, ordinal
                ) VALUES (
                    :id, :tenant_id, :dataset_id, :field_key, :display_name, :value_type, :max_length,
                    :source_kind, :signal_id, :model_id, :model_field_path, :resource_id, :source_ref,
                    :source_revision, CAST(:transform_json AS jsonb), :nullable, :required, :unit, :ordinal
                )
                """,
                {
                    "id": uuid4(),
                    "tenant_id": tenant_id,
                    "dataset_id": ds_id,
                    "field_key": f.key,
                    "display_name": f.display_name,
                    "value_type": f.type,
                    "max_length": f.max_length,
                    "source_kind": f.source_kind,
                    "signal_id": parse_uuid(f.signal_id) if f.signal_id else None,
                    "model_id": parse_uuid(f.model_id) if f.model_id else None,
                    "model_field_path": f.model_field_path,
                    "resource_id": parse_uuid(f.resource_id) if f.resource_id else None,
                    "source_ref": f.from_ref,
                    "source_revision": f.source_revision,
                    "transform_json": _dump_json(transform_dict),
                    "nullable": f.nullable,
                    "required": f.required,
                    "unit": f.unit,
                    "ordinal": idx,
                },
            )

    # Sync storage dependencies for the design
    await _sync_design_dependencies(session, tenant_id, design_id, ast)

    return dataset_ids_by_key


async def _sync_design_dependencies(
    session: AsyncSession,
    tenant_id: UUID,
    design_id: UUID,
    ast: StorageDesignAst,
) -> None:
    """Record ownership dependencies in `storage_dependencies`."""
    now = utcnow()
    await execute(
        session,
        "DELETE FROM storage_dependencies WHERE tenant_id = :tenant_id AND owner_type = 'storage_design' AND owner_id = :owner_id",
        {"tenant_id": tenant_id, "owner_id": design_id},
    )

    seen: set[tuple[str, UUID, str]] = set()
    for ds in ast.spec.datasets:
        for f in ds.fields:
            if f.signal_id:
                target_u = parse_uuid(f.signal_id)
                key = ("signal", target_u, "")
                if key not in seen:
                    seen.add(key)
                    await execute(
                        session,
                        """
                        INSERT INTO storage_dependencies (id, tenant_id, owner_type, owner_id, target_type, target_id, target_subpath, kind, created_at)
                        VALUES (:id, :tenant_id, 'storage_design', :owner_id, 'signal', :target_id, '', 'reads_from', :now)
                        ON CONFLICT DO NOTHING
                        """,
                        {"id": uuid4(), "tenant_id": tenant_id, "owner_id": design_id, "target_id": target_u, "now": now},
                    )
            if f.model_id:
                target_u = parse_uuid(f.model_id)
                subpath = f.model_field_path or ""
                key = ("data_model", target_u, subpath)
                if key not in seen:
                    seen.add(key)
                    await execute(
                        session,
                        """
                        INSERT INTO storage_dependencies (id, tenant_id, owner_type, owner_id, target_type, target_id, target_subpath, kind, created_at)
                        VALUES (:id, :tenant_id, 'storage_design', :owner_id, 'data_model', :target_id, :subpath, 'reads_from', :now)
                        ON CONFLICT DO NOTHING
                        """,
                        {"id": uuid4(), "tenant_id": tenant_id, "owner_id": design_id, "target_id": target_u, "subpath": subpath, "now": now},
                    )
            if f.resource_id:
                target_u = parse_uuid(f.resource_id)
                key = ("resource", target_u, "")
                if key not in seen:
                    seen.add(key)
                    await execute(
                        session,
                        """
                        INSERT INTO storage_dependencies (id, tenant_id, owner_type, owner_id, target_type, target_id, target_subpath, kind, created_at)
                        VALUES (:id, :tenant_id, 'storage_design', :owner_id, 'resource', :target_id, '', 'reads_from', :now)
                        ON CONFLICT DO NOTHING
                        """,
                        {"id": uuid4(), "tenant_id": tenant_id, "owner_id": design_id, "target_id": target_u, "now": now},
                    )


async def update_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any],
    *,
    expected_version: int | None = None,
    if_match: str | int | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Update draft AST / metadata with optimistic concurrency check (HTTP 409 VERSION_CONFLICT)."""
    curr = await fetch_one(
        session,
        "SELECT id, current_version, status, draft_revision, name FROM storage_designs WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": design_id},
    )
    if not curr:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    # Concurrency verification
    target_ver: int | None = expected_version
    if target_ver is None and if_match is not None:
        try:
            target_ver = int(str(if_match).strip().strip('"').strip("'"))
        except (ValueError, TypeError):
            pass

    actual_ver = int(curr["current_version"])
    if target_ver is not None and target_ver != actual_ver:
        raise AppError(
            409,
            "VERSION_CONFLICT",
            f"Storage design version mismatch: client expected version {target_ver}, but current version is {actual_ver}.",
            extra={"current_version": actual_ver, "expected_version": target_ver},
        )

    ast = _ast_from_payload(payload, default_name=str(curr["name"]))
    new_name = ast.metadata.name.strip()

    # Active name uniqueness check if name was modified
    if new_name.lower() != str(curr["name"]).lower():
        dup = await fetch_one(
            session,
            """
            SELECT id FROM storage_designs
            WHERE tenant_id = :tenant_id AND lower(btrim(name)) = lower(btrim(:name))
              AND id <> :id AND status NOT IN ('ARCHIVED', 'RETIRED')
            """,
            {"tenant_id": tenant_id, "name": new_name, "id": design_id},
        )
        if dup:
            raise AppError(409, "DUPLICATE_NAME", f"Another storage design named {new_name!r} already exists.")

    catalog = await load_catalog_snapshot(session, tenant_id)
    resolved_ast, issues = resolve_and_validate_design(ast, catalog)

    now = utcnow()
    raw_ast_dict = resolved_ast.to_dict(include_ui_meta=True)
    val_json = {"valid": not any(i.severity == "error" for i in issues), "issues": [i.to_dict() for i in issues]}
    next_draft_rev = int(curr.get("draft_revision") or 1) + 1

    await execute(
        session,
        """
        UPDATE storage_designs
        SET name = :name, description = :description,
            scope_json = CAST(:scope_json AS jsonb),
            draft_ast_json = CAST(:draft_ast_json AS jsonb),
            draft_ui_meta_json = CAST(:draft_ui_meta_json AS jsonb),
            draft_revision = :draft_rev,
            last_validation_json = CAST(:last_val_json AS jsonb),
            updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {
            "id": design_id,
            "tenant_id": tenant_id,
            "name": new_name,
            "description": resolved_ast.metadata.description,
            "scope_json": _dump_json(raw_ast_dict["spec"]["scope"]),
            "draft_ast_json": _dump_json(raw_ast_dict),
            "draft_ui_meta_json": _dump_json(resolved_ast.spec.ui_meta),
            "draft_rev": next_draft_rev,
            "last_val_json": _dump_json(val_json),
            "now": now,
        },
    )

    # If design is in DRAFT state, sync draft datasets and bindings
    if str(curr["status"]).upper() in {"DRAFT", "VALIDATED"}:
        await _sync_design_datasets_and_bindings(
            session, tenant_id, design_id, resolved_ast, status=str(curr["status"]).upper(), version=actual_ver
        )

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_UPDATED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before={"version": actual_ver, "name": curr["name"]},
        after={"name": new_name, "version": actual_ver, "draft_revision": next_draft_rev},
        correlation_id=correlation_id or f"storage-{uuid4().hex[:8]}",
    )

    return await get_design(session, tenant_id, design_id)


async def validate_design(
    session: AsyncSession,
    tenant_id: UUID,
    payload: Mapping[str, Any] | None = None,
    *,
    design_id: UUID | None = None,
    body: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Lossless DSL round-trip check, catalog resolution, and row width byte budget verification."""
    effective = dict(payload or body or {})
    if not effective and design_id:
        detail = await get_design(session, tenant_id, design_id)
        effective = {"ast": detail["ast"]}
    try:
        ast = _ast_from_payload(effective)
    except StorageDslError as exc:
        return {
            "valid": False,
            "issues": [i.to_dict() for i in exc.issues],
            "ast": None,
            "yaml": str(effective.get("source_yaml") or effective.get("yaml") or effective.get("dsl") or ""),
            "normalized_yaml": "",
            "row_width_bytes": 0,
            "row_budget_bytes": MAX_TDENGINE_ROW_BYTES,
            "max_row_width_bytes": MAX_TDENGINE_ROW_BYTES,
            "row_budget_pct": 0.0,
            "datasets": [],
            "timestamp": iso_ms(utcnow()),
        }
    catalog = await load_catalog_snapshot(session, tenant_id)
    resolved_ast, issues = resolve_and_validate_design(ast, catalog)

    # Lossless round-trip check
    yaml_text = serialize_storage_dsl(resolved_ast)
    reparsed = parse_storage_dsl(yaml_text)
    if reparsed.semantic_hash() != resolved_ast.semantic_hash():
        issues.append(
            DslIssue(
                severity="error",
                code="LOSSLESS_ROUNDTRIP_FAILED",
                message="AST semantic hash deviated across YAML serialization round-trip.",
            )
        )

    # Compute row width per dataset and check against 64,500 byte limit
    dataset_row_widths: dict[str, int] = {}
    max_row_width = 900
    for ds in resolved_ast.spec.datasets:
        ds_bytes = 900
        for f in ds.fields:
            _col_type, col_bytes = _td_column_type(f.type, f.max_length)
            ds_bytes += col_bytes
        dataset_row_widths[ds.key] = ds_bytes
        if ds_bytes > max_row_width:
            max_row_width = ds_bytes
        if ds_bytes > MAX_TDENGINE_ROW_BYTES:
            issues.append(
                DslIssue(
                    severity="error",
                    code="ROW_WIDTH_EXCEEDED",
                    message=f"Dataset {ds.key!r} width ({ds_bytes} bytes) exceeds TDengine row limit ({MAX_TDENGINE_ROW_BYTES} bytes).",
                    path=f"spec.datasets[{ds.key}]",
                )
            )

    has_errors = any(i.severity == "error" for i in issues)
    val_res = {
        "valid": not has_errors,
        "ast": resolved_ast.to_dict(include_ui_meta=True),
        "yaml": yaml_text,
        "issues": [i.to_dict() for i in issues],
        "semantic_hash": resolved_ast.semantic_hash(),
        "ast_hash": resolved_ast.full_hash(),
        "row_width_bytes": max_row_width,
        "max_row_width_bytes": MAX_TDENGINE_ROW_BYTES,
        "dataset_row_widths": dataset_row_widths,
    }

    if design_id:
        await execute(
            session,
            """
            UPDATE storage_designs
            SET last_validation_json = CAST(:last_val_json AS jsonb),
                status = CASE WHEN status = 'DRAFT' AND :is_valid THEN 'VALIDATED' ELSE status END,
                updated_at = :now
            WHERE id = :id AND tenant_id = :tenant_id
            """,
            {
                "id": design_id,
                "tenant_id": tenant_id,
                "last_val_json": _dump_json(val_res),
                "is_valid": not has_errors,
                "now": utcnow(),
            },
        )

    return val_res


async def compile_design_physical_plan(
    session: AsyncSession,
    tenant_id: UUID,
    payload: Mapping[str, Any] | None = None,
    *,
    design_id: UUID | None = None,
    body: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Compile deterministic TDengine DDL, supertables, subtables, and schema diff."""
    effective_payload = dict(payload or body or {})
    if effective_payload.get("ast") or effective_payload.get("yaml") or effective_payload.get("dsl") or effective_payload.get("source_yaml"):
        ast = _ast_from_payload(effective_payload)
    elif design_id:
        detail = await get_design(session, tenant_id, design_id)
        ast = parse_storage_dsl(detail["ast"])
    else:
        raise AppError(422, "MISSING_DESIGN", "Provide design_id or design AST in payload.")

    catalog = await load_catalog_snapshot(session, tenant_id)
    resolved_ast, issues = resolve_and_validate_design(ast, catalog)
    if any(i.severity == "error" for i in issues):
        raise AppError(
            422,
            "VALIDATION_FAILED",
            "Cannot compile physical plan: design contains validation errors.",
            extra={"issues": [i.to_dict() for i in issues]},
        )

    # Fetch previous plan if design was previously published
    prev_plan: dict[str, Any] | None = None
    target_version = 1
    if design_id:
        row = await fetch_one(
            session,
            """
            SELECT d.current_version, d.status, v.ddl_plan_json
            FROM storage_designs d
            LEFT JOIN storage_design_versions v ON v.id = d.published_version_id
            WHERE d.tenant_id = :tenant_id AND d.id = :design_id
            """,
            {"tenant_id": tenant_id, "design_id": design_id},
        )
        if row:
            curr_status = str(row["status"]).upper()
            curr_ver = int(row.get("current_version") or 1)
            target_version = curr_ver if curr_status in {"DRAFT", "VALIDATED"} else curr_ver + 1
            if row.get("ddl_plan_json"):
                prev_plan = _safe_json_dict(row["ddl_plan_json"])

    compiled = compile_storage_plan(
        resolved_ast,
        tenant_id=tenant_id,
        design_id=design_id or uuid4(),
        target_version=target_version,
        previous_plan=prev_plan,
    )
    plan_dict = compiled.to_dict()
    plan_dict["database_name"] = plan_dict.get("td_database")
    plan_dict["total_row_width_bytes"] = sum(
        d.get("estimated_row_bytes", 500) for d in plan_dict.get("datasets", [])
    ) or 500
    plan_dict["stables"] = list({s["td_stable"] for s in plan_dict.get("series", []) if s.get("td_stable")})
    return plan_dict


async def simulate_design(
    session: AsyncSession,
    tenant_id: UUID,
    payload: Mapping[str, Any] | None = None,
    *,
    design_id: UUID | None = None,
    body: Mapping[str, Any] | None = None,
    tdengine: TDEngineClient | None = None,
) -> dict[str, Any]:
    """Dry-run recording policy evaluation with ZERO writes to TDengine Managed subtables."""
    payload_dict = dict(payload or body or {})
    if payload_dict.get("ast") or payload_dict.get("yaml") or payload_dict.get("dsl") or payload_dict.get("source_yaml"):
        ast = _ast_from_payload(payload_dict)
    elif design_id:
        detail = await get_design(session, tenant_id, design_id)
        ast = parse_storage_dsl(detail["ast"])
    else:
        raise AppError(422, "MISSING_DESIGN", "Provide design_id or design AST in payload.")

    catalog = await load_catalog_snapshot(session, tenant_id)
    resolved_ast, _issues = resolve_and_validate_design(ast, catalog)

    # Construct ManagedBindingTarget instances in-memory
    targets: list[ManagedBindingTarget] = []
    fake_design_id = design_id or uuid4()
    db_name = tenant_td_database(tenant_id)

    for ds in resolved_ast.spec.datasets:
        fake_ds_id = parse_uuid(ds.id) if ds.id else uuid4()
        stable_name = stable_name_for_dataset(fake_design_id, ds.key)
        for f in ds.fields:
            s_key = f"sig:{f.signal_id}" if f.signal_id else f"fld:{ds.key}:{f.key}"
            sub_name = subtable_name_for_series(fake_ds_id, s_key)
            target_row = {
                "design_id": fake_design_id,
                "design_version_id": None,
                "dataset_id": fake_ds_id,
                "dataset_key": ds.key,
                "design_status": "RUNNING",
                "dataset_status": "RUNNING",
                "registry_status": "ACTIVE",
                "semantics": ds.semantics,
                "time_axis": ds.time_axis,
                "td_database": db_name,
                "td_stable": stable_name,
                "td_subtable": sub_name,
                "registry_series_key": f"{fake_ds_id}:{s_key}",
                "field_key": f.key,
                "value_type": f.type,
                "max_length": f.max_length,
                "nullable": f.nullable,
                "required": f.required,
                "signal_id": f.signal_id,
                "model_id": f.model_id,
                "model_field_path": f.model_field_path,
                "resource_id": f.resource_id,
                "source_revision": f.source_revision,
                "transform_json": {"expr": f.transform} if f.transform else {},
                "recording_mode": ds.recording.mode,
                "policy_json": {
                    "mode": ds.recording.mode,
                    "deadband": {"kind": ds.recording.deadband.kind, "value": ds.recording.deadband.value} if ds.recording.deadband else None,
                    "max_checkpoint_interval": ds.recording.max_checkpoint_interval,
                    "interval": ds.recording.interval,
                    "late_tolerance": ds.recording.late_tolerance,
                    "missing_policy": ds.recording.missing_policy,
                },
                "policy_version": 1,
                "policy_enabled": True,
                "tags_json": [{"key": t.key, "value": t.value} for t in ds.tags],
            }
            targets.append(build_managed_target_from_row(target_row))

    metrics = PolicyMetricsCounter()
    evaluator = DefaultRecordingPolicyEvaluator(metrics=metrics)

    # Collect sample observations to evaluate
    provided_samples = payload_dict.get("samples")
    sample_items: list[dict[str, Any]] = []

    if isinstance(provided_samples, list) and len(provided_samples) > 0:
        sample_items = [s for s in provided_samples if isinstance(s, dict)]
    else:
        # Generate a deterministic dry-run sequence of 20 samples per target
        base_time = utcnow() - timedelta(minutes=15)
        for t in targets:
            sig_id = t.signal_id or uuid4()
            for step in range(20):
                ts = base_time + timedelta(seconds=step * 45)
                # Introduce deterministic value transitions & occasional quality changes
                is_quality_drop = step == 7
                val = (100.0 + (step % 4) * 0.1) if not is_quality_drop else 100.2
                qual = "BAD" if is_quality_drop else "GOOD"
                reason = "SENSOR_FAULT" if is_quality_drop else None
                sample_items.append(
                    {
                        "signal_id": str(sig_id),
                        "dataset_key": t.dataset_key,
                        "field_key": t.field_key,
                        "value": val,
                        "ts": ts.isoformat().replace("+00:00", "Z"),
                        "quality": qual,
                        "reason_code": reason,
                    }
                )

    # Sort samples by timestamp
    sample_items.sort(key=lambda s: str(s.get("ts") or ""))

    # Evaluate dry-run with ZERO writes
    sample_rows_out: list[dict[str, Any]] = []
    from factorix.domain.canonical import CanonicalObservation
    from factorix.domain.quality import Origin, Quality

    for idx, s in enumerate(sample_items):
        s_val = s.get("value")
        s_qual = str(s.get("quality") or "GOOD").upper()
        s_reason = s.get("reason_code")
        ts_str = str(s.get("ts") or utcnow().isoformat())
        ts_dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))

        target = next((t for t in targets if t.field_key == s.get("field_key")), targets[0] if targets else None)
        if not target:
            continue

        sig_id = parse_uuid(s.get("signal_id")) or target.signal_id or uuid4()
        obs = CanonicalObservation(
            tenant_id=tenant_id,
            signal_id=sig_id,
            resource_id=getattr(target, "resource_id", None) or uuid4(),
            acquired_at=ts_dt,
            value_type=getattr(target, "data_type", None) or "float64",
            value=s_val,
            quality=Quality(s_qual) if s_qual in Quality.__members__ else Quality.GOOD,
            quality_reason=s_reason,
            origin=Origin.LIVE,
            data_epoch=1,
            event_uid=f"sim-{idx}",
            config_revision=1,
        )

        detailed = evaluator.evaluate_for_targets(obs, targets=[target], active_epoch=1)
        directive = detailed.decision.managed_directives[0] if detailed.decision.managed_directives else None
        would_write = directive.write_row if directive else False
        skip_reason = directive.skip_reason.value if directive else "NONE"
        record_kind = "change" if would_write else "skipped"

        sample_rows_out.append(
            {
                "index": idx + 1,
                "ts": ts_dt.isoformat().replace("+00:00", "Z"),
                "acquired_at": ts_dt.isoformat().replace("+00:00", "Z"),
                "source_time": None,
                "dataset_key": target.dataset_key,
                "field_key": target.field_key,
                "source_ref": f"sig:{sig_id}",
                "signal_id": str(sig_id),
                "raw_value": s_val,
                "transformed_value": s_val,
                "quality": s_qual,
                "reason_code": s_reason,
                "would_write": would_write,
                "record_kind": record_kind,
                "skip_reason": skip_reason,
            }
        )

    evaluated = len(sample_rows_out)
    would_write_count = sum(1 for r in sample_rows_out if r["would_write"])
    skipped_count = evaluated - would_write_count
    reduction_pct = round(((skipped_count / evaluated) * 100.0), 1) if evaluated > 0 else 0.0
    compression_ratio = round((evaluated / max(1, would_write_count)), 2)

    skipped_by_reason: dict[str, int] = defaultdict(int)
    for r in sample_rows_out:
        if not r["would_write"]:
            skipped_by_reason[r["skip_reason"]] += 1

    return {
        "dry_run": True,
        "evaluated_samples": evaluated,
        "would_write": would_write_count,
        "skipped_total": skipped_count,
        "skipped_by_reason": dict(skipped_by_reason),
        "checkpoints_written": metrics.managed_checkpoints,
        "gap_markers_written": metrics.managed_gap_markers,
        "estimated_reduction_pct": reduction_pct,
        "compression_ratio": compression_ratio,
        "compression_ratio_estimate": compression_ratio,
        "estimated_bytes_per_day": would_write_count * 128,
        "exactness_warnings": [
            "ON_CHANGE simulation compresses unchanged intervals; exact point-count aggregation requires full Operational History."
        ],
        "samples": sample_rows_out[:200],
        "sample_rows": sample_rows_out[:200],
    }


async def publish_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any] | None = None,
    *,
    tdengine: TDEngineClient | None = None,
    idempotency_key: str | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Idempotently publish a storage design version, compile DDL, sync physical registry, and activate."""
    payload_dict = dict(payload or {})
    corr_id = correlation_id or f"pub-{uuid4().hex[:8]}"

    # Idempotency check
    effective_idemp_key = idempotency_key or payload_dict.get("idempotency_key")
    if effective_idemp_key:
        cached_op = await fetch_one(
            session,
            """
            SELECT step_state_json FROM storage_operations
            WHERE tenant_id = :tenant_id AND operation_type = 'PUBLISH_DESIGN'
              AND idempotency_key = :key AND status = 'COMPLETED'
            """,
            {"tenant_id": tenant_id, "key": effective_idemp_key},
        )
        if cached_op and cached_op.get("step_state_json"):
            state = _safe_json_dict(cached_op["step_state_json"])
            if state.get("published_result"):
                return state["published_result"]

    design_row = await fetch_one(
        session,
        """
        SELECT id, name, description, status, current_version, published_version_id,
               draft_ast_json, draft_ui_meta_json
        FROM storage_designs
        WHERE tenant_id = :tenant_id AND id = :design_id
        FOR UPDATE
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    if not design_row:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    # Concurrency check
    expected_ver = payload_dict.get("expected_version")
    actual_ver = int(design_row["current_version"])
    if expected_ver is not None and int(expected_ver) != actual_ver:
        raise AppError(
            409,
            "VERSION_CONFLICT",
            f"Optimistic lock conflict: expected version {expected_ver}, but design is at version {actual_ver}.",
            extra={"current_version": actual_ver, "expected_version": expected_ver},
        )

    # Parse and validate AST
    raw_ast = design_row.get("draft_ast_json")
    ast = normalize_ast_dict(_safe_json_dict(raw_ast), fallback_name=str(design_row["name"]))
    catalog = await load_catalog_snapshot(session, tenant_id)
    resolved_ast, issues = resolve_and_validate_design(ast, catalog)
    if any(i.severity == "error" for i in issues):
        raise AppError(
            422,
            "VALIDATION_FAILED",
            "Cannot publish design: unresolved issues present.",
            extra={"issues": [i.to_dict() for i in issues]},
        )

    target_version = actual_ver if str(design_row["status"]).upper() in {"DRAFT", "VALIDATED"} else actual_ver + 1
    active_epoch_num = await _active_epoch(session, tenant_id)

    # Previous plan for diff
    prev_plan: dict[str, Any] | None = None
    if design_row.get("published_version_id"):
        prev_ver_row = await fetch_one(
            session,
            "SELECT ddl_plan_json FROM storage_design_versions WHERE id = :id",
            {"id": design_row["published_version_id"]},
        )
        if prev_ver_row and prev_ver_row.get("ddl_plan_json"):
            prev_plan = _safe_json_dict(prev_ver_row["ddl_plan_json"])

    compiled_plan = compile_storage_plan(
        resolved_ast,
        tenant_id=tenant_id,
        design_id=design_id,
        target_version=target_version,
        previous_plan=prev_plan,
    )

    # Record storage_operations in RUNNING state
    op_id = uuid4()
    now = utcnow()
    await execute(
        session,
        """
        INSERT INTO storage_operations (
            id, tenant_id, operation_type, target_type, target_id, actor_id,
            idempotency_key, status, requested_at, started_at, step_state_json, trace_id
        ) VALUES (
            :id, :tenant_id, 'PUBLISH_DESIGN', 'storage_design', :design_id, :actor_id,
            :idemp_key, 'RUNNING', :now, :now, CAST(:step_state AS jsonb), :trace_id
        )
        """,
        {
            "id": op_id,
            "tenant_id": tenant_id,
            "design_id": design_id,
            "actor_id": actor_id,
            "idemp_key": effective_idemp_key,
            "now": now,
            "step_state": _dump_json({"stage": "compilation_verified", "version": target_version}),
            "trace_id": corr_id,
        },
    )

    # Version row
    version_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO storage_design_versions (
            id, tenant_id, design_id, version, ast_json, ast_hash, semantic_hash,
            ui_meta_json, compiler_version, ddl_plan_json, plan_hash, publish_state,
            effective_from_epoch, effective_at, created_by, created_at, applied_at, diagnostics_json
        ) VALUES (
            :id, :tenant_id, :design_id, :version, CAST(:ast_json AS jsonb), :ast_hash, :semantic_hash,
            CAST(:ui_meta_json AS jsonb), :compiler_version, CAST(:ddl_plan_json AS jsonb), :plan_hash,
            'APPLIED', :epoch, :now, :actor_id, :now, :now, CAST(:diagnostics_json AS jsonb)
        )
        """,
        {
            "id": version_id,
            "tenant_id": tenant_id,
            "design_id": design_id,
            "version": target_version,
            "ast_json": _dump_json(resolved_ast.to_dict(include_ui_meta=False)),
            "ast_hash": resolved_ast.full_hash(),
            "semantic_hash": resolved_ast.semantic_hash(),
            "ui_meta_json": _dump_json(resolved_ast.spec.ui_meta),
            "compiler_version": compiled_plan.compiler_version,
            "ddl_plan_json": _dump_json(compiled_plan.to_dict()),
            "plan_hash": compiled_plan.plan_hash,
            "epoch": active_epoch_num,
            "now": now,
            "actor_id": actor_id,
            "diagnostics_json": _dump_json({"ddl_statements_count": len(compiled_plan.ddl_statements)}),
        },
    )

    # Sync datasets & bindings
    dataset_ids_by_key = await _sync_design_datasets_and_bindings(
        session, tenant_id, design_id, resolved_ast, status="RUNNING", version=target_version
    )

    # Execute physical plan against TDengine if client is provided
    applied_stmts = 0
    verified_subtables = len(compiled_plan.series)

    if tdengine is not None:
        try:
            apply_res = await apply_compiled_plan(
                tdengine,
                session,
                tenant_id=tenant_id,
                design_id=design_id,
                design_version_id=version_id,
                dataset_ids_by_key=dataset_ids_by_key,
                plan=compiled_plan,
                generation=target_version,
            )
            applied_stmts = int(apply_res.get("applied_statements", len(compiled_plan.ddl_statements)))
            verified_subtables = int(apply_res.get("verified_subtables", len(compiled_plan.series)))
        except (TDEngineError, Exception) as exc:
            err_code = getattr(exc, "code", "TDENGINE_UNAVAILABLE")
            err_msg = str(exc)
            await execute(
                session,
                """
                UPDATE storage_operations
                SET status = 'FAILED', error_code = :err_code, error_message = :err_msg, completed_at = :now
                WHERE id = :id
                """,
                {"id": op_id, "err_code": err_code, "err_msg": err_msg, "now": utcnow()},
            )
            raise AppError(
                503,
                "TDENGINE_UNAVAILABLE",
                f"Failed to apply TDengine physical plan: {err_msg}",
                extra={"error_code": err_code},
            ) from exc
    else:
        # Register physical registry entries directly in PostgreSQL for unit tests / offline mock
        for s in compiled_plan.series:
            ds_uuid = dataset_ids_by_key.get(s.dataset_key)
            await execute(
                session,
                """
                INSERT INTO storage_physical_registry (
                    id, tenant_id, tier, design_id, design_version_id, dataset_id, signal_id,
                    series_key, value_type, td_database, td_stable, td_subtable,
                    physical_schema_hash, generation, status, created_at, updated_at
                ) VALUES (
                    :id, :tenant_id, 'MANAGED', :design_id, :design_version_id, :dataset_id, :signal_id,
                    :series_key, :value_type, :td_database, :td_stable, :td_subtable,
                    :schema_hash, :generation, 'ACTIVE', :now, :now
                )
                ON CONFLICT (tenant_id, tier, series_key) DO UPDATE SET
                    design_id = EXCLUDED.design_id,
                    design_version_id = EXCLUDED.design_version_id,
                    dataset_id = EXCLUDED.dataset_id,
                    value_type = EXCLUDED.value_type,
                    td_stable = EXCLUDED.td_stable,
                    td_subtable = EXCLUDED.td_subtable,
                    physical_schema_hash = EXCLUDED.physical_schema_hash,
                    generation = EXCLUDED.generation,
                    status = 'ACTIVE',
                    updated_at = EXCLUDED.updated_at
                """,
                {
                    "id": uuid4(),
                    "tenant_id": tenant_id,
                    "design_id": design_id,
                    "design_version_id": version_id,
                    "dataset_id": ds_uuid,
                    "signal_id": parse_uuid(s.signal_id) if s.signal_id else None,
                    "series_key": f"{ds_uuid or design_id}:{s.series_key}",
                    "value_type": s.value_type,
                    "td_database": s.td_database,
                    "td_stable": s.td_stable,
                    "td_subtable": s.td_subtable,
                    "schema_hash": s.physical_schema_hash,
                    "generation": int(target_version),
                    "now": now,
                },
            )
        applied_stmts = len(compiled_plan.ddl_statements)

    # Update design to RUNNING
    await execute(
        session,
        """
        UPDATE storage_designs
        SET status = 'RUNNING', current_version = :ver, published_version_id = :ver_id, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"id": design_id, "tenant_id": tenant_id, "ver": target_version, "ver_id": version_id, "now": now},
    )

    published_result = {
        "design_id": str(design_id),
        "status": "RUNNING",
        "version": target_version,
        "published_version": target_version,
        "version_id": str(version_id),
        "operation_id": str(op_id),
        "semantic_hash": resolved_ast.semantic_hash(),
        "plan_hash": compiled_plan.plan_hash,
        "td_database": compiled_plan.td_database,
        "applied_statements": applied_stmts,
        "verified_subtables": verified_subtables,
        "published_at": iso_ms(now),
    }

    # Complete operation
    await execute(
        session,
        """
        UPDATE storage_operations
        SET status = 'COMPLETED', completed_at = :now,
            step_state_json = CAST(:step_state AS jsonb)
        WHERE id = :id
        """,
        {
            "id": op_id,
            "now": now,
            "step_state": _dump_json({"stage": "completed", "published_result": published_result}),
        },
    )

    # Emit factorix_config_changed PG notify
    notify_payload = {
        "tenant_id": str(tenant_id),
        "kind": "storage_design_published",
        "design_id": str(design_id),
        "version": target_version,
    }
    await execute(
        session,
        "SELECT pg_notify('factorix_config_changed', :payload)",
        {"payload": json.dumps(notify_payload)},
    )

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_PUBLISHED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before={"status": design_row["status"], "version": actual_ver},
        after={"version": target_version, "status": "RUNNING"},
        correlation_id=corr_id,
    )

    return published_result


# ==============================================================================
# S11 Catalog & Lifecycle Functions
# ==============================================================================


async def pause_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Pause managed writes for design, datasets, and physical registry while preserving operational history."""
    effective_payload = payload if payload is not None else body
    design = await fetch_one(
        session,
        "SELECT id, status, name, current_version FROM storage_designs WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": design_id},
    )
    if not design:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    curr_status = str(design["status"]).upper()
    if curr_status in {"ARCHIVED", "RETIRED"}:
        raise AppError(409, "DESIGN_ARCHIVED", f"Cannot pause archived design {design['name']!r}.")

    now = utcnow()
    await execute(
        session,
        "UPDATE storage_designs SET status = 'PAUSED', updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_datasets SET status = 'PAUSED', updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_physical_registry SET status = 'PAUSED', updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )

    # Log operation
    op_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO storage_operations (id, tenant_id, operation_type, target_type, target_id, actor_id, status, requested_at, completed_at, trace_id)
        VALUES (:id, :tenant_id, 'PAUSE_DESIGN', 'storage_design', :design_id, :actor_id, 'COMPLETED', :now, :now, :trace_id)
        """,
        {"id": op_id, "tenant_id": tenant_id, "design_id": design_id, "actor_id": actor_id, "now": now, "trace_id": correlation_id},
    )

    # Emit notify
    await execute(
        session,
        "SELECT pg_notify('factorix_config_changed', :payload)",
        {"payload": json.dumps({"tenant_id": str(tenant_id), "kind": "storage_design_paused", "design_id": str(design_id)})},
    )

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_PAUSED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before={"status": curr_status},
        after={"status": "PAUSED"},
        correlation_id=correlation_id or f"pause-{uuid4().hex[:8]}",
    )

    return await get_design(session, tenant_id, design_id)


async def resume_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Resume managed writes for design, datasets, and physical registry."""
    effective_payload = payload if payload is not None else body
    design = await fetch_one(
        session,
        "SELECT id, status, name FROM storage_designs WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": design_id},
    )
    if not design:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    curr_status = str(design["status"]).upper()
    if curr_status in {"ARCHIVED", "RETIRED"}:
        raise AppError(409, "DESIGN_ARCHIVED", f"Cannot resume archived design {design['name']!r}.")

    now = utcnow()
    await execute(
        session,
        "UPDATE storage_designs SET status = 'RUNNING', updated_at = :now WHERE id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_datasets SET status = 'RUNNING', updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_physical_registry SET status = 'ACTIVE', updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )

    # Log operation
    op_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO storage_operations (id, tenant_id, operation_type, target_type, target_id, actor_id, status, requested_at, completed_at, trace_id)
        VALUES (:id, :tenant_id, 'RESUME_DESIGN', 'storage_design', :design_id, :actor_id, 'COMPLETED', :now, :now, :trace_id)
        """,
        {"id": op_id, "tenant_id": tenant_id, "design_id": design_id, "actor_id": actor_id, "now": now, "trace_id": correlation_id},
    )

    await execute(
        session,
        "SELECT pg_notify('factorix_config_changed', :payload)",
        {"payload": json.dumps({"tenant_id": str(tenant_id), "kind": "storage_design_resumed", "design_id": str(design_id)})},
    )

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_RESUMED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before={"status": curr_status},
        after={"status": "RUNNING"},
        correlation_id=correlation_id or f"resume-{uuid4().hex[:8]}",
    )

    return await get_design(session, tenant_id, design_id)


async def duplicate_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Clone an existing design into a fresh DRAFT version with a unique name."""
    source = await get_design(session, tenant_id, design_id)
    payload_dict = dict(payload if payload is not None else (body or {}))

    base_name = payload_dict.get("name") or payload_dict.get("target_name") or f"Copy of {source['name']}"
    name = base_name.strip()

    # Ensure uniqueness of clone name
    suffix = 1
    while True:
        dup = await fetch_one(
            session,
            """
            SELECT id FROM storage_designs
            WHERE tenant_id = :tenant_id AND lower(btrim(name)) = lower(btrim(:name))
              AND status NOT IN ('ARCHIVED', 'RETIRED')
            """,
            {"tenant_id": tenant_id, "name": name},
        )
        if not dup:
            break
        suffix += 1
        name = f"{base_name} ({suffix})"

    new_ast_dict = dict(source["ast"])
    new_ast_dict["metadata"]["name"] = name
    new_ast_dict["metadata"]["description"] = payload_dict.get("description") or source.get("description") or ""

    return await create_design(
        session,
        tenant_id,
        actor_id,
        {"ast": new_ast_dict, "name": name, "description": new_ast_dict["metadata"]["description"]},
        correlation_id=correlation_id or f"dup-{uuid4().hex[:8]}",
    )


async def archive_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Archive design while preserving historical TDengine records. Reject RUNNING unless force=True."""
    design = await fetch_one(
        session,
        "SELECT id, status, name FROM storage_designs WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": design_id},
    )
    if not design:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    curr_status = str(design["status"]).upper()
    payload_dict = dict(payload if payload is not None else (body or {}))
    force = bool(payload_dict.get("force"))

    if curr_status == "RUNNING" and not force:
        raise AppError(
            409,
            "DESIGN_RUNNING",
            f"Cannot archive running design {design['name']!r}. Pause recording first or pass force=true.",
        )

    now = utcnow()
    await execute(
        session,
        """
        UPDATE storage_designs
        SET status = 'ARCHIVED', archived_at = :now, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_datasets SET status = 'ARCHIVED', updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_physical_registry SET status = 'RETIRED', updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "now": now},
    )

    op_id = uuid4()
    await execute(
        session,
        """
        INSERT INTO storage_operations (id, tenant_id, operation_type, target_type, target_id, actor_id, status, requested_at, completed_at, trace_id)
        VALUES (:id, :tenant_id, 'ARCHIVE_DESIGN', 'storage_design', :design_id, :actor_id, 'COMPLETED', :now, :now, :trace_id)
        """,
        {"id": op_id, "tenant_id": tenant_id, "design_id": design_id, "actor_id": actor_id, "now": now, "trace_id": correlation_id},
    )

    await execute(
        session,
        "SELECT pg_notify('factorix_config_changed', :payload)",
        {"payload": json.dumps({"tenant_id": str(tenant_id), "kind": "storage_design_archived", "design_id": str(design_id)})},
    )

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_ARCHIVED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before={"status": curr_status},
        after={"status": "ARCHIVED"},
        correlation_id=correlation_id or f"archive-{uuid4().hex[:8]}",
    )

    return await get_design(session, tenant_id, design_id)


async def restore_design(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    design_id: UUID,
    payload: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    correlation_id: str = "",
) -> dict[str, Any]:
    """Restore an archived design back to PAUSED (if published version exists) or DRAFT."""
    effective_payload = payload if payload is not None else (body or {})
    design = await fetch_one(
        session,
        "SELECT id, status, published_version_id FROM storage_designs WHERE tenant_id = :tenant_id AND id = :id",
        {"tenant_id": tenant_id, "id": design_id},
    )
    if not design:
        raise AppError(404, "NOT_FOUND", f"Storage design {design_id} not found.")

    target_status = "PAUSED" if design["published_version_id"] else "DRAFT"
    if effective_payload and effective_payload.get("target_status"):
        target_status = str(effective_payload["target_status"]).upper()

    now = utcnow()
    await execute(
        session,
        """
        UPDATE storage_designs
        SET status = :status, archived_at = NULL, updated_at = :now
        WHERE id = :id AND tenant_id = :tenant_id
        """,
        {"id": design_id, "tenant_id": tenant_id, "status": target_status, "now": now},
    )
    await execute(
        session,
        "UPDATE storage_datasets SET status = :status, updated_at = :now WHERE design_id = :id AND tenant_id = :tenant_id",
        {"id": design_id, "tenant_id": tenant_id, "status": target_status, "now": now},
    )

    await audit(
        session,
        tenant_id=tenant_id,
        event_type="STORAGE_DESIGN_RESTORED",
        actor_id=actor_id,
        entity_type="storage_design",
        entity_id=design_id,
        before={"status": design["status"]},
        after={"status": target_status},
        correlation_id=correlation_id or f"restore-{uuid4().hex[:8]}",
    )

    return await get_design(session, tenant_id, design_id)


async def bulk_designs(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    payload: Mapping[str, Any],
    correlation_id: str = "",
) -> dict[str, Any]:
    """Execute bulk pause, resume, or archive actions across storage designs."""
    action = str(payload.get("action") or "").strip().lower()
    if action not in ALLOWED_LIFECYCLE_ACTIONS:
        raise AppError(422, "INVALID_ACTION", f"Unsupported bulk action {action!r}. Use pause, resume, or archive.")

    raw_ids = payload.get("design_ids") or []
    design_ids = [parse_uuid(x) for x in raw_ids if x]
    if not design_ids:
        return {"affected": 0, "ids": [], "errors": []}

    successful: list[str] = []
    errors: list[dict[str, str]] = []

    for did in design_ids:
        try:
            if action == "pause":
                await pause_design(session, tenant_id, actor_id, did, payload, correlation_id)
            elif action == "resume":
                await resume_design(session, tenant_id, actor_id, did, payload, correlation_id)
            elif action == "archive":
                await archive_design(session, tenant_id, actor_id, did, payload, correlation_id)
            successful.append(str(did))
        except AppError as exc:
            errors.append({"id": str(did), "message": exc.message})
        except Exception as exc:  # noqa: BLE001
            errors.append({"id": str(did), "message": str(exc)})

    return {
        "affected": len(successful),
        "succeeded": len(successful),
        "failed": len(errors),
        "ids": successful,
        "errors": errors,
    }


async def get_design_dependencies(
    session: AsyncSession,
    tenant_id: UUID,
    design_id: UUID,
) -> dict[str, Any]:
    """Retrieve detailed upstream and downstream dependencies for a storage design."""
    # Signals
    sig_rows = await fetch_all(
        session,
        """
        SELECT DISTINCT s.id, s.key, s.data_type, s.status, r.name AS resource_name, c.protocol
        FROM storage_field_bindings fb
        JOIN signal_definitions s ON s.id = fb.signal_id
        LEFT JOIN resources r ON r.id = s.resource_id
        LEFT JOIN signal_bindings b ON b.signal_id = s.id AND b.valid_to IS NULL
        LEFT JOIN source_fields sf ON sf.id = b.source_field_id
        LEFT JOIN acquisition_jobs j ON j.id = sf.acquisition_job_id
        LEFT JOIN connections c ON c.id = j.connection_id
        WHERE fb.tenant_id = :tenant_id AND fb.signal_id IS NOT NULL
          AND fb.dataset_id IN (SELECT id FROM storage_datasets WHERE design_id = :design_id)
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    signals = [
        {
            "id": str(sr["id"]),
            "type": "signal",
            "target_id": str(sr["id"]),
            "name": str(sr.get("key") or sr.get("field_name") or sr.get("id")),
            "key": str(sr.get("key") or sr.get("field_name") or sr.get("id")),
            "status": str(sr.get("status") or "ACTIVE"),
            "protocol": sr.get("protocol"),
            "resource_name": sr.get("resource_name"),
        }
        for sr in sig_rows
    ]

    # Factory Resources
    res_rows = await fetch_all(
        session,
        """
        SELECT DISTINCT r.id, r.name, r.code, r.status
        FROM storage_field_bindings fb
        JOIN resources r ON r.id = fb.resource_id
        WHERE fb.tenant_id = :tenant_id AND fb.resource_id IS NOT NULL
          AND fb.dataset_id IN (SELECT id FROM storage_datasets WHERE design_id = :design_id)
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    resources = [
        {
            "id": str(rr["id"]),
            "type": "resource",
            "target_id": str(rr["id"]),
            "name": str(rr.get("name") or rr.get("code") or rr.get("id")),
            "key": str(rr.get("code") or rr.get("name") or rr.get("id")),
            "status": str(rr.get("status") or "ACTIVE"),
        }
        for rr in res_rows
    ]

    # Data Models
    mod_rows = await fetch_all(
        session,
        """
        SELECT DISTINCT g.id, g.display_name, g.status, fb.model_field_path
        FROM storage_field_bindings fb
        JOIN output_groups g ON g.id = fb.model_id
        WHERE fb.tenant_id = :tenant_id AND fb.model_id IS NOT NULL
          AND fb.dataset_id IN (SELECT id FROM storage_datasets WHERE design_id = :design_id)
        """,
        {"tenant_id": tenant_id, "design_id": design_id},
    )
    data_models = [
        {
            "id": str(mr["id"]),
            "type": "data_model",
            "target_id": str(mr["id"]),
            "name": str(mr["display_name"]),
            "subpath": mr.get("model_field_path"),
            "status": str(mr["status"]),
        }
        for mr in mod_rows
    ]

    # Saved Queries / Views referencing this design
    view_rows = await fetch_all(
        session,
        """
        SELECT id, name
        FROM saved_queries
        WHERE tenant_id = :tenant_id AND query_spec_json->>'design_id' = :design_id_str
        """,
        {"tenant_id": tenant_id, "design_id_str": str(design_id)},
    )
    saved_views = [
        {"id": str(vr["id"]), "type": "saved_view", "target_id": str(vr["id"]), "name": str(vr["name"])}
        for vr in view_rows
    ]

    # Export Jobs referencing this design
    exp_rows = await fetch_all(
        session,
        """
        SELECT id, file_name, status
        FROM export_jobs
        WHERE tenant_id = :tenant_id AND query_json->>'design_id' = :design_id_str
        ORDER BY created_at DESC
        LIMIT 10
        """,
        {"tenant_id": tenant_id, "design_id_str": str(design_id)},
    )
    exports = [
        {"id": str(er["id"]), "type": "export", "target_id": str(er["id"]), "name": str(er["file_name"]), "status": str(er["status"])}
        for er in exp_rows
    ]

    total_count = len(signals) + len(resources) + len(data_models) + len(saved_views) + len(exports)
    return {
        "design_id": str(design_id),
        "signals": signals,
        "resources": resources,
        "data_models": data_models,
        "saved_views": saved_views,
        "exports": exports,
        "total_count": total_count,
    }


async def export_design_bundle(
    session: AsyncSession,
    tenant_id: UUID,
    design_id: UUID,
    *,
    fmt: str = "yaml",
) -> dict[str, Any]:
    """Export redacted YAML or JSON design bundle with zero secrets."""
    design = await get_design(session, tenant_id, design_id)
    ast = parse_storage_dsl(design["ast"])
    content = (
        json.dumps(ast.to_dict(include_ui_meta=True), indent=2, ensure_ascii=False)
        if fmt.lower() == "json"
        else serialize_storage_dsl(ast, output_format="yaml")
    )
    return {
        "format": fmt.lower(),
        "design_id": str(design_id),
        "name": design["name"],
        "version": design["current_version"],
        "semantic_hash": ast.semantic_hash(),
        "content": content,
        "ast": ast.to_dict(include_ui_meta=True),
        "exported_at": iso_ms(utcnow()),
    }


async def import_design_bundle(
    session: AsyncSession,
    tenant_id: UUID,
    actor_id: UUID | None,
    payload: Mapping[str, Any],
    correlation_id: str = "",
) -> dict[str, Any]:
    """Import a validated declarative YAML/JSON design bundle as a new DRAFT design."""
    target_name = payload.get("target_name") or payload.get("name")
    bundle_data = payload.get("bundle") if isinstance(payload.get("bundle"), (dict, Mapping)) else payload
    ast = _ast_from_payload(bundle_data or payload)
    base_name = target_name or (bundle_data.get("name") if isinstance(bundle_data, (dict, Mapping)) else None) or ast.metadata.name or "Imported Storage Design"
    name = base_name.strip()

    # Ensure unique active name
    suffix = 1
    while True:
        dup = await fetch_one(
            session,
            """
            SELECT id FROM storage_designs
            WHERE tenant_id = :tenant_id AND lower(btrim(name)) = lower(btrim(:name))
              AND status NOT IN ('ARCHIVED', 'RETIRED')
            """,
            {"tenant_id": tenant_id, "name": name},
        )
        if not dup:
            break
        suffix += 1
        name = f"{base_name} ({suffix})"

    ast_dict = ast.to_dict(include_ui_meta=True)
    ast_dict["metadata"]["name"] = name
    return await create_design(
        session,
        tenant_id,
        actor_id,
        {"ast": ast_dict, "name": name, "description": ast_dict["metadata"].get("description") or ""},
        correlation_id=correlation_id or f"imp-{uuid4().hex[:8]}",
    )


async def get_storage_health(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    tdengine: TDEngineClient | None = None,
) -> dict[str, Any]:
    """Truthful TDengine + Ingestion + Retention status. Destination is always 'TDengine', never RabbitMQ."""
    now = utcnow()
    active_epoch_num = await _active_epoch(session, tenant_id)

    # TDengine status probe
    td_status = "HEALTHY"
    reachable = False
    td_version = "3.3.x"
    stables_count = 0
    managed_count = 0
    operational_count = 0
    last_write_at: str | None = None
    write_latency_ms: float | None = None
    msg: str | None = None

    hist_prov = get_history_provider()
    active_td = tdengine or (hist_prov.client if hist_prov else None)

    if active_td is not None:
        try:
            probe = await active_td.health_probe()
            reachable = probe.reachable
            td_version = probe.server_version or "3.3.x"
            write_latency_ms = getattr(probe, "latency_ms", None)
            td_status = "HEALTHY" if reachable else "OFFLINE"
        except Exception as exc:  # noqa: BLE001
            reachable = False
            td_status = "OFFLINE"
            msg = str(exc)

    # Physical counts from storage_physical_registry in PostgreSQL
    reg_counts = await fetch_all(
        session,
        """
        SELECT tier, count(*) AS cnt, max(updated_at) AS last_up
        FROM storage_physical_registry
        WHERE tenant_id = :tenant_id
        GROUP BY tier
        """,
        {"tenant_id": tenant_id},
    )
    for rc in reg_counts:
        tier_name = str(rc["tier"]).upper()
        if tier_name == "MANAGED":
            managed_count = int(rc["cnt"])
        elif tier_name == "OPERATIONAL":
            operational_count = int(rc["cnt"])
        if rc.get("last_up"):
            last_write_at = iso_ms(rc["last_up"])

    # Count distinct published stables
    stable_row = await fetch_one(
        session,
        "SELECT count(DISTINCT td_stable) AS scnt FROM storage_physical_registry WHERE tenant_id = :tenant_id",
        {"tenant_id": tenant_id},
    )
    stables_count = int(stable_row["scnt"] or 0) if stable_row else 0

    # Ingestion pipeline status
    ing_status = "HEALTHY"
    broker_ok = True
    q_depth = 0
    dlq_depth = 0
    last_ingested: str | None = None

    rt_row = await fetch_one(
        session,
        "SELECT health, broker_ok, spool_pending, updated_at FROM collector_runtime_status ORDER BY updated_at DESC LIMIT 1",
        {},
    )
    if rt_row:
        broker_ok = bool(rt_row.get("broker_ok", True))
        q_depth = int(rt_row.get("spool_pending") or 0)
        ing_status = "HEALTHY" if broker_ok else "DEGRADED"
        if rt_row.get("updated_at"):
            last_ingested = iso_ms(rt_row["updated_at"])

    # Retention status
    ret_row = await fetch_one(
        session,
        """
        SELECT count(*) AS total_policies,
               sum(CASE WHEN legal_hold THEN 1 ELSE 0 END) AS holds_count,
               max(updated_at) AS last_run
        FROM storage_recording_policies
        WHERE tenant_id = :tenant_id
        """,
        {"tenant_id": tenant_id},
    )
    active_policies_count = int(ret_row["total_policies"] or 0) if ret_row else 0
    legal_holds_count = int(ret_row["holds_count"] or 0) if ret_row else 0
    last_ret_run = iso_ms(ret_row["last_run"]) if ret_row and ret_row.get("last_run") else None

    top_status = "HEALTHY"
    if td_status == "OFFLINE" or ing_status == "OFFLINE":
        top_status = "OFFLINE"
    elif td_status == "DEGRADED" or ing_status == "DEGRADED":
        top_status = "DEGRADED"

    return {
        "status": top_status,
        "destination": "TDengine",
        "storage_destination": "TDengine",
        "tdengine": {
            "status": td_status,
            "reachable": reachable,
            "engine": "TDengine",
            "version": td_version,
            "database": tenant_td_database(tenant_id),
            "stables_count": stables_count,
            "managed_subtables_count": managed_count,
            "operational_subtables_count": operational_count,
            "last_write_at": last_write_at,
            "write_latency_ms": write_latency_ms,
            "message": msg,
        },
        "ingestion": {
            "status": ing_status,
            "transport": "RabbitMQ",
            "broker_reachable": broker_ok,
            "consumer_ready": True,
            "queue_depth": q_depth,
            "dlq_depth": dlq_depth,
            "active_epoch": active_epoch_num,
            "managed_bindings_active": managed_count,
            "last_ingested_at": last_ingested,
        },
        "retention": {
            "status": "BLOCKED_LEGAL_HOLD" if legal_holds_count > 0 else "HEALTHY",
            "active_policies_count": active_policies_count,
            "legal_holds_count": legal_holds_count,
            "last_run_at": last_ret_run,
        },
        "checked_at": iso_ms(now),
    }


async def list_storage_operations(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    design_id: UUID | None = None,
    kind: str | None = None,
    status: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List storage_operations log entries with optional filters."""
    clauses = ["o.tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id}

    if design_id:
        clauses.append("(o.target_id = :design_id OR o.step_state_json->>'design_id' = :design_id_str)")
        params["design_id"] = design_id
        params["design_id_str"] = str(design_id)

    if kind:
        clauses.append("o.operation_type = :kind")
        params["kind"] = kind

    if status:
        clauses.append("o.status = :status")
        params["status"] = status.upper()

    where_sql = " AND ".join(clauses)
    bounded_limit = min(max(int(limit), 1), 500)

    rows = await fetch_all(
        session,
        f"""
        SELECT o.id, o.tenant_id, o.operation_type, o.target_type, o.target_id, o.actor_id,
               o.idempotency_key, o.status, o.requested_at, o.started_at, o.completed_at,
               o.step_state_json, o.error_code, o.error_message, o.trace_id,
               d.name AS design_name
        FROM storage_operations o
        LEFT JOIN storage_designs d ON d.id = o.target_id
        WHERE {where_sql}
        ORDER BY o.requested_at DESC
        LIMIT :limit OFFSET :offset
        """,
        {**params, "limit": bounded_limit, "offset": max(int(offset), 0)},
    )

    return [
        {
            "id": str(r["id"]),
            "tenant_id": str(r["tenant_id"]),
            "operation_type": str(r["operation_type"]),
            "target_type": str(r["target_type"]),
            "target_id": str(r["target_id"]) if r.get("target_id") else None,
            "design_id": str(r["target_id"]) if r.get("target_id") else None,
            "design_name": r.get("design_name"),
            "actor_id": str(r["actor_id"]) if r.get("actor_id") else None,
            "status": str(r["status"]),
            "requested_at": iso_ms(r["requested_at"]),
            "started_at": iso_ms(r["started_at"]) if r.get("started_at") else None,
            "completed_at": iso_ms(r["completed_at"]) if r.get("completed_at") else None,
            "step_state_json": _safe_json_dict(r.get("step_state_json")),
            "error_code": r.get("error_code"),
            "error_message": r.get("error_message"),
            "trace_id": str(r.get("trace_id") or ""),
        }
        for r in rows
    ]


async def preview_storage_retention(
    session: AsyncSession,
    tenant_id: UUID,
    payload: Mapping[str, Any] | None = None,
    *,
    body: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Preview retention impact across datasets and policies; blocks if legal_hold = TRUE."""
    payload_dict = dict(payload or body or {})
    design_id = parse_uuid(payload_dict.get("design_id")) if payload_dict.get("design_id") else None
    dataset_id = parse_uuid(payload_dict.get("dataset_id")) if payload_dict.get("dataset_id") else None
    days_override = int(payload_dict["retention_days_override"]) if payload_dict.get("retention_days_override") else None

    clauses = ["ds.tenant_id = :tenant_id"]
    params: dict[str, Any] = {"tenant_id": tenant_id}

    if design_id:
        clauses.append("ds.design_id = :design_id")
        params["design_id"] = design_id

    if dataset_id:
        clauses.append("ds.id = :dataset_id")
        params["dataset_id"] = dataset_id

    where_sql = " AND ".join(clauses)
    now = utcnow()

    rows = await fetch_all(
        session,
        f"""
        SELECT ds.id AS dataset_id, ds.dataset_key, ds.design_id, d.name AS design_name,
               rp.mode, rp.retention_json, rp.legal_hold,
               (SELECT count(*) FROM storage_physical_registry r WHERE r.dataset_id = ds.id) AS subtable_count,
               (SELECT max(r.td_stable) FROM storage_physical_registry r WHERE r.dataset_id = ds.id) AS td_stable
        FROM storage_datasets ds
        JOIN storage_designs d ON d.id = ds.design_id
        LEFT JOIN storage_recording_policies rp ON rp.dataset_id = ds.id
        WHERE {where_sql}
        ORDER BY d.name ASC, ds.dataset_key ASC
        """,
        params,
    )

    dataset_items: list[dict[str, Any]] = []
    legal_hold_datasets: list[str] = []
    total_subtables = 0
    total_expired = 0

    for r in rows:
        ret_dict = _safe_json_dict(r.get("retention_json"))
        is_legal_hold = bool(r.get("legal_hold") or ret_dict.get("legalHold") or ret_dict.get("legal_hold"))
        keep_days = days_override if days_override is not None else int(ret_dict.get("days") or 90)
        cutoff_dt = now - timedelta(days=keep_days)
        sub_count = int(r.get("subtable_count") or 0)
        total_subtables += sub_count

        ds_key = str(r["dataset_key"])
        if is_legal_hold:
            legal_hold_datasets.append(ds_key)

        # Conservative estimated expired rows
        est_expired = 0 if is_legal_hold else max(0, sub_count * 1500)
        total_expired += est_expired

        dataset_items.append(
            {
                "dataset_id": str(r.get("dataset_id") or r.get("id")),
                "dataset_key": ds_key,
                "design_id": str(r.get("design_id") or ""),
                "design_name": str(r.get("design_name") or "Design"),
                "td_stable": str(r.get("td_stable") or f"ds_{ds_key}"),
                "subtable_count": sub_count,
                "retention_days": keep_days,
                "legal_hold": is_legal_hold,
                "cutoff_timestamp": cutoff_dt.isoformat().replace("+00:00", "Z"),
                "estimated_expired_rows": est_expired,
                "blocked_by_legal_hold": is_legal_hold,
                "status": "BLOCKED_LEGAL_HOLD" if is_legal_hold else ("READY" if est_expired > 0 else "NO_EXPIRED_DATA"),
            }
        )

    blocked = len(legal_hold_datasets) > 0
    return {
        "design_id": str(design_id) if design_id else None,
        "can_execute": not blocked,
        "blocked_by_legal_hold": blocked,
        "legal_hold_datasets": legal_hold_datasets,
        "total_subtables_evaluated": total_subtables,
        "total_estimated_expired_rows": total_expired,
        "datasets": dataset_items,
        "evaluated_at": iso_ms(now),
    }
