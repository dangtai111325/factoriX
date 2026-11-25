"""Store Center receipt time (``ingested_at``) on ``latest_signal_state`` (WS-P, plan §5.4).

``last_acquired_at`` is the Acquisition clock; ``ingested_at`` is when Center ingestion received
the observation (Center clock). Their difference is the delivery lag, which lets freshness tell
"source silent" apart from "pipeline late". Nullable and metadata-only (no table rewrite); the
ingestion worker probes for the column at start, so it runs before and after this migration.
"""

from __future__ import annotations

from alembic import op

revision = "0011_latest_ingested_at"
down_revision = "0010_storage_model_recording"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE latest_signal_state ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ")


def downgrade() -> None:
    op.execute("ALTER TABLE latest_signal_state DROP COLUMN IF EXISTS ingested_at")
