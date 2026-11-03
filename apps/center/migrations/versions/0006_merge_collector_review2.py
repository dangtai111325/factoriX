"""Allow both the reverted baseline and the already-deployed review2 appliance to upgrade.

The historical sibling-code migration is retained unchanged so the live revision
is recognized. Current hierarchy constraints are strengthened in later migrations.
"""

revision = "0006_merge_collector_review2"
down_revision = ("0005_commissioning_contract", "0005_code_sibling_uq")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
