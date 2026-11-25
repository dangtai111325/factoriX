"""Read-only PostgreSQL role for the PostgreSQL explorer (B-14 / OP-19).

Creates the ``NOLOGIN`` role ``factorix_explorer_ro`` if it does not exist, grants it ``USAGE`` on the application
schemas and ``SELECT`` on every table / view except the explorer's sensitive tables
(``factorix.platform.pg_explorer_role.SENSITIVE_TABLES``, the list the explorer's 403 check uses too) and grants
the role to the migrating user (the application login) so the explorer can ``SET LOCAL ROLE`` to it.

* No default privileges: tables created by later migrations are not readable through the explorer until a
  migration calls ``provision_explorer_role`` again (a new table may hold secrets).
* A database user without ``SUPERUSER`` / ``CREATEROLE`` (single-container appliance) can not create the role:
  the migration logs a warning, changes nothing and succeeds; the explorer then keeps its ``READ ONLY``
  transaction and reports ``privilege_isolation: false``.
* Downgrade revokes every grant of this database and drops the role (kept, with a warning, when another database
  of the same cluster still grants it something).
"""

from __future__ import annotations

from alembic import op

from factorix.platform.pg_explorer_role import drop_explorer_role, provision_explorer_role

revision = "0015_explorer_ro_role"
down_revision = "0014_bulk_jobs_failed_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    provision_explorer_role(op.get_bind())


def downgrade() -> None:
    drop_explorer_role(op.get_bind())
