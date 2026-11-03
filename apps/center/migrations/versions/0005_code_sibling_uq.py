"""Resource codes unique per parent path, not tenant-wide."""

from __future__ import annotations

from alembic import op

revision = "0005_code_sibling_uq"
down_revision = "0004_admin_full_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Sibling uniqueness is enforced in application code (CONTAINS parent).
    op.execute("ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_tenant_id_code_key")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS resources_tenant_code_idx
        ON resources (tenant_id, code)
        """
    )
    # Seed Area type for existing tenants (ISA-95).
    op.execute(
        """
        INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
        SELECT md5(random()::text || clock_timestamp()::text || t.id::text)::uuid,
               t.id, 'area', 'Area', 'AREA', '{}'::jsonb, TRUE, 1
        FROM tenants t
        WHERE NOT EXISTS (
            SELECT 1 FROM resource_types rt
            WHERE rt.tenant_id = t.id AND rt.key = 'area'
        )
        """
    )
    op.execute(
        """
        INSERT INTO type_adjacency (tenant_id, relation_code, parent_type_key, child_type_key)
        SELECT t.id, 'CONTAINS', parent_key, child_key
        FROM tenants t
        CROSS JOIN (VALUES
            ('site', 'area'),
            ('area', 'zone'),
            ('area', 'line'),
            ('area', 'workshop'),
            ('area', 'plant'),
            ('area', 'machine'),
            ('plant', 'area'),
            ('zone', 'physical_asset'),
            ('zone', 'functional_position'),
            ('line', 'physical_asset'),
            ('line', 'functional_position'),
            ('machine', 'physical_asset'),
            ('machine', 'functional_position'),
            ('machine', 'sensor'),
            ('functional_position', 'sensor')
        ) AS pairs(parent_key, child_key)
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS resources_tenant_code_idx")
    op.execute(
        """
        DELETE FROM type_adjacency
        WHERE (parent_type_key, child_type_key) IN (
            ('site', 'area'),
            ('area', 'zone'),
            ('area', 'line'),
            ('area', 'workshop'),
            ('area', 'plant'),
            ('area', 'machine'),
            ('plant', 'area'),
            ('zone', 'physical_asset'),
            ('zone', 'functional_position'),
            ('line', 'physical_asset'),
            ('line', 'functional_position'),
            ('machine', 'physical_asset'),
            ('machine', 'functional_position'),
            ('machine', 'sensor'),
            ('functional_position', 'sensor')
        )
        """
    )
    # Re-adding UNIQUE may fail if duplicate sibling codes already exist.
    op.execute(
        """
        DO $$
        BEGIN
            ALTER TABLE resources ADD CONSTRAINT resources_tenant_id_code_key UNIQUE (tenant_id, code);
        EXCEPTION WHEN others THEN
            NULL;
        END $$
        """
    )
