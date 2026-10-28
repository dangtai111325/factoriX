"""CSV formula-injection guard and bounded export cells."""

from __future__ import annotations


def csv_cell(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    if text.startswith(("=", "+", "-", "@", "\t", "\r")):
        text = "'" + text
    if any(ch in text for ch in (",", '"', "\n", "\r")):
        text = '"' + text.replace('"', '""') + '"'
    return text


def csv_row(values: list[object]) -> str:
    return ",".join(csv_cell(value) for value in values)
