"""Bound transient read-only MQTT discovery to its Edge and connection revision."""

from alembic import op

revision = '0009_mqtt_topic_capture'
down_revision = '0008_local_appliance'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE mqtt_topic_captures (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants(id),
            connection_id UUID NOT NULL REFERENCES connections(id),
            edge_id UUID NOT NULL REFERENCES edge_nodes(id),
            connection_version INTEGER NOT NULL,
            requested_by UUID NOT NULL REFERENCES admin_accounts(id),
            topic_filter TEXT NOT NULL,
            duration_s INTEGER NOT NULL CHECK (duration_s BETWEEN 2 AND 30),
            status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
            result_json JSONB,
            error_code TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            CHECK (octet_length(topic_filter) BETWEEN 1 AND 2048),
            CHECK (result_json IS NULL OR octet_length(result_json::text) <= 1200000)
        )
    """)
    op.execute("CREATE UNIQUE INDEX mqtt_capture_active_edge ON mqtt_topic_captures(edge_id) WHERE status IN ('PENDING','RUNNING')")
    op.execute('CREATE INDEX mqtt_capture_owner ON mqtt_topic_captures(tenant_id, created_at)')


def downgrade() -> None:
    op.execute('DROP TABLE mqtt_topic_captures')
