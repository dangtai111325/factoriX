"""Storage & Historian control plane schema (S05).

Adds:
- ``telemetry_generations``: per-tenant monotonic ``active_epoch`` and reset lifecycle fencing (§10.3).
- ``collector_runtime_status``: local FactoriX Acquisition runtime status (replaces remote Edge dependency).
- ``storage_designs``, ``storage_design_versions``, ``storage_datasets``,
  ``storage_field_bindings``, ``storage_recording_policies``, ``storage_physical_registry``,
  ``storage_dependencies``, ``storage_operations``: Storage Designer / Catalog / Saga control plane (§6.2).
- Extends existing ``saved_queries`` and ``export_jobs`` cleanly without duplicating entities (§6.2).
- Extends ``latest_signal_state`` with dual freshness timestamps (``last_acquired_at``,
  ``last_value_changed_at``), ``data_epoch``, ``source_sequence``, ``reason_code``, ``event_uid`` (§5.4).
- Allows ``connections.edge_id`` to be NULL for local acquisition connections (§4.2, §6.1).
"""

from __future__ import annotations

from alembic import op

revision = "0008_storage_and_historian"
down_revision = "0007_data_model_v2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Local acquisition: edge_id is no longer mandatory for connections.
    op.execute("ALTER TABLE connections ALTER COLUMN edge_id DROP NOT NULL")

    # 2. Local collector runtime status table (schema aligned with factorix_acquisition.pg_control).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS collector_runtime_status (
            instance_id TEXT PRIMARY KEY,
            role TEXT NOT NULL DEFAULT 'acquisition',
            health TEXT NOT NULL DEFAULT 'UNKNOWN',
            software_version TEXT NOT NULL DEFAULT '',
            config_revision BIGINT NOT NULL DEFAULT 0,
            spool_pending BIGINT NOT NULL DEFAULT 0,
            fast_buffered BIGINT NOT NULL DEFAULT 0,
            broker_ok BOOLEAN NOT NULL DEFAULT FALSE,
            queues_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            diagnostic TEXT,
            last_heartbeat TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )

    # 3. Telemetry epoch fencing table (§10.3). Every existing tenant starts at active_epoch = 1.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS telemetry_generations (
            tenant_id UUID PRIMARY KEY REFERENCES tenants (id),
            active_epoch BIGINT NOT NULL DEFAULT 1,
            lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_by UUID REFERENCES admin_accounts (id),
            reset_operation_id UUID,
            CONSTRAINT telemetry_generations_epoch CHECK (active_epoch >= 1),
            CONSTRAINT telemetry_generations_state CHECK (lifecycle_state IN ('ACTIVE', 'RESETTING', 'FAILED_FENCED'))
        )
        """
    )
    op.execute(
        """
        INSERT INTO telemetry_generations (tenant_id, active_epoch, lifecycle_state, updated_at)
        SELECT id, 1, 'ACTIVE', now()
        FROM tenants
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )

    # 4. Storage Designer & Catalog metadata (§6.2).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_designs (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            draft_ast_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            draft_ui_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            draft_revision INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'DRAFT',
            current_version INTEGER NOT NULL DEFAULT 1,
            published_version_id UUID,
            owner_id UUID REFERENCES admin_accounts (id),
            last_validation_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            archived_at TIMESTAMPTZ,
            CONSTRAINT storage_designs_status CHECK (
                status IN ('DRAFT', 'VALIDATED', 'RUNNING', 'PAUSED', 'APPLYING', 'ERROR', 'ARCHIVED', 'RETIRED')
            )
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_designs_active_name
        ON storage_designs (tenant_id, lower(btrim(name)))
        WHERE status NOT IN ('ARCHIVED', 'RETIRED')
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_designs_tenant_status
        ON storage_designs (tenant_id, status, updated_at DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_design_versions (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            design_id UUID NOT NULL REFERENCES storage_designs (id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            ast_json JSONB NOT NULL,
            ast_hash TEXT NOT NULL,
            semantic_hash TEXT NOT NULL,
            ui_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            compiler_version TEXT NOT NULL,
            ddl_plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            plan_hash TEXT NOT NULL,
            publish_state TEXT NOT NULL DEFAULT 'APPLIED',
            effective_from_epoch BIGINT NOT NULL DEFAULT 1,
            effective_at TIMESTAMPTZ,
            created_by UUID REFERENCES admin_accounts (id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            applied_at TIMESTAMPTZ,
            diagnostics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            CONSTRAINT storage_design_versions_uniq UNIQUE (design_id, version),
            CONSTRAINT storage_design_versions_state CHECK (publish_state IN ('PENDING', 'APPLIED', 'FAILED', 'SUPERSEDED'))
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_design_versions_lookup
        ON storage_design_versions (tenant_id, design_id, version DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_datasets (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            design_id UUID NOT NULL REFERENCES storage_designs (id) ON DELETE CASCADE,
            dataset_key TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            resource_scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            semantics TEXT NOT NULL DEFAULT 'state_series',
            source_kind TEXT NOT NULL DEFAULT 'signals',
            time_axis TEXT NOT NULL DEFAULT 'acquired_at',
            tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            status TEXT NOT NULL DEFAULT 'DRAFT',
            current_schema_version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_datasets_uniq UNIQUE (design_id, dataset_key),
            CONSTRAINT storage_datasets_semantics CHECK (semantics IN ('state_series', 'event_stream', 'structured_record')),
            CONSTRAINT storage_datasets_source_kind CHECK (source_kind IN ('signals', 'model_fields', 'mixed')),
            CONSTRAINT storage_datasets_time_axis CHECK (time_axis IN ('acquired_at', 'source_time')),
            CONSTRAINT storage_datasets_status CHECK (status IN ('DRAFT', 'RUNNING', 'PAUSED', 'ARCHIVED', 'RETIRED'))
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_datasets_tenant
        ON storage_datasets (tenant_id, status)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_field_bindings (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            dataset_id UUID NOT NULL REFERENCES storage_datasets (id) ON DELETE CASCADE,
            field_key TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            value_type TEXT NOT NULL,
            max_length INTEGER,
            source_kind TEXT NOT NULL,
            signal_id UUID REFERENCES signal_definitions (id) ON DELETE SET NULL,
            model_id UUID REFERENCES output_groups (id) ON DELETE SET NULL,
            model_field_path TEXT,
            resource_id UUID REFERENCES resources (id) ON DELETE SET NULL,
            source_ref TEXT NOT NULL DEFAULT '',
            source_revision INTEGER NOT NULL DEFAULT 1,
            transform_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            nullable BOOLEAN NOT NULL DEFAULT TRUE,
            required BOOLEAN NOT NULL DEFAULT FALSE,
            unit TEXT,
            ordinal INTEGER NOT NULL DEFAULT 0,
            CONSTRAINT storage_field_bindings_uniq UNIQUE (dataset_id, field_key),
            CONSTRAINT storage_field_bindings_type CHECK (
                value_type IN ('bool', 'int64', 'float64', 'string', 'enum', 'json', 'timestamp')
            ),
            CONSTRAINT storage_field_bindings_kind CHECK (
                source_kind IN ('signal', 'model_field', 'constant', 'expression')
            )
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_storage_field_bindings_signal ON storage_field_bindings (tenant_id, signal_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_storage_field_bindings_model ON storage_field_bindings (tenant_id, model_id)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_recording_policies (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            dataset_id UUID NOT NULL UNIQUE REFERENCES storage_datasets (id) ON DELETE CASCADE,
            mode TEXT NOT NULL DEFAULT 'ON_CHANGE',
            policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            retention_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            version INTEGER NOT NULL DEFAULT 1,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_recording_policies_mode CHECK (mode IN ('ON_CHANGE', 'EVERY_ACQUISITION', 'INTERVAL'))
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_physical_registry (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            tier TEXT NOT NULL DEFAULT 'MANAGED',
            design_id UUID REFERENCES storage_designs (id) ON DELETE SET NULL,
            design_version_id UUID REFERENCES storage_design_versions (id) ON DELETE SET NULL,
            dataset_id UUID REFERENCES storage_datasets (id) ON DELETE SET NULL,
            signal_id UUID REFERENCES signal_definitions (id) ON DELETE SET NULL,
            series_key TEXT NOT NULL,
            value_type TEXT NOT NULL,
            td_database TEXT NOT NULL,
            td_stable TEXT NOT NULL,
            td_subtable TEXT NOT NULL,
            physical_schema_hash TEXT NOT NULL,
            generation BIGINT NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_physical_registry_tier CHECK (tier IN ('OPERATIONAL', 'MANAGED', 'MODEL_SNAPSHOT')),
            CONSTRAINT storage_physical_registry_status CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED')),
            CONSTRAINT storage_physical_registry_uniq_subtable UNIQUE (td_database, td_subtable),
            CONSTRAINT storage_physical_registry_uniq_series UNIQUE (tenant_id, tier, series_key)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_physical_registry_lookup
        ON storage_physical_registry (tenant_id, status, tier)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_dependencies (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            owner_type TEXT NOT NULL,
            owner_id UUID NOT NULL,
            target_type TEXT NOT NULL,
            target_id UUID NOT NULL,
            target_subpath TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'reads_from',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_dependencies_uniq UNIQUE (
                tenant_id, owner_type, owner_id, target_type, target_id, target_subpath, kind
            )
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_storage_dependencies_target ON storage_dependencies (tenant_id, target_type, target_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_storage_dependencies_owner ON storage_dependencies (tenant_id, owner_type, owner_id)")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_operations (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            operation_type TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id UUID,
            actor_id UUID REFERENCES admin_accounts (id),
            idempotency_key TEXT,
            status TEXT NOT NULL DEFAULT 'PENDING',
            requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            approved_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            step_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            error_code TEXT,
            error_message TEXT,
            trace_id TEXT NOT NULL DEFAULT '',
            CONSTRAINT storage_operations_status CHECK (
                status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED_RETRYABLE')
            )
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_operations_idempotency
        ON storage_operations (tenant_id, operation_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_operations_recent
        ON storage_operations (tenant_id, operation_type, requested_at DESC)
        """
    )

    # 5. Extend saved_queries for Historian Saved Views (avoids duplicate saved-view table).
    op.execute(
        """
        ALTER TABLE saved_queries
            ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES admin_accounts (id),
            ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS query_spec_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS chart_options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_queries_tenant_updated
        ON saved_queries (tenant_id, updated_at DESC)
        """
    )

    # 6. Extend export_jobs cleanly to cover async Historian/Storage exports (§6.2).
    op.execute("ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_status")
    op.execute(
        """
        ALTER TABLE export_jobs
            ADD CONSTRAINT export_status CHECK (
                status IN ('PENDING', 'RUNNING', 'READY', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')
            )
        """
    )
    op.execute(
        """
        ALTER TABLE export_jobs
            ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'csv',
            ADD COLUMN IF NOT EXISTS output_ref TEXT,
            ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT 'export.csv',
            ADD COLUMN IF NOT EXISTS byte_size BIGINT,
            ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS error_code TEXT,
            ADD COLUMN IF NOT EXISTS error_message TEXT,
            ADD COLUMN IF NOT EXISTS data_epoch BIGINT NOT NULL DEFAULT 1
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant_created
        ON export_jobs (tenant_id, created_at DESC)
        """
    )

    # 7. Extend latest_signal_state for dual freshness semantics & ordering (§5.4).
    op.execute(
        """
        ALTER TABLE latest_signal_state
            ADD COLUMN IF NOT EXISTS last_acquired_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_value_changed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS data_epoch BIGINT NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS source_sequence BIGINT,
            ADD COLUMN IF NOT EXISTS reason_code TEXT,
            ADD COLUMN IF NOT EXISTS event_uid TEXT
        """
    )
    op.execute(
        """
        UPDATE latest_signal_state
        SET last_acquired_at = COALESCE(last_acquired_at, received_time),
            last_value_changed_at = COALESCE(last_value_changed_at, event_time)
        WHERE last_acquired_at IS NULL OR last_value_changed_at IS NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE latest_signal_state
            DROP COLUMN IF EXISTS event_uid,
            DROP COLUMN IF EXISTS reason_code,
            DROP COLUMN IF EXISTS source_sequence,
            DROP COLUMN IF EXISTS data_epoch,
            DROP COLUMN IF EXISTS last_value_changed_at,
            DROP COLUMN IF EXISTS last_acquired_at
        """
    )

    op.execute("DROP INDEX IF EXISTS idx_export_jobs_tenant_created")
    op.execute(
        """
        ALTER TABLE export_jobs
            DROP COLUMN IF EXISTS data_epoch,
            DROP COLUMN IF EXISTS error_message,
            DROP COLUMN IF EXISTS error_code,
            DROP COLUMN IF EXISTS completed_at,
            DROP COLUMN IF EXISTS started_at,
            DROP COLUMN IF EXISTS expires_at,
            DROP COLUMN IF EXISTS byte_size,
            DROP COLUMN IF EXISTS file_name,
            DROP COLUMN IF EXISTS output_ref,
            DROP COLUMN IF EXISTS format
        """
    )
    op.execute("ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_status")
    op.execute("UPDATE export_jobs SET status = 'READY' WHERE status = 'COMPLETED'")
    op.execute("UPDATE export_jobs SET status = 'FAILED' WHERE status IN ('CANCELLED', 'EXPIRED')")
    op.execute("UPDATE export_jobs SET status = 'PENDING' WHERE status = 'RUNNING'")
    op.execute(
        """
        ALTER TABLE export_jobs
            ADD CONSTRAINT export_status CHECK (status IN ('PENDING', 'READY', 'FAILED'))
        """
    )

    op.execute("DROP INDEX IF EXISTS idx_saved_queries_tenant_updated")
    op.execute(
        """
        ALTER TABLE saved_queries
            DROP COLUMN IF EXISTS updated_at,
            DROP COLUMN IF EXISTS created_at,
            DROP COLUMN IF EXISTS version,
            DROP COLUMN IF EXISTS is_default,
            DROP COLUMN IF EXISTS chart_options_json,
            DROP COLUMN IF EXISTS query_spec_json,
            DROP COLUMN IF EXISTS description,
            DROP COLUMN IF EXISTS owner_id
        """
    )

    op.execute("DROP TABLE IF EXISTS storage_operations")
    op.execute("DROP TABLE IF EXISTS storage_dependencies")
    op.execute("DROP TABLE IF EXISTS storage_physical_registry")
    op.execute("DROP TABLE IF EXISTS storage_recording_policies")
    op.execute("DROP TABLE IF EXISTS storage_field_bindings")
    op.execute("DROP TABLE IF EXISTS storage_datasets")
    op.execute("DROP TABLE IF EXISTS storage_design_versions")
    op.execute("DROP TABLE IF EXISTS storage_designs")
    op.execute("DROP TABLE IF EXISTS telemetry_generations")
    op.execute("DROP TABLE IF EXISTS collector_runtime_status")

    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM connections WHERE edge_id IS NULL) THEN
                ALTER TABLE connections ALTER COLUMN edge_id SET NOT NULL;
            END IF;
        END $$;
        """
    )
