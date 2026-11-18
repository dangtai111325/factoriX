"""Managed recording of Data Model fields into user-created TDengine subtables (WS-H, guide G-05/G-06).

Adds:
- ``storage_bindings``: ``ATOMIC_EVENT`` row assembly (one row per completion event, guide F4) and
  ``source_data_type`` (type of the bound source at bind time, for drift checks). A subtable created
  with the explicit "no binding" choice simply has no rows here.
- ``storage_objects.recording_json``: recording policy of a subtable/supertable (mode ON_CHANGE |
  ON_NEW_EVENT | EVERY_ACQUISITION | INTERVAL, deadband, identity paths). Recording on/off is the
  object ``status`` (ACTIVE = recording, PAUSED = not recording).
- ``storage_operations.object_key``: canonical ``db.name`` of the object an operation creates, used for
  idempotent replay and to show the operation in the UI.
- ``storage_field_state``: durable last committed value/quality/null-state per binding (ON_CHANGE
  comparator survives restarts, guide D3.6) and last event identity (ON_NEW_EVENT dedup).
- ``storage_record_outbox``: durable at-least-once outbox between the model engine and the TDengine
  writer. Rows are written in the same PostgreSQL transaction as ``model_state``; the dispatcher marks
  them CONFIRMED only after TDengine accepted the INSERT. ``(ts, event_key)`` is deterministic, so a
  replay is an idempotent upsert on the composite key.
"""

from __future__ import annotations

from alembic import op

revision = "0010_storage_model_recording"
down_revision = "0009_storage_drafts_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE storage_bindings DROP CONSTRAINT IF EXISTS storage_bindings_policy")
    op.execute(
        """
        ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_policy CHECK (
            row_assembly_policy IN (
                'INDEPENDENT_EVENTS', 'LATEST_AS_OF_TRIGGER', 'TIME_BUCKET', 'EXACT_TIMESTAMP', 'ATOMIC_EVENT'
            )
        )
        """
    )
    op.execute("ALTER TABLE storage_bindings ADD COLUMN IF NOT EXISTS source_data_type TEXT")
    op.execute("ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS recording_json JSONB NOT NULL DEFAULT '{}'::jsonb")
    op.execute("ALTER TABLE storage_operations ADD COLUMN IF NOT EXISTS object_key TEXT")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_bindings_model
        ON storage_bindings (tenant_id, model_id) WHERE status = 'ACTIVE' AND model_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_field_state (
            binding_key TEXT NOT NULL,
            tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            physical_db TEXT NOT NULL,
            physical_subtable TEXT NOT NULL,
            data_epoch BIGINT NOT NULL DEFAULT 1,
            last_value_canon TEXT,
            last_quality TEXT,
            last_is_null BOOLEAN NOT NULL DEFAULT FALSE,
            last_identity TEXT,
            last_ts TIMESTAMPTZ,
            sequence BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, binding_key)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_record_outbox (
            id BIGSERIAL PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            physical_db TEXT NOT NULL,
            physical_subtable TEXT NOT NULL,
            event_key TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            data_epoch BIGINT NOT NULL DEFAULT 1,
            payload_json JSONB NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            confirmed_at TIMESTAMPTZ,
            CONSTRAINT storage_record_outbox_status CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
            CONSTRAINT uq_storage_record_outbox_event UNIQUE (tenant_id, physical_db, physical_subtable, event_key)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_storage_record_outbox_pending
        ON storage_record_outbox (next_attempt_at, id) WHERE status = 'PENDING'
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS storage_record_outbox")
    op.execute("DROP TABLE IF EXISTS storage_field_state")
    op.execute("DROP INDEX IF EXISTS idx_storage_bindings_model")
    op.execute("ALTER TABLE storage_operations DROP COLUMN IF EXISTS object_key")
    op.execute("ALTER TABLE storage_objects DROP COLUMN IF EXISTS recording_json")
    op.execute("ALTER TABLE storage_bindings DROP COLUMN IF EXISTS source_data_type")
    op.execute("ALTER TABLE storage_bindings DROP CONSTRAINT IF EXISTS storage_bindings_policy")
    op.execute(
        """
        ALTER TABLE storage_bindings ADD CONSTRAINT storage_bindings_policy CHECK (
            row_assembly_policy IN ('INDEPENDENT_EVENTS', 'LATEST_AS_OF_TRIGGER', 'TIME_BUCKET', 'EXACT_TIMESTAMP')
        )
        """
    )
