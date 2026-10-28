"""Restricted expression evaluator. No eval/exec, no attribute access, no IO."""

from __future__ import annotations

import ast
import math
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

MAX_CHARS = 2000
MAX_NODES = 200
MAX_DEPTH = 24
MAX_ABS = 1e12

_ALLOWED_BINOPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: _pow(a, b),
}
_ALLOWED_CMP = {
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
}
_ALLOWED_UNARY = {
    ast.UAdd: lambda a: +a,
    ast.USub: lambda a: -a,
    ast.Not: lambda a: not a,
}


class FormulaError(ValueError):
    def __init__(self, code: str, message: str, token: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.token = token


def _clamp(value: float, low: float, high: float) -> float:
    return min(max(value, low), high)


FUNCTIONS: dict[str, Any] = {
    "abs": abs,
    "min": min,
    "max": max,
    "round": round,
    "sqrt": math.sqrt,
    "pow": pow,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
    "log": math.log,
    "log10": math.log10,
    "exp": math.exp,
    "floor": math.floor,
    "ceil": math.ceil,
    "clamp": _clamp,
}

WINDOW_FUNCTIONS = frozenset({"avg", "sum", "min_over_time", "max_over_time", "count", "rate"})


@dataclass(frozen=True, slots=True)
class FormulaAnalysis:
    names: tuple[str, ...]
    node_count: int
    normalized: str
    warnings: tuple[str, ...] = ()


@dataclass
class FormulaProgram:
    tree: ast.Expression
    analysis: FormulaAnalysis
    bindings: dict[str, UUID] = field(default_factory=dict)


def parse_expression(source: str) -> FormulaProgram:
    if not source or not source.strip():
        raise FormulaError("EMPTY", "Biểu thức trống.")
    if len(source) > MAX_CHARS:
        raise FormulaError("TOO_LARGE", "Biểu thức vượt quá giới hạn.")
    if "__" in source:
        raise FormulaError("FORBIDDEN", "Biểu thức chứa từ khóa bị cấm.")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise FormulaError("SYNTAX", "Cú pháp biểu thức không hợp lệ.", token=str(exc.lineno)) from exc
    names: list[str] = []
    warnings: list[str] = []
    count = 0

    def walk(node: ast.AST, depth: int) -> None:
        nonlocal count
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            raise FormulaError("TOO_COMPLEX", "Biểu thức quá phức tạp.")
        if isinstance(node, ast.Expression):
            walk(node.body, depth + 1)
            return
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float, str, bool, type(None))):
                raise FormulaError("FORBIDDEN", "Hằng số không được phép.")
            if isinstance(node.value, float) and not math.isfinite(node.value):
                raise FormulaError("NON_FINITE", "Hằng số không hữu hạn.")
            return
        if isinstance(node, ast.Name):
            if node.id.startswith("_") or node.id in FUNCTIONS or node.id in WINDOW_FUNCTIONS:
                return
            if node.id not in names:
                names.append(node.id)
            return
        if isinstance(node, ast.BinOp):
            if type(node.op) not in _ALLOWED_BINOPS:
                raise FormulaError("FORBIDDEN", "Toán tử không được phép.")
            walk(node.left, depth + 1)
            walk(node.right, depth + 1)
            return
        if isinstance(node, ast.UnaryOp):
            if type(node.op) not in _ALLOWED_UNARY:
                raise FormulaError("FORBIDDEN", "Toán tử một ngôi không được phép.")
            walk(node.operand, depth + 1)
            return
        if isinstance(node, ast.BoolOp):
            if not isinstance(node.op, (ast.And, ast.Or)):
                raise FormulaError("FORBIDDEN", "Toán tử logic không được phép.")
            for value in node.values:
                walk(value, depth + 1)
            return
        if isinstance(node, ast.Compare):
            if any(type(op) not in _ALLOWED_CMP for op in node.ops):
                raise FormulaError("FORBIDDEN", "Phép so sánh không được phép.")
            walk(node.left, depth + 1)
            for comparator in node.comparators:
                walk(comparator, depth + 1)
            return
        if isinstance(node, ast.IfExp):
            walk(node.test, depth + 1)
            walk(node.body, depth + 1)
            walk(node.orelse, depth + 1)
            return
        if isinstance(node, ast.Call):
            _check_call(node, depth, walk)
            return
        raise FormulaError("FORBIDDEN", f"Nút AST {type(node).__name__} bị cấm.")

    walk(tree, 0)
    if _division_without_guard(tree):
        warnings.append("Mẫu số có thể bằng 0. Thêm điều kiện trước khi chia.")
    normalized = ast.dump(tree, include_attributes=False)
    return FormulaProgram(
        tree=tree,
        analysis=FormulaAnalysis(tuple(names), count, normalized, tuple(warnings)),
    )


