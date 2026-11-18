"""Telemetry reset (CLEAR_TELEMETRY_ONLY) constants: phrases, stage names, cleared/protected tables
(R2-E B8, moved verbatim from ``factorix.modules.telemetry_reset``)."""

from __future__ import annotations

CONFIRM_PHRASE = "CLEAR TELEMETRY"
OPERATION_KIND = "TELEMETRY_RESET"
AUDIT_ACTION = "TELEMETRY_RESET_EXECUTED"

STAGE_R0_PREFLIGHT = "R0_PREFLIGHT"
STAGE_R1_QUIESCING = "R1_QUIESCING"
STAGE_R2_PURGE_BROKER = "R2_PURGE_BROKER"
STAGE_R3_CLEAR_TDENGINE = "R3_CLEAR_TDENGINE"
STAGE_R4_CLEAR_PG_RUNTIME_CACHES = "R4_CLEAR_PG_RUNTIME_CACHES"
STAGE_R5_RESUME_AND_AUDIT = "R5_RESUME_AND_AUDIT"

STATE_MACHINE_ORDER: tuple[str, ...] = ("R0", "R1", "R2", "R3", "R4", "R5")

# Explicit allowlist of runtime telemetry tables whose tenant rows are cleared in R4.
CLEARED_PG_TABLES: tuple[str, ...] = (
    "observations",
    "ingest_dedup",
    "latest_signal_state",
    "observation_quarantine",
    "model_snapshots",
    "model_state",
    "commissioning_jobs",
    "export_jobs",
)

# Explicit set of control-plane / configuration tables that MUST NEVER be deleted or truncated.
PROTECTED_CONTROL_PLANE_TABLES: frozenset[str] = frozenset(
    {
        "tenants",
        "sites",
        "admin_accounts",
        "sessions",
        "secret_store",
        "resource_types",
        "resources",
        "relation_types",
        "type_adjacency",
        "resource_relations",
        "hierarchy_templates",
        "hierarchy_views",
        "connections",
        "acquisition_jobs",
        "source_fields",
        "signal_definitions",
        "signal_bindings",
        "mapping_definitions",
        "formula_definitions",
        "formula_dependencies",
        "output_groups",
        "output_group_members",
        "model_templates",
        "model_refs",
        "storage_designs",
        "storage_design_versions",
        "storage_datasets",
        "storage_field_bindings",
        "storage_recording_policies",
        "storage_physical_registry",
        "storage_dependencies",
        "saved_queries",
        "alembic_version",
    }
)
