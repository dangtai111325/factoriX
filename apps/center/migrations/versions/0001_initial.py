"""Apply the versioned schema. Runtime never creates tables implicitly."""

from __future__ import annotations

import os
from pathlib import Path

from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

SQL_PATH = Path(__file__).resolve().parents[4] / "infrastructure" / "postgres" / "001_schema.sql"


def _statements(sql: str) -> list[str]:
    chunks: list[str] = []
    for part in sql.split(";"):
        lines = [line for line in part.splitlines() if not line.strip().startswith("--")]
        statement = "\n".join(lines).strip()
        if statement:
            chunks.append(statement)
    return chunks


def upgrade() -> None:
    path = Path(os.environ.get("FACTORIX_SCHEMA_SQL", SQL_PATH))
    for statement in _statements(path.read_text(encoding="utf-8")):
        op.execute(statement)


def downgrade() -> None:
    tables = [
        "export_jobs",
        "audit_events",
        "saved_queries",
        "retention_jobs",
        "retention_policies",
        "dashboard_revisions",
        "dashboards",
        "observation_quarantine",
        "latest_signal_state",
        "ingest_dedup",
        "observations",
        "commissioning_jobs",
        "deployment_events",
        "configuration_releases",
        "configuration_drafts",
        "output_group_members",
        "output_groups",
        "formula_dependencies",
        "formula_definitions",
        "mapping_definitions",
        "signal_bindings",
        "signal_definitions",
        "source_fields",
        "acquisition_jobs",
        "connections",
        "secret_store",
        "edge_enrollment_tokens",
        "edge_nodes",
        "layout_revisions",
        "layout_definitions",
        "hierarchy_views",
        "hierarchy_templates",
        "resource_relations",
        "type_adjacency",
        "relation_types",
        "resources",
        "resource_types",
        "login_throttle",
        "sessions",
        "admin_accounts",
        "sites",
        "tenants",
    ]
    for name in tables:
        op.execute(f"DROP TABLE IF EXISTS {name} CASCADE")
