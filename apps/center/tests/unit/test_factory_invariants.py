"""Unit tests for factory model invariants: cross-site move guards, archive/restore state preservation, and graph queries."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch, MagicMock
from uuid import uuid4
import pytest

from factorix.platform.errors import AppError
from factorix.modules.resources import move_resource, archive_resource, restore_resource, MoveIn


@pytest.mark.asyncio
async def test_cross_site_move_with_active_bindings_raises_409() -> None:
    """FACT-33: Moving resource across sites with active bindings raises 409 CROSS_SITE_BINDINGS."""
    session = AsyncMock()
    tenant_id = uuid4()
    actor_id = uuid4()
    resource_id = uuid4()
    parent_id = uuid4()
    site_a = uuid4()
    site_b = uuid4()

    # Current resource under site_a
    mock_resource = {
        "id": resource_id,
        "tenant_id": tenant_id,
        "code": "M01",
        "name": "Machine 01",
        "parent_id": None,
        "path_code": "SITE-A/M01",
        "site_id": site_a,
        "status": "ACTIVE",
        "version": 1,
        "type": "machine",
        "type_key": "machine",
    }

    # Target parent under site_b
    mock_parent = {
        "id": parent_id,
        "tenant_id": tenant_id,
        "code": "LINE-B",
        "name": "Line B",
        "site_id": site_b,
        "path_code": "SITE-B/LINE-B",
        "status": "ACTIVE",
        "version": 1,
        "type": "line",
        "type_key": "line",
    }

    # Simulate active bindings query returning 1 active binding
    active_binding = {
        "id": uuid4(),
        "signal_id": uuid4(),
        "key": "temperature",
        "connection_id": uuid4(),
        "connection_name": "mqtt-conn-1",
    }

    body = MoveIn(version=1, parent_id=str(parent_id))

    with patch("factorix.modules.resources._resource", AsyncMock(side_effect=[mock_resource, mock_parent])), \
         patch("factorix.modules.resources.fetch_one", AsyncMock(side_effect=[
             {"hierarchy_mode": "guided"},  # tenant hierarchy_mode
             None,  # duplicate code check
         ])), \
         patch("factorix.modules.resources.fetch_all", AsyncMock(side_effect=[
             [active_binding],  # active bindings query
         ])):

        with pytest.raises(AppError) as exc_info:
            await move_resource(session, tenant_id, actor_id, resource_id, body, "test-corr")

        assert exc_info.value.status == 409
        assert exc_info.value.code == "CROSS_SITE_BINDINGS"
        assert "active signal binding(s) exist" in exc_info.value.message


@pytest.mark.asyncio
async def test_archive_resource_stores_prior_archive_state() -> None:
    """FACT-14, FACT-15: Archive stores prior enabled bindings in properties_json."""
    session = AsyncMock()
    tenant_id = uuid4()
    actor_id = uuid4()
    resource_id = uuid4()

    mock_resource = {
        "id": resource_id,
        "tenant_id": tenant_id,
        "status": "ACTIVE",
        "properties_json": {},
    }

    sig_1 = uuid4()
    sig_2 = uuid4()

    # sig_1 is enabled, sig_2 is disabled
    sig_rows = [
        {"id": sig_1, "enabled": True},
        {"id": sig_2, "enabled": False},
    ]

    with patch("factorix.modules.resources._resource", AsyncMock(return_value=mock_resource)), \
         patch("factorix.modules.resources.fetch_one", AsyncMock(return_value={"count": 0})), \
         patch("factorix.modules.resources.fetch_all", AsyncMock(return_value=sig_rows)), \
         patch("factorix.modules.resources.execute", AsyncMock()) as mock_exec, \
         patch("factorix.modules.resources.audit", AsyncMock()), \
         patch("factorix.modules.resources.get_resource", AsyncMock(return_value={"id": str(resource_id), "status": "ARCHIVED"})), \
         patch("factorix.modules.collect.bump_edge_release", AsyncMock()):

        res = await archive_resource(session, tenant_id, actor_id, resource_id, "corr-1")
        assert res["status"] == "ARCHIVED"
        assert res["affected_signals"] == 2

        # Verify UPDATE resources was called with properties_json containing _prior_archive_state
        update_calls = [call for call in mock_exec.call_args_list if "UPDATE resources SET status = 'ARCHIVED'" in str(call)]
        assert len(update_calls) == 1
        props_arg = update_calls[0][0][2]["props"]
        props_dict = json.loads(props_arg) if isinstance(props_arg, str) else props_arg
        prior_state = props_dict["_prior_archive_state"]
        assert str(sig_1) in prior_state["enabled_bindings"]
        assert str(sig_2) not in prior_state["enabled_bindings"]


@pytest.mark.asyncio
async def test_restore_resource_restores_only_previously_enabled_bindings() -> None:
    """FACT-15: Restore only re-enables bindings that were enabled before archive."""
    session = AsyncMock()
    tenant_id = uuid4()
    actor_id = uuid4()
    resource_id = uuid4()
    sig_enabled = uuid4()
    sig_disabled = uuid4()

    mock_archived_resource = {
        "id": resource_id,
        "tenant_id": tenant_id,
        "code": "M01",
        "name": "Machine 01",
        "parent_id": None,
        "status": "ARCHIVED",
        "archived_at": "2026-11-05T00:00:00Z",
        "properties_json": {
            "_prior_archive_state": {
                "active_signals": [str(sig_enabled), str(sig_disabled)],
                "enabled_bindings": [str(sig_enabled)],  # only sig_enabled was enabled
            }
        },
    }

    with patch("factorix.modules.resources._resource", AsyncMock(return_value=mock_archived_resource)), \
         patch("factorix.modules.resources.fetch_one", AsyncMock(return_value=None)), \
         patch("factorix.modules.resources.fetch_all", AsyncMock(return_value=[{"id": sig_enabled, "key_taken": False}, {"id": sig_disabled, "key_taken": False}])), \
         patch("factorix.modules.resources.execute", AsyncMock()) as mock_exec, \
         patch("factorix.modules.resources.audit", AsyncMock()), \
         patch("factorix.modules.resources.get_resource", AsyncMock(return_value={"id": str(resource_id), "status": "ACTIVE"})), \
         patch("factorix.modules.collect.bump_edge_release", AsyncMock()):

        res = await restore_resource(session, tenant_id, actor_id, resource_id, "corr-2")
        assert res["status"] == "ACTIVE"

        # Check bindings update call
        binding_calls = [call for call in mock_exec.call_args_list if "UPDATE signal_bindings SET enabled = TRUE" in str(call)]
        assert len(binding_calls) == 1
        ids_arg = binding_calls[0][0][2]["ids"]
        assert ids_arg == [sig_enabled], f"Expected only sig_enabled to be re-enabled, got: {ids_arg}"
