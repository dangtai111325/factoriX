"""B-02 / OP-03 (R2-07): the "N with write errors" KPI, the failures list and the Objects-table filter "Error"
name the same subtables (those with FAILED writer-outbox rows)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest

from factorix.modules import storage_topology as ST

TENANT = UUID("00000000-0000-0000-0000-000000000001")
DB = f"fx_t_{TENANT.hex}"


async def test_recording_error_subtables_query_is_failed_only_and_skips_purged_objects() -> None:
    seen: list[tuple[str, dict[str, Any]]] = []

    async def fake_fetch_all(_session: Any, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        seen.append((sql, params))
        return [{"physical_db": DB, "physical_subtable": "cond_aa10_01"}]

    with patch("factorix.modules.common.fetch_all", fake_fetch_all):
        out = await ST.recording_error_subtables(object(), TENANT, limit=7)

    assert out == [(DB, "cond_aa10_01")]
    sql, params = seen[0]
    assert "x.status = 'FAILED'" in sql
    assert "o.status <> 'PURGED'" in sql
    assert params == {"tenant_id": TENANT, "limit": 7}


async def test_catalog_status_error_lists_subtables_with_failed_writes() -> None:
    names = ["cond_aa10_01", "cond_aa10_02", "cond_aa10_03"]
    td_client = MagicMock(query_rows=AsyncMock(return_value=[{"table_name": n, "stable_name": "st_cond"} for n in names]))
    inspector = ST.StorageTopologyInspector(td_client)
    db = ST.DatabaseInfo(DB, "ms", 1, None, "30d", 1, 3, None, True)
    registry = [{"object_type": "subtable", "physical_db": DB, "physical_name": n, "status": "ACTIVE"} for n in names]

    async def fake_fetch_all(_session: Any, sql: str, _params: dict[str, Any]) -> list[dict[str, Any]]:
        if "storage_record_outbox" in sql:
            return [{"physical_db": DB, "physical_subtable": "cond_aa10_02"}]
        return registry

    with (
        patch.object(inspector, "list_databases", AsyncMock(return_value=[db])),
        patch.object(inspector, "_load_storage_labels", AsyncMock(return_value={})),
        patch("factorix.modules.common.fetch_all", fake_fetch_all),
    ):
        rows, total = await inspector.list_catalog(
            TENANT, object(), object_type=None, status="ERROR", search="", page=1, page_size=25,
        )
        all_rows, all_total = await inspector.list_catalog(
            TENANT, object(), object_type="subtable", status=None, search="", page=1, page_size=25,
        )

    assert total == 1
    assert rows[0]["id"] == f"subtable:{DB}.cond_aa10_02"
    assert rows[0]["recording_error"] is True
    # The object state itself is untouched (ACTIVE subtable that failed to write).
    assert rows[0]["status"] == "ACTIVE"
    assert all_total == 3
    assert not any(r.get("recording_error") for r in all_rows)


@pytest.mark.parametrize("status", ["PAUSED", "RETIRED"])
async def test_catalog_filters_by_paused_and_retired_states(status: str) -> None:
    td_client = MagicMock(query_rows=AsyncMock(return_value=[
        {"table_name": "a", "stable_name": "st"}, {"table_name": "b", "stable_name": "st"},
    ]))
    inspector = ST.StorageTopologyInspector(td_client)
    db = ST.DatabaseInfo(DB, "ms", 1, None, "30d", 1, 2, None, True)
    registry = [
        {"object_type": "subtable", "physical_db": DB, "physical_name": "a", "status": status},
        {"object_type": "subtable", "physical_db": DB, "physical_name": "b", "status": "ACTIVE"},
    ]
    with (
        patch.object(inspector, "list_databases", AsyncMock(return_value=[db])),
        patch.object(inspector, "_load_storage_labels", AsyncMock(return_value={})),
        patch("factorix.modules.common.fetch_all", AsyncMock(return_value=registry)),
    ):
        rows, total = await inspector.list_catalog(
            TENANT, object(), object_type="subtable", status=status, search="", page=1, page_size=25,
        )
    assert total == 1 and rows[0]["physical_name"] == "a"
