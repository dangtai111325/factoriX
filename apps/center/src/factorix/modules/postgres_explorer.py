"""PostgreSQL Explorer: Strict Read-Only Metadata & Preview Provider.

Provides:
- Schema discovery (allowlisted, non-system).
- Tables and views catalog with column counts and row count estimates.
- Detailed column definitions, primary keys, and indexes.
- Real foreign key relationships (from pg_constraint) vs inferred relationships.
- Sanitized data preview with secret/password/token masking.

Zero write operations. All table/schema names validated against pg catalog.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules.common import fetch_all, fetch_one
from factorix.platform.errors import AppError

# Schemas to ignore
SYSTEM_SCHEMAS = frozenset({
    "pg_catalog",
    "information_schema",
    "pg_toast",
    "pg_temp_1",
    "pg_toast_temp_1",
})

# Tables to block from previewing entirely for security
SENSITIVE_TABLES = frozenset({
    "alembic_version",
    "admin_accounts",
    "secret_store",
    "sessions",
    "password_reset_codes",
})

# Columns whose values MUST be masked in data preview
SENSITIVE_COLUMN_PATTERNS = re.compile(
    r"(password|passwd|secret|token|hash|credential|auth_token|salt|private_key)",
    re.IGNORECASE,
)


def _mask_nested_secrets(obj: Any) -> Any:
    """Recursively mask sensitive keys in nested dictionaries and lists."""
    if isinstance(obj, dict):
        masked: dict[str, Any] = {}
        for k, v in obj.items():
            if SENSITIVE_COLUMN_PATTERNS.search(str(k)):
                masked[k] = "********" if v is not None else None
            else:
                masked[k] = _mask_nested_secrets(v)
        return masked
    elif isinstance(obj, list):
        return [_mask_nested_secrets(item) for item in obj]
    return obj

_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,62}$")


def _validate_ident(name: str, kind: str = "identifier") -> str:
    if not isinstance(name, str) or not _IDENT_RE.fullmatch(name):
        raise AppError(400, "INVALID_IDENTIFIER", f"Invalid {kind}: {name!r}")
    return name


class PostgresExplorerService:
    """Read-only introspection and data preview for PostgreSQL."""

    async def list_schemas(self, session: AsyncSession) -> list[dict[str, Any]]:
        """Return non-system schemas."""
        rows = await fetch_all(
            session,
            """
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND schema_name NOT LIKE 'pg_temp_%'
              AND schema_name NOT LIKE 'pg_toast_temp_%'
            ORDER BY schema_name
            """,
            {},
        )
        return [
            {
                "name": str(r["schema_name"]),
                "schema_name": str(r["schema_name"]),
                "table_count": 0,
                "view_count": 0,
            }
            for r in rows
        ]

    async def list_tables(
        self,
        session: AsyncSession,
        schema: str = "public",
    ) -> list[dict[str, Any]]:
        """Return tables and views in the schema with row estimates."""
        _validate_ident(schema, "schema name")
        rows = await fetch_all(
            session,
            """
            SELECT
                t.table_name,
                t.table_type,
                COALESCE(c.reltuples::bigint, 0) AS estimated_rows,
                (
                    SELECT count(*)
                    FROM information_schema.columns col
                    WHERE col.table_schema = t.table_schema
                      AND col.table_name = t.table_name
                ) AS column_count
            FROM information_schema.tables t
            LEFT JOIN pg_class c ON c.relname = t.table_name
            LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
            WHERE t.table_schema = :schema
            ORDER BY t.table_name
            """,
            {"schema": schema},
        )
        return [
            {
                "schema": schema,
                "schema_name": schema,
                "name": str(r["table_name"]),
                "table_name": str(r["table_name"]),
                "type": "VIEW" if "VIEW" in str(r["table_type"]).upper() else "BASE TABLE",
                "table_type": "VIEW" if "VIEW" in str(r["table_type"]).upper() else "TABLE",
                "estimated_rows": max(0, int(r["estimated_rows"] or 0)),
                "row_count_estimate": max(0, int(r["estimated_rows"] or 0)),
                "column_count": int(r["column_count"] or 0),
            }
            for r in rows
            if str(r["table_name"]) not in SENSITIVE_TABLES
        ]

    async def get_table_details(
        self,
        session: AsyncSession,
        table: str,
        schema: str = "public",
    ) -> dict[str, Any] | None:
        """Return columns, primary keys, and indexes for a table."""
        _validate_ident(schema, "schema name")
        _validate_ident(table, "table name")

        # 1. Columns
        col_rows = await fetch_all(
            session,
            """
            SELECT
                column_name,
                data_type,
                is_nullable,
                column_default,
                character_maximum_length,
                ordinal_position
            FROM information_schema.columns
            WHERE table_schema = :schema AND table_name = :table
            ORDER BY ordinal_position
            """,
            {"schema": schema, "table": table},
        )
        if not col_rows:
            return None

        # 2. Primary key columns
        pk_rows = await fetch_all(
            session,
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = :schema
              AND tc.table_name = :table
            """,
            {"schema": schema, "table": table},
        )
        pk_cols = {str(r["column_name"]) for r in pk_rows}

        columns = []
        for r in col_rows:
            cname = str(r["column_name"])
            columns.append({
                "name": cname,
                "column_name": cname,
                "data_type": str(r["data_type"]),
                "is_nullable": str(r["is_nullable"]).upper() == "YES",
                "default": str(r["column_default"]) if r.get("column_default") else None,
                "column_default": str(r["column_default"]) if r.get("column_default") else None,
                "max_length": r.get("character_maximum_length"),
                "is_primary_key": cname in pk_cols,
                "is_foreign_key": False,
                "is_sensitive": bool(SENSITIVE_COLUMN_PATTERNS.search(cname)),
            })

        # 3. Indexes
        idx_rows = await fetch_all(
            session,
            """
            SELECT
                i.relname AS index_name,
                ix.indisunique AS is_unique,
                ix.indisprimary AS is_primary,
                pg_get_indexdef(ix.indexrelid) AS index_definition
            FROM pg_class t
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_index ix ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            WHERE n.nspname = :schema AND t.relname = :table
            ORDER BY i.relname
            """,
            {"schema": schema, "table": table},
        )
        indexes = [
            {
                "name": str(r["index_name"]),
                "index_name": str(r["index_name"]),
                "is_unique": bool(r["is_unique"]),
                "is_primary": bool(r["is_primary"]),
                "definition": str(r["index_definition"]),
                "columns": [],
            }
            for r in idx_rows
        ]

        return {
            "schema": schema,
            "schema_name": schema,
            "name": table,
            "table_name": table,
            "columns": columns,
            "relationships": [],
            "indexes": indexes,
            "primary_key": sorted(pk_cols),
        }

    async def list_relationships(
        self,
        session: AsyncSession,
        schema: str = "public",
    ) -> list[dict[str, Any]]:
        """Return real FK constraints and inferred foreign keys."""
        _validate_ident(schema, "schema name")

        # 1. Real FK constraints from pg_constraint
        real_fk_rows = await fetch_all(
            session,
            """
            SELECT
                con.conname AS constraint_name,
                src_cls.relname AS from_table,
                src_att.attname AS from_column,
                tgt_cls.relname AS to_table,
                tgt_att.attname AS to_column
            FROM pg_constraint con
            JOIN pg_namespace nsp ON nsp.oid = con.connamespace
            JOIN pg_class src_cls ON src_cls.oid = con.conrelid
            JOIN pg_class tgt_cls ON tgt_cls.oid = con.confrelid
            JOIN pg_attribute src_att ON src_att.attrelid = con.conrelid
                                      AND src_att.attnum = ANY(con.conkey)
            JOIN pg_attribute tgt_att ON tgt_att.attrelid = con.confrelid
                                      AND tgt_att.attnum = ANY(con.confkey)
            WHERE con.contype = 'f' AND nsp.nspname = :schema
            ORDER BY src_cls.relname, con.conname
            """,
            {"schema": schema},
        )

        relationships = []
        real_pairs = set()
        for r in real_fk_rows:
            from_t = str(r["from_table"])
            from_c = str(r["from_column"])
            to_t = str(r["to_table"])
            to_c = str(r["to_column"])
            real_pairs.add((from_t, from_c, to_t))
            relationships.append({
                "constraint_name": str(r["constraint_name"]),
                "from_table": from_t,
                "from_column": from_c,
                "to_table": to_t,
                "to_column": to_c,
                "source_table": from_t,
                "source_column": from_c,
                "target_table": to_t,
                "target_column": to_c,
                "inferred": False,
                "is_inferred": False,
                "kind": "FOREIGN_KEY",
            })

        # 2. Inferred relationships (naming convention: e.g. <entity>_id -> <entity>s.id)
        cols_rows = await fetch_all(
            session,
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = :schema AND column_name LIKE '%_id'
            ORDER BY table_name, column_name
            """,
            {"schema": schema},
        )
        all_tables_rows = await fetch_all(
            session,
            "SELECT table_name FROM information_schema.tables WHERE table_schema = :schema",
            {"schema": schema},
        )
        existing_tables = {str(r["table_name"]) for r in all_tables_rows}

        for c in cols_rows:
            tname = str(c["table_name"])
            cname = str(c["column_name"])
            prefix = cname[:-3]  # strip '_id'
            # candidate target table: prefix or prefix + 's' (e.g. tenant -> tenants, resource -> resources)
            candidates = [prefix, f"{prefix}s", f"{prefix}es"]
            target = next((cand for cand in candidates if cand in existing_tables and cand != tname), None)
            if target and (tname, cname, target) not in real_pairs:
                relationships.append({
                    "constraint_name": f"inferred_{tname}_{cname}",
                    "from_table": tname,
                    "from_column": cname,
                    "to_table": target,
                    "to_column": "id",
                    "source_table": tname,
                    "source_column": cname,
                    "target_table": target,
                    "target_column": "id",
                    "inferred": True,
                    "is_inferred": True,
                    "kind": "INFERRED_FK",
                })

        return relationships

    async def preview_data(
        self,
        session: AsyncSession,
        table: str,
        schema: str = "public",
        limit: int = 50,
        offset: int = 0,
        tenant_id: UUID | str | None = None,
    ) -> dict[str, Any]:
        """Read paginated rows from table with sensitive values masked and tenant filtering."""
        _validate_ident(schema, "schema name")
        _validate_ident(table, "table name")

        if table.lower() in SENSITIVE_TABLES:
            raise AppError(403, "ACCESS_DENIED", f"Table '{table}' cannot be previewed.")

        # Get column list first
        col_rows = await fetch_all(
            session,
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = :schema AND table_name = :table
            ORDER BY ordinal_position
            """,
            {"schema": schema, "table": table},
        )
        if not col_rows:
            raise AppError(404, "NOT_FOUND", f"Table '{schema}.{table}' not found.")

        column_names = [str(r["column_name"]) for r in col_rows]
        safe_limit = min(max(1, int(limit)), 200)
        safe_offset = max(0, int(offset))

        # Enforce tenant isolation if the table contains a tenant_id column
        params: dict[str, Any] = {}
        where_clause = ""
        if "tenant_id" in column_names:
            if tenant_id:
                where_clause = ' WHERE "tenant_id" = CAST(:tenant_id AS uuid)'
                params["tenant_id"] = str(tenant_id)
            else:
                raise AppError(403, "TENANT_REQUIRED", f"Table '{table}' requires tenant context to preview.")

        # Build SELECT with quoted columns
        quoted_cols = ", ".join(f'"{c}"' for c in column_names)
        sql = f'SELECT {quoted_cols} FROM "{schema}"."{table}"{where_clause} LIMIT {safe_limit} OFFSET {safe_offset}'

        rows = await fetch_all(session, sql, params)

        # Mask sensitive columns and nested secrets in JSON
        masked_rows = []
        for r in rows:
            row_dict: dict[str, Any] = {}
            for col in column_names:
                val = r.get(col)
                if SENSITIVE_COLUMN_PATTERNS.search(col):
                    row_dict[col] = "********" if val is not None else None
                elif isinstance(val, (dict, list)):
                    row_dict[col] = _mask_nested_secrets(val)
                elif isinstance(val, (bytes, bytearray)):
                    row_dict[col] = f"<binary {len(val)} bytes>"
                elif hasattr(val, "isoformat"):
                    row_dict[col] = val.isoformat()
                elif isinstance(val, UUID):
                    row_dict[col] = str(val)
                else:
                    row_dict[col] = val
            masked_rows.append(row_dict)

        # Total rows count / estimate with tenant scope applied
        count_row = await fetch_one(
            session,
            f'SELECT count(*) AS total FROM "{schema}"."{table}"{where_clause}',
            params,
        )
        total = int(count_row["total"]) if count_row else len(masked_rows)

        return {
            "schema": schema,
            "table": table,
            "columns": column_names,
            "rows": masked_rows,
            "total": total,
            "limit": safe_limit,
            "offset": safe_offset,
        }
