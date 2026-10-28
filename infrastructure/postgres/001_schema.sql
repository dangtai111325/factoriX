CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT tenants_status CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE TABLE sites (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, code)
);

CREATE TABLE admin_accounts (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    login TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'vi',
    timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, login),
    UNIQUE (tenant_id, email)
);

CREATE UNIQUE INDEX one_active_admin ON admin_accounts ((1)) WHERE disabled_at IS NULL;

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    admin_id UUID NOT NULL REFERENCES admin_accounts (id),
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE password_reset_codes (
    id UUID PRIMARY KEY,
    admin_id UUID NOT NULL REFERENCES admin_accounts (id),
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX password_reset_codes_admin ON password_reset_codes (admin_id, created_at DESC);

CREATE TABLE login_throttle (
    login TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL,
    window_started TIMESTAMPTZ NOT NULL,
    locked_until TIMESTAMPTZ
);

CREATE TABLE resource_types (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE (tenant_id, key),
    CONSTRAINT resource_types_category CHECK (
        category IN ('ENTERPRISE', 'SITE', 'AREA', 'WORK_CENTER', 'ASSET', 'POSITION', 'CUSTOM')
    )
);

CREATE TABLE resources (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    site_id UUID REFERENCES sites (id),
    type_id UUID NOT NULL REFERENCES resource_types (id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    version INTEGER NOT NULL DEFAULT 1,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, code),
    CONSTRAINT resources_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
);

CREATE INDEX resources_tenant_type ON resources (tenant_id, type_id);
CREATE INDEX resources_site ON resources (tenant_id, site_id);

CREATE TABLE relation_types (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    code TEXT NOT NULL,
    inverse_label TEXT NOT NULL,
    from_categories JSONB NOT NULL,
    to_categories JSONB NOT NULL,
    acyclic BOOLEAN NOT NULL,
    temporal BOOLEAN NOT NULL,
    UNIQUE (tenant_id, code)
);

CREATE TABLE type_adjacency (
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    relation_code TEXT NOT NULL,
    parent_type_key TEXT NOT NULL,
    child_type_key TEXT NOT NULL,
    PRIMARY KEY (tenant_id, relation_code, parent_type_key, child_type_key)
);

CREATE TABLE resource_relations (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    from_id UUID NOT NULL REFERENCES resources (id),
    to_id UUID NOT NULL REFERENCES resources (id),
    relation_type_id UUID NOT NULL REFERENCES relation_types (id),
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT relations_distinct CHECK (from_id <> to_id),
    CONSTRAINT relations_time CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX relations_from ON resource_relations (tenant_id, from_id);
CREATE INDEX relations_to ON resource_relations (tenant_id, to_id);

CREATE TABLE hierarchy_templates (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    allowed_type_rules_json JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    UNIQUE (tenant_id, name),
    CONSTRAINT hierarchy_templates_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))
);

CREATE TABLE hierarchy_views (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    name TEXT NOT NULL,
    relation_filter TEXT NOT NULL DEFAULT 'CONTAINS',
    root_selector JSONB NOT NULL DEFAULT '{}'::jsonb,
    level_rules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    UNIQUE (tenant_id, name)
);

CREATE TABLE layout_definitions (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    scope_resource_id UUID REFERENCES resources (id),
    name TEXT NOT NULL,
    draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    published_revision INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, name)
);

CREATE TABLE layout_revisions (
    id UUID PRIMARY KEY,
    layout_id UUID NOT NULL REFERENCES layout_definitions (id),
    revision INTEGER NOT NULL,
    elements_json JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES admin_accounts (id),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (layout_id, revision)
);

CREATE TABLE edge_nodes (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    site_id UUID NOT NULL REFERENCES sites (id),
    name TEXT NOT NULL,
    enrollment_status TEXT NOT NULL,
    credential_hash TEXT,
    desired_revision BIGINT NOT NULL DEFAULT 0,
    active_revision BIGINT NOT NULL DEFAULT 0,
    last_heartbeat TIMESTAMPTZ,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    software_version TEXT NOT NULL DEFAULT '',
    outbox_pending INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, site_id, name),
    CONSTRAINT edge_enroll CHECK (enrollment_status IN ('UNENROLLED', 'ENROLLED', 'REVOKED')),
    CONSTRAINT edge_health CHECK (
        health IN ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'OFFLINE', 'CONFIG_PENDING', 'CONFIG_VALIDATED', 'ACTIVE')
    )
);