def _check_call(node: ast.Call, depth: int, walk: Any) -> None:
    if node.keywords:
        raise FormulaError("FORBIDDEN", "Không hỗ trợ đối số đặt tên.")
    if not isinstance(node.func, ast.Name):
        raise FormulaError("FORBIDDEN", "Chỉ được gọi hàm trong allowlist.")
    name = node.func.id
    if name in WINDOW_FUNCTIONS:
        if len(node.args) != 2 or not isinstance(node.args[0], ast.Name):
            raise FormulaError("WINDOW", "Hàm cửa sổ cần alias và khoảng thời gian hằng số.")
        if not isinstance(node.args[1], ast.Constant) or not isinstance(node.args[1].value, int):
            raise FormulaError("WINDOW", "Cửa sổ thời gian phải là số giây hằng số.")
        seconds = node.args[1].value
        if seconds < 1 or seconds > 86_400:
            raise FormulaError("WINDOW", "Cửa sổ thời gian phải từ 1 đến 86400 giây.")
        walk(node.args[0], depth + 1)
        return
    if name not in FUNCTIONS:
        raise FormulaError("FORBIDDEN", f"Hàm {name} không nằm trong allowlist.", token=name)
    if len(node.args) > 8:
        raise FormulaError("TOO_COMPLEX", "Quá nhiều đối số.")
    for arg in node.args:
        walk(arg, depth + 1)


def _division_without_guard(tree: ast.Expression) -> bool:
    divides = any(isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div) for node in ast.walk(tree))
    guarded = any(isinstance(node, ast.IfExp) for node in ast.walk(tree))
    return divides and not guarded


def bind(program: FormulaProgram, alias_to_signal: dict[str, UUID]) -> FormulaProgram:
    missing = [name for name in program.analysis.names if name not in alias_to_signal]
    if missing:
        raise FormulaError("UNBOUND", "Biến chưa gắn signal: " + ", ".join(missing), token=missing[0])
    extra = [name for name in alias_to_signal if name not in program.analysis.names]
    if extra:
        raise FormulaError("UNUSED_ALIAS", "Alias không xuất hiện trong biểu thức.")
    program.bindings = dict(alias_to_signal)
    return program


def detect_cycles(graph: dict[UUID, set[UUID]]) -> None:
    color: dict[UUID, int] = {}

    def visit(node: UUID, stack: list[UUID]) -> None:
        color[node] = 1
        stack.append(node)
        for dep in graph.get(node, ()):
            state = color.get(dep, 0)
            if state == 1:
                raise FormulaError("CYCLE", "Công thức tạo vòng phụ thuộc.")
            if state == 0:
                visit(dep, stack)
        stack.pop()
        color[node] = 2

    for node in list(graph):
        if color.get(node, 0) == 0:
            visit(node, [])


def evaluate(program: FormulaProgram, values: dict[str, Any], *, windows: dict[str, list[float]] | None = None) -> Any:
    windows = windows or {}

    def ev(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id not in values:
                return None
            return values[node.id]
        if isinstance(node, ast.UnaryOp):
            value = ev(node.operand)
            if value is None:
                return None
            return _ALLOWED_UNARY[type(node.op)](value)
        if isinstance(node, ast.BinOp):
            left = ev(node.left)
            right = ev(node.right)
            if left is None or right is None:
                return None
            return _num(_ALLOWED_BINOPS[type(node.op)](left, right))
        if isinstance(node, ast.BoolOp):
            if isinstance(node.op, ast.And):
                current = True
                for value_node in node.values:
                    current = ev(value_node)
                    if not current:
                        return current
                return current
            current = False
            for value_node in node.values:
                current = ev(value_node)
                if current:
                    return current
            return current
        if isinstance(node, ast.Compare):
            left = ev(node.left)
            for op, comparator in zip(node.ops, node.comparators, strict=True):
                right = ev(comparator)
                if left is None or right is None:
                    return None
                if not _ALLOWED_CMP[type(op)](left, right):
                    return False
                left = right
            return True
        if isinstance(node, ast.IfExp):
            return ev(node.body) if ev(node.test) else ev(node.orelse)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in WINDOW_FUNCTIONS:
                alias = node.args[0].id  # type: ignore[attr-defined]
                series = windows.get(alias)
                if not series:
                    return None
                return _window(node.func.id, series)
            args = [ev(arg) for arg in node.args]
            if any(arg is None for arg in args):
                return None
            try:
                return _num(FUNCTIONS[node.func.id](*args))
            except (ValueError, OverflowError, ZeroDivisionError) as exc:
                raise FormulaError("EVAL", "Không tính được biểu thức.") from exc
        raise FormulaError("FORBIDDEN", "Không thực thi được nút này.")

    return ev(program.tree)


def _window(name: str, series: list[float]) -> float | int | None:
    finite = [float(item) for item in series if isinstance(item, (int, float)) and math.isfinite(float(item))]
    if not finite:
        return None
    if name == "count":
        return len(finite)
    if name in {"sum", "rate"}:
        total = sum(finite)
        return total if name == "sum" else total / max(len(finite) - 1, 1)
    if name == "avg":
        return sum(finite) / len(finite)
    if name == "min_over_time":
        return min(finite)
    if name == "max_over_time":
        return max(finite)
    raise FormulaError("WINDOW", "Hàm cửa sổ không hỗ trợ.")


def _pow(left: Any, right: Any) -> float:
    if isinstance(right, (int, float)) and abs(float(right)) > 8:
        raise FormulaError("EVAL", "Số mũ vượt giới hạn.")
    result = left**right
    return _num(result)


def _num(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value) or abs(value) > MAX_ABS:
            raise FormulaError("EVAL", "Kết quả số vượt giới hạn an toàn.")
    return value


def output_quality(input_qualities: list[str], value: Any) -> str:
    if value is None:
        return "BAD"
    if any(item == "BAD" for item in input_qualities):
        return "BAD"
    if any(item in {"UNCERTAIN", "STALE"} for item in input_qualities):
        return "UNCERTAIN"
    return "GOOD"
