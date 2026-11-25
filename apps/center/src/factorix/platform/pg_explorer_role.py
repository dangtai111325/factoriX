"""Read-only PostgreSQL role of the PostgreSQL explorer (B-14 / OP-19): the single definition of what it may read.

``factorix_explorer_ro`` is a ``NOLOGIN`` role with ``USAGE`` on the application schemas and ``SELECT`` on every
table / view of those schemas except ``SENSITIVE_TABLES`` (and views that read one of them). The application login
is granted membership so the explorer can ``SET LOCAL ROLE factorix_explorer_ro`` inside its ``READ ONLY``
transaction: PostgreSQL itself then refuses a sensitive table (``42501``) even if the explorer's own 403 check were
bypassed, and refuses every write twice (read-only transaction + no INSERT/UPDATE/DELETE/DDL privilege).

* Provisioned by migration ``0015_explorer_ro_role`` (``provision_explorer_role``), idempotent: running it again
  resets the grants to the current table list.
* No ``ALTER DEFAULT PRIVILEGES``: a table created later is **not** readable through the explorer until a
  migration calls ``provision_explorer_role`` again (it may hold secrets; it is opted in, never in by accident).
  Such a table answers 403 ``EXPLORER_NOT_GRANTED`` in the explorer.
* Environments where the migrating user can neither create the role (no ``SUPERUSER`` / ``CREATEROLE``) nor
  use an existing one (e.g. the single-container appliance, whose login has neither) do not fail the deploy:
  a warning is logged, nothing is changed, and the explorer keeps its ``READ ONLY`` transaction and reports
  ``privilege_isolation: false`` in ``GET /api/v1/storage/pg/status``.

Only the standard library and SQLAlchemy are imported, so the migration can use this module.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError

logger = logging.getLogger(__name__)

EXPLORER_ROLE = "factorix_explorer_ro"

# Credential, session and audit tables: hidden from the explorer list, 403 for details / preview / count, and never
# granted to the explorer role. The single list used by the explorer (``factorix.modules.postgres_explorer``) and
# by the role provisioning below.
SENSITIVE_TABLES = frozenset({
    "alembic_version",
    "admin_accounts",
    "secret_store",
    "sessions",
    "password_reset_codes",
    "edge_enrollment_tokens",
    "login_throttle",
    "audit_events",
})

_IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
assert all(_IDENT.fullmatch(t) for t in SENSITIVE_TABLES) and _IDENT.fullmatch(EXPLORER_ROLE)

_APP_SCHEMAS_WHERE = (
    "n.nspname NOT IN ('pg_catalog', 'information_schema') "
    "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'"
)
_SENSITIVE_SQL = ", ".join(f"'{t}'" for t in sorted(SENSITIVE_TABLES))

# Can the session login switch to the role? PostgreSQL 16+ separates membership from the SET option (a role
# created by a CREATEROLE user is auto-granted to it WITH SET FALSE), so ask for SET there.
ROLE_USABLE_SQL = (
    "SELECT CASE"
    " WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role) THEN false"
    " WHEN current_setting('server_version_num')::int >= 160000 THEN pg_has_role(session_user, :role, 'SET')"
    " ELSE pg_has_role(session_user, :role, 'MEMBER') END AS usable"
)

APP_SCHEMAS_SQL = (
    f"SELECT n.nspname AS schema FROM pg_namespace n WHERE {_APP_SCHEMAS_WHERE} "
    "AND pg_has_role(n.nspowner, 'USAGE') ORDER BY 1"
)

# Tables, partitioned tables, views, materialized views and foreign tables of the application schemas that the
# migrating user owns, minus the sensitive tables and minus views whose rules read a sensitive table (a view runs
# with its owner's privileges, so granting it would expose the table behind it).
READABLE_RELATIONS_SQL = f"""
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND {_APP_SCHEMAS_WHERE}
  AND pg_has_role(c.relowner, 'USAGE')
  AND lower(c.relname) NOT IN ({_SENSITIVE_SQL})
  AND NOT EXISTS (
      SELECT 1
      FROM pg_rewrite rw
      JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
                      AND d.refclassid = 'pg_class'::regclass
      JOIN pg_class t ON t.oid = d.refobjid
      WHERE rw.ev_class = c.oid AND lower(t.relname) IN ({_SENSITIVE_SQL})
  )
