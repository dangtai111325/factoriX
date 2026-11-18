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

from factorix_core.tdengine.sql import IDENT_RE
from factorix_core.tdengine.naming import TENANT_DB_RE

from factorix.modules.storage_dsl import tenant_td_database

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Identifier validation — mirrors platform/tdengine.py rules
# ---------------------------------------------------------------------------
_IDENT_RE = IDENT_RE  # B-18: the shared kernel pattern (same object)
_TENANT_DB_RE = TENANT_DB_RE  # R2-E B7: shared kernel (factorix_core.tdengine.naming), same pattern
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
    primary_key: bool = False


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
    subtable_count: int = 0


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

#: Subtables drawn per supertable in the topology canvas; ``subtable_count`` always carries the true
#: total so the UI shows "+N more" and links to the paginated Objects table (G-08 / P1-17).
TOPOLOGY_CHILD_LIMIT = 50


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

    async def list_databases(
        self, tenant_id: UUID | None = None, extra_names: Any = ()
    ) -> list[DatabaseInfo]:
        """Return actual TDengine databases (excluding system DBs).

        If *tenant_id* is given only the tenant's canonical ``fx_t_<hex>`` database and the databases
        in *extra_names* (user databases registered to that tenant in ``storage_objects``) are
        returned, so a database created through the wizard is visible to its owner only (G-08).
        """
        allowed_extra = {str(n) for n in (extra_names or ())}
        rows = await self._td_query("SELECT * FROM information_schema.ins_databases")

        dbs: list[DatabaseInfo] = []
        for r in rows:
            name = _safe_str(r, ("name", "database_name"), 0)
            if not name or name in _SYSTEM_DBS:
                continue
            is_tenant = bool(_TENANT_DB_RE.fullmatch(name))
            if tenant_id is not None:
                expected = tenant_td_database(tenant_id)
                if name != expected and name not in allowed_extra:
                    continue
            _safe_ident(name)
            stable_counts = await self._td_query(
                "SELECT COUNT(*) AS stable_count FROM information_schema.ins_stables "
                f"WHERE db_name = '{name}'"
            )
            subtables = await self._subtable_counts(name)
            dbs.append(DatabaseInfo(
                name=name,
                precision=_safe_str(r, "precision", 14, "ms"),
                replica=_safe_int(r, "replica", 4, 1) or 1,
                quorum=_safe_int(r, "quorum", None),
                keep=_safe_str(r, "keep", 7, "3650d"),
                vgroups=_safe_int(r, "vgroups", 2, 0) or 0,
                ntables=_safe_int(r, "ntables", 3, 0) or 0,
                cache_model=_row_val(r, ("cachemodel", "cache_model"), 18, None),
                is_tenant=is_tenant,
                stable_count=(_safe_int(stable_counts[0], "stable_count", 0, 0) or 0) if stable_counts else 0,
                subtable_count=sum(subtables.values()),
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
                f"SELECT stable_name "
                f"FROM information_schema.ins_stables "
                f"WHERE db_name = '{database}'"
            )
        except Exception:
            rows = await self._td_query(f"SHOW {_safe_ident(database)}.STABLES")

        subtable_counts = await self._subtable_counts(database)
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
                subtable_count=subtable_counts.get(sname, 0),
            ))
        return stables

    async def get_stable(self, database: str, stable_name: str) -> StableInfo | None:
        """Return detailed info for one supertable."""
        _safe_ident(database)
        _safe_ident(stable_name)
        cols, tags = await self._describe_stable(database, stable_name)
        counts = await self._subtable_counts(database)
        return StableInfo(
            name=stable_name,
            database=database,
            columns=cols,
            tags=tags,
            subtable_count=counts.get(stable_name, 0),
        )

    async def _subtable_counts(self, database: str) -> dict[str, int]:
        _safe_ident(database)
        rows = await self._td_query(
            "SELECT stable_name, COUNT(*) AS subtable_count FROM information_schema.ins_tables "
            f"WHERE db_name = '{database}' AND type = 'CHILD_TABLE' GROUP BY stable_name"
        )
        return {
            _safe_str(row, "stable_name", 0): _safe_int(row, "subtable_count", 1, 0) or 0
            for row in rows
        }

    @staticmethod
    def _subtable_filter(database: str, stable_name: str | None, search: str | None) -> str:
        _safe_ident(database)
        where = f"WHERE db_name = '{database}' AND type = 'CHILD_TABLE'"
        if stable_name:
            _safe_ident(stable_name)
            where += f" AND stable_name = '{stable_name}'"
        if search:
            # Identifier characters only (P1-12: nothing user-typed reaches SQL unvalidated).
            needle = re.sub(r"[^A-Za-z0-9_]", "", str(search))[:64]
            if needle:
                where += f" AND table_name LIKE '%{needle}%'"
        return where

    async def count_subtables(self, database: str, stable_name: str | None = None, search: str | None = None) -> int:
        rows = await self._td_query(
            "SELECT COUNT(*) AS n FROM information_schema.ins_tables " + self._subtable_filter(database, stable_name, search)
        )
        return (_safe_int(rows[0], ("n", "count(*)"), 0, 0) or 0) if rows else 0

    async def list_subtables(
        self,
        database: str,
        stable_name: str | None = None,
        cursor: str | None = None,
        limit: int = 200,
        *,
        include_tags: bool = True,
        search: str | None = None,
    ) -> tuple[list[SubtableInfo], str | None]:
        """Return subtables with tag values, optionally filtered by stable and name search.

        Keyset pagination on ``table_name``; the cursor must be an identifier (P1-12). The search
        is applied in SQL *before* paging, so totals and pages are exact. Tags of the page are read
        with one ``information_schema.ins_tags`` query (no N+1, no invalid ``SELECT ... TAGS``).
        Returns (items, next_cursor).
        """
        base = "SELECT table_name, stable_name, create_time FROM information_schema.ins_tables " + self._subtable_filter(
            database, stable_name, search
        )
        if cursor:
            _safe_ident(cursor)
            base += f" AND table_name > '{cursor}'"
        base += f" ORDER BY table_name LIMIT {max(1, int(limit)) + 1}"

        rows = await self._td_query(base)

        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cur = _safe_str(rows[-1], ("table_name", "name"), 0) if has_more and rows else None
        names = [_safe_str(r, ("table_name", "name"), 0) for r in rows]
        tag_map = await self._get_tags_bulk(database, names) if include_tags and names else {}

        items: list[SubtableInfo] = []
        for r in rows:
            tname = _safe_str(r, ("table_name", "name"), 0)
            sname = _safe_str(r, "stable_name", 1, "")
            tags = tag_map.get(tname, {})
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

    async def list_catalog(
        self,
        tenant_id: UUID,
        session: Any,
        *,
        object_type: str | None,
        status: str | None,
        search: str,
        page: int,
        page_size: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """Page through tenant physical metadata without graph limits or per-object tag reads."""
        from factorix.modules.common import fetch_all

        labels = await self._load_storage_labels(tenant_id, session)
        registry = await fetch_all(
            session,
            "SELECT object_type, physical_db, physical_name, status FROM storage_objects "
            "WHERE tenant_id = :tenant_id AND status != 'PURGED'",
            {"tenant_id": tenant_id},
        )
        statuses = {
            f"db:{entry['physical_name']}" if entry["object_type"] == "database"
            else f"{entry['object_type']}:{entry['physical_db']}.{entry['physical_name']}": entry["status"]
            for entry in registry
        }
        rows: list[dict[str, Any]] = []
        registered_dbs = [e["physical_name"] for e in registry if e["object_type"] == "database"]
        for db in await self.list_databases(tenant_id, registered_dbs):
            db_label = labels.get(db.name, db.name)
            if object_type in (None, "database"):
                rows.append({
                    "id": f"db:{db.name}", "object_type": "database",
                    "physical_name": db.name, "display_name": db_label,
                    "subtable_count": db.subtable_count,
                })
            if object_type in (None, "stable"):
                counts = await self._subtable_counts(db.name)
                stables = await self._td_query(
                    f"SELECT * FROM information_schema.ins_stables WHERE db_name = '{db.name}' ORDER BY stable_name"
                )
                for stable in stables:
                    name = _safe_str(stable, "stable_name", 0)
                    rows.append({
                        "id": f"stable:{db.name}.{name}", "object_type": "stable",
                        "physical_name": name, "display_name": labels.get(name, name), "parent_name": db_label,
                        "column_count": _safe_int(stable, "columns", 3, 0),
                        "tag_count": _safe_int(stable, "tags", 4, 0),
                        "subtable_count": counts.get(name, 0),
                    })
            if object_type in (None, "subtable"):
                subtables = await self._td_query(
                    "SELECT table_name, stable_name FROM information_schema.ins_tables "
                    f"WHERE db_name = '{db.name}' AND type = 'CHILD_TABLE' ORDER BY table_name"
                )
                for subtable in subtables:
                    name = _safe_str(subtable, "table_name", 0)
                    parent = _safe_str(subtable, "stable_name", 1, "")
                    rows.append({
                        "id": f"subtable:{db.name}.{name}", "object_type": "subtable",
                        "physical_name": name, "display_name": labels.get(name, name),
                        "parent_name": labels.get(parent, parent),
                    })

        for row in rows:
            row["status"] = statuses.get(row["id"], "ACTIVE")
        if status is not None:
            rows = [row for row in rows if row["status"] == status]
        query = search.strip().casefold()
        if query:
            rows = [row for row in rows if any(
                query in row.get(field, "").casefold() for field in ("physical_name", "display_name", "parent_name")
            )]
        start = (page - 1) * page_size
        return rows[start:start + page_size], len(rows)

    async def summarize(self, tenant_id: UUID, session: Any) -> dict[str, Any]:
        """Compact per-database / per-supertable counts for overview screens (no subtable listing).

        TDengine gives the physical counts; the registry adds what FactoriX manages: registered
        subtables by recording status, active bindings, and the writer outbox (pending / failed /
        last confirmed write in the outbox retention window).
        """
        from factorix.modules.common import fetch_all, iso_ms
        from factorix.modules.storage_objects import is_system_stable

        dbs = await self.list_databases(tenant_id, await registered_databases(session, tenant_id))
        reg = await fetch_all(
            session,
            """
            SELECT o.physical_db, o.parent_name, o.status, COUNT(*) AS n,
                   COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM storage_bindings b WHERE b.tenant_id = o.tenant_id
                       AND b.physical_db = o.physical_db AND b.physical_subtable = o.physical_name AND b.status = 'ACTIVE')) AS bound
            FROM storage_objects o
            WHERE o.tenant_id = :tenant_id AND o.object_type = 'subtable' AND o.status <> 'PURGED'
            GROUP BY o.physical_db, o.parent_name, o.status
            """,
            {"tenant_id": tenant_id},
        )
        outbox = await fetch_all(
            session,
            """
            SELECT o.physical_db, so.parent_name,
                   COUNT(*) FILTER (WHERE o.status = 'PENDING') AS pending,
                   COUNT(*) FILTER (WHERE o.status = 'FAILED') AS failed,
                   MAX(o.confirmed_at) AS last_write_at
            FROM storage_record_outbox o
            LEFT JOIN storage_objects so ON so.tenant_id = o.tenant_id AND so.object_type = 'subtable'
             AND so.physical_db = o.physical_db AND so.physical_name = o.physical_subtable AND so.status <> 'PURGED'
            WHERE o.tenant_id = :tenant_id
            GROUP BY o.physical_db, so.parent_name
            """,
            {"tenant_id": tenant_id},
        )
        managed_stables = {
            (str(r["physical_db"]), str(r["physical_name"])) for r in await fetch_all(
                session,
                "SELECT physical_db, physical_name FROM storage_objects WHERE tenant_id = :tenant_id "
                "AND object_type = 'stable' AND status <> 'PURGED'",
                {"tenant_id": tenant_id},
            )
        }
        out_dbs = []
        for db in dbs:
            counts = await self._subtable_counts(db.name)
            names = await self._td_query(f"SELECT stable_name FROM information_schema.ins_stables WHERE db_name = '{db.name}'")
            stables = []
            for row in names:
                st = _safe_str(row, "stable_name", 0)
                rec: dict[str, int] = {}
                bound = 0
                for r in reg:
                    if r["physical_db"] == db.name and r["parent_name"] == st:
                        rec[str(r["status"])] = rec.get(str(r["status"]), 0) + int(r["n"])
                        bound += int(r["bound"] or 0)
                ob = next((r for r in outbox if r["physical_db"] == db.name and r["parent_name"] == st), None)
                stables.append({
                    "name": st,
                    "id": f"stable:{db.name}.{st}",
                    "is_system": is_system_stable(st),
                    "managed": (db.name, st) in managed_stables,
                    "subtable_count": counts.get(st, 0),
                    "registered_subtables": rec,
                    "bound_subtables": bound,
                    "writer": {
                        "pending": int(ob["pending"]) if ob else 0,
                        "failed": int(ob["failed"]) if ob else 0,
                        "last_write_at": iso_ms(ob["last_write_at"]) if ob and ob.get("last_write_at") else None,
                    },
                })
            stables.sort(key=lambda x: (x["is_system"], x["name"]))
            out_dbs.append({
                "name": db.name, "id": f"db:{db.name}", "precision": db.precision, "keep": db.keep,
                "is_tenant_default": db.is_tenant, "stable_count": db.stable_count,
                "subtable_count": db.subtable_count, "stables": stables,
            })
        return {"databases": out_dbs}

    async def get_topology(
        self,
        tenant_id: UUID,
        database: str | None = None,
        depth: int = 2,
        cursor: str | None = None,
        session: Any | None = None,
        *,
        include_subtable_tags: bool = True,
    ) -> TopologySnapshot:
        """Return full or filtered topology snapshot for the UI canvas."""
        observed_at = datetime.now(timezone.utc)
        # Always tenant-scoped (P1-13): ?database= can only narrow to a database the tenant owns.
        dbs = await self.list_databases(tenant_id, await registered_databases(session, tenant_id))
        if database:
            dbs = [d for d in dbs if d.name == database]

        label_map = await self._load_storage_labels(tenant_id, session)

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
                    "stable_count": db.stable_count,
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
                            db.name, st.name, cursor=cursor, limit=TOPOLOGY_CHILD_LIMIT,
                            include_tags=include_subtable_tags,
                        )
                        all_subtables.extend(subs)
                        for sub in subs:
                            display_label = label_map.get(sub.name, sub.name)
                            nodes.append(TopologyNode(
                                node_id=f"subtable:{db.name}.{sub.name}",
                                kind="subtable",
                                label=display_label,
                                parent_id=f"stable:{db.name}.{st.name}",
                                metadata={
                                    "tags": sub.tags,
                                    "physical_name": sub.name,
                                    "display_name": display_label,
                                },
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

    async def _load_storage_labels(self, tenant_id: UUID, session: Any | None) -> dict[str, str]:
        label_map: dict[str, str] = {}
        if session is not None and tenant_id:
            from factorix.modules.common import fetch_all

            # 1. output_groups for ms_<hex>
            try:
                m_rows = await fetch_all(
                    session,
                    "SELECT id, key, display_name FROM output_groups WHERE tenant_id = :tenant_id",
                    {"tenant_id": tenant_id},
                )
                for r in m_rows:
                    m_id_hex = UUID(str(r["id"])).hex
                    m_label = str(r.get("display_name") or r.get("key") or "")
                    if m_label:
                        label_map[f"ms_{m_id_hex}"] = f"{m_label} (Snapshot)"
            except Exception as exc:
                logger.debug("Failed loading output_groups for topology label map: %s", exc)

            # 2. signal_definitions for op_*_<hex>
            try:
                s_rows = await fetch_all(
                    session,
                    "SELECT s.id, s.key, r.name AS resource_name FROM signal_definitions s "
                    "LEFT JOIN resources r ON r.id = s.resource_id WHERE s.tenant_id = :tenant_id",
                    {"tenant_id": tenant_id},
                )
                for r in s_rows:
                    s_id_hex = UUID(str(r["id"])).hex
                    s_label = str(r.get("key") or "")
                    if r.get("resource_name"):
                        s_label = f"{r['resource_name']} \u00b7 {s_label}"
                    if s_label:
                        for pfx in ("op_float64_", "op_int64_", "op_bool_", "op_binary_", "op_string_", "op_json_"):
                            label_map[f"{pfx}{s_id_hex}"] = f"{s_label} (Telemetry)"
            except Exception as exc:
                logger.debug("Failed loading signal_definitions for topology label map: %s", exc)

            # 3. storage_objects for managed subtables
            try:
                so_rows = await fetch_all(
                    session,
                    "SELECT physical_name, display_name FROM storage_objects WHERE tenant_id = :tenant_id AND status != 'PURGED'",
                    {"tenant_id": tenant_id},
                )
                for r in so_rows:
                    pname = str(r.get("physical_name") or "")
                    dname = str(r.get("display_name") or "")
                    if pname and dname:
                        label_map[pname] = dname
            except Exception as exc:
                logger.debug("Failed loading storage_objects for topology label map: %s", exc)
        return label_map

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
            is_ts = ctype.upper() == "TIMESTAMP" and not is_tag and not cols
            role = "time_key" if is_ts else ("tag" if is_tag else "value")
            is_key = ("COMPOSITE" in note or "PRIMARY" in note) and not is_tag
            ci = ColumnInfo(
                name=cname,
                td_type=ctype,
                length=clength,
                role=role,
                # TDengine: only the first timestamp and the composite key are NOT NULL (R2-13).
                nullable=not (is_ts or is_key),
                primary_key=is_key,
            )
            if is_tag:
                tags.append(ci)
            else:
                cols.append(ci)
        return cols, tags

    async def _get_tags_bulk(self, database: str, names: list[str]) -> dict[str, dict[str, Any]]:
        """Tag values of many subtables with one query (TDengine 3.4: ``information_schema.ins_tags``)."""
        if self._td is None or not names:
            return {}
        _safe_ident(database)
        out: dict[str, dict[str, Any]] = {}
        for i in range(0, len(names), 200):
            chunk = [n for n in names[i:i + 200] if n]
            for n in chunk:
                _safe_ident(n)
            in_list = ", ".join(f"'{n}'" for n in chunk)
            try:
                rows = await self._td_query(
                    "SELECT table_name, tag_name, tag_value FROM information_schema.ins_tags "
                    f"WHERE db_name = '{database}' AND table_name IN ({in_list})"
                )
            except Exception as exc:  # noqa: BLE001 - tags are optional decoration of the list
                logger.warning("Reading tags of %s failed: %s", database, exc)
                return out
            for r in rows or []:
                t = _safe_str(r, "table_name", 0)
                out.setdefault(t, {})[_safe_str(r, "tag_name", 1)] = _row_val(r, "tag_value", 2, None)
        return out

    async def _get_subtable_tags(
        self, database: str, table_name: str
    ) -> dict[str, Any]:
        """Return tag values for a subtable as {tag_name: value}."""
        return (await self._get_tags_bulk(database, [table_name])).get(table_name, {})

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

async def registered_databases(session: Any | None, tenant_id: UUID) -> list[str]:
    """User databases registered to *tenant_id* (created through the Storage wizard)."""
    if session is None:
        return []
    from factorix.modules.common import fetch_all

    rows = await fetch_all(
        session,
        "SELECT physical_name FROM storage_objects WHERE tenant_id = :tenant_id "
        "AND object_type = 'database' AND status <> 'PURGED'",
        {"tenant_id": tenant_id},
    )
    return [str(r["physical_name"]) for r in rows]


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
                "physical_name": (n.metadata.get("physical_name") or n.label) if n.metadata else n.label,
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
        "primary_key": c.primary_key,
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
