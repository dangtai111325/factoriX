"""Persist the single local appliance's explicit Edge assignment and retry token."""

from alembic import op

revision = "0008_local_appliance"
down_revision = "0007_resource_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE appliance_bindings (
            slot TEXT PRIMARY KEY CHECK (slot = 'local'),
            edge_id UUID NOT NULL REFERENCES edge_nodes(id),
            token_ciphertext BYTEA,
            token_hash TEXT,
            token_expires_at TIMESTAMPTZ,
            requested_by UUID REFERENCES admin_accounts(id),
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            CHECK ((token_ciphertext IS NULL AND token_hash IS NULL AND token_expires_at IS NULL)
                OR (token_ciphertext IS NOT NULL AND token_hash IS NOT NULL AND token_expires_at IS NOT NULL))
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE appliance_bindings")
