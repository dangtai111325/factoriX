"""HTTP connection test: authentication is proven on a real data path (R2-CN-01) and the
overall result always agrees with the stages (R2-CN-03)."""

from __future__ import annotations

from typing import Any

import pytest

import factorix_edge.commissioning as commissioning
from factorix_edge.commissioning import Commissioner, Stages, overall_status
from factorix_edge.connectors.errors import ConnectorError
from factorix_edge.runtime import endpoints_for

GOOD_KEY = "right-key"


class FakeHttp:
    """Source that requires X-API-Key on /api/* and serves a public non-JSON root page."""

    calls: list[tuple[str, dict[str, str]]] = []

    def __init__(self, base_url: str, allow: Any, timeout_s: float = 5.0, **_: Any) -> None:
        self.base_url = base_url

    async def get_json(self, path: str, headers: dict[str, str] | None = None, *, max_wait_s: float | None = None) -> Any:
        headers = headers or {}
        FakeHttp.calls.append((path, headers))
        if path in {"", "/"}:
            raise ConnectorError("DECODE", "HTTP response is not JSON.")
        if path.startswith("/api/"):
            if headers.get("X-API-Key") != GOOD_KEY:
                raise ConnectorError("AUTH", "HTTP authentication failed (status 401).")
            return {"employee": "E1", "program_no": 7}
        raise ConnectorError("PROTOCOL", "HTTP returned status code 404.")

    async def close(self) -> None:
        return None


class Reports:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        self.items[path.rsplit("/", 1)[-1]] = body or {}
        return {}


def _commissioner(key: str) -> tuple[Commissioner, Reports]:
    async def secret(ref: str) -> str:
        return key

    reports = Reports()
    return Commissioner(reports.request, lambda p, c: endpoints_for(p, c), secret), reports


CONFIG = {"base_url": "http://127.0.0.1:8443", "auth": "api_key", "header_name": "X-API-Key"}


async def _run(monkeypatch: pytest.MonkeyPatch, job: dict[str, Any], key: str = GOOD_KEY) -> dict[str, Any]:
    monkeypatch.setattr(commissioning, "HttpPullConnector", FakeHttp)
    FakeHttp.calls = []
    commissioner, reports = _commissioner(key)
    await commissioner.run({"id": "j", "protocol": "http", "secret_ref": "s1", "config_json": CONFIG, **job})
    return reports.items["j"]


def _stage(report: dict[str, Any], name: str) -> dict[str, Any]:
    return next(item for item in report["stages"] if item["stage"] == name)


@pytest.mark.asyncio
async def test_wrong_key_fails_auth_on_the_field_path(monkeypatch: pytest.MonkeyPatch) -> None:
    fields = [{"key": "employee", "address": {"method": "GET", "path": "/api/v1/machines/M1/operator", "jsonpath": "$.employee"}}]
    report = await _run(monkeypatch, {"mode": "CONNECTIVITY", "fields": fields}, key="wrong_key_123")
    assert report["status"] == "FAILED"
    assert _stage(report, "REACH")["status"] == "PASSED"
    auth = _stage(report, "AUTH")
    assert auth["status"] == "FAILED" and "401" in auth["detail"] and "API key" in auth["detail"]
    assert FakeHttp.calls[0][0] == "/api/v1/machines/M1/operator"


@pytest.mark.asyncio
async def test_right_key_passes_auth_on_the_test_path(monkeypatch: pytest.MonkeyPatch) -> None:
    report = await _run(monkeypatch, {"mode": "CONNECTIVITY", "fields": [], "test_path": "/api/v1/machines/M1/operator"})
    assert report["status"] == "PASSED"
    assert _stage(report, "AUTH")["status"] == "PASSED"
    assert "GET /api/v1/machines/M1/operator" in _stage(report, "AUTH")["detail"]


