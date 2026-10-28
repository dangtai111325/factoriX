"""Restricted JSONPath evaluator with explicit cardinality policies.

Supports dotted names, quoted keys, indexes and a single wildcard in an array.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

Cardinality = Literal["FIRST", "ARRAY", "MAP_BY_ID", "REJECT_MULTI"]
MissingPolicy = Literal["OMIT", "NULL", "BAD"]


class MappingError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class PathToken:
    kind: Literal["key", "index", "wildcard"]
    key: str | None = None
    index: int | None = None


def compile_path(expression: str) -> list[PathToken]:
    if not expression or not expression.startswith("$"):
        raise MappingError("INVALID_PATH", "JSONPath phải bắt đầu bằng $.")
    if len(expression) > 512:
        raise MappingError("PATH_TOO_LONG", "JSONPath quá dài.")
    tokens: list[PathToken] = []
    i = 1
    while i < len(expression):
        ch = expression[i]
        if ch == ".":
            i += 1
            if i >= len(expression):
                raise MappingError("INVALID_PATH", "JSONPath kết thúc bằng dấu chấm.")
            if expression[i] == "[":
                continue
            start = i
            while i < len(expression) and expression[i] not in ".[":
                i += 1
            name = expression[start:i]
            if not name.isidentifier() and not name.replace("_", "").isalnum():
                raise MappingError("INVALID_PATH", "Tên khóa không hợp lệ. Dùng $['k.hóa'].")
            tokens.append(PathToken("key", key=name))
            continue
        if ch == "[":
            end = expression.find("]", i)
            if end < 0:
                raise MappingError("INVALID_PATH", "Thiếu dấu ].")
            inner = expression[i + 1 : end].strip()
            if inner == "*":
                tokens.append(PathToken("wildcard"))
            elif (inner.startswith("'") and inner.endswith("'")) or (
                inner.startswith('"') and inner.endswith('"')
            ):
                tokens.append(PathToken("key", key=inner[1:-1]))
            elif inner.isdigit() or (inner.startswith("-") and inner[1:].isdigit()):
                tokens.append(PathToken("index", index=int(inner)))
            else:
                raise MappingError("INVALID_PATH", "Chỉ mục không hợp lệ.")
            i = end + 1
            continue
        raise MappingError("INVALID_PATH", "Cú pháp JSONPath không được hỗ trợ.")
    if sum(1 for token in tokens if token.kind == "wildcard") > 1:
        raise MappingError("INVALID_PATH", "Chỉ một wildcard được phép.")
    return tokens


def evaluate(expression: str, document: Any) -> list[Any]:
    tokens = compile_path(expression)
    current: list[Any] = [document]
    for token in tokens:
        nxt: list[Any] = []
        for node in current:
            nxt.extend(_step(node, token))
        current = nxt
    return current


def _step(node: Any, token: PathToken) -> list[Any]:
    if token.kind == "key":
        if isinstance(node, dict) and token.key in node:
            return [node[token.key]]
        return []
    if not isinstance(node, list):
        return []
    if token.kind == "wildcard":
        return list(node)
    assert token.index is not None
    if token.index < 0:
        index = len(node) + token.index
    else:
        index = token.index
    if 0 <= index < len(node):
        return [node[index]]
    return []


@dataclass(frozen=True, slots=True)
class MapResult:
    present: bool
    value: Any
    match_count: int
    quality_override: str | None = None


def apply_cardinality(
    matches: list[Any],
    *,
    cardinality: Cardinality,
    missing: MissingPolicy,
    map_id_field: str | None = None,
) -> MapResult:
    if not matches:
        if missing == "BAD":
            return MapResult(False, None, 0, "BAD")
        if missing == "NULL":
            return MapResult(False, None, 0, None)
        return MapResult(False, None, 0, None)
    if cardinality == "FIRST":
        return MapResult(True, matches[0], len(matches))
    if cardinality == "ARRAY":
        return MapResult(True, matches, len(matches))
    if cardinality == "REJECT_MULTI":
        if len(matches) > 1:
            raise MappingError("CARDINALITY", "Nhiều giá trị khớp một tín hiệu scalar.")
        return MapResult(True, matches[0], 1)
    if cardinality == "MAP_BY_ID":
        if not map_id_field:
            raise MappingError("CARDINALITY", "MAP_BY_ID cần trường định danh.")
        mapped: dict[str, Any] = {}
        for item in matches:
            if not isinstance(item, dict) or map_id_field not in item:
                raise MappingError("CARDINALITY", "Phần tử không có định danh.")
            mapped[str(item[map_id_field])] = item
        return MapResult(True, mapped, len(matches))
    raise MappingError("CARDINALITY", "Chính sách cardinality không hỗ trợ.")


def suggest_type(samples: list[Any]) -> str:
    present = [sample for sample in samples if sample is not None]
    if not present:
        return "string"
    if all(isinstance(sample, bool) for sample in present):
        return "bool"
    if all(isinstance(sample, int) and not isinstance(sample, bool) for sample in present):
        return "int64"
    if all(isinstance(sample, (int, float)) and not isinstance(sample, bool) for sample in present):
        return "float64"
    if all(isinstance(sample, str) for sample in present):
        return "string"
    return "json"
