import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
sys.path.insert(0, str(ROOT / "apps" / "center" / "src"))
sys.path.insert(0, str(ROOT / "apps" / "edge" / "src"))