ORDER BY 1, 2
"""


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


@dataclass
class ProvisionResult:
    available: bool
    reason: str = ""
    created: bool = False
    schemas: list[str] = field(default_factory=list)
    granted: list[str] = field(default_factory=list)


def _role_exists(conn: Connection, role: str) -> bool:
    return bool(conn.execute(text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"), {"role": role}).scalar())


def role_usable(conn: Connection, role: str = EXPLORER_ROLE) -> bool:
    return bool(conn.execute(text(ROLE_USABLE_SQL), {"role": role}).scalar())


def _db_error(exc: DBAPIError) -> str:
    message = str(getattr(exc, "orig", None) or exc).strip()
    return message.splitlines()[0] if message else type(exc).__name__


def provision_explorer_role(conn: Connection, role: str = EXPLORER_ROLE) -> ProvisionResult:
    """Create (if needed) and grant the explorer role; never raises for missing privileges (warning + fallback)."""
    if not _IDENT.fullmatch(role):
        raise ValueError(f"invalid role name {role!r}")
    me = conn.execute(
        text("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user")
    ).mappings().first() or {}
    can_create = bool(me.get("rolsuper") or me.get("rolcreaterole"))
    exists = _role_exists(conn, role)
    result = ProvisionResult(available=False)
    if not exists and not can_create:
        result.reason = (
            f"role {role} does not exist and the database user can not create it (needs SUPERUSER or CREATEROLE)"
        )
        logger.warning("PostgreSQL explorer: %s; the explorer keeps READ ONLY transactions without privilege isolation.", result.reason)
        return result
    q_role = quote_ident(role)
    try:
        with conn.begin_nested():
            if not exists:
                conn.execute(text(f"CREATE ROLE {q_role} NOLOGIN"))
                result.created = True
            result.schemas = [str(r[0]) for r in conn.execute(text(APP_SCHEMAS_SQL))]
            for schema in result.schemas:
                # Reset to "nothing granted", then grant the current list: a table that became sensitive loses it.
                conn.execute(text(f"REVOKE ALL ON ALL TABLES IN SCHEMA {quote_ident(schema)} FROM {q_role}"))
                conn.execute(text(f"GRANT USAGE ON SCHEMA {quote_ident(schema)} TO {q_role}"))
            for schema, name in conn.execute(text(READABLE_RELATIONS_SQL)):
                conn.execute(text(f"GRANT SELECT ON {quote_ident(schema)}.{quote_ident(name)} TO {q_role}"))
                result.granted.append(f"{schema}.{name}")
    except DBAPIError as exc:
        result = ProvisionResult(available=False, reason=f"granting {role} failed: {_db_error(exc)}")
        logger.warning("PostgreSQL explorer: %s; the explorer keeps READ ONLY transactions without privilege isolation.", result.reason)
        return result
    if not role_usable(conn, role):
        try:
            with conn.begin_nested():
                conn.execute(text(f"GRANT {q_role} TO CURRENT_USER"))
        except DBAPIError as exc:
            result.reason = f"the database user can not be granted {role}: {_db_error(exc)}"
    result.available = role_usable(conn, role)
    if not result.available:
        result.reason = result.reason or f"the database user can not SET ROLE {role}"
        logger.warning("PostgreSQL explorer: %s; the explorer keeps READ ONLY transactions without privilege isolation.", result.reason)
    return result


def drop_explorer_role(conn: Connection, role: str = EXPLORER_ROLE) -> bool:
    """Revoke everything granted here and drop the role; True when the role is gone.

    The role is cluster-wide: if another database of the same cluster still grants it something, ``DROP ROLE``
    fails; the grants of this database are still revoked and a warning says why the role was kept.
    """
    if not _IDENT.fullmatch(role):
        raise ValueError(f"invalid role name {role!r}")
    if not _role_exists(conn, role):
        return True
    q_role = quote_ident(role)
    try:
        with conn.begin_nested():
            for (schema,) in conn.execute(text(APP_SCHEMAS_SQL)).all():
                conn.execute(text(f"REVOKE ALL ON ALL TABLES IN SCHEMA {quote_ident(schema)} FROM {q_role}"))
                conn.execute(text(f"REVOKE ALL ON SCHEMA {quote_ident(schema)} FROM {q_role}"))
            conn.execute(text(f"REVOKE {q_role} FROM CURRENT_USER"))
    except DBAPIError as exc:
        logger.warning("PostgreSQL explorer: revoking %s failed: %s", role, _db_error(exc))
        return False
    try:
        with conn.begin_nested():
            conn.execute(text(f"DROP ROLE {q_role}"))
    except DBAPIError as exc:
        logger.warning("PostgreSQL explorer: role %s kept (%s); its grants in this database were revoked.", role, _db_error(exc))
        return False
    return True
