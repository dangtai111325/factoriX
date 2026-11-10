"""Standalone test defaults so `pytest apps/acquisition` works from root or apps/acquisition."""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("FACTORIX_DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/factorix_test")
os.environ.setdefault("FACTORIX_DATA_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
os.environ.setdefault("FACTORIX_ENVIRONMENT", "test")

APPS = Path(__file__).resolve().parents[2]
ROOT = APPS.parent
for path in (APPS / "acquisition/src", APPS / "center/src", ROOT):
    p = str(path)
    if p not in sys.path:
        sys.path.insert(0, p)
