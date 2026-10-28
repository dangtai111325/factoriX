"""UNS / output-group topic projection. Identity stays on signal UUID."""

from __future__ import annotations

import re

_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")
_FORBIDDEN = set("/+#")


class TopicError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def slug_segment(value: str) -> str:
    cleaned = value.strip()
    if not cleaned or any(ch in cleaned for ch in _FORBIDDEN):
        raise TopicError("ILLEGAL_SEGMENT", "Segment topic chứa ký tự cấm.")
    slug = _SEGMENT.sub("-", cleaned).strip("-._")
    if not slug or slug in {".", ".."}:
        raise TopicError("ILLEGAL_SEGMENT", "Segment topic không hợp lệ.")
    return slug[:80]


def render_topic(template: str, context: dict[str, str | None]) -> str:
    """Render `{name}` placeholders. Missing optional segments are omitted, not left empty."""
    if "#" in template or "+" in template:
        raise TopicError("WILDCARD", "Template không được chứa wildcard MQTT.")

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in context:
            raise TopicError("UNKNOWN_PLACEHOLDER", f"Thiếu biến {key}.")
        raw = context[key]
        if raw is None or raw == "":
            return ""
        return slug_segment(raw)

    rendered = re.sub(r"\{([a-zA-Z0-9_]+)\}", replace, template)
    parts = [part for part in rendered.split("/") if part]
    if not parts:
        raise TopicError("EMPTY_TOPIC", "Topic rỗng.")
    return "/".join(parts)


def default_factory_topic(parts: dict[str, str | None], group: str) -> str:
    ordered = ["enterprise", "site", "plant", "zone", "line", "resource"]
    context = {key: parts.get(key) for key in ordered}
    context["group"] = group
    template = "fx/v1/{enterprise}/{site}/{plant}/{zone}/{line}/{resource}/{group}"
    return render_topic(template, context)
