"""Flexible hierarchy: area type, scoped resource codes, path_code, and hierarchy mode."""

from __future__ import annotations

from alembic import op

revision = "0005_flexible_hierarchy_area"
down_revision = "0004_admin_full_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Tenants hierarchy mode
    op.execute(
        """
        ALTER TABLE tenants
        ADD COLUMN IF NOT EXISTS hierarchy_mode VARCHAR(20) NOT NULL DEFAULT 'guided'
        """
    )

    # 2. Audit events severity
    op.execute(
        """
        ALTER TABLE audit_events
        ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'INFO'
        """
    )

    # 3. Resources parent_id and path_code
    op.execute(
        """
        ALTER TABLE resources
        ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES resources (id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS path_code TEXT
        """
    )

    op.execute(
        """
        ALTER TABLE commissioning_jobs
        ADD COLUMN IF NOT EXISTS samples_json JSONB DEFAULT '{}'::jsonb
        """
    )

    op.execute(
        """
        ALTER TABLE edge_nodes
        ADD COLUMN IF NOT EXISTS queues_json JSONB DEFAULT '{}'::jsonb
        """
    )

    # 4. Drop old global unique code constraint if it exists
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'resources_tenant_id_code_key'
            ) THEN
                ALTER TABLE resources DROP CONSTRAINT resources_tenant_id_code_key;
            END IF;
        END $$;
        """
    )

    # 5. Add scoped unique indices for code
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_sibling_code
        ON resources (tenant_id, parent_id, lower(code))
        WHERE status = 'ACTIVE' AND parent_id IS NOT NULL
        """
    )

    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_root_code
        ON resources (tenant_id, lower(code))
        WHERE status = 'ACTIVE' AND parent_id IS NULL
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_resources_path_code
        ON resources (tenant_id, path_code)
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_resources_parent_id
        ON resources (tenant_id, parent_id)
        """
    )

    # 6. Insert 'area' type into resource_types for all tenants
    op.execute(
        """
        INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
        SELECT gen_random_uuid(), id, 'area', 'Area', 'AREA', '{}'::jsonb, TRUE, 1
        FROM tenants t
        WHERE NOT EXISTS (
            SELECT 1 FROM resource_types rt
            WHERE rt.tenant_id = t.id AND rt.key = 'area'
        )
        """
    )

    # 7. Insert 'area' adjacencies into type_adjacency for all tenants
    op.execute(
        """
        INSERT INTO type_adjacency (tenant_id, relation_code, parent_type_key, child_type_key)
        SELECT t.id, 'CONTAINS', p.parent, p.child
        FROM tenants t
        CROSS JOIN (
            VALUES
                ('site', 'area'),
                ('area', 'zone'),
                ('area', 'line'),
                ('area', 'cell'),
                ('area', 'workshop'),
                ('area', 'machine'),
                ('area', 'utility_system')
        ) AS p(parent, child)
        ON CONFLICT DO NOTHING
        """
    )

    # 8. Backfill parent_id and path_code for existing resources from resource_relations
    op.execute(
        """
        UPDATE resources r
        SET parent_id = rr.from_id
        FROM resource_relations rr
        JOIN relation_types rt ON rt.id = rr.relation_type_id
        WHERE rr.to_id = r.id AND rt.code = 'CONTAINS' AND rr.valid_to IS NULL
          AND r.parent_id IS NULL
        """
    )

    op.execute(
        """
        UPDATE resources
        SET path_code = code
        WHERE parent_id IS NULL AND path_code IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_resources_sibling_code")
    op.execute("DROP INDEX IF EXISTS uq_resources_root_code")
    op.execute("DROP INDEX IF EXISTS idx_resources_path_code")
    op.execute("DROP INDEX IF EXISTS idx_resources_parent_id")
    op.execute("ALTER TABLE resources DROP COLUMN IF EXISTS parent_id")
    op.execute("ALTER TABLE resources DROP COLUMN IF EXISTS path_code")
    op.execute("ALTER TABLE audit_events DROP COLUMN IF EXISTS severity")
    op.execute("ALTER TABLE tenants DROP COLUMN IF EXISTS hierarchy_mode")
