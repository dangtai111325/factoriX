from __future__ import annotations

import pytest
from factorix.modules.protocols import assert_valid_topic
from factorix.platform.errors import AppError


def test_con05_hash_wrong_position():
    with pytest.raises(AppError) as exc:
        assert_valid_topic("uns/#/x")
    assert exc.value.code == "TOPIC"
    assert "wildcard" in exc.value.message.lower() or "#" in exc.value.message


def test_con06_plus_not_whole_level():
    with pytest.raises(AppError) as exc:
        assert_valid_topic("uns/a+/b")
    assert exc.value.code == "TOPIC"
    assert "+" in exc.value.message


def test_con07_leading_slash_empty_level_dollar():
    # leading slash
    with pytest.raises(AppError) as exc:
        assert_valid_topic("/a")
    assert exc.value.code == "TOPIC"

    # empty level
    with pytest.raises(AppError) as exc:
        assert_valid_topic("a//b")
    assert exc.value.code == "TOPIC"

    # system topic $
    with pytest.raises(AppError) as exc:
        assert_valid_topic("$SYS/#")
    assert exc.value.code == "TOPIC"


def test_con08_valid_wildcards():
    # Valid topic with single-level and multi-level wildcards
    assert_valid_topic("uns/TIPA/+/Factory-1/#")
    assert_valid_topic("sensors/temp")
    assert_valid_topic("a/b/c/+")
    assert_valid_topic("#")
