"""Pure checks for the commercial gate that do not need a database."""

from factorix.modules.telemetry import retention_scope


def test_site_retention_does_not_match_the_whole_tenant() -> None:
    clause, params = retention_scope({"scope_type": "SITE", "scope_id": "site-1"})
    assert "site_id" in clause
    assert params["scope_id"] == "site-1"


def test_unknown_retention_scope_matches_nothing() -> None:
    clause, _params = retention_scope({"scope_type": "LINE", "scope_id": "x"})
    assert clause == " AND FALSE"


def test_tenant_retention_has_no_extra_predicate() -> None:
    clause, params = retention_scope({"scope_type": "TENANT", "scope_id": None})
    assert clause == ""
    assert params == {}
