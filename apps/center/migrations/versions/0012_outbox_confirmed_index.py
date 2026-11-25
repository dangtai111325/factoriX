"""storage_record_outbox: partial index for the CONFIRMED-row prune (WS-P P6 / WS-H round 4).

The recorder deletes CONFIRMED outbox rows older than the keep window every few minutes. Without an
index that DELETE was a sequential scan of the whole table (~300 MB on the appliance) each time. The
prune now deletes in bounded batches ordered by ``confirmed_at``; this partial index serves exactly that
predicate (``status = 'CONFIRMED' AND confirmed_at < cutoff``) and stays small relative to the table
(it covers only CONFIRMED rows, which are pruned).

Built ``CONCURRENTLY`` (outside the migration transaction) so the running recorder is not blocked
while the index is built on a large table.
"""

from __future__ import annotations

from alembic import op

revision = "0012_outbox_confirmed_index"
down_revision = "0011_latest_ingested_at"
branch_labels = None
depends_on = None

INDEX = "idx_storage_record_outbox_confirmed_at"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {INDEX} "
            "ON storage_record_outbox (confirmed_at) WHERE status = 'CONFIRMED'"
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX}")
