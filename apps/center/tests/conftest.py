import os
import sys
from pathlib import Path

# Safe test environment defaults so unit and safety tests can run in CI or clean environments without a local .env file
os.environ.setdefault("FACTORIX_DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/factorix_test")
os.environ.setdefault("FACTORIX_DATA_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
os.environ.setdefault("FACTORIX_ENVIRONMENT", "test")

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "center" / "src"))
sys.path.insert(0, str(ROOT / "apps" / "edge" / "src"))
