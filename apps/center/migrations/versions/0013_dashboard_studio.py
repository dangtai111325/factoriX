"""Dashboard Studio metadata (ADR-019, contract ``dashboard.md``).

* ``dashboard_revisions``: ``document_json`` (the published schema-v1 document), ``published_by``, ``note``;
* ``dashboards``: ``published_at``, ``updated_by``;
* ``dashboard_templates``: tenant templates (role-based documents saved from a dashboard).

Forward-only and data-safe: every new column is nullable or has a default, no row is rewritten. Existing
drafts (``{"widgets": [...]}``) are upgraded to schema v1 when read; revisions without ``document_json`` are
rebuilt from ``widget_configs_json`` when read; publish keeps writing ``breakpoints_json`` and
``widget_configs_json`` for older readers. ``published_at`` is back-filled from the published revision so the
dashboard list shows it for dashboards published before this migration.
"""

from __future__ import annotations

from alembic import op

revision = "0013_dashboard_studio"
down_revision = "0012_outbox_confirmed_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE dashboard_revisions
            ADD COLUMN IF NOT EXISTS document_json JSONB,
            ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES admin_accounts (id),
            ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''
        """
    )
    op.execute(
        """
        ALTER TABLE dashboards
            ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS updated_by UUID
        """
    )
    op.execute(
        """
        UPDATE dashboards d
        SET published_at = COALESCE(r.published_at, r.created_at)
        FROM dashboard_revisions r
        WHERE r.dashboard_id = d.id AND r.revision = d.published_revision AND d.published_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dashboard_templates (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'custom',
            document_json JSONB NOT NULL,
            roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_by UUID REFERENCES admin_accounts (id),
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS dashboard_templates_tenant ON dashboard_templates (tenant_id)")
    op.execute("CREATE INDEX IF NOT EXISTS dashboards_tenant ON dashboards (tenant_id, archived_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS dashboards_tenant")
    op.execute("DROP INDEX IF EXISTS dashboard_templates_tenant")
    op.execute("DROP TABLE IF EXISTS dashboard_templates")
    op.execute("ALTER TABLE dashboards DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS published_at")
    op.execute(
        "ALTER TABLE dashboard_revisions DROP COLUMN IF EXISTS note, DROP COLUMN IF EXISTS published_by, "
        "DROP COLUMN IF EXISTS document_json"
    )
