"""Canonical current parent and database-enforced sibling identities."""

from alembic import op

revision = "0007_resource_identity"
down_revision = "0006_merge_collector_review2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("ALTER TABLE resources ADD COLUMN parent_id UUID")
    op.execute("ALTER TABLE sites ADD COLUMN resource_id UUID")
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (
                SELECT rr.to_id FROM resource_relations rr
                JOIN relation_types rt ON rt.id = rr.relation_type_id
                WHERE rt.code = 'CONTAINS' AND rr.valid_from <= now()
                  AND (rr.valid_to IS NULL OR rr.valid_to > now())
                GROUP BY rr.to_id HAVING count(*) > 1
            ) THEN RAISE EXCEPTION 'Resolve multiple current parents before upgrading the resource model.'; END IF;
            IF EXISTS (
                SELECT 1 FROM resource_relations rr
                JOIN relation_types rt ON rt.id = rr.relation_type_id
                JOIN resources p ON p.id = rr.from_id JOIN resources c ON c.id = rr.to_id
                WHERE rt.code = 'CONTAINS' AND (p.tenant_id <> c.tenant_id OR rr.tenant_id <> p.tenant_id)
            ) THEN RAISE EXCEPTION 'Resolve cross-tenant hierarchy relationships before upgrading.'; END IF;
            IF EXISTS (
                SELECT r.site_id FROM resources r JOIN resource_types t ON t.id = r.type_id
                WHERE t.key = 'site' AND r.site_id IS NOT NULL GROUP BY r.site_id HAVING count(*) > 1
            ) THEN RAISE EXCEPTION 'Resolve multiple Site resource anchors for one Site scope before upgrading.'; END IF;
        END $$
    """)
    op.execute("""
        UPDATE resources child SET parent_id = rr.from_id FROM resource_relations rr
        JOIN relation_types rt ON rt.id = rr.relation_type_id
        WHERE child.id = rr.to_id AND rt.code = 'CONTAINS' AND rr.valid_from <= now()
          AND (rr.valid_to IS NULL OR rr.valid_to > now())
    """)
    op.execute("""
        UPDATE sites s SET resource_id = r.id FROM resources r JOIN resource_types t ON t.id = r.type_id
        WHERE r.site_id = s.id AND r.tenant_id = s.tenant_id AND t.key = 'site'
    """)
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM resources GROUP BY tenant_id, parent_id, code HAVING count(*) > 1)
            THEN RAISE EXCEPTION 'Resolve duplicate codes under the same parent before upgrading.'; END IF;
            IF EXISTS (
                WITH RECURSIVE parents AS (
                    SELECT id, parent_id, ARRAY[id] AS path, FALSE AS cycle FROM resources
                    UNION ALL
                    SELECT w.id, p.parent_id, w.path || p.id, p.id = ANY(w.path)
                    FROM parents w JOIN resources p ON p.id = w.parent_id WHERE NOT w.cycle
                ) SELECT 1 FROM parents WHERE cycle
            ) THEN RAISE EXCEPTION 'Resolve hierarchy cycles before upgrading.'; END IF;
        END $$
    """)
    op.execute("ALTER TABLE resources ADD CONSTRAINT resources_tenant_identity UNIQUE (tenant_id, id)")
    op.execute("ALTER TABLE sites ADD CONSTRAINT sites_tenant_identity UNIQUE (tenant_id, id)")
    op.execute("""ALTER TABLE resources ADD CONSTRAINT resources_parent_tenant_fk
        FOREIGN KEY (tenant_id, parent_id) REFERENCES resources (tenant_id, id)""")
    op.execute("""ALTER TABLE resources ADD CONSTRAINT resources_site_tenant_fk
        FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id)""")
    op.execute("ALTER TABLE resources ADD CONSTRAINT resources_parent_not_self CHECK (parent_id IS DISTINCT FROM id)")
    op.execute("CREATE UNIQUE INDEX resources_sibling_code_uq ON resources (tenant_id, parent_id, code) NULLS NOT DISTINCT")
    op.execute("CREATE INDEX resources_parent_idx ON resources (tenant_id, parent_id)")
    op.execute("ALTER TABLE sites ADD CONSTRAINT sites_resource_anchor_uq UNIQUE (resource_id)")
    op.execute("""ALTER TABLE sites ADD CONSTRAINT sites_resource_tenant_fk
        FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, id)""")
    op.execute("ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_tenant_id_code_key")
    op.execute("CREATE INDEX sites_tenant_code_idx ON sites (tenant_id, code, id)")
    op.execute("""
        INSERT INTO resource_types (id, tenant_id, key, name, category, schema_json, is_system, revision)
        SELECT gen_random_uuid(), id, 'area', 'Area', 'AREA', '{}'::jsonb, TRUE, 1 FROM tenants
        ON CONFLICT (tenant_id, key) DO NOTHING
    """)


def downgrade() -> None:
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM sites GROUP BY tenant_id, code HAVING count(*) > 1)
        THEN RAISE EXCEPTION 'Duplicate Site codes cannot be represented by the old schema; restore a backup instead.'; END IF;
    END $$""")
    op.execute("ALTER TABLE sites DROP CONSTRAINT sites_resource_tenant_fk")
    op.execute("ALTER TABLE sites DROP CONSTRAINT sites_resource_anchor_uq")
    op.execute("ALTER TABLE resources DROP CONSTRAINT resources_site_tenant_fk")
    op.execute("ALTER TABLE resources DROP CONSTRAINT resources_parent_tenant_fk")
    op.execute("ALTER TABLE resources DROP CONSTRAINT resources_parent_not_self")
    op.execute("DROP INDEX resources_sibling_code_uq")
    op.execute("DROP INDEX resources_parent_idx")
    op.execute("ALTER TABLE resources DROP COLUMN parent_id")
    op.execute("ALTER TABLE sites DROP COLUMN resource_id")
    op.execute("ALTER TABLE sites DROP CONSTRAINT sites_tenant_identity")
    op.execute("ALTER TABLE resources DROP CONSTRAINT resources_tenant_identity")
    op.execute("DROP INDEX sites_tenant_code_idx")
    op.execute("ALTER TABLE sites ADD CONSTRAINT sites_tenant_id_code_key UNIQUE (tenant_id, code)")
