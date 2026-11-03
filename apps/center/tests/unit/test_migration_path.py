"""The current appliance's recorded revision must remain a valid upgrade base."""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_supports_upgrading_the_existing_review2_appliance():
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[2] / "migrations"))
    migrations = ScriptDirectory.from_config(config)
    deployed = migrations.get_revision("0005_code_sibling_uq")
    assert deployed is not None
    pending = list(migrations.iterate_revisions("heads", deployed.revision))
    assert pending, "The collector upgrade must extend the appliance's deployed schema."
    assert len(migrations.get_heads()) == 1
