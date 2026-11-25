"""Bulk creation of subtables ("Subtables from Data Models", R2-04 / R2-05).

Same rules as the single-object saga in :mod:`factorix.modules.storage_revisions` (validate everything
first, no ``IF NOT EXISTS`` that could hide a clash, idempotency per row, read-back verification,
registry + bindings + APPLIED in PostgreSQL, compensation of objects this request created), but the
work is batched so a chunk of N rows costs a handful of round trips instead of ~15 per row:

========================  =====================================================================
Phase                     TDengine / PostgreSQL work for the whole chunk
========================  =====================================================================
1. resolve                tenant check per distinct database; parent STABLE schema once per parent
2. existence              one ``information_schema.ins_tables`` + ``ins_stables`` query per database
3. validate               models / field owners / resource index loaded once; rows validated in
                          memory (a field bound by an earlier row of the same chunk counts as owned)
4. operations             prior operations of all idempotency keys in one query; one commit
5. DDL                    one multi-table ``CREATE TABLE a USING … TAGS (…) b USING …`` per
                          database; when TDengine rejects the statement, rows are retried one by one
                          so one bad row never blocks the others
6. verify                 ``ins_tables`` + ``ins_tags`` read back for all created names at once
7. register               one transaction (a savepoint per row) + one bindings-cache invalidation
========================  =====================================================================

Before (R2-05): every row ran the full saga — ~8 TDengine ``information_schema``/DESCRIBE calls, 6
commits, two loads of every binding of the tenant and a recorder cache invalidation — so 126 rows
took ~92 s and kept the shared TDengine worker pool (4 threads) busy for every other page.

Result per row: ``CREATED`` | ``EXISTS`` | ``VALID`` (dry run) | ``INVALID`` | ``FAILED`` with
``operation_id`` / ``object_id`` / ``errors``; plus ``summary`` and ``timing_ms`` per phase.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from factorix.modules import storage_bindings as SB
from factorix.modules.common import execute, fetch_all, fetch_one, iso_ms, jsonb, utcnow
from factorix.modules.storage_objects import StorageObjectError, generate_create_subtable_ddl, validate_subtable_spec
from factorix.modules.storage_revisions import (
    IN_PROGRESS,
    STUCK_AFTER,
    StorageRevisionService,
    _compute_spec_hash,
    _row_value,
    load_models,
    subtable_spec_from,
)
from factorix.platform.tdengine import quote_str

logger = logging.getLogger(__name__)

MAX_ROWS = 50
#: Subtables per multi-table CREATE statement (keeps one SQL text well below the TDengine limit).
DDL_CHUNK = 50
OP_TYPE = "CREATE_SUBTABLE"


_PREFIX_DROP_HEAD = {"st", "stable", "machine", "machines", "production", "plant", "factory", "mes"}
_PREFIX_DROP_TAIL = {"change", "changes", "value", "values", "event", "events", "history", "log", "stream", "data"}


def suggested_subtable_prefix(stable_name: str) -> str:
    """Name prefix the bulk wizard proposes for the subtables of a supertable (R2-14): the domain word(s)
    of the supertable name without the generic qualifiers, e.g. ``st_machine_state_change`` -> ``state_``,
    ``st_production_order_change`` -> ``order_`` (was "production"), ``st_machine_condition_value`` ->
    ``condition_``. Falls back to the name without ``st_`` when nothing is left."""
    parts = [p for p in str(stable_name or "").lower().split("_") if p]
    core = list(parts)
    while core and core[0] in _PREFIX_DROP_HEAD:
        core.pop(0)
    while core and core[-1] in _PREFIX_DROP_TAIL:
        core.pop()
    if not core:
        core = [p for p in parts if p not in ("st", "stable")] or ["t"]
    return "_".join(core) + "_"


def bulk_idempotency_key(database: str, name: str, spec: dict[str, Any]) -> str:
    """``bulk:<db>.<name>:<spec hash>`` — a retried chunk never duplicates (same as before)."""
    return f"bulk:{database}.{name}:{_compute_spec_hash(spec)}"


def _err_fields(exc: BaseException) -> tuple[str, str, list[dict[str, Any]]]:
    code = str(getattr(exc, "code", None) or "FAILED")
    message = str(getattr(exc, "message", None) or exc)
    errors = list(getattr(exc, "field_errors", None) or [])
    return code, message, errors


def _in_list(names: list[str]) -> str:
    return ", ".join(quote_str(n) for n in names)


class BulkSubtableCreator:
    """Batched counterpart of ``StorageRevisionService.publish_draft`` for many subtables."""

    def __init__(self, revisions: StorageRevisionService) -> None:
        self.rev = revisions

    async def run(
        self,
        session: AsyncSession,
        tenant_id: UUID,
        actor_id: UUID | None,
        raw_rows: list[dict[str, Any]],
        *,
        dry_run: bool,
        resolve_db: Callable[[str | None], Awaitable[str]],
    ) -> dict[str, Any]:
        t0 = time.perf_counter()
        timing: dict[str, float] = {}

        def lap(name: str, since: float) -> float:
            now = time.perf_counter()
            timing[name] = round((now - since) * 1000, 1)
            return now

        # ---- 1. normalise + tenant check per database -------------------------------------------
        rows: list[dict[str, Any]] = []
        db_cache: dict[str | None, str | BaseException] = {}
        for raw in raw_rows:
            spec = dict(raw)
            stable_ref = str(spec.get("stable") or spec.get("stable_id") or "")
            if "." in stable_ref:
                spec["database"], spec["stable"] = stable_ref.split(".", 1)
            name = str(spec.get("name") or spec.get("physical_name") or "")
            entry: dict[str, Any] = {"name": name, "database": spec.get("database"), "stable": spec.get("stable")}
            key = spec.get("database")
            if key not in db_cache:
                try:
                    db_cache[key] = await resolve_db(key)
                except Exception as exc:  # noqa: BLE001 - reported on the row (404 tenant check)
                    db_cache[key] = exc
            resolved = db_cache[key]
            if isinstance(resolved, BaseException):
                code, message, errors = _err_fields(resolved)
                entry.update(status="FAILED", code=code, message=message, errors=errors)
            else:
                spec["database"] = resolved
                entry["database"] = resolved
            rows.append({"entry": entry, "spec": spec})
        mark = lap("resolve", t0)

        live = [r for r in rows if "status" not in r["entry"]]
        # ---- 2. existence: one query per database ----------------------------------------------
        by_db: dict[str, list[dict[str, Any]]] = {}
        for r in live:
            by_db.setdefault(r["spec"]["database"], []).append(r)
        existing: dict[str, set[str]] = {}
        for db, items in by_db.items():
            names = sorted({r["entry"]["name"] for r in items if r["entry"]["name"]})
            existing[db] = await self._existing_names(db, names) if names else set()
        for r in live:
            if r["entry"]["name"] in existing.get(r["spec"]["database"], set()):
                r["entry"].update(status="EXISTS", message=f"'{r['entry']['name']}' already exists; open it to verify, nothing was created.")
        mark = lap("existence", mark)

        # ---- 3. validate in memory with shared caches ------------------------------------------
        live = [r for r in rows if "status" not in r["entry"]]
        parents: dict[tuple[str, str], tuple[list[Any], list[Any]]] = {}
        model_ids: list[str] = []
        for r in live:
            for b in r["spec"].get("bindings") or []:
                if isinstance(b, dict):
                    mid = b.get("model_id") or (str(b.get("source_id") or "") if b.get("source_kind") == "model_field" else None)
                    if mid:
                        model_ids.append(str(mid))
        models = await load_models(session, tenant_id, sorted(set(model_ids))) if model_ids else {}
        owners = await SB.bound_model_fields(session, tenant_id) if live else {}
        check_ctx: dict[str, Any] = {"models": models}
        for r in live:
            spec, entry = r["spec"], r["entry"]
            try:
                sub = subtable_spec_from(spec)
                pkey = (sub.database, sub.stable)
                if pkey not in parents:
                    parents[pkey] = await self.rev.stable_schema(session, tenant_id, sub.database, sub.stable)
                cols, tags = parents[pkey]
                res = validate_subtable_spec(sub, tags)
                errors = list(res.errors)
                bindings: list[dict[str, Any]] = []
                if res.valid:
                    try:
                        bindings = await self.rev.resolve_bindings(session, tenant_id, sub, cols, spec, models=models, owners=owners)
                    except StorageObjectError as exc:
                        errors.extend(getattr(exc, "field_errors", None) or [{"field": "bindings", "code": exc.code, "message": str(exc)}])
                    else:
                        errors.extend(await self.rev.machine_tag_errors(session, tenant_id, sub, bindings, ctx=check_ctx))
                if errors:
                    entry.update(status="INVALID", code=errors[0].get("code") or "VALIDATION_FAILED",
                                 message=errors[0].get("message") or "Validation failed", errors=errors)
                    continue
                # A field may have one owner: later rows of this chunk see the fields bound above.
                for b in bindings:
                    if b.get("source_kind") == "model_field":
                        owners[(str(b["model_id"]), SB.normalize_field_path(b["model_field_path"]))] = {
                            "database": sub.database, "subtable": sub.name, "column": b["target_column"]}
                r.update(sub=sub, extra={"stable_columns": cols, "stable_tags": tags, "bindings": bindings},
                         ddl=generate_create_subtable_ddl(sub, tags))
                if dry_run:
                    entry.update(status="VALID", errors=[], ddl=[r["ddl"]], bindings=len(bindings))
            except StorageObjectError as exc:
                code, message, errs = _err_fields(exc)
                entry.update(status="INVALID", code=code, message=message, errors=errs or [{"field": "", "code": code, "message": message}])
        mark = lap("validate", mark)
        if dry_run:
            return self._result(rows, dry_run, timing, t0)

        # ---- 4. operations: idempotency + one commit -------------------------------------------
        todo = [r for r in rows if "status" not in r["entry"]]
        if todo:
            for r in todo:
                r["key"] = bulk_idempotency_key(r["spec"]["database"], r["entry"]["name"], r["spec"])
                r["hash"] = _compute_spec_hash(r["spec"])
            prior = {
                str(p["idempotency_key"]): p for p in await fetch_all(
                    session,
                    "SELECT id, idempotency_key, status, started_at, requested_at FROM storage_operations "
                    "WHERE tenant_id = :tenant_id AND operation_type = :op AND idempotency_key = ANY(:keys)",
                    {"tenant_id": tenant_id, "op": OP_TYPE, "keys": [r["key"] for r in todo]},
                )
            }
            now = utcnow()
            for r in todo:
                p = prior.get(r["key"])
                state = {"phase": "APPLYING", "steps_total": 1, "steps_done": 0, "bulk": True,
                         "object_key": f"{r['spec']['database']}.{r['entry']['name']}", "ddl": [r["ddl"]]}
                if p is not None:
                    started = p.get("started_at") or p.get("requested_at")
                    if str(p["status"]) in IN_PROGRESS and started is not None and now - started < STUCK_AFTER:
                        r["entry"].update(status="FAILED", code="OPERATION_IN_PROGRESS",
                                          message=f"Creating {state['object_key']} is already in progress (operation {p['id']}).")
                        continue
                    r["op_id"] = UUID(str(p["id"]))
                    await execute(
                        session,
                        "UPDATE storage_operations SET status = 'APPLYING', started_at = :now, completed_at = NULL, "
                        "error_code = NULL, error_message = NULL, step_state_json = :state WHERE id = :id",
                        {"id": r["op_id"], "now": now, "state": jsonb(state)},
                    )
                else:
                    r["op_id"] = uuid4()
                    await execute(
                        session,
                        """
                        INSERT INTO storage_operations (
                            id, tenant_id, operation_type, target_type, actor_id, idempotency_key,
                            status, requested_at, started_at, step_state_json, spec_hash, object_key
                        ) VALUES (:id, :tenant_id, :op, 'subtable', :actor_id, :key, 'APPLYING', :now, :now, :state, :hash, :object_key)
                        """,
                        {"id": r["op_id"], "tenant_id": tenant_id, "op": OP_TYPE, "actor_id": actor_id, "key": r["key"],
                         "now": now, "state": jsonb(state), "hash": r["hash"], "object_key": state["object_key"]},
                    )
            await session.commit()
        mark = lap("operations", mark)

        # ---- 5. DDL: one multi-table CREATE per database, per-row retry on rejection ------------
        todo = [r for r in rows if "status" not in r["entry"] and r.get("op_id")]
        created: list[dict[str, Any]] = []
        failed_ddl: list[tuple[dict[str, Any], str]] = []
        groups: dict[str, list[dict[str, Any]]] = {}
        for r in todo:
            groups.setdefault(r["spec"]["database"], []).append(r)
        for _db, items in groups.items():
            for i in range(0, len(items), DDL_CHUNK):
                chunk = items[i:i + DDL_CHUNK]
                sql = "CREATE TABLE " + " ".join(c["ddl"][len("CREATE TABLE "):] for c in chunk)
                try:
                    await self.rev._td_exec(sql)
                    created.extend(chunk)
                    continue
                except Exception as exc:  # noqa: BLE001 - retried row by row below
                    logger.info("Multi-table CREATE rejected (%s rows), retrying one by one: %s", len(chunk), exc)
                # TDengine may have created part of the statement: whatever exists now and did not
                # exist in phase 2 was created by this request.
                now_there = await self._existing_names(chunk[0]["spec"]["database"], [c["entry"]["name"] for c in chunk])
                for c in chunk:
                    if c["entry"]["name"] in now_there:
                        created.append(c)
                        continue
                    try:
                        await self.rev._td_exec(c["ddl"])
                        created.append(c)
                    except Exception as exc:  # noqa: BLE001 - row FAILED, others continue
                        failed_ddl.append((c, str(exc)))
        mark = lap("ddl", mark)

        # ---- 6. read-back verification (batched) -----------------------------------------------
        problems = await self._verify(created)
        mark = lap("verify", mark)

        # ---- 7. registry + bindings + APPLIED; failures compensated -------------------------------
        to_drop: list[dict[str, Any]] = []
        for c, msg in failed_ddl:
            await self._mark_failed(session, c, "DDL_EXECUTION_ERROR", f"TDengine rejected the DDL: {msg}")
        for c in created:
            name = c["entry"]["name"]
            if problems.get(name):
                to_drop.append(c)
                await self._mark_failed(session, c, "VERIFICATION_FAILED",
                                        f"The created object does not match the request ({'; '.join(problems[name])}).")
                continue
            try:
                async with session.begin_nested():
                    obj_id = await self.rev._register(session, tenant_id, "subtable", c["spec"], c["extra"],
                                                      c["spec"]["database"], name, c["hash"])
                    await execute(
                        session,
                        "UPDATE storage_operations SET status = 'APPLIED', completed_at = :now, verification_json = :v, "
                        "step_state_json = :state WHERE id = :id",
                        {"id": c["op_id"], "now": utcnow(),
                         "v": jsonb({"read_back_ok": True, "problems": [], "object_kind": "subtable", "verified_at": iso_ms(utcnow())}),
                         "state": jsonb({"phase": "APPLIED", "steps_total": 1, "steps_done": 1, "bulk": True,
                                         "executed_sqls": [c["ddl"]], "object_id": str(obj_id)})},
                    )
                c["entry"].update(status="CREATED", operation_id=str(c["op_id"]), object_id=str(obj_id),
                                  replay=False, bindings=len(c["extra"]["bindings"]))
            except Exception as exc:  # noqa: BLE001 - this row is compensated, the others are kept
                logger.exception("Registry write failed for %s.%s", c["spec"]["database"], name)
                to_drop.append(c)
                await self._mark_failed(session, c, "REGISTRY_FAILED", f"The object could not be registered: {exc}")
        await session.commit()
        for c in to_drop:
            dropped = await self.rev._compensate("subtable", c["spec"]["database"], c["entry"]["name"])
            c["entry"]["compensated"] = dropped
            c["entry"]["message"] = (c["entry"].get("message") or "") + (" It was removed again." if dropped else
                                                                       " It could not be removed automatically.")
        if any(c["entry"].get("status") == "CREATED" for c in created):
            from factorix.modules import storage_model_recorder

            storage_model_recorder.invalidate_bindings(tenant_id)
        lap("register", mark)
        return self._result(rows, dry_run, timing, t0)

    # ------------------------------------------------------------------------------------------
    async def _existing_names(self, db: str, names: list[str]) -> set[str]:
        """Names of ``names`` that already exist as a table or supertable in ``db``."""
        if not names:
            return set()
        found: set[str] = set()
        for i in range(0, len(names), 200):
            part = names[i:i + 200]
            for sql in (
                f"SELECT table_name AS n FROM information_schema.ins_tables WHERE db_name = {quote_str(db)} AND table_name IN ({_in_list(part)})",
                f"SELECT stable_name AS n FROM information_schema.ins_stables WHERE db_name = {quote_str(db)} AND stable_name IN ({_in_list(part)})",
            ):
                for row in await self.rev._td_read(sql):
                    found.add(str(_row_value(row, "n", 0)))
        return found

    async def _verify(self, created: list[dict[str, Any]]) -> dict[str, list[str]]:
        """``name -> problems`` for the created subtables (parent STABLE + tag values read back)."""
        problems: dict[str, list[str]] = {}
        by_db: dict[str, list[dict[str, Any]]] = {}
        for c in created:
            by_db.setdefault(c["spec"]["database"], []).append(c)
        for db, items in by_db.items():
            names = [c["entry"]["name"] for c in items]
            parents: dict[str, str] = {}
            tags: dict[str, dict[str, Any]] = {}
            for i in range(0, len(names), 200):
                part = _in_list(names[i:i + 200])
                for row in await self.rev._td_read(
                    f"SELECT table_name, stable_name FROM information_schema.ins_tables WHERE db_name = {quote_str(db)} AND table_name IN ({part})"
                ):
                    parents[str(_row_value(row, "table_name", 0))] = str(_row_value(row, "stable_name", 1) or "")
                for row in await self.rev._td_read(
                    f"SELECT table_name, tag_name, tag_value FROM information_schema.ins_tags WHERE db_name = {quote_str(db)} AND table_name IN ({part})"
                ):
                    tags.setdefault(str(_row_value(row, "table_name", 0)), {})[str(_row_value(row, "tag_name", 1))] = _row_value(row, "tag_value", 2)
            for c in items:
                sub, name, errs = c["sub"], c["entry"]["name"], []
                if name not in parents:
                    errs.append(f"subtable '{name}' not found")
                elif parents[name] != sub.stable:
                    errs.append(f"parent is {parents[name]}, expected {sub.stable}")
                got = tags.get(name, {})
                for tag in c["extra"]["stable_tags"]:
                    want = sub.tag_values.get(tag.name)
                    if want is not None and str(got.get(tag.name)) != str(want):
                        errs.append(f"tag {tag.name}={got.get(tag.name)!r}, expected {want!r}")
                if errs:
                    problems[name] = errs
        return problems

    async def _mark_failed(self, session: AsyncSession, c: dict[str, Any], code: str, message: str) -> None:
        c["entry"].update(status="FAILED", code=code, message=message, operation_id=str(c["op_id"]))
        await execute(
            session,
            "UPDATE storage_operations SET status = 'FAILED', completed_at = :now, error_code = :code, "
            "error_message = :msg WHERE id = :id",
            {"id": c["op_id"], "now": utcnow(), "code": code, "msg": message[:2000]},
        )

    @staticmethod
    def _result(rows: list[dict[str, Any]], dry_run: bool, timing: dict[str, float], t0: float) -> dict[str, Any]:
        items = [r["entry"] for r in rows]
        summary: dict[str, int] = {}
        for e in items:
            summary[e["status"]] = summary.get(e["status"], 0) + 1
        timing["total"] = round((time.perf_counter() - t0) * 1000, 1)
        return {"items": items, "summary": summary, "dry_run": dry_run, "timing_ms": timing,
                "completed_at": iso_ms(utcnow())}


# ------------------------------------------------------------------------------------------------
# Background jobs (WS-P P6 / R2-05): bulk creation never runs inside the API request nor on the shared
# TDengine pool. ``POST .../bulk`` answers 202 with a job id; the job uses its OWN one-connection
# TDengine client, one job at a time, in chunks of ``MAX_ROWS``, a fresh PostgreSQL session per chunk.
# The live job state is in memory (single API process) and is mirrored to ``storage_bulk_jobs``
# (migration 0014) when it starts, after every chunk and when it ends (B-12 / OP-14). A job the current
# process does not know but the table shows QUEUED / RUNNING ran in a process that is gone: it is reported
# INTERRUPTED with the rows it finished. Every row is idempotent in ``storage_operations``, so validating
# the same rows again reports the created ones as EXISTS.
# ------------------------------------------------------------------------------------------------

MAX_JOB_ROWS = 1000
JOB_KEEP_S = 3600.0
_JOBS: dict[str, dict[str, Any]] = {}
_JOB_TASKS: set[Any] = set()
_RUN_ONE_AT_A_TIME: Any = None  # asyncio.Semaphore, created lazily in the running loop
# Identifies this API process in storage_bulk_jobs.process_id (diagnostics: which boot ran the job).
PROCESS_ID = f"{os.getpid()}-{uuid4().hex[:8]}"
JOB_ACTIVE_STATES = ("QUEUED", "RUNNING")
INTERRUPTED_MESSAGE = (
    "The Center restarted while this job was running; {done} of {total} rows were processed. "
    "Validate the same rows again: the ones already created show as Exists, the rest can be created."
)
_persist_warned = False

ResolveFactory = Callable[[AsyncSession], Callable[[str | None], Awaitable[str]]]


def _job_public(job: dict[str, Any], *, with_items: bool = True) -> dict[str, Any]:
    out = {k: v for k, v in job.items() if not k.startswith("_") and (with_items or k != "items")}
    out["progress_pct"] = round(100.0 * job["done"] / job["total"], 1) if job["total"] else 100.0
    return out


def _prune_jobs() -> None:
    now = time.monotonic()
    for jid in [j for j, job in _JOBS.items() if job.get("_finished_mono") and now - job["_finished_mono"] > JOB_KEEP_S]:
        _JOBS.pop(jid, None)


def _default_td_factory() -> Any:
    """One dedicated TDengine connection for the job (not the API's shared 4-thread pool)."""
    from factorix.platform.settings import get_settings
    from factorix.platform.tdengine import TDEngineClient, TDEngineConfig

    cfg = get_settings()
    return TDEngineClient(TDEngineConfig(dsn=cfg.tdengine_dsn, db_prefix=cfg.tdengine_db_prefix, max_workers=1))


def _default_session_factory() -> Any:
    from factorix.platform.db import session_factory

    return session_factory()


def submit_job(
    tenant_id: UUID,
    actor_id: UUID | None,
    rows: list[dict[str, Any]],
    *,
    resolve_factory: ResolveFactory,
    session_factory: Any = None,
    td_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Queue a bulk creation; returns the public job record (status QUEUED)."""
    import asyncio

    global _RUN_ONE_AT_A_TIME
    if _RUN_ONE_AT_A_TIME is None:
        _RUN_ONE_AT_A_TIME = asyncio.Semaphore(1)
    _prune_jobs()
    job_id = str(uuid4())
    job: dict[str, Any] = {
        "job_id": job_id, "tenant_id": str(tenant_id), "status": "QUEUED", "total": len(rows), "done": 0,
        "summary": {}, "items": [], "timing_ms": {}, "error": None,
        "created_at": iso_ms(utcnow()), "started_at": None, "finished_at": None, "_finished_mono": None,
    }
    _JOBS[job_id] = job
    task = asyncio.create_task(
        _run_job(job, tenant_id, actor_id, rows, resolve_factory, session_factory or _default_session_factory(),
                 td_factory or _default_td_factory),
        name=f"storage-bulk-{job_id[:8]}",
    )
    _JOB_TASKS.add(task)
    task.add_done_callback(_JOB_TASKS.discard)
    return _job_public(job)


async def _run_job(
    job: dict[str, Any], tenant_id: UUID, actor_id: UUID | None, rows: list[dict[str, Any]],
    resolve_factory: ResolveFactory, sessions: Any, td_factory: Callable[[], Any],
) -> None:
    await _persist_job(sessions, job)  # QUEUED is visible (and recoverable) before the job may start
    async with _RUN_ONE_AT_A_TIME:
        job.update(status="RUNNING", started_at=iso_ms(utcnow()))
        await _persist_job(sessions, job)
        td = None
        try:
            td = td_factory()
            creator = BulkSubtableCreator(StorageRevisionService(td))
            for i in range(0, len(rows), MAX_ROWS):
                chunk = rows[i:i + MAX_ROWS]
                async with sessions() as session:
                    res = await creator.run(session, tenant_id, actor_id, chunk, dry_run=False,
                                            resolve_db=resolve_factory(session))
                job["items"].extend(res["items"])
                job["done"] += len(chunk)
                for k, v in res["summary"].items():
                    job["summary"][k] = job["summary"].get(k, 0) + v
                for k, v in res["timing_ms"].items():
                    job["timing_ms"][k] = round(job["timing_ms"].get(k, 0.0) + v, 1)
                await _persist_job(sessions, job)
            job["status"] = "DONE"
        except Exception as exc:  # noqa: BLE001 - reported on the job; rows already done stay done
            logger.exception("Bulk subtable job %s failed", job["job_id"])
            job.update(status="FAILED", error=str(exc)[:1000])
        finally:
            if td is not None and hasattr(td, "close"):
                try:
                    await td.close()
                except Exception:  # noqa: BLE001 - closing a dedicated client is best effort
                    logger.warning("Closing the bulk job TDengine client failed", exc_info=True)
            job.update(finished_at=iso_ms(utcnow()), _finished_mono=time.monotonic())
            await _persist_job(sessions, job)


_UPSERT_JOB = """
INSERT INTO storage_bulk_jobs (id, tenant_id, status, total, done, summary_json, items_json, timing_json, error,
                               process_id, created_at, started_at, finished_at, updated_at)
VALUES (:id, :tenant_id, :status, :total, :done, CAST(:summary AS jsonb), CAST(:items AS jsonb), CAST(:timing AS jsonb),
        :error, :process_id, :created_at, :started_at, :finished_at, now())
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, done = EXCLUDED.done, summary_json = EXCLUDED.summary_json,
    items_json = EXCLUDED.items_json, timing_json = EXCLUDED.timing_json, error = EXCLUDED.error,
    started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, updated_at = now()
"""


def _ts(value: str | None) -> Any:
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


async def _persist_job(sessions: Any, job: dict[str, Any]) -> None:
    """Mirror the job to storage_bulk_jobs; never fails the job (e.g. before migration 0014 ran)."""
    global _persist_warned
    try:
        async with sessions() as session:
            await execute(session, _UPSERT_JOB, {
                "id": UUID(job["job_id"]), "tenant_id": UUID(job["tenant_id"]), "status": job["status"],
                "total": job["total"], "done": job["done"], "summary": json.dumps(job["summary"]),
                "items": json.dumps(job["items"], default=str), "timing": json.dumps(job["timing_ms"]),
                "error": job.get("error"), "process_id": PROCESS_ID, "created_at": _ts(job["created_at"]),
                "started_at": _ts(job.get("started_at")), "finished_at": _ts(job.get("finished_at")),
            })
            await session.commit()
    except Exception:  # noqa: BLE001 - durability is best effort; the in-memory job is the source of truth here
        if not _persist_warned:
            _persist_warned = True
            logger.warning("Could not persist bulk job %s (storage_bulk_jobs missing?)", job["job_id"], exc_info=True)


def _job_from_row(row: dict[str, Any], *, with_items: bool) -> dict[str, Any]:
    """A stored job; QUEUED / RUNNING without a live task in this process = INTERRUPTED."""

    def _json(value: Any, default: Any) -> Any:
        if isinstance(value, str):
            try:
                return json.loads(value)
            except ValueError:
                return default
        return default if value is None else value

    status = str(row.get("status") or "FAILED")
    total, done = int(row.get("total") or 0), int(row.get("done") or 0)
    error = row.get("error")
    if status in JOB_ACTIVE_STATES:
        status = "INTERRUPTED"
        error = INTERRUPTED_MESSAGE.format(done=done, total=total)
    job = {
        "job_id": str(row["id"]), "tenant_id": str(row["tenant_id"]), "status": status, "total": total, "done": done,
        "summary": _json(row.get("summary_json"), {}), "items": _json(row.get("items_json"), []),
        "timing_ms": _json(row.get("timing_json"), {}), "error": error,
        "created_at": iso_ms(row["created_at"]) if row.get("created_at") else None,
        "started_at": iso_ms(row["started_at"]) if row.get("started_at") else None,
        "finished_at": iso_ms(row["finished_at"]) if row.get("finished_at") else None,
        "interrupted": status == "INTERRUPTED",
    }
    return _job_public(job, with_items=with_items)


async def load_job(session: AsyncSession, tenant_id: UUID, job_id: str, *, with_items: bool = True) -> dict[str, Any] | None:
    """In-memory job of this process, else the stored one (survives an API restart)."""
    live = get_job(tenant_id, job_id, with_items=with_items)
    if live is not None:
        return live
    try:
        jid = UUID(str(job_id))
    except ValueError:
        return None
    try:
        row = await fetch_one(
            session,
            "SELECT id, tenant_id, status, total, done, summary_json, items_json, timing_json, error, created_at, "
            "started_at, finished_at FROM storage_bulk_jobs WHERE id = :id AND tenant_id = :tenant_id",
            {"id": jid, "tenant_id": tenant_id},
        )
    except Exception:  # noqa: BLE001 - table missing before migration 0014: same answer as before (404)
        return None
    return _job_from_row(dict(row), with_items=with_items) if row else None


async def load_jobs(session: AsyncSession, tenant_id: UUID, *, limit: int = 20) -> list[dict[str, Any]]:
    """Recent jobs: this process's live ones plus stored ones (newest first, no per-row items)."""
    live = {j["job_id"]: j for j in list_jobs(tenant_id)}
    try:
        rows = await fetch_all(
            session,
            "SELECT id, tenant_id, status, total, done, summary_json, '[]'::jsonb AS items_json, timing_json, error, "
            "created_at, started_at, finished_at FROM storage_bulk_jobs WHERE tenant_id = :tenant_id "
            "ORDER BY created_at DESC LIMIT :limit",
            {"tenant_id": tenant_id, "limit": int(limit)},
        )
    except Exception:  # noqa: BLE001 - before migration 0014
        rows = []
    stored = [_job_from_row(dict(r), with_items=False) for r in rows if str(r["id"]) not in live]
    return sorted([*live.values(), *stored], key=lambda j: j.get("created_at") or "", reverse=True)


def get_job(tenant_id: UUID, job_id: str, *, with_items: bool = True) -> dict[str, Any] | None:
    job = _JOBS.get(str(job_id))
    if job is None or job["tenant_id"] != str(tenant_id):
        return None
    return _job_public(job, with_items=with_items)


def list_jobs(tenant_id: UUID) -> list[dict[str, Any]]:
    _prune_jobs()
    return [_job_public(j, with_items=False) for j in sorted(_JOBS.values(), key=lambda j: j["created_at"], reverse=True)
            if j["tenant_id"] == str(tenant_id)]