CREATE TABLE edge_enrollment_tokens (
    id UUID PRIMARY KEY,
    edge_id UUID NOT NULL REFERENCES edge_nodes (id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

CREATE TABLE secret_store (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    rotated_at TIMESTAMPTZ
);

CREATE TABLE connections (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    site_id UUID NOT NULL REFERENCES sites (id),
    edge_id UUID NOT NULL REFERENCES edge_nodes (id),
    protocol TEXT NOT NULL,
    name TEXT NOT NULL,
    endpoint_redacted TEXT NOT NULL,
    secret_ref UUID REFERENCES secret_store (id),
    config_json JSONB NOT NULL,
    status TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    last_error TEXT,
    last_success_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (tenant_id, site_id, name),
    CONSTRAINT connections_protocol CHECK (protocol IN ('modbus_tcp', 'opcua', 'mqtt', 'http')),
    CONSTRAINT connections_status CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'))
);

CREATE TABLE acquisition_jobs (
    id UUID PRIMARY KEY,
    connection_id UUID NOT NULL REFERENCES connections (id),
    mode TEXT NOT NULL,
    interval_ms INTEGER,
    schedule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    timeout_ms INTEGER NOT NULL DEFAULT 3000,
    concurrency_limit INTEGER NOT NULL DEFAULT 1,
    config_revision BIGINT NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT jobs_mode CHECK (mode IN ('POLL', 'SUBSCRIBE', 'EVENT'))
);

CREATE TABLE source_fields (
    id UUID PRIMARY KEY,
    acquisition_job_id UUID NOT NULL REFERENCES acquisition_jobs (id),
    address_kind TEXT NOT NULL,
    address_json JSONB NOT NULL,
    native_datatype TEXT NOT NULL,
    decode_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ordinal INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE signal_definitions (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    resource_id UUID NOT NULL REFERENCES resources (id),
    key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    data_type TEXT NOT NULL,
    unit TEXT,
    category TEXT NOT NULL,
    expected_interval_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT signals_type CHECK (data_type IN ('bool', 'int64', 'float64', 'string', 'enum', 'json')),
    CONSTRAINT signals_category CHECK (category IN ('COLLECTED', 'CALCULATED', 'REFERENCED')),
    CONSTRAINT signals_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
);

CREATE UNIQUE INDEX signal_key_active ON signal_definitions (resource_id, key) WHERE status = 'ACTIVE';

CREATE TABLE signal_bindings (
    id UUID PRIMARY KEY,
    signal_id UUID NOT NULL REFERENCES signal_definitions (id),
    source_field_id UUID NOT NULL REFERENCES source_fields (id),
    transform_chain_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revision INTEGER NOT NULL DEFAULT 1,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ
);

CREATE UNIQUE INDEX one_active_binding ON signal_bindings (signal_id) WHERE enabled = TRUE AND valid_to IS NULL;

CREATE TABLE mapping_definitions (
    id UUID PRIMARY KEY,
    connection_id UUID NOT NULL REFERENCES connections (id),
    jsonpath TEXT NOT NULL,
    cardinality_policy TEXT NOT NULL,
    missing_policy TEXT NOT NULL,
    coercion_policy TEXT NOT NULL DEFAULT 'STRICT',
    revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE formula_definitions (
    id UUID PRIMARY KEY,
    signal_id UUID NOT NULL UNIQUE REFERENCES signal_definitions (id),
    expression_source TEXT NOT NULL,
    ast_json JSONB NOT NULL,
    unit TEXT,
    temporal_policy_json JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    CONSTRAINT formula_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))
);

CREATE TABLE formula_dependencies (
    formula_id UUID NOT NULL REFERENCES formula_definitions (id),
    variable_alias TEXT NOT NULL,
    dependency_signal_id UUID NOT NULL REFERENCES signal_definitions (id),
    PRIMARY KEY (formula_id, variable_alias)
);

CREATE TABLE output_groups (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    resource_id UUID NOT NULL REFERENCES resources (id),
    key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    topic_template TEXT NOT NULL,
    projection_policy_json JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    UNIQUE (resource_id, key),
    CONSTRAINT output_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))
);

CREATE TABLE output_group_members (
    output_group_id UUID NOT NULL REFERENCES output_groups (id),
    signal_id UUID NOT NULL REFERENCES signal_definitions (id),
    output_alias TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (output_group_id, output_alias)
);

CREATE TABLE configuration_drafts (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    scope_id UUID NOT NULL,
    author_id UUID NOT NULL REFERENCES admin_accounts (id),
    payload_json JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT draft_state CHECK (state IN ('DRAFT', 'DISCARDED', 'PUBLISHED'))
);

CREATE TABLE configuration_releases (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    edge_id UUID NOT NULL REFERENCES edge_nodes (id),
    revision BIGINT NOT NULL,
    content_hash TEXT NOT NULL,
    snapshot_json JSONB NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    published_by UUID NOT NULL REFERENCES admin_accounts (id),
    status TEXT NOT NULL,
    UNIQUE (edge_id, revision),
    CONSTRAINT release_status CHECK (status IN ('PUBLISHED', 'SUPERSEDED', 'FAILED'))
);

