"""Data Model v2: member kinds, model kinds, templates, composed state, events; websocket protocol."""

from __future__ import annotations

from alembic import op

revision = "0006_data_model_v2"
down_revision = "0005_flexible_hierarchy_area"
branch_labels = None
depends_on = None

_DEFAULT_EMIT = """'{"republish_ms": null, "max_events": 1000, "snapshot_grace_ms": 0}'::jsonb"""


def upgrade() -> None:
    # 1. Connections: allow the websocket protocol. connections.health has no CHECK constraint in
    #    001_schema.sql, so 'UNKNOWN' / 'IDLE' already fit and nothing changes there.
    op.execute("ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_protocol")
    op.execute(
        """
        ALTER TABLE connections ADD CONSTRAINT connections_protocol
        CHECK (protocol IN ('modbus_tcp', 'opcua', 'mqtt', 'http', 'websocket'))
        """
    )

    # 2. Templates (created first: output_groups.template_id references it).
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS model_templates (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            key TEXT NOT NULL,
            display_name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'STATE',
            topic_template TEXT NOT NULL,
            fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            emit_policy_json JSONB NOT NULL DEFAULT {_DEFAULT_EMIT},
            is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT model_templates_tenant_key UNIQUE (tenant_id, key),
            CONSTRAINT model_templates_kind CHECK (kind IN ('STATE', 'EVENT'))
        )
        """
    )

    # 3. Output groups (data models).
    op.execute(
        f"""
        ALTER TABLE output_groups
            ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'STATE',
            ADD COLUMN IF NOT EXISTS emit_policy_json JSONB NOT NULL DEFAULT {_DEFAULT_EMIT},
            ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES model_templates (id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        """
    )
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_groups_kind")
    op.execute("ALTER TABLE output_groups ADD CONSTRAINT output_groups_kind CHECK (kind IN ('STATE', 'EVENT'))")
    # The inline UNIQUE (resource_id, key) of 001_schema.sql is auto-named
    # output_groups_resource_id_key_key; look it up by its columns so a renamed constraint is found too.
    op.execute(
        """
        DO $$
        DECLARE
            con_name TEXT;
        BEGIN
            FOR con_name IN
                SELECT c.conname
                FROM pg_constraint c
                WHERE c.conrelid = 'output_groups'::regclass
                  AND c.contype = 'u'
                  AND array_length(c.conkey, 1) = 2
                  AND c.conkey @> ARRAY[
                      (SELECT attnum FROM pg_attribute WHERE attrelid = 'output_groups'::regclass AND attname = 'resource_id'),
                      (SELECT attnum FROM pg_attribute WHERE attrelid = 'output_groups'::regclass AND attname = 'key')
                  ]::smallint[]
            LOOP
                EXECUTE format('ALTER TABLE output_groups DROP CONSTRAINT %I', con_name);
            END LOOP;
        END $$;
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS output_groups_key_active
        ON output_groups (resource_id, key) WHERE status <> 'ARCHIVED'
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS output_groups_tenant_status ON output_groups (tenant_id, status, kind)")
    # Clean bodies are flat (data_clean.md). The v1 default 'rich' nested every value; models are
    # switched to 'compact' (the v1 preview never worked, so nothing consumed the rich shape).
    op.execute(
        """
        UPDATE output_groups
        SET projection_policy_json = jsonb_set(COALESCE(projection_policy_json, '{}'::jsonb), '{mode}', '"compact"'::jsonb)
        WHERE COALESCE(projection_policy_json ->> 'mode', 'rich') <> 'compact'
        """
    )

    # 4. Members: kinds other than signal; signal_id becomes optional.
    op.execute("ALTER TABLE output_group_members ALTER COLUMN signal_id DROP NOT NULL")
    op.execute(
        """
        ALTER TABLE output_group_members
            ADD COLUMN IF NOT EXISTS member_kind TEXT NOT NULL DEFAULT 'SIGNAL',
            ADD COLUMN IF NOT EXISTS signal_key TEXT,
            ADD COLUMN IF NOT EXISTS context_ref TEXT,
            ADD COLUMN IF NOT EXISTS constant_json JSONB,
            ADD COLUMN IF NOT EXISTS system_field TEXT,
            ADD COLUMN IF NOT EXISTS contributes_ts BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS is_trigger BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    op.execute(
        """
        UPDATE output_group_members m
        SET signal_key = s.key
        FROM signal_definitions s
        WHERE s.id = m.signal_id AND m.signal_key IS NULL
        """
    )
    op.execute("ALTER TABLE output_group_members DROP CONSTRAINT IF EXISTS output_member_kind")
    op.execute(
        """
        ALTER TABLE output_group_members ADD CONSTRAINT output_member_kind
        CHECK (member_kind IN ('SIGNAL', 'SNAPSHOT', 'CONTEXT', 'CONSTANT', 'SYSTEM'))
        """
    )
    op.execute("ALTER TABLE output_group_members DROP CONSTRAINT IF EXISTS output_member_system_field")
    op.execute(
        """
        ALTER TABLE output_group_members ADD CONSTRAINT output_member_system_field
        CHECK (system_field IS NULL OR system_field IN ('source_timestamp', 'publish_timestamp'))
        """
    )
    op.execute("ALTER TABLE output_group_members DROP CONSTRAINT IF EXISTS output_member_shape")
    op.execute(
        """
        ALTER TABLE output_group_members ADD CONSTRAINT output_member_shape CHECK (
            (member_kind IN ('SIGNAL', 'SNAPSHOT') AND signal_id IS NOT NULL)
            OR (member_kind = 'CONTEXT' AND context_ref IS NOT NULL AND signal_id IS NULL)
            OR (member_kind = 'CONSTANT' AND constant_json IS NOT NULL AND signal_id IS NULL)
            OR (member_kind = 'SYSTEM' AND system_field IS NOT NULL AND signal_id IS NULL)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS output_group_members_signal ON output_group_members (signal_id)")

    # 5. Latest composed body per STATE model. TEXT keeps key order (JSONB would not).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS model_state (
            group_id UUID PRIMARY KEY REFERENCES output_groups (id) ON DELETE CASCADE,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            body_text TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            source_ts TIMESTAMPTZ,
            last_publish_ts TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )

    # 6. EVENT model history. dedupe_key = trigger instant, so retries and repeated polls of
    #    the same completion insert nothing.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS model_events (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            group_id UUID NOT NULL REFERENCES output_groups (id) ON DELETE CASCADE,
            dedupe_key TEXT NOT NULL,
            source_ts TIMESTAMPTZ NOT NULL,
            body_text TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'FINAL',
            created_at TIMESTAMPTZ NOT NULL,
            CONSTRAINT model_events_dedupe UNIQUE (group_id, dedupe_key),
            CONSTRAINT model_events_status CHECK (status IN ('PENDING', 'FINAL'))
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS model_events_recent
        ON model_events (tenant_id, group_id, source_ts DESC, created_at DESC)
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS model_events_pending ON model_events (status, created_at) WHERE status = 'PENDING'")

    # 7. Snapshot lookups ("value active at the trigger instant").
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS observations_signal_source
        ON observations (tenant_id, signal_id, source_time DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS observations_signal_source")
    op.execute("DROP TABLE IF EXISTS model_events")
    op.execute("DROP TABLE IF EXISTS model_state")

    op.execute("DROP INDEX IF EXISTS output_group_members_signal")
    op.execute("ALTER TABLE output_group_members DROP CONSTRAINT IF EXISTS output_member_shape")
    op.execute("ALTER TABLE output_group_members DROP CONSTRAINT IF EXISTS output_member_system_field")
    op.execute("ALTER TABLE output_group_members DROP CONSTRAINT IF EXISTS output_member_kind")
    # Members that are not signals cannot exist in the v1 shape.
    op.execute("DELETE FROM output_group_members WHERE signal_id IS NULL")
    op.execute(
        """
        ALTER TABLE output_group_members
            DROP COLUMN IF EXISTS member_kind,
            DROP COLUMN IF EXISTS signal_key,
            DROP COLUMN IF EXISTS context_ref,
            DROP COLUMN IF EXISTS constant_json,
            DROP COLUMN IF EXISTS system_field,
            DROP COLUMN IF EXISTS contributes_ts,
            DROP COLUMN IF EXISTS is_trigger
        """
    )
    op.execute("ALTER TABLE output_group_members ALTER COLUMN signal_id SET NOT NULL")

    op.execute("DROP INDEX IF EXISTS output_groups_tenant_status")
    op.execute("DROP INDEX IF EXISTS output_groups_key_active")
    # Archived duplicates would block the v1 constraint; keep the newest row per (resource_id, key)
    # by renaming the older archived ones.
    op.execute(
        """
        UPDATE output_groups g
        SET key = g.key || '-archived-' || left(g.id::text, 8)
        WHERE g.status = 'ARCHIVED'
          AND EXISTS (
              SELECT 1 FROM output_groups o
              WHERE o.resource_id = g.resource_id AND o.key = g.key AND o.id <> g.id
                AND (
                    o.status <> 'ARCHIVED'
                    OR o.created_at > g.created_at
                    OR (o.created_at = g.created_at AND o.id > g.id)
                )
          )
        """
    )
    op.execute("ALTER TABLE output_groups ADD CONSTRAINT output_groups_resource_id_key_key UNIQUE (resource_id, key)")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_groups_kind")
    op.execute(
        """
        ALTER TABLE output_groups
            DROP COLUMN IF EXISTS kind,
            DROP COLUMN IF EXISTS emit_policy_json,
            DROP COLUMN IF EXISTS template_id,
            DROP COLUMN IF EXISTS created_at,
            DROP COLUMN IF EXISTS updated_at
        """
    )
    op.execute("DROP TABLE IF EXISTS model_templates")

    op.execute("ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_protocol")
    # NOT VALID: websocket rows created while on 0006 must not block the downgrade.
    op.execute(
        """
        ALTER TABLE connections ADD CONSTRAINT connections_protocol
        CHECK (protocol IN ('modbus_tcp', 'opcua', 'mqtt', 'http')) NOT VALID
        """
    )
