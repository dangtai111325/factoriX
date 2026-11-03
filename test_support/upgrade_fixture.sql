-- Synthetic data only. Run exclusively on factorix_upgrade_test before upgrade.
BEGIN;
INSERT INTO tenants (id, code, display_name, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'upgrade-check', 'Migration fixture', now());
INSERT INTO resource_types (id, tenant_id, key, name, category, is_system)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'enterprise', 'Enterprise', 'ENTERPRISE', true);
INSERT INTO resources (id, tenant_id, type_id, code, name, properties_json, version, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002', 'UPGRADE_CHECK', 'Kept during upgrade',
        '{"sentinel":"must-survive"}', 7, now(), now());
COMMIT;