CREATE TABLE deployment_events (
    id UUID PRIMARY KEY,
    edge_id UUID NOT NULL REFERENCES edge_nodes (id),
    revision BIGINT NOT NULL,
    state TEXT NOT NULL,
    diagnostic_redacted TEXT NOT NULL DEFAULT '',
    at TIMESTAMPTZ NOT NULL
);

CREATE TABLE commissioning_jobs (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    connection_id UUID NOT NULL REFERENCES connections (id),
    requested_by UUID NOT NULL REFERENCES admin_accounts (id),
    stages_json JSONB NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    error_code TEXT,
    diagnostic TEXT NOT NULL DEFAULT '',
    CONSTRAINT commission_status CHECK (status IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'CANCELLED'))
);

CREATE TABLE observations (
    id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    site_id UUID,
    resource_id UUID NOT NULL,
    signal_id UUID NOT NULL,
    edge_id UUID,
    connection_id UUID,
    event_uid TEXT NOT NULL,
    event_time TIMESTAMPTZ NOT NULL,
    received_time TIMESTAMPTZ NOT NULL,
    source_time TIMESTAMPTZ,
    value_type TEXT NOT NULL,
    value_json JSONB,
    unit TEXT,
    quality TEXT NOT NULL,
    origin TEXT NOT NULL,
    config_revision BIGINT NOT NULL,
    provenance_json JSONB NOT NULL,
    PRIMARY KEY (event_time, id)
) PARTITION BY RANGE (event_time);

CREATE INDEX observations_signal_time ON observations (tenant_id, signal_id, event_time DESC);
CREATE INDEX observations_resource_time ON observations (tenant_id, resource_id, event_time DESC);

CREATE TABLE ingest_dedup (
    tenant_id UUID NOT NULL,
    edge_id UUID NOT NULL,
    event_uid TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, edge_id, event_uid)
);

CREATE TABLE latest_signal_state (
    tenant_id UUID NOT NULL,
    signal_id UUID NOT NULL,
    resource_id UUID NOT NULL,
    observation_id UUID NOT NULL,
    value_type TEXT NOT NULL,
    value_json JSONB,
    unit TEXT,
    quality TEXT NOT NULL,
    event_time TIMESTAMPTZ NOT NULL,
    received_time TIMESTAMPTZ NOT NULL,
    source_time TIMESTAMPTZ,
    config_revision BIGINT NOT NULL,
    origin TEXT NOT NULL,
    last_good_value_json JSONB,
    last_good_event_time TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, signal_id)
);

CREATE TABLE observation_quarantine (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    edge_id UUID,
    event_uid TEXT NOT NULL,
    reason TEXT NOT NULL,
    received_time TIMESTAMPTZ NOT NULL,
    payload_redacted JSONB NOT NULL
);

CREATE TABLE dashboards (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    site_id UUID REFERENCES sites (id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_admin_id UUID NOT NULL REFERENCES admin_accounts (id),
    draft_revision INTEGER NOT NULL DEFAULT 1,
    published_revision INTEGER,
    draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    archived_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE dashboard_revisions (
    id UUID PRIMARY KEY,
    dashboard_id UUID NOT NULL REFERENCES dashboards (id),
    revision INTEGER NOT NULL,
    breakpoints_json JSONB NOT NULL,
    widget_configs_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ,
    UNIQUE (dashboard_id, revision)
);

CREATE TABLE retention_policies (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    scope_type TEXT NOT NULL,
    scope_id UUID,
    keep_days INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
    purge_schedule TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT retention_keep CHECK (keep_days >= 1 AND keep_days <= 3650)
);

CREATE TABLE retention_jobs (
    id UUID PRIMARY KEY,
    policy_id UUID NOT NULL REFERENCES retention_policies (id),
    dry_run BOOLEAN NOT NULL,
    affected_count BIGINT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ
);

CREATE TABLE saved_queries (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    name TEXT NOT NULL,
    selected_signals_json JSONB NOT NULL,
    aggregation_json JSONB NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'PRIVATE'
);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    actor_id UUID,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    before_json JSONB,
    after_json JSONB,
    correlation_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX audit_tenant_time ON audit_events (tenant_id, occurred_at DESC);

CREATE TABLE export_jobs (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants (id),
    requested_by UUID NOT NULL REFERENCES admin_accounts (id),
    query_json JSONB NOT NULL,
    status TEXT NOT NULL,
    row_count INTEGER,
    csv_text TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT export_status CHECK (status IN ('PENDING', 'READY', 'FAILED'))
);
