"""Add the administrator email and one-time password reset codes."""

from __future__ import annotations

from alembic import op

revision = "0002_admin_email"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS email TEXT")
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_email_unique
        ON admin_accounts (tenant_id, email)
        WHERE email IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS password_reset_codes (
            id UUID PRIMARY KEY,
            admin_id UUID NOT NULL REFERENCES admin_accounts (id),
            code_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            consumed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS password_reset_codes_admin
        ON password_reset_codes (admin_id, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS password_reset_codes")
    op.execute("DROP INDEX IF EXISTS admin_accounts_email_unique")
    op.execute("ALTER TABLE admin_accounts DROP COLUMN IF EXISTS email")
