"""Create the application role inside the appliance. The password is not printed."""

from __future__ import annotations

import os
import re
import subprocess

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def main() -> None:
    user = os.environ["POSTGRES_USER"]
    database = os.environ["POSTGRES_DB"]
    password = os.environ["POSTGRES_PASSWORD"]
    if not _NAME.fullmatch(user) or not _NAME.fullmatch(database):
        raise SystemExit("POSTGRES_USER and POSTGRES_DB must be simple names.")
    quoted = password.replace("'", "''")
    role = f"""
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{user}') THEN
        CREATE ROLE {user} LOGIN PASSWORD '{quoted}';
      ELSE
        ALTER ROLE {user} WITH LOGIN PASSWORD '{quoted}';
      END IF;
    END
    $$;
    """
    subprocess.run(["su", "postgres", "-c", "psql -d postgres -v ON_ERROR_STOP=1"], input=role, text=True, check=True)
    exists = subprocess.run(
        ["su", "postgres", "-c", "psql -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname = '%s'\"" % database],
        text=True,
        capture_output=True,
        check=True,
    )
    if exists.stdout.strip() != "1":
        subprocess.run(["su", "postgres", "-c", f"createdb -O {user} {database}"], check=True)


if __name__ == "__main__":
    main()
