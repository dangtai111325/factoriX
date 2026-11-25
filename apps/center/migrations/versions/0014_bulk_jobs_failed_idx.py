"""Durable bulk-subtable jobs + partial index for FAILED writer-outbox rows (B-12 / OP-14).

* ``storage_bulk_jobs``: the progress and per-row results of ``POST /storage/td/subtables/bulk`` jobs. The
  job still runs in the API process; this table lets ``GET /storage/td/bulk-jobs/{id}`` answer after an
  API restart — a job that was QUEUED / RUNNING in a process that is gone is reported INTERRUPTED with
  the rows it finished (each row is idempotent, so validating again shows the created ones as EXISTS).
* ``idx_storage_record_outbox_failed``: the "N with write errors" KPI (``/td/stats``), the Error filter and
  ``/storage/recording/failures`` look only at FAILED rows; without this index each call scanned the
  whole outbox (~370 ms for 272k rows on the appliance). Partial, so it stays tiny (FAILED rows are rare).
  Built ``CONCURRENTLY`` outside the migration transaction so the running recorder is not blocked.

Depends on ``0013_dashboard_studio`` (Dashboard Studio, written in parallel on the Dashboard branch);
the chain stays single-headed once both are merged.
"""

from __future__ import annotations

from alembic import op

revision = "0014_bulk_jobs_failed_idx"
down_revision = "0013_dashboard_studio"
branch_labels = None
depends_on = None

FAILED_INDEX = "idx_storage_record_outbox_failed"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_bulk_jobs (
            id UUID PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'QUEUED',
            total INTEGER NOT NULL DEFAULT 0,
            done INTEGER NOT NULL DEFAULT 0,
            summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            timing_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            error TEXT,
            process_id TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT storage_bulk_jobs_status CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'INTERRUPTED'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_storage_bulk_jobs_tenant_created ON storage_bulk_jobs (tenant_id, created_at DESC)"
    )
    with op.get_context().autocommit_block():
        op.execute(
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {FAILED_INDEX} "
            "ON storage_record_outbox (tenant_id, physical_db, physical_subtable, created_at) WHERE status = 'FAILED'"
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {FAILED_INDEX}")
    op.execute("DROP TABLE IF EXISTS storage_bulk_jobs")
