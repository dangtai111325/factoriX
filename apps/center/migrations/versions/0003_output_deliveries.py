"""Northbound delivery queue. Preview remains a preview."""

from __future__ import annotations

from alembic import op

revision = "0003_output_deliveries"
down_revision = "0002_admin_email"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS output_deliveries (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            group_id UUID NOT NULL REFERENCES output_groups (id),
            event_uid TEXT NOT NULL,
            payload_json JSONB NOT NULL,
            status TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            CONSTRAINT output_delivery_status CHECK (status IN ('QUEUED', 'SENT', 'FAILED'))
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS output_deliveries_group
        ON output_deliveries (tenant_id, group_id, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS output_deliveries")
