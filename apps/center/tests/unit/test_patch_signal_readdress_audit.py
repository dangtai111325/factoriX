"""B-16 (ARCH-B B-01): ``patch_signal`` kept the new source field id of a re-address unused. Intent: the field id
is the provenance key observations carry, so the address-change audit records it (before -> after)."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest

from factorix.application.collector import signals as SIG
from factorix.application.collector.schemas import SignalPatch
from factorix.domain.source_address import AddressCheck

TENANT, ACTOR, SIGNAL = uuid4(), uuid4(), uuid4()
OLD_FIELD, NEW_FIELD = uuid4(), uuid4()


@pytest.fixture()
def patched(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    seen: dict[str, list[Any]] = {"audits": [], "readdress": [], "notify": []}
    source = {"source_field_id": OLD_FIELD, "binding_id": uuid4(), "acquisition_job_id": uuid4(), "address_kind": "modbus",
              "address_json": {"register": 10}, "native_datatype": "uint16", "edge_id": None, "connection_id": uuid4(),
              "protocol": "modbus_tcp", "enabled": True}
    current = {"id": SIGNAL, "version": 3, "status": "ACTIVE", "display_name": "Temp", "description": "", "unit": "C",
               "expected_interval_ms": 1000}

    async def _signal(_s: Any, _t: UUID, _sid: UUID) -> dict[str, Any]:
        return dict(current)

    async def _current_sources(_s: Any, _t: UUID, _ids: list[UUID]) -> dict[UUID, dict[str, Any]]:
        return {SIGNAL: dict(source)}

    async def execute_rowcount(_s: Any, _sql: str, _p: dict[str, Any]) -> int:
        return 1

    async def _readdress(_s: Any, sid: UUID, src: dict[str, Any], check: AddressCheck) -> UUID:
        seen["readdress"].append((sid, check.address))
        return NEW_FIELD

    async def audit(_s: Any, **kw: Any) -> None:
        seen["audits"].append(kw)

    async def notify(_s: Any, tid: UUID) -> None:
        seen["notify"].append(tid)

    monkeypatch.setattr(SIG, "_signal", _signal)
    monkeypatch.setattr(SIG, "_current_sources", _current_sources)
    monkeypatch.setattr(SIG, "execute_rowcount", execute_rowcount)
    monkeypatch.setattr(SIG, "_readdress", _readdress)
    monkeypatch.setattr(SIG, "audit", audit)
    monkeypatch.setattr(SIG, "_notify_config_changed", notify)
    monkeypatch.setattr(SIG, "check_address_change", lambda _sig, _src, patch: AddressCheck(address={"register": patch["register"]}))
    return seen


async def test_readdress_audit_records_old_and_new_source_field(patched: dict[str, list[Any]]) -> None:
    out = await SIG.patch_signal(object(), TENANT, ACTOR, SIGNAL, SignalPatch(version=3, address_patch={"register": 20}), "corr")
    assert patched["readdress"] == [(SIGNAL, {"register": 20})]
    (addr_audit,) = [a for a in patched["audits"] if a["event_type"] == "SIGNAL_ADDRESS_UPDATE"]
    assert addr_audit["before"] == {"address": {"register": 10}, "source_field_id": str(OLD_FIELD)}
    assert addr_audit["after"] == {"address": {"register": 20}, "source_field_id": str(NEW_FIELD)}
    assert patched["notify"] == [TENANT]  # local acquisition reloads (no edge to release)
    assert out["source"]["source_field_id"] == str(OLD_FIELD)  # response = the re-read source (fake returns the old one)


async def test_metadata_only_patch_writes_no_address_audit(patched: dict[str, list[Any]]) -> None:
    await SIG.patch_signal(object(), TENANT, ACTOR, SIGNAL, SignalPatch(version=3, display_name="Temperature"), "corr")
    assert [a["event_type"] for a in patched["audits"]] == ["SIGNAL_UPDATE"]
    assert patched["readdress"] == [] and patched["notify"] == []
