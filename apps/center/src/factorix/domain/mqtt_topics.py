"""MQTT topic-filter containment without subscribing or expanding wildcards."""


def valid_filter(value: str) -> bool:
    parts = value.split('/')
    return bool(value) and len(value.encode('utf-8')) <= 2048 and not any(ord(c) < 32 or ord(c) == 127 for c in value) and not value.startswith('$share/') and all(
        ('#' not in part or part == '#' and i == len(parts) - 1) and ('+' not in part or part == '+')
        for i, part in enumerate(parts)
    )


def filter_covers(allowed: str, requested: str) -> bool:
    """Every concrete topic in requested must also be covered by allowed."""
    if not valid_filter(allowed) or not valid_filter(requested):
        return False
    parent, child = allowed.split('/'), requested.split('/')
    if child[0].startswith('$') and parent[0] in {'#', '+'}:
        return False
    for i, part in enumerate(parent):
        if part == '#':
            return True
        if i >= len(child) or child[i] == '#':
            return False
        if part != '+' and part != child[i]:
            return False
    return len(parent) == len(child)
