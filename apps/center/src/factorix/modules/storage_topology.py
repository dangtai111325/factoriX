"""TDengine physical topology inspector.

Reads ACTUAL metadata from TDengine ``information_schema`` / ``SHOW`` commands
to return the real physical state: databases, supertables, subtables, columns,
tags, row counts, and drift status vs the desired registry in PostgreSQL.

All queries are read-only.  No DDL is executed here.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Identifier validation — mirrors platform/tdengine.py rules
# ---------------------------------------------------------------------------
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_TENANT_DB_RE = re.compile(r"^fx_t_[0-9a-f]{32}$")
_SYSTEM_DBS = frozenset({"information_schema", "performance_schema", "log"})


def _safe_ident(name: str) -> str:
    """Validate and return a backtick-quoted TDengine identifier."""
    if not isinstance(name, str) or not _IDENT_RE.fullmatch(name):
        raise ValueError(f"Unsafe TDengine identifier: {name!r}")
    return f"`{name}`"


# ---------------------------------------------------------------------------
# Domain objects
# ---------------------------------------------------------------------------

@dataclass
class ColumnInfo:
    name: str
    td_type: str
    length: int | None
    role: str  # "time_key" | "value" | "tag"
    nullable: bool


@dataclass
class SubtableInfo:
    name: str
    stable_name: str
    database: str
    tags: dict[str, Any]
    row_count: int | None = None
    created_time: datetime | None = None


@dataclass
class StableInfo:
    name: str
    database: str
    columns: list[ColumnInfo] = field(default_factory=list)
    tags: list[ColumnInfo] = field(default_factory=list)
    subtable_count: int = 0
    row_count: int | None = None
    created_time: datetime | None = None


@dataclass
class DatabaseInfo:
    name: str
    precision: str
    replica: int
    quorum: int | None
    keep: str
    vgroups: int
    ntables: int
    cache_model: str | None
    is_tenant: bool
    stable_count: int = 0


@dataclass
class TopologyNode:
    """Single node in the flattened topology graph for the UI canvas."""
    node_id: str
    kind: str  # "database" | "stable" | "subtable"
    label: str
    parent_id: str | None
    metadata: dict[str, Any]


@dataclass
class DriftStatus:
    object_kind: str
    physical_name: str
    drift_type: str  # "MISSING_PHYSICAL" | "UNEXPECTED_PHYSICAL" | "SCHEMA_MISMATCH" | "OK"
    details: str
    last_verified_at: datetime


@dataclass
class TopologySnapshot:
    databases: list[DatabaseInfo]
    stables: list[StableInfo]
    subtables: list[SubtableInfo]
    nodes: list[TopologyNode]
    drift: list[DriftStatus]
    observed_at: datetime


# ---------------------------------------------------------------------------
# Main topology inspector
# ---------------------------------------------------------------------------

class StorageTopologyInspector:
    """Inspects live TDengine metadata and reconciles against desired registry."""

    def __init__(self, td_client: Any, pg_pool: Any | None = None) -> None:
        """
        Args:
            td_client: TDEngineClient instance (platform.tdengine.TDEngineClient).
            pg_pool:   asyncpg pool for the desired-state registry (optional).
        """
        self._td = td_client
        self._pg = pg_pool

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_engines_info(self, pg_session: Any | None = None) -> dict[str, Any]:
        """Return TDengine version/health/dialect capabilities and dynamic PostgreSQL status.

        Never reveals connection credentials.
        """
        try:
            rows = await self._td_query("SELECT server_version() AS ver, NOW() AS now_ts")
            version = _safe_str(rows[0], ("ver", "server_version()"), 0, "unknown") if rows else "unknown"
            rows_dbs = await self._td_query("SHOW DATABASES")
            db_count = sum(
                1 for r in rows_dbs
                if _safe_str(r, ("name", "database_name"), 0) not in _SYSTEM_DBS
            )
            td_ok = True
        except Exception as exc:
            logger.warning("TDengine health check failed: %s", exc)
            version = "unavailable"
            db_count = None
            td_ok = False

        pg_version = None
        pg_ok = False
        pg_source = pg_session or self._pg
        if pg_source is not None:
            try:
                if hasattr(pg_source, "fetchval"):
                    ver = await pg_source.fetchval("SELECT current_setting('server_version')")
                    pg_version = str(ver) if ver else None
                    pg_ok = True
                elif hasattr(pg_source, "acquire"):
                    async with pg_source.acquire() as conn:
                        ver = await conn.fetchval("SELECT current_setting('server_version')")
                        pg_version = str(ver) if ver else None
                        pg_ok = True
                elif hasattr(pg_source, "execute"):
                    from sqlalchemy import text
                    res = await pg_source.execute(text("SELECT current_setting('server_version')"))
                    row = res.first()
                    pg_version = str(row[0]) if row else None
                    pg_ok = True
            except Exception as exc:
                logger.warning("PostgreSQL version check failed: %s", exc)
                pg_version = "unavailable"
                pg_ok = False

        return {
            "tdengine": {
                "healthy": td_ok,
                "version": version,
                "tenant_database_count": db_count,
                "features": {
                    "supertables": True,
                    "subtables": True,
                    "virtual_tables": False,  # 3.4.3.9: not GA
                    "composite_key": False,
                    "db_keep_per_stable": False,
                    "tag_indexes": True,
                },
            },
            "postgresql": {
                "enabled": pg_ok or (self._pg is not None),
                "healthy": pg_ok,
                "version": pg_version or "PostgreSQL 17",
            },
            "postgres_explorer": {
                "enabled": pg_ok or (self._pg is not None),
            },
        }

    async def list_databases(self, tenant_id: UUID | None = None) -> list[DatabaseInfo]:
        """Return actual TDengine databases (excluding system DBs).

        If *tenant_id* is given only the matching ``fx_t_<hex>`` database is
        returned.
        """
        try:
            rows = await self._td_query(
                "SELECT name, ntables, vgroups, replica, quorum, precision, "
                "keep, cache_model FROM information_schema.ins_databases"
            )
        except Exception:
            # Fallback: SHOW DATABASES (older schema)
            rows = await self._td_query("SHOW DATABASES")

        dbs: list[DatabaseInfo] = []
        for r in rows:
            name = _safe_str(r, ("name", "database_name"), 0)
            if not name or name in _SYSTEM_DBS:
                continue
            is_tenant = bool(_TENANT_DB_RE.fullmatch(name))
            if tenant_id is not None:
                expected = f"fx_t_{UUID(str(tenant_id)).hex}"
                if name != expected:
                    continue
            dbs.append(DatabaseInfo(
                name=name,
                precision=_safe_str(r, "precision", 5, "ms"),
                replica=_safe_int(r, "replica", 3, 1) or 1,
                quorum=_safe_int(r, "quorum", 4, None),
                keep=_safe_str(r, "keep", 6, "3650d"),
                vgroups=_safe_int(r, "vgroups", 2, 0) or 0,
                ntables=_safe_int(r, "ntables", 1, 0) or 0,
                cache_model=_safe_str(r, "cache_model", 7, None),
                is_tenant=is_tenant,
            ))
        return dbs

    async def get_database(self, name: str) -> DatabaseInfo | None:
        """Return info for a single database by name."""
        dbs = await self.list_databases()
        return next((d for d in dbs if d.name == name), None)

    async def list_stables(self, database: str) -> list[StableInfo]:
        """Return supertables in *database* with column/tag metadata."""
        _safe_ident(database)
        try:
            rows = await self._td_query(
                f"SELECT stable_name, columns, tags, ntables "
                f"FROM information_schema.ins_stables "
                f"WHERE db_name = '{database}'"
            )
        except Exception:
            rows = await self._td_query(f"SHOW {_safe_ident(database)}.STABLES")

        stables: list[StableInfo] = []
        for r in rows:
            sname = _safe_str(r, ("stable_name", "name"), 0)
            if not sname:
                continue
            # Fetch column/tag detail via DESCRIBE
            cols, tags = await self._describe_stable(database, sname)
            stables.append(StableInfo(
                name=sname,
                database=database,
                columns=cols,
                tags=tags,
                subtable_count=_safe_int(r, "ntables", 3, 0) or 0,
            ))
        return stables

    async def get_stable(self, database: str, stable_name: str) -> StableInfo | None:
        """Return detailed info for one supertable."""
        _safe_ident(database)
        _safe_ident(stable_name)
        cols, tags = await self._describe_stable(database, stable_name)
        try:
            rows = await self._td_query(
                f"SELECT ntables FROM information_schema.ins_stables "
                f"WHERE db_name = '{database}' AND stable_name = '{stable_name}'"
            )
            count = _safe_int(rows[0], "ntables", 0, 0) if rows else 0
        except Exception:
            count = 0
        return StableInfo(
            name=stable_name,
            database=database,
            columns=cols,
            tags=tags,
            subtable_count=count or 0,
        )

    async def list_subtables(
        self,
        database: str,
        stable_name: str | None = None,
        cursor: str | None = None,
        limit: int = 200,
    ) -> tuple[list[SubtableInfo], str | None]:
        """Return subtables with tag values, optionally filtered by stable.

        Returns (items, next_cursor).
        """
        _safe_ident(database)
        base = (
            "SELECT table_name, stable_name, create_time "
            f"FROM information_schema.ins_tables "
            f"WHERE db_name = '{database}' AND type = 'CHILD_TABLE'"
        )
        if stable_name:
            _safe_ident(stable_name)
            base += f" AND stable_name = '{stable_name}'"
        if cursor:
            # cursor is last table_name seen; use it for keyset pagination
            base += f" AND table_name > '{cursor}'"
        base += f" ORDER BY table_name LIMIT {int(limit) + 1}"

        try:
            rows = await self._td_query(base)
        except Exception as exc:
            logger.warning("list_subtables failed: %s", exc)
            return [], None

        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cur = _safe_str(rows[-1], ("table_name", "name"), 0) if has_more and rows else None

        items: list[SubtableInfo] = []
        for r in rows:
            tname = _safe_str(r, ("table_name", "name"), 0)
            sname = _safe_str(r, "stable_name", 1, "")
            tags = await self._get_subtable_tags(database, tname)
            items.append(SubtableInfo(
                name=tname,
                stable_name=sname,
                database=database,
                tags=tags,
            ))
        return items, next_cur

    async def get_subtable(self, database: str, table_name: str) -> SubtableInfo | None:
        """Return info for a single subtable including tag values."""
        _safe_ident(database)
        _safe_ident(table_name)
        tags = await self._get_subtable_tags(database, table_name)
        try:
            rows = await self._td_query(
                f"SELECT table_name, stable_name FROM information_schema.ins_tables "
                f"WHERE db_name = '{database}' AND table_name = '{table_name}'"
            )
            if not rows:
                return None
            sname = _safe_str(rows[0], "stable_name", 1, "")
        except Exception:
            return None
        return SubtableInfo(
            name=table_name,
            stable_name=sname,
            database=database,
            tags=tags,
        )

    async def get_topology(
        self,
        tenant_id: UUID,
        database: str | None = None,
        depth: int = 2,
        cursor: str | None = None,
    ) -> TopologySnapshot:
        """Return full or filtered topology snapshot for the UI canvas."""
        observed_at = datetime.now(timezone.utc)
        dbs = await self.list_databases(tenant_id if not database else None)
        if database:
            dbs = [d for d in dbs if d.name == database]

        all_stables: list[StableInfo] = []
        all_subtables: list[SubtableInfo] = []
        nodes: list[TopologyNode] = []

        for db in dbs:
            nodes.append(TopologyNode(
                node_id=f"db:{db.name}",
                kind="database",
                label=db.name,
                parent_id=None,
                metadata={
                    "precision": db.precision,
                    "keep": db.keep,
                    "vgroups": db.vgroups,
                    "ntables": db.ntables,
                    "replica": db.replica,
                    "is_tenant": db.is_tenant,
                },
            ))
            if depth >= 1:
                stables = await self.list_stables(db.name)
                all_stables.extend(stables)
                for st in stables:
                    nodes.append(TopologyNode(
                        node_id=f"stable:{db.name}.{st.name}",
                        kind="stable",
                        label=st.name,
                        parent_id=f"db:{db.name}",
                        metadata={
                            "column_count": len(st.columns),
                            "tag_count": len(st.tags),
                            "subtable_count": st.subtable_count,
                        },
                    ))
                    if depth >= 2:
                        subs, _nc = await self.list_subtables(
                            db.name, st.name, cursor=cursor, limit=50
                        )
                        all_subtables.extend(subs)
                        for sub in subs:
                            nodes.append(TopologyNode(
                                node_id=f"subtable:{db.name}.{sub.name}",
                                kind="subtable",
                                label=sub.name,
                                parent_id=f"stable:{db.name}.{st.name}",
                                metadata={"tags": sub.tags},
                            ))

        drift = await self._compute_drift(tenant_id, all_stables, all_subtables)

        return TopologySnapshot(
            databases=dbs,
            stables=all_stables,
            subtables=all_subtables,
            nodes=nodes,
            drift=drift,
            observed_at=observed_at,
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _td_query(self, sql: str) -> list[Any]:
        """Execute a read SQL against TDengine and return rows."""
        if self._td is None:
            raise RuntimeError("STORAGE_ENGINE_UNAVAILABLE: TDengine client is not configured")
        if hasattr(self._td, "query_rows"):
            return await self._td.query_rows(sql)
        if hasattr(self._td, "run_read"):
            return await self._td.run_read(sql)
        raise RuntimeError("STORAGE_ENGINE_UNAVAILABLE: TDengine client has no query method")

    async def _describe_stable(
        self, database: str, stable_name: str
    ) -> tuple[list[ColumnInfo], list[ColumnInfo]]:
        """Run DESCRIBE on a stable and split into columns and tags."""
        if self._td is None:
            return [], []
        try:
            if hasattr(self._td, "query_rows"):
                rows = await self._td.query_rows(
                    f"DESCRIBE {_safe_ident(database)}.{_safe_ident(stable_name)}"
                )
            else:
                rows = await self._td.run_read(
                    f"DESCRIBE {_safe_ident(database)}.{_safe_ident(stable_name)}"
                )
        except Exception as exc:
            logger.debug("DESCRIBE %s.%s failed: %s", database, stable_name, exc)
            return [], []

        cols: list[ColumnInfo] = []
        tags: list[ColumnInfo] = []
        for r in (rows or []):
            cname = _safe_str(r, ("Field", "field", "name"), 0)
            ctype = _safe_str(r, ("Type", "type"), 1)
            clength = _safe_int(r, ("Length", "length"), 2, None)
            note = _safe_str(r, ("Note", "note"), 3, "").upper()
            is_tag = "TAG" in note
            is_ts = ctype.upper() == "TIMESTAMP" and not is_tag
            role = "time_key" if is_ts else ("tag" if is_tag else "value")
            ci = ColumnInfo(
                name=cname,
                td_type=ctype,
                length=clength,
                role=role,
                nullable=not is_ts,
            )
            if is_tag:
                tags.append(ci)
            else:
                cols.append(ci)
        return cols, tags

    async def _get_subtable_tags(
        self, database: str, table_name: str
    ) -> dict[str, Any]:
        """Return tag values for a subtable as {tag_name: value}."""
        if self._td is None:
            return {}
        try:
            if hasattr(self._td, "query_rows"):
                rows = await self._td.query_rows(
                    f"SELECT * FROM {_safe_ident(database)}.{_safe_ident(table_name)} TAGS"
                )
            else:
                rows = await self._td.run_read(
                    f"SELECT * FROM {_safe_ident(database)}.{_safe_ident(table_name)} TAGS"
                )
            if not rows:
                return {}
            if isinstance(rows[0], dict):
                return {k: v for k, v in rows[0].items()}
            return {}
        except Exception:
            return {}

    async def _compute_drift(
        self,
        tenant_id: UUID,
        actual_stables: list[StableInfo],
        actual_subtables: list[SubtableInfo],
    ) -> list[DriftStatus]:
        """Compare actual TDengine state against desired PostgreSQL registry.

        Returns drift entries.  Returns empty list if pg pool is unavailable.
        """
        now = datetime.now(timezone.utc)
        drift: list[DriftStatus] = []
        if self._pg is None:
            return drift

        desired: list[dict[str, Any]] = []
        try:
            if hasattr(self._pg, "acquire"):
                async with self._pg.acquire() as conn:
                    try:
                        rows = await conn.fetch(
                            """
                            SELECT physical_db, physical_name, object_type, status AS state
                            FROM storage_objects
                            WHERE tenant_id = $1
                              AND status NOT IN ('RETIRED', 'PURGED')
                            """,
                            tenant_id,
                        )
                        desired = [dict(r) for r in rows]
                    except Exception:
                        rows = await conn.fetch(
                            """
                            SELECT td_database AS physical_db, td_stable AS physical_name, 'STABLE' AS object_type, status AS state
                            FROM storage_physical_registry
                            WHERE tenant_id = $1
                              AND status NOT IN ('RETIRED')
                            UNION
                            SELECT td_database AS physical_db, td_subtable AS physical_name, 'SUBTABLE' AS object_type, status AS state
                            FROM storage_physical_registry
                            WHERE tenant_id = $1
                              AND status NOT IN ('RETIRED')
                            """,
                            tenant_id,
                        )
                        desired = [dict(r) for r in rows]
            elif hasattr(self._pg, "execute"):
                from sqlalchemy import text
                try:
                    res = await self._pg.execute(
                        text(
                            """
                            SELECT physical_db, physical_name, object_type, status AS state
                            FROM storage_objects
                            WHERE tenant_id = :tenant_id
                              AND status NOT IN ('RETIRED', 'PURGED')
                            """
                        ),
                        {"tenant_id": tenant_id},
                    )
                    desired = [dict(r) for r in res.mappings().all()]
                except Exception:
                    res = await self._pg.execute(
                        text(
                            """
                            SELECT td_database AS physical_db, td_stable AS physical_name, 'STABLE' AS object_type, status AS state
                            FROM storage_physical_registry
                            WHERE tenant_id = :tenant_id
                              AND status NOT IN ('RETIRED')
                            UNION
                            SELECT td_database AS physical_db, td_subtable AS physical_name, 'SUBTABLE' AS object_type, status AS state
                            FROM storage_physical_registry
                            WHERE tenant_id = :tenant_id
                              AND status NOT IN ('RETIRED')
                            """
                        ),
                        {"tenant_id": tenant_id},
                    )
                    desired = [dict(r) for r in res.mappings().all()]
        except Exception as exc:
            logger.debug("Drift check failed: %s", exc)
            return [
                DriftStatus(
                    object_kind="SYSTEM",
                    physical_name="registry",
                    drift_type="UNKNOWN",
                    details=f"Cannot inspect desired state registry: {exc}",
                    last_verified_at=now,
                )
            ]

        actual_stable_keys = {(s.database, s.name) for s in actual_stables}
        actual_subtable_keys = {(s.database, s.name) for s in actual_subtables}

        for row in desired:
            pdb = str(row["physical_db"])
            pname = str(row["physical_name"])
            otype = str(row["object_type"]).upper()
            if otype in ("STABLE", "SUPERTABLE") and (pdb, pname) not in actual_stable_keys:
                drift.append(DriftStatus(
                    object_kind=otype,
                    physical_name=f"{pdb}.{pname}",
                    drift_type="MISSING_PHYSICAL",
                    details="Desired STable not found in TDengine INFORMATION_SCHEMA",
                    last_verified_at=now,
                ))
            elif otype in ("SUBTABLE", "TABLE") and (pdb, pname) not in actual_subtable_keys:
                drift.append(DriftStatus(
                    object_kind=otype,
                    physical_name=f"{pdb}.{pname}",
                    drift_type="MISSING_PHYSICAL",
                    details="Desired Subtable not found in TDengine INFORMATION_SCHEMA",
                    last_verified_at=now,
                ))
        return drift


# ---------------------------------------------------------------------------
# Helper serialization
# ---------------------------------------------------------------------------

def topology_snapshot_to_dict(snap: TopologySnapshot) -> dict[str, Any]:
    edges = []
    for n in snap.nodes:
        if n.parent_id:
            edge_kind = "CONTAINS" if n.kind == "stable" else "INHERITS_SCHEMA"
            edges.append({
                "edge_id": f"{n.parent_id}->{n.node_id}",
                "source_node_id": n.parent_id,
                "target_node_id": n.node_id,
                "edge_kind": edge_kind,
                "metadata": {},
            })

    return {
        "observed_at": snap.observed_at.isoformat(),
        "databases": [_db_to_dict(d) for d in snap.databases],
        "stables": [_stable_to_dict(s) for s in snap.stables],
        "subtables": [_subtable_to_dict(s) for s in snap.subtables],
        "nodes": [
            {
                "node_id": n.node_id,
                "kind": n.kind,
                "object_type": n.kind,
                "label": n.label,
                "physical_name": n.label,
                "display_name": n.label,
                "parent_id": n.parent_id,
                "status": "ACTIVE",
                "metadata": n.metadata,
            }
            for n in snap.nodes
        ],
        "edges": edges,
        "drift": [
            {
                "object_kind": d.object_kind,
                "physical_name": d.physical_name,
                "drift_type": d.drift_type,
                "details": d.details,
                "last_verified_at": d.last_verified_at.isoformat(),
            }
            for d in snap.drift
        ],
    }


def _db_to_dict(d: DatabaseInfo) -> dict[str, Any]:
    return {
        "name": d.name,
        "precision": d.precision,
        "replica": d.replica,
        "keep": d.keep,
        "vgroups": d.vgroups,
        "ntables": d.ntables,
        "cache_model": d.cache_model,
        "is_tenant": d.is_tenant,
        "stable_count": d.stable_count,
    }


def _stable_to_dict(s: StableInfo) -> dict[str, Any]:
    return {
        "name": s.name,
        "database": s.database,
        "subtable_count": s.subtable_count,
        "columns": [_col_to_dict(c) for c in s.columns],
        "tags": [_col_to_dict(t) for t in s.tags],
    }


def _subtable_to_dict(s: SubtableInfo) -> dict[str, Any]:
    return {
        "name": s.name,
        "stable_name": s.stable_name,
        "database": s.database,
        "tags": s.tags,
        "row_count": s.row_count,
    }


def _col_to_dict(c: ColumnInfo) -> dict[str, Any]:
    return {
        "name": c.name,
        "td_type": c.td_type,
        "length": c.length,
        "role": c.role,
        "nullable": c.nullable,
    }


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def parse_canonical_object_id(object_id: str) -> tuple[str, str, str | None]:
    """Parse canonical object ID into (kind, physical_db, physical_name).

    Formats supported:
    - db:<name> -> ('database', <name>, None)
    - stable:<db>.<name> -> ('stable', <db>, <name>)
    - subtable:<db>.<name> -> ('subtable', <db>, <name>)
    - <db>.<name> -> ('table', <db>, <name>)
    - <name> -> ('database', <name>, None)
    """
    if object_id.startswith("db:"):
        return ("database", object_id[3:], None)
    if object_id.startswith("stable:"):
        rest = object_id[7:]
        parts = rest.split(".", 1)
        return ("stable", parts[0], parts[1] if len(parts) > 1 else None)
    if object_id.startswith("subtable:"):
        rest = object_id[9:]
        parts = rest.split(".", 1)
        return ("subtable", parts[0], parts[1] if len(parts) > 1 else None)
    if "." in object_id:
        parts = object_id.split(".", 1)
        return ("table", parts[0], parts[1])
    return ("database", object_id, None)


def format_canonical_object_id(kind: str, db: str, name: str | None = None) -> str:
    k = kind.lower()
    if k in ("db", "database") or not name:
        return f"db:{db}"
    if k in ("stable", "supertable"):
        return f"stable:{db}.{name}"
    return f"subtable:{db}.{name}"


def _row_val(
    row: Any,
    key_or_idx: str | int | tuple[str, ...],
    idx_or_default: Any = None,
    default: Any = None,
) -> Any:
    if row is None:
        return default if default is not None else idx_or_default

    candidate_keys: tuple[str, ...] = ()
    fallback_idx: int | None = None
    def_val: Any = None

    if isinstance(key_or_idx, int):
        fallback_idx = key_or_idx
        def_val = idx_or_default
    elif isinstance(key_or_idx, str):
        candidate_keys = (key_or_idx,)
        if isinstance(idx_or_default, int):
            fallback_idx = idx_or_default
            def_val = default
        else:
            def_val = idx_or_default
    elif isinstance(key_or_idx, (tuple, list)):
        candidate_keys = tuple(key_or_idx)
        if isinstance(idx_or_default, int):
            fallback_idx = idx_or_default
            def_val = default
        else:
            def_val = idx_or_default

    if isinstance(row, dict):
        for k in candidate_keys:
            if k in row:
                return row[k]
            lk = k.lower()
            for rk, rv in row.items():
                if rk.lower() == lk:
                    return rv
        if fallback_idx is not None:
            vals = list(row.values())
            if 0 <= fallback_idx < len(vals):
                return vals[fallback_idx]
        return def_val

    if isinstance(row, (tuple, list)):
        if fallback_idx is not None and 0 <= fallback_idx < len(row):
            return row[fallback_idx]
        return def_val

    return def_val


def _safe_str(
    row: Any,
    key_or_idx: str | int | tuple[str, ...],
    idx_or_default: Any = "",
    default: Any = None,
) -> str:
    v = _row_val(row, key_or_idx, idx_or_default, default)
    def_val = default if default is not None else idx_or_default
    return str(v) if v is not None else (str(def_val) if def_val is not None else "")


def _safe_int(
    row: Any,
    key_or_idx: str | int | tuple[str, ...],
    idx_or_default: Any = 0,
    default: Any = None,
) -> int | None:
    v = _row_val(row, key_or_idx, idx_or_default, default)
    def_val = default if default is not None else idx_or_default
    if v is None:
        return def_val
    try:
        return int(v)
    except (TypeError, ValueError):
        return def_val
