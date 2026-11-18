"""Contract tests read both sides of a process boundary: make the acquisition package importable even when
pytest picks ``apps/center/pyproject.toml`` as its rootdir (running this folder on its own)."""

import sys
from pathlib import Path

_ACQ_SRC = Path(__file__).resolve().parents[3] / "acquisition" / "src"
if str(_ACQ_SRC) not in sys.path:
    sys.path.insert(0, str(_ACQ_SRC))
