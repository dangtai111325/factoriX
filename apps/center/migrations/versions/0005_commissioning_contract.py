"""Bind commissioning to draft mappings, connection revision and a deadline."""

from alembic import op

revision = "0005_commissioning_contract"
down_revision = "0004_admin_full_name"
branch_labels = None
depends_on = None


def upgrade():
    statements = """
        ALTER TABLE commissioning_jobs ADD COLUMN request_json JSONB NOT NULL DEFAULT '{}';
        ALTER TABLE commissioning_jobs ADD COLUMN connection_version INTEGER;
        UPDATE commissioning_jobs j SET connection_version = c.version FROM connections c WHERE c.id = j.connection_id;
        ALTER TABLE commissioning_jobs ALTER COLUMN connection_version SET NOT NULL;
        ALTER TABLE commissioning_jobs ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '45 seconds');
    """
    for statement in statements.split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    statements = """
        ALTER TABLE commissioning_jobs DROP COLUMN expires_at;
        ALTER TABLE commissioning_jobs DROP COLUMN connection_version;
        ALTER TABLE commissioning_jobs DROP COLUMN request_json;
    """
    for statement in statements.split(";"):
        if statement.strip():
            op.execute(statement)
