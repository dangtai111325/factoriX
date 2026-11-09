"""Data Model v2: custom body builder (spec_json), sampling engine state, snapshots, reference index.

Upgrade converts every existing model (output group + members) into a v2 body spec so no user data
is lost (rules of datamodel_v2_spec.md §4):

* signal members    -> mapping fields
* context members   -> calculated string constants holding the resolved names
* constant members  -> calculated literals
* system source_timestamp  -> ``latest_ts(<all contributing signal refs>)``
* system publish_timestamp -> ``now()``
* snapshot members  -> ``value_at(ref, ts(<first trigger ref>))``
* PUBLISHED -> state RUNNING, DRAFT -> PAUSED (both status ACTIVE); ARCHIVED stays ARCHIVED.

The member rows are left in place (unused by v2). Downgrade rebuilds members from the v2 spec
(best effort: top-level fields only; nested fields are flattened when their key is a valid alias)
and restores the 0006 schema. The conversion helpers are pure and unit-tested.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "0007_data_model_v2"
down_revision = "0006_data_model_v2"
branch_labels = None
depends_on = None

MIN_SAMPLE_MS = 200
MAX_SAMPLE_MS = 3_600_000
DEFAULT_SAMPLE_MS = 1000
_BARE_KEY = re.compile(r"^[A-Za-z0-9_]+$")
_ALIAS = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_TOKEN = re.compile(r"\{\{sig:([0-9a-fA-F-]{36})\}\}")
_CONTEXT_LEVELS = ("enterprise", "site", "plant", "area", "zone", "workshop", "line", "cell", "machine")


# ---- pure helpers (tested in apps/center/tests/unit/test_dm2_migration.py) -------------------


def _escape(name: str) -> str:
    return name.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _key_text(key: str) -> str:
    return key if _BARE_KEY.match(key) else "`" + key.replace("\\", "\\\\").replace("`", "\\`") + "`"


def signal_label(signal: Mapping[str, Any]) -> str:
    return f"${signal.get('type_key') or 'resource'}[{_escape(str(signal.get('resource_name') or ''))}].{_key_text(str(signal.get('key') or ''))}"


def resolve_context(chain: Sequence[Mapping[str, Any]], ref: str) -> Any:
    """Value of a v1 context ref (``zone.name``, ``self.code`` ...) from a breadcrumb (self first)."""
    level, _, attr = str(ref).partition(".")
    if attr not in ("name", "code") or not chain:
        return None
    if level == "self":
        return chain[0].get(attr)
    for item in chain:
        if item.get("type_key") == level:
            return item.get(attr)
    return None


def literal(value: Any) -> tuple[str, str]:
    """(rule expression, value_type) for a JSON constant."""
    if value is None:
        return "null", "auto"
    if isinstance(value, bool):
        return ("true" if value else "false"), "bool"
    if isinstance(value, (int, float)):
        return json.dumps(value), "auto"
    if isinstance(value, str):
        return json.dumps(value), "string"
    return json.dumps(json.dumps(value, separators=(",", ":"))), "json"


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def sample_ms_of(emit_policy: Any) -> int:
    policy = _json(emit_policy)
    raw = policy.get("republish_ms") if isinstance(policy, dict) else None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
        return int(min(max(raw, MIN_SAMPLE_MS), MAX_SAMPLE_MS))
    return DEFAULT_SAMPLE_MS


def spec_from_members(members: Sequence[Mapping[str, Any]], signals: Mapping[str, Mapping[str, Any]], chain: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """v2 spec of a v1 model. ``members`` ordered by ordinal; ``signals`` by id: key, resource_name, type_key."""
    def tok(signal_id: Any) -> str:
        return "{{sig:" + str(signal_id).lower() + "}}"

    contributing: list[str] = []
    triggers: list[str] = []
    for m in members:
        kind = str(m.get("member_kind") or "SIGNAL").upper()
        sid = m.get("signal_id")
        if kind == "SIGNAL" and sid:
            if m.get("contributes_ts", True) and str(sid).lower() not in contributing:
                contributing.append(str(sid).lower())
            if m.get("is_trigger") and str(sid).lower() not in triggers:
                triggers.append(str(sid).lower())
    children: list[dict[str, Any]] = []
    labels: dict[str, str] = {}
    for m in members:
        kind = str(m.get("member_kind") or "SIGNAL").upper()
        key = str(m.get("output_alias"))
        sid = str(m["signal_id"]).lower() if m.get("signal_id") else None
        if sid and sid in signals:
            labels[f"sig:{sid}"] = signal_label(signals[sid])
        if kind == "SIGNAL" and sid:
            children.append({"key": key, "type": "field", "mode": "mapping", "ref": {"signal_id": sid}, "value_type": "auto"})
        elif kind == "SNAPSHOT" and sid:
            if triggers:
                expr = f"value_at({tok(sid)}, ts({tok(triggers[0])}))"
                children.append({"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": "auto"})
            else:
                children.append({"key": key, "type": "field", "mode": "mapping", "ref": {"signal_id": sid}, "value_type": "auto"})
        elif kind == "CONTEXT":
            value = resolve_context(chain, str(m.get("context_ref") or ""))
            expr = json.dumps(str(value)) if value is not None else "null"
            children.append({"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": "string"})
        elif kind == "CONSTANT":
            constant = _json(m.get("constant_json"))
            expr, value_type = literal(constant.get("v") if isinstance(constant, dict) else None)
            children.append({"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": value_type})
        elif kind == "SYSTEM" and m.get("system_field") == "publish_timestamp":
            children.append({"key": key, "type": "field", "mode": "calculated", "expr": "now()", "value_type": "timestamp"})
        elif kind == "SYSTEM":
            expr = f"latest_ts({', '.join(tok(s) for s in contributing)})" if contributing else "null"
            children.append({"key": key, "type": "field", "mode": "calculated", "expr": expr, "value_type": "timestamp"})
    return {"version": 2, "root": {"type": "object", "children": children}, "labels": labels}


def spec_signal_ids(spec: Mapping[str, Any]) -> list[str]:
    out: list[str] = []
    stack = list((spec.get("root") or {}).get("children") or [])
    while stack:
        node = stack.pop(0)
        if node.get("type") in ("object", "array"):
            stack[0:0] = list(node.get("children") or [])
            continue
        if node.get("mode") == "mapping":
            sid = (node.get("ref") or {}).get("signal_id")
            ids = [str(sid).lower()] if sid else []
        else:
            ids = [m.lower() for m in _TOKEN.findall(str(node.get("expr") or ""))]
        out.extend(i for i in ids if i not in out)
    return out


def members_from_spec(spec: Mapping[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """(model kind, v1 member rows) of a v2 spec, for the downgrade. Best effort."""
    members: list[dict[str, Any]] = []
    triggers: set[str] = set()
    seen: set[str] = set()

    def walk(nodes: list[dict[str, Any]], prefix: str) -> None:
        for node in nodes:
            key = f"{prefix}{node.get('key', '')}" if node.get("key") is not None else ""
            if node.get("type") == "object":
                walk(list(node.get("children") or []), f"{key}_" if key else prefix)
                continue
            if node.get("type") != "field" or not _ALIAS.match(key) or key in seen:
                continue
            seen.add(key)
            base = {"output_alias": key, "signal_id": None, "member_kind": None, "context_ref": None, "constant_json": None, "system_field": None, "contributes_ts": False, "is_trigger": False}
            if node.get("mode") == "mapping":
                sid = (node.get("ref") or {}).get("signal_id")
                if sid:
                    members.append({**base, "member_kind": "SIGNAL", "signal_id": str(sid).lower(), "contributes_ts": True})
                continue
            expr = str(node.get("expr") or "").strip()
            if expr == "now()":
                members.append({**base, "member_kind": "SYSTEM", "system_field": "publish_timestamp"})
            elif expr.startswith("latest_ts("):
                members.append({**base, "member_kind": "SYSTEM", "system_field": "source_timestamp"})
            elif expr.startswith("value_at("):
                ids = [m.lower() for m in _TOKEN.findall(expr)]
                if ids:
                    members.append({**base, "member_kind": "SNAPSHOT", "signal_id": ids[0]})
                    triggers.update(ids[1:])
            else:
                try:
                    value = json.loads(expr)  # string / number / true / false / null literals
                except ValueError:
                    continue
                members.append({**base, "member_kind": "CONSTANT", "constant_json": json.dumps({"v": value})})

    walk(list((spec.get("root") or {}).get("children") or []), "")
    for member in members:
        if member["member_kind"] == "SIGNAL" and member["signal_id"] in triggers:
            member["is_trigger"] = True
    kind = "EVENT" if any(m["member_kind"] == "SNAPSHOT" for m in members) and any(m["is_trigger"] for m in members) else "STATE"
    return kind, members


def unique_names(rows: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """New display name per model id so active names are unique per tenant (case-insensitive)."""
    taken: dict[str, set[str]] = {}
    out: dict[str, str] = {}
    for row in sorted(rows, key=lambda r: (str(r["tenant_id"]), str(r.get("display_name") or ""), str(r["id"]))):
        names = taken.setdefault(str(row["tenant_id"]), set())
        base = (str(row.get("display_name") or "").strip() or "Model")[:200]
        name, n = base, 2
        while name.lower() in names:
            name = f"{base} ({n})"
            n += 1
        names.add(name.lower())
        out[str(row["id"])] = name
    return out


# ---- migration ---------------------------------------------------------------------------------


def _chains(conn: Any) -> dict[str, list[dict[str, Any]]]:
    resources = conn.execute(
        sa.text("SELECT r.id, r.parent_id, r.name, r.code, t.key AS type_key FROM resources r JOIN resource_types t ON t.id = r.type_id")
    ).mappings().all()
    parents: dict[str, str] = {str(r["id"]): str(r["parent_id"]) for r in resources if r["parent_id"]}
    relations = conn.execute(
        sa.text(
            """
            SELECT rr.from_id, rr.to_id FROM resource_relations rr
            JOIN relation_types rt ON rt.id = rr.relation_type_id AND rt.code = 'CONTAINS'
            WHERE rr.valid_to IS NULL
            """
        )
    ).mappings().all()
    for rel in relations:  # the v1 engine resolved context through CONTAINS relations
        parents[str(rel["to_id"])] = str(rel["from_id"])
    by_id = {str(r["id"]): dict(r) for r in resources}
    chains: dict[str, list[dict[str, Any]]] = {}
    for rid in by_id:
        chain, seen, current = [], set(), rid
        while current in by_id and current not in seen and len(chain) < 32:
            seen.add(current)
            chain.append(by_id[current])
            current = parents.get(current, "")
        chains[rid] = chain
    return chains


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE output_groups
            ADD COLUMN IF NOT EXISTS spec_json JSONB,
            ADD COLUMN IF NOT EXISTS sample_ms INTEGER NOT NULL DEFAULT 1000,
            ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'RUNNING',
            ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''
        """
    )
    op.execute("ALTER TABLE output_groups ALTER COLUMN resource_id DROP NOT NULL")
    op.execute("ALTER TABLE output_groups ALTER COLUMN topic_template SET DEFAULT ''")
    op.execute("ALTER TABLE output_groups ALTER COLUMN projection_policy_json SET DEFAULT '{}'::jsonb")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_status")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_groups_state")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_groups_sample_ms")

    op.execute("DROP TABLE IF EXISTS model_state")
    op.execute(
        """
        CREATE TABLE model_state (
            group_id UUID PRIMARY KEY REFERENCES output_groups (id) ON DELETE CASCADE,
            tenant_id UUID NOT NULL,
            body_text TEXT NOT NULL,
            sampled_at TIMESTAMPTZ NOT NULL,
            errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            error_count INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS model_snapshots (
            id BIGSERIAL PRIMARY KEY,
            group_id UUID NOT NULL REFERENCES output_groups (id) ON DELETE CASCADE,
            tenant_id UUID NOT NULL,
            sampled_at TIMESTAMPTZ NOT NULL,
            body_text TEXT NOT NULL,
            errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
            error_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS model_snapshots_recent ON model_snapshots (group_id, id DESC)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS model_refs (
            model_id UUID NOT NULL REFERENCES output_groups (id) ON DELETE CASCADE,
            tenant_id UUID NOT NULL,
            ref_kind TEXT NOT NULL,
            ref_id UUID NOT NULL,
            PRIMARY KEY (model_id, ref_kind, ref_id),
            CONSTRAINT model_refs_kind CHECK (ref_kind IN ('signal', 'resource'))
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS model_refs_target ON model_refs (tenant_id, ref_kind, ref_id)")

    # ---- convert v1 models ------------------------------------------------------------------
    conn = op.get_bind()
    groups = conn.execute(
        sa.text("SELECT id, tenant_id, resource_id, display_name, status, emit_policy_json FROM output_groups ORDER BY id")
    ).mappings().all()
    if groups:
        members = conn.execute(
            sa.text(
                """
                SELECT output_group_id, member_kind, output_alias, signal_id, context_ref, constant_json, system_field,
                       contributes_ts, is_trigger, ordinal
                FROM output_group_members ORDER BY output_group_id, ordinal
                """
            )
        ).mappings().all()
        signals = {
            str(row["id"]).lower(): dict(row)
            for row in conn.execute(
                sa.text(
                    """
                    SELECT s.id, s.key, r.name AS resource_name, t.key AS type_key
                    FROM signal_definitions s JOIN resources r ON r.id = s.resource_id JOIN resource_types t ON t.id = r.type_id
                    """
                )
            ).mappings().all()
        }
        chains = _chains(conn)
        by_group: dict[str, list[dict[str, Any]]] = {}
        for row in members:
            by_group.setdefault(str(row["output_group_id"]), []).append(dict(row))
        names = unique_names([g for g in groups if g["status"] != "ARCHIVED"])
        for group in groups:
            gid = str(group["id"])
            spec = spec_from_members(by_group.get(gid, []), signals, chains.get(str(group["resource_id"]), []))
            archived = group["status"] == "ARCHIVED"
            conn.execute(
                sa.text(
                    """
                    UPDATE output_groups
                    SET spec_json = CAST(:spec AS jsonb), sample_ms = :sample_ms, state = :state, status = :status,
                        display_name = :name, kind = 'STATE'
                    WHERE id = :id
                    """
                ),
                {
                    "spec": json.dumps(spec),
                    "sample_ms": sample_ms_of(group["emit_policy_json"]),
                    "state": "RUNNING" if group["status"] == "PUBLISHED" else "PAUSED",
                    "status": "ARCHIVED" if archived else "ACTIVE",
                    "name": names.get(gid, group["display_name"]),
                    "id": group["id"],
                },
            )
            for sid in spec_signal_ids(spec):
                conn.execute(
                    sa.text(
                        "INSERT INTO model_refs (model_id, tenant_id, ref_kind, ref_id) VALUES (:m, :t, 'signal', :r) ON CONFLICT DO NOTHING"
                    ),
                    {"m": group["id"], "t": group["tenant_id"], "r": uuid.UUID(sid)},
                )
    op.execute("UPDATE output_groups SET spec_json = '{\"version\": 2, \"root\": {\"type\": \"object\", \"children\": []}, \"labels\": {}}'::jsonb WHERE spec_json IS NULL")
    op.execute("ALTER TABLE output_groups ADD CONSTRAINT output_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))")
    op.execute("ALTER TABLE output_groups ADD CONSTRAINT output_groups_state CHECK (state IN ('RUNNING', 'PAUSED'))")
    op.execute("ALTER TABLE output_groups ADD CONSTRAINT output_groups_sample_ms CHECK (sample_ms BETWEEN 200 AND 3600000)")
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS output_groups_name_active
        ON output_groups (tenant_id, lower(display_name)) WHERE status <> 'ARCHIVED'
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS output_groups_engine ON output_groups (status, state)")


def downgrade() -> None:
    conn = op.get_bind()
    op.execute("DROP INDEX IF EXISTS output_groups_engine")
    op.execute("DROP INDEX IF EXISTS output_groups_name_active")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_groups_sample_ms")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_groups_state")
    op.execute("ALTER TABLE output_groups DROP CONSTRAINT IF EXISTS output_status")

    rows = conn.execute(sa.text("SELECT id, tenant_id, resource_id, status, state, spec_json FROM output_groups ORDER BY id")).mappings().all()
    signal_resource = {
        str(r["id"]).lower(): r["resource_id"]
        for r in conn.execute(sa.text("SELECT id, resource_id FROM signal_definitions")).mappings().all()
    }
    doomed: list[Any] = []
    for row in rows:
        spec = _json(row["spec_json"]) or {}
        kind, members = members_from_spec(spec if isinstance(spec, dict) else {})
        resource_id = row["resource_id"]
        if resource_id is None:
            resource_id = next((signal_resource[s] for s in spec_signal_ids(spec) if s in signal_resource), None)
        if resource_id is None:
            doomed.append(row["id"])  # v2-only model without any data point: cannot exist in v1
            continue
        status = "ARCHIVED" if row["status"] == "ARCHIVED" else ("PUBLISHED" if row["state"] == "RUNNING" else "DRAFT")
        conn.execute(
            sa.text("UPDATE output_groups SET resource_id = :r, status = :s, kind = :k WHERE id = :id"),
            {"r": resource_id, "s": status, "k": kind, "id": row["id"]},
        )
        conn.execute(sa.text("DELETE FROM output_group_members WHERE output_group_id = :id"), {"id": row["id"]})
        for ordinal, m in enumerate(m for m in members if m["member_kind"] != "SIGNAL" or m["signal_id"] in signal_resource):
            conn.execute(
                sa.text(
                    """
                    INSERT INTO output_group_members (
                        output_group_id, signal_id, output_alias, ordinal, member_kind, signal_key, context_ref,
                        constant_json, system_field, contributes_ts, is_trigger
                    ) VALUES (:g, :sid, :alias, :ordinal, :kind, NULL, :ctx, CAST(:const AS jsonb), :sys, :cts, :trig)
                    """
                ),
                {
                    "g": row["id"],
                    "sid": uuid.UUID(m["signal_id"]) if m["signal_id"] else None,
                    "alias": m["output_alias"],
                    "ordinal": ordinal,
                    "kind": m["member_kind"],
                    "ctx": m["context_ref"],
                    "const": m["constant_json"],
                    "sys": m["system_field"],
                    "cts": m["contributes_ts"],
                    "trig": m["is_trigger"],
                },
            )
    if doomed:
        for table, column in (("output_deliveries", "group_id"), ("model_events", "group_id"), ("output_group_members", "output_group_id")):
            conn.execute(sa.text(f"DELETE FROM {table} WHERE {column} = ANY(:ids)"), {"ids": doomed})
        conn.execute(sa.text("DELETE FROM output_groups WHERE id = ANY(:ids)"), {"ids": doomed})
    op.execute(
        """
        UPDATE output_group_members m SET signal_key = s.key
        FROM signal_definitions s WHERE s.id = m.signal_id AND m.signal_key IS NULL
        """
    )

    op.execute("DROP TABLE IF EXISTS model_refs")
    op.execute("DROP TABLE IF EXISTS model_snapshots")
    op.execute("DROP TABLE IF EXISTS model_state")
    op.execute(
        """
        CREATE TABLE model_state (
            group_id UUID PRIMARY KEY REFERENCES output_groups (id) ON DELETE CASCADE,
            tenant_id UUID NOT NULL REFERENCES tenants (id),
            body_text TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            source_ts TIMESTAMPTZ,
            last_publish_ts TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute("ALTER TABLE output_groups ADD CONSTRAINT output_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))")
    op.execute("ALTER TABLE output_groups ALTER COLUMN resource_id SET NOT NULL")
    op.execute("ALTER TABLE output_groups ALTER COLUMN topic_template DROP DEFAULT")
    op.execute("ALTER TABLE output_groups ALTER COLUMN projection_policy_json DROP DEFAULT")
    op.execute(
        """
        ALTER TABLE output_groups
            DROP COLUMN IF EXISTS spec_json,
            DROP COLUMN IF EXISTS sample_ms,
            DROP COLUMN IF EXISTS state,
            DROP COLUMN IF EXISTS description
        """
    )
