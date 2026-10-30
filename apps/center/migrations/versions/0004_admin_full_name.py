"""Store the administrator full name separately from the tenant workspace name."""

from __future__ import annotations

from alembic import op

revision = "0004_admin_full_name"
down_revision = "0003_output_deliveries"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE admin_accounts
        ADD COLUMN IF NOT EXISTS full_name TEXT
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE admin_accounts DROP COLUMN IF EXISTS full_name")