@pytest.mark.asyncio
async def test_without_any_path_auth_is_not_verified_and_result_is_consistent(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (GOOD_KEY, "wrong_key_123"):  # a public root page cannot tell the keys apart
        report = await _run(monkeypatch, {"mode": "CONNECTIVITY", "fields": []}, key=key)
        assert report["status"] == "PASSED", report
        assert report["diagnostic"] == "" and report["error_code"] is None
        auth = _stage(report, "AUTH")
        assert auth["status"] == "SKIPPED" and auth["detail"] == "Not verified — add a data path"


@pytest.mark.asyncio
async def test_full_test_without_fields_passes_when_its_stages_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    report = await _run(monkeypatch, {"mode": "FULL", "fields": []})
    assert report["status"] == "PASSED"
    assert {item["stage"]: item["status"] for item in report["stages"]} == {
        "REACH": "PASSED",
        "AUTH": "SKIPPED",
        "READ": "NOT_APPLICABLE",
        "SAMPLE": "NOT_APPLICABLE",
        "MAP": "NOT_APPLICABLE",
    }


@pytest.mark.asyncio
async def test_failing_data_path_in_connectivity_mode_shows_the_failed_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    report = await _run(monkeypatch, {"mode": "CONNECTIVITY", "fields": [], "test_path": "/missing"})
    assert report["status"] == "FAILED"
    assert _stage(report, "AUTH")["status"] == "SKIPPED"
    assert _stage(report, "READ")["status"] == "FAILED"  # listed even though CONNECTIVITY has no READ stage
    assert report["diagnostic"].startswith("GET /missing")


def test_overall_status_never_contradicts_the_stages() -> None:
    stages = Stages(["REACH", "AUTH"])
    stages.set("REACH", "PASSED")
    passed, diagnostic = overall_status(False, stages, "")
    assert not passed and stages.by_name["AUTH"]["status"] == "FAILED" and diagnostic
    ok = Stages(["REACH", "AUTH"])
    ok.set("REACH", "PASSED")
    ok.set("AUTH", "SKIPPED", "Not verified — add a data path")
    assert overall_status(True, ok, "") == (True, "")
    broken = Stages(["REACH"])
    broken.set("REACH", "FAILED", "down")
    assert overall_status(True, broken, "")[0] is False


# R3-CN-01: the stored connection config carries the form default "path": "/". The test path the
# user typed must still be the one requested, so a wrong key fails Authenticate.
STORED_CONFIG = {**CONFIG, "path": "/", "method": "GET", "rate_limit_per_min": 100, "timeout_ms": 5000}


async def _run_stored(monkeypatch: pytest.MonkeyPatch, job: dict[str, Any], key: str) -> dict[str, Any]:
    monkeypatch.setattr(commissioning, "HttpPullConnector", FakeHttp)
    FakeHttp.calls = []
    commissioner, reports = _commissioner(key)
    await commissioner.run({"id": "j", "protocol": "http", "secret_ref": "s1", "config_json": STORED_CONFIG, **job})
    return reports.items["j"]


@pytest.mark.asyncio
async def test_test_path_wins_over_the_stored_root_path_wrong_key_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    job = {"mode": "CONNECTIVITY", "fields": [], "test_path": "/api/v1/machines/AA10-01/operator-program"}
    report = await _run_stored(monkeypatch, job, key="wrong_key_123")
    assert FakeHttp.calls[0][0] == "/api/v1/machines/AA10-01/operator-program"
    assert report["status"] == "FAILED"
    auth = _stage(report, "AUTH")
    assert auth["status"] == "FAILED" and "401" in auth["detail"]


@pytest.mark.asyncio
async def test_test_path_wins_over_the_stored_root_path_right_key_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    job = {"mode": "CONNECTIVITY", "fields": [], "test_path": "/api/v1/machines/AA10-01/operator-program"}
    report = await _run_stored(monkeypatch, job, key=GOOD_KEY)
    assert report["status"] == "PASSED"
    assert _stage(report, "AUTH")["status"] == "PASSED"


@pytest.mark.asyncio
async def test_stored_root_path_alone_is_not_a_proof_of_authentication(monkeypatch: pytest.MonkeyPatch) -> None:
    report = await _run_stored(monkeypatch, {"mode": "CONNECTIVITY", "fields": []}, key=GOOD_KEY)
    assert report["status"] == "PASSED"
    assert _stage(report, "AUTH")["status"] == "SKIPPED"


def test_auth_probe_path_precedence() -> None:
    assert commissioning.auth_probe_path("/api/x", "/api/y") == "/api/x"
    assert commissioning.auth_probe_path(None, "/api/y") == "/api/y"
    assert commissioning.auth_probe_path("  ", "/") == ""
    assert commissioning.auth_probe_path(None, None) == ""
