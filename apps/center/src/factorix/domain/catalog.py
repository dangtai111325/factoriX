"""System type catalog created with the tenant at bootstrap. Not factory data."""

from __future__ import annotations

SYSTEM_TYPES: tuple[tuple[str, str, str], ...] = (
    ("enterprise", "Enterprise", "ENTERPRISE"),
    ("site", "Site", "SITE"),
    ("plant", "Plant", "AREA"),
    ("zone", "Zone", "AREA"),
    ("line", "Line", "WORK_CENTER"),
    ("workshop", "Workshop", "WORK_CENTER"),
    ("cell", "Cell", "WORK_CENTER"),
    ("utility_system", "Utility system", "WORK_CENTER"),
    ("machine", "Machine", "ASSET"),
    ("sensor", "Sensor", "ASSET"),
    ("physical_asset", "Physical asset", "ASSET"),
    ("functional_position", "Functional position", "POSITION"),
)

RELATION_TYPES: tuple[tuple[str, str, bool, bool], ...] = (
    ("CONTAINS", "Contains", True, False),
    ("PART_OF", "Part of", True, False),
    ("INSTALLED_AT", "Installed at", False, True),
    ("FEEDS", "Feeds", False, False),
    ("CONNECTED_TO", "Connected to", False, False),
    ("MONITORED_BY", "Monitored by", False, False),
)

CONTAINS_PAIRS: tuple[tuple[str, str], ...] = (
    ("enterprise", "site"),
    ("site", "plant"),
    ("plant", "zone"),
    ("plant", "line"),
    ("plant", "workshop"),
    ("plant", "machine"),
    ("plant", "utility_system"),
    ("zone", "line"),
    ("zone", "cell"),
    ("zone", "machine"),
    ("zone", "workshop"),
    ("line", "machine"),
    ("line", "cell"),
    ("line", "sensor"),
    ("workshop", "machine"),
    ("workshop", "cell"),
    ("cell", "machine"),
    ("cell", "sensor"),
    ("utility_system", "sensor"),
    ("utility_system", "machine"),
)

HIERARCHY_PRESETS: dict[str, list[dict[str, object]]] = {
    "Assembly": [
        {"type_key": "enterprise", "optional": False},
        {"type_key": "site", "optional": False},
        {"type_key": "plant", "optional": False},
        {"type_key": "zone", "optional": True},
        {"type_key": "line", "optional": True},
        {"type_key": "machine", "optional": False},
    ],
    "Discrete": [
        {"type_key": "plant", "optional": False},
        {"type_key": "line", "optional": False},
        {"type_key": "machine", "optional": False},
    ],
    "Process": [
        {"type_key": "plant", "optional": False},
        {"type_key": "zone", "optional": False},
        {"type_key": "cell", "optional": True},
        {"type_key": "machine", "optional": False},
    ],
    "Utility": [
        {"type_key": "plant", "optional": False},
        {"type_key": "utility_system", "optional": False},
        {"type_key": "sensor", "optional": False},
    ],
}
