"""Run migrated DB tests in a named disposable DB inside the existing appliance.

This does not launch an HTTP server or change the running app's environment.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

from sqlalchemy.engine import make_url


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="factorix_test")
    parser.add_argument("--migration-only", action="store_true")
    parser.add_argument("--target-revision", default="head")
    parser.add_argument("pytest_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_]+_test", args.database):
        parser.error("Database must be explicitly disposable and end in _test.")
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.target_revision):
        parser.error("Invalid migration revision.")
    root = Path(__file__).resolve().parents[1]
    url = make_url(os.environ["FACTORIX_DATABASE_URL"]).set(database=args.database)
    env = dict(os.environ)
    env.update(
        FACTORIX_DATABASE_URL=url.render_as_string(hide_password=False),
        FACTORIX_TEST_DATABASE_URL=url.render_as_string(hide_password=False),
        FACTORIX_BOOTSTRAP_TOKEN="integration-bootstrap-token",
        FACTORIX_ENVIRONMENT="test", FACTORIX_APPLIANCE="false", FACTORIX_DATA_DIR="",
        FACTORIX_WEB_DIST="", FACTORIX_COOKIE_SECURE="false", FACTORIX_SMTP_HOST="",
        FACTORIX_SCHEMA_SQL=str(root / "infrastructure/postgres/001_schema.sql"),
        PYTHONPATH=os.pathsep.join([str(root / "apps/center/src"), str(root / "apps/edge/src"), "/tmp/factorix-test-deps"]),
    )
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", args.target_revision], cwd=root / "apps/center", env=env, check=True)
    if args.migration_only:
        print(f"Migration reached {args.target_revision} on {args.database}.")
        return
    test_args = args.pytest_args[1:] if args.pytest_args[:1] == ["--"] else args.pytest_args
    result = subprocess.run([sys.executable, "-m", "pytest", "-c", str(root / "pytest.ini"), "-q", "-p", "no:cacheprovider", *test_args], cwd=root, env=env)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
