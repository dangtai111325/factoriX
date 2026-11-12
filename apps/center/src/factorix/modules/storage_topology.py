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

    async def get_engines_info(self) -> dict[str, Any]:
        """Return TDengine version/health/dialect capabilities.

        Never reveals connection credentials.
        """
        try:
            rows = await self._td_query("SELECT server_version()")
            version = rows[0][0] if rows else "unknown"
        except Exception as exc:
            logger.warning("Cannot read TDengine version: %s", exc)
            version = "unavailable"

        try:
            rows = await self._td_query("SHOW DATABASES")
            db_count = sum(
                1 for r in rows
                if str(r[0]) not in _SYSTEM_DBS
            )
            td_ok = True
        except Exception as exc:
            logger.warning("TDengine health check failed: %s", exc)
            db_count = None
            td_ok = False

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
            "postgres_explorer": {
                "enabled": self._pg is not None,
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
            name = str(r[0])
            if name in _SYSTEM_DBS:
                continue
            is_tenant = bool(_TENANT_DB_RE.fullmatch(name))
            if tenant_id is not None:
                expected = f"fx_t_{UUID(str(tenant_id)).hex}"
                if name != expected:
                    continue
            dbs.append(DatabaseInfo(
                name=name,
                precision=_safe_str(r, 5, "ms"),
                replica=_safe_int(r, 3, 1),
                quorum=_safe_int(r, 4, None),
                keep=_safe_str(r, 6, "3650d"),
                vgroups=_safe_int(r, 2, 0),
                ntables=_safe_int(r, 1, 0),
                cache_model=_safe_str(r, 7, None),
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
            sname = str(r[0])
            # Fetch column/tag detail via DESCRIBE
            cols, tags = await self._describe_stable(database, sname)
            stables.append(StableInfo(
                name=sname,
                database=database,
                columns=cols,
                tags=tags,
                subtable_count=_safe_int(r, 3, 0),
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
            count = _safe_int(rows[0], 0, 0) if rows else 0
        except Exception:
            count = 0
        return StableInfo(
            name=stable_name,
            database=database,
            columns=cols,
            tags=tags,
            subtable_count=count,
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
        next_cur = rows[-1][0] if has_more and rows else None

        items: list[SubtableInfo] = []
        for r in rows:
            tname = str(r[0])
            sname = str(r[1]) if r[1] else ""
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
            sname = str(rows[0][1]) if rows[0][1] else ""
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
            return []
        try:
            result = await self._td.run_read(sql)
            return result if result is not None else []
        except Exception as exc:
            logger.debug("TD query failed: %s (%s)", sql, exc)
            return []

    async def _describe_stable(
        self, database: str, stable_name: str
    ) -> tuple[list[ColumnInfo], list[ColumnInfo]]:
        """Run DESCRIBE on a stable and split into columns and tags."""
        if self._td is None:
            return [], []
        try:
            rows = await self._td.run_read(
                f"DESCRIBE {_safe_ident(database)}.{_safe_ident(stable_name)}"
            )
        except Exception as exc:
            logger.debug("DESCRIBE %s.%s failed: %s", database, stable_name, exc)
            return [], []

        cols: list[ColumnInfo] = []
        tags: list[ColumnInfo] = []
        for r in (rows or []):
            cname = str(r[0])
            ctype = str(r[1])
            clength = _safe_int(r, 2, None)
            note = str(r[3]).upper() if len(r) > 3 else ""
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
        if self._pg is None:
            return []
        now = datetime.now(timezone.utc)
        drift: list[DriftStatus] = []
        try:
            async with self._pg.acquire() as conn:
                desired = await conn.fetch(
                    """
                    SELECT physical_db, physical_name, object_type, state
                    FROM storage_objects
                    WHERE tenant_id = $1
                      AND state NOT IN ('RETIRED', 'PURGED')
                    """,
                    tenant_id,
                )
        except Exception as exc:
            logger.debug("Drift check: storage_objects not available: %s", exc)
            return []

        actual_stable_keys = {(s.database, s.name) for s in actual_stables}
        actual_subtable_keys = {(s.database, s.name) for s in actual_subtables}

        for row in desired:
            pdb = str(row["physical_db"])
            pname = str(row["physical_name"])
            otype = str(row["object_type"])
            if otype == "STABLE" and (pdb, pname) not in actual_stable_keys:
                drift.append(DriftStatus(
                    object_kind=otype,
                    physical_name=f"{pdb}.{pname}",
                    drift_type="MISSING_PHYSICAL",
                    details="Desired STable not found in TDengine INFORMATION_SCHEMA",
                    last_verified_at=now,
                ))
            elif otype == "SUBTABLE" and (pdb, pname) not in actual_subtable_keys:
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

def _safe_str(row: Any, idx: int, default: Any) -> Any:
    try:
        v = row[idx]
        return str(v) if v is not None else default
    except (IndexError, TypeError):
        return default


def _safe_int(row: Any, idx: int, default: Any) -> Any:
    try:
        v = row[idx]
        return int(v) if v is not None else default
    except (IndexError, TypeError, ValueError):
        return default
