"""Containment rules prevent discovery from broadening configured MQTT subscriptions."""

import pytest

from factorix.domain.mqtt_topics import filter_covers


@pytest.mark.parametrize('allowed,requested,expected', [
    ('f/#', 'f', True), ('f/#', 'f/+/state', True), ('f/+/state', 'f/M/state', True),
    ('f/+/state', 'f/#', False), ('f/+', 'f/#', False), ('f/+', 'f', False),
    ('f/a', 'f/+', False), ('f/#', 'f/b/#/bad', False), ('f/#', 'f/ab+cd', False),
    ('#', '$SYS/#', False), ('+/state', '$SYS/state', False), ('$SYS/#', '$SYS/state', True),
    ('f/+/state', 'f//state', True), ('f/#', 'f/多语言/state', True),
    ('#', '$share/g/f/#', False), ('#', '', False), ('f/#', 'f/\x00', False),
])
def test_filter_containment(allowed, requested, expected):
    assert filter_covers(allowed, requested) is expected
