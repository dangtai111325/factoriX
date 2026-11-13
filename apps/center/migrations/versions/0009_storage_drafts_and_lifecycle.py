"""Storage Drafts, Physical Objects, and Lifecycle Saga Schema.

Adds:
- ``storage_object_drafts``: Persistent storage for physical object drafts (replaces in-memory store).
- ``storage_objects``: Authoritative control-plane registry for physical TDengine objects (database, stable, subtable).
- ``storage_bindings``: Physical subtable column to canonical source bindings.
- Updates ``storage_operations`` status constraint to support the unified operation saga enum:
  ('DRAFT', 'VALIDATING', 'PLANNED', 'PREPARING', 'APPLYING', 'VERIFYING', 'APPLIED', 'FAILED', 'RECOVERING', 'CANCELLED').
"""

from __future__ import annotations

from alembic import op

revision = "0009_storage_drafts_and_lifecycle"
down_revision = "0008_storage_and_historian"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Persistent storage drafts
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_object_drafts (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            object_kind TEXT NOT NULL,
            name TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            spec_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            state TEXT NOT NULL DEFAULT 'DRAFT',
            created_by UUID REFERENCES admin_accounts (id) ON DELETE SET NULL,
            spec_hash TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_object_drafts_kind CHECK (object_kind IN ('database', 'stable', 'subtable')),
            CONSTRAINT storage_object_drafts_state CHECK (
                state IN ('DRAFT', 'VALIDATING', 'PLANNED', 'APPLIED', 'FAILED', 'CANCELLED')
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_object_drafts_tenant
        ON storage_object_drafts (tenant_id, object_kind, updated_at DESC)
        """
    )

    # 2. Authoritative physical objects registry
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_objects (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            object_type TEXT NOT NULL,
            physical_db TEXT NOT NULL,
            physical_name TEXT NOT NULL,
            parent_id UUID REFERENCES storage_objects (id) ON DELETE CASCADE,
            parent_name TEXT,
            display_name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            tags_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            binding_revision INTEGER NOT NULL DEFAULT 1,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_objects_type CHECK (object_type IN ('database', 'stable', 'subtable')),
            CONSTRAINT storage_objects_status CHECK (status IN ('ACTIVE', 'PAUSED', 'RETIRED', 'PURGED', 'ERROR')),
            CONSTRAINT uq_storage_objects_physical UNIQUE (tenant_id, object_type, physical_db, physical_name)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_objects_lookup
        ON storage_objects (tenant_id, object_type, status)
        """
    )

    # 3. Canonical subtable source bindings
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_bindings (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            subtable_id UUID REFERENCES storage_objects (id) ON DELETE CASCADE,
            physical_db TEXT NOT NULL,
            physical_subtable TEXT NOT NULL,
            canonical_source_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            target_column TEXT NOT NULL,
            signal_id UUID REFERENCES signal_definitions (id) ON DELETE SET NULL,
            model_id UUID REFERENCES output_groups (id) ON DELETE SET NULL,
            model_field_path TEXT,
            row_assembly_policy TEXT NOT NULL DEFAULT 'INDEPENDENT_EVENTS',
            policy_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            binding_revision INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_bindings_kind CHECK (source_kind IN ('signal', 'model_field')),
            CONSTRAINT storage_bindings_policy CHECK (
                row_assembly_policy IN ('INDEPENDENT_EVENTS', 'LATEST_AS_OF_TRIGGER', 'TIME_BUCKET', 'EXACT_TIMESTAMP')
            ),
            CONSTRAINT uq_storage_bindings_col UNIQUE (tenant_id, physical_db, physical_subtable, target_column)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_bindings_tenant
        ON storage_bindings (tenant_id, physical_db, physical_subtable)
        """
    )

    # 4. Expand storage_operations status enum and add verification fields
    op.execute("ALTER TABLE storage_operations DROP CONSTRAINT IF EXISTS storage_operations_status")
    op.execute(
        """
        ALTER TABLE storage_operations ADD CONSTRAINT storage_operations_status CHECK (
            status IN (
                'DRAFT', 'VALIDATING', 'PLANNED', 'PREPARING', 'APPLYING', 'VERIFYING',
                'APPLIED', 'FAILED', 'RECOVERING', 'CANCELLED',
                'PENDING', 'RUNNING', 'COMPLETED', 'PAUSED_RETRYABLE'
            )
        )
        """
    )
    op.execute("ALTER TABLE storage_operations ADD COLUMN IF NOT EXISTS spec_hash TEXT")
    op.execute("ALTER TABLE storage_operations ADD COLUMN IF NOT EXISTS verification_json JSONB NOT NULL DEFAULT '{}'::jsonb")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS storage_bindings")
    op.execute("DROP TABLE IF EXISTS storage_objects")
    op.execute("DROP TABLE IF EXISTS storage_object_drafts")
