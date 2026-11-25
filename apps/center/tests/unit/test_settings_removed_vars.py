"""C-05: ``acquisition_spool_path`` / ``acquisition_spool_max_bytes`` were never read (the acquisition spool reads
``FACTORIX_SPOOL_*``); they are removed, and a leftover ``FACTORIX_ACQUISITION_SPOOL_*`` variable only warns."""

from __future__ import annotations

import logging

import pytest

from factorix.platform import settings as S


def test_unused_spool_settings_are_gone() -> None:
    assert "acquisition_spool_path" not in S.Settings.model_fields
    assert "acquisition_spool_max_bytes" not in S.Settings.model_fields


def test_leftover_variables_warn_and_point_at_the_real_ones(caplog: pytest.LogCaptureFixture) -> None:
    env = {"FACTORIX_ACQUISITION_SPOOL_PATH": "/data/x.sqlite", "FACTORIX_SPOOL_PATH": "/data/spool.sqlite"}
    with caplog.at_level(logging.WARNING, logger=S.logger.name):
        found = S.warn_removed_env_vars(env)
    assert found == ["FACTORIX_ACQUISITION_SPOOL_PATH"]
    assert "FACTORIX_SPOOL_PATH" in caplog.text and "ignored" in caplog.text


def test_no_warning_without_leftovers(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger=S.logger.name):
        assert S.warn_removed_env_vars({"FACTORIX_SPOOL_MAX_BYTES": "1"}) == []
    assert caplog.text == ""


def test_settings_still_load_with_a_leftover_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORIX_ACQUISITION_SPOOL_MAX_BYTES", "1")  # used to fail validation (ge=1 MiB); now ignored
    S.get_settings.cache_clear()
    try:
        assert S.get_settings().database_url
    finally:
        S.get_settings.cache_clear()
