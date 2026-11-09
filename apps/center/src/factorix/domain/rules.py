"""Custom Rule language of Data Model v2. Pure: no framework, database or network imports.

A rule is a Python-like expression. It is parsed with :mod:`ast` against a strict node whitelist
and evaluated by a small tree walker (never ``eval``/``exec``) with length, node, depth, step,
number-size and string-size budgets.

References to data are written ``$<type>[<name>].<signal_key>`` (optionally chained,
``$line[L1].machine[M1].status``) or ``$<type>[<name>].@name`` / ``.@code`` / ``.@type`` /
``.@<type>.@name`` for resource attributes. They are stored canonically as ``{{sig:<uuid>}}`` and
``{{res:<uuid>}}`` (followed by the attribute text), and rendered back with the current names.

Pipeline::

    text --resolve(catalog)--> stored text (tokens) --compile--> Program --evaluate(ctx)--> value

Stateful filters (``debounce``, ``hold``, ``avg``, ``ema``, ``delta``, ``rate``, ``hysteresis``,
``changed``, ``count_changes``) keep their state in a :class:`FilterState` owned by the caller
(per model and field). The state lives in memory only and resets when the server restarts.
"""

from __future__ import annotations

import ast
import difflib
import json
import math
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

MAX_EXPR_LEN = 4000
MAX_NODES = 500
MAX_DEPTH = 64
MAX_STEPS = 20_000
MAX_STR_LEN = 10_000
MAX_INT_BITS = 1024
MAX_ARGS = 64
MAX_WINDOW = 1000
MAX_FILTER_MS = 86_400_000

ATTR_FINAL = ("name", "code", "type")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")
_BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_]+$")
_TOKEN_RE = re.compile(r"\{\{(sig|res):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}\}")
_PLACEHOLDER = "__fxr{}__"
_IF_PLACEHOLDER = "__fxif__"
_MISSING = "⚠missing"  # "⚠missing"
_KEYWORDS_BEFORE_OPERAND = {"and", "or", "not", "else", "if", "in", "is", "lambda"}


# ============================================================================================
# Errors and values
# ============================================================================================


class RuleError(ValueError):
    """A rule cannot be resolved or compiled. ``pos``/``end`` are 0-based offsets in the rule text."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        pos: int | None = None,
        end: int | None = None,
        suggestions: list[str] | None = None,
        severity: str = "error",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.pos = pos
        self.end = end
        self.suggestions = suggestions or []
        self.severity = severity

    def as_issue(self) -> dict[str, Any]:
        issue: dict[str, Any] = {"severity": self.severity, "code": self.code, "message": self.message}
        if self.pos is not None:
            issue["pos"] = self.pos
        if self.end is not None:
            issue["end"] = self.end
        if self.suggestions:
            issue["suggestions"] = list(self.suggestions)
        return issue


class RuleRuntimeError(ValueError):
    """Evaluation failed (division by zero, type error, missing reference, budget). The field is null."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class LookupPending(Exception):  # noqa: N818 - control flow signal, not an error
    """``value_at`` needs a value the caller has not fetched yet. The caller fetches and re-evaluates."""

    def __init__(self, signal_id: str, at: datetime) -> None:
        super().__init__(f"value_at({signal_id}, {at.isoformat()})")
        self.signal_id = signal_id
        self.at = at


@dataclass(frozen=True)
class Sample:
    """The latest valid value of a signal (or the value at an instant)."""

    value: Any
    quality: str | None = "GOOD"
    source_time: datetime | None = None
    received_time: datetime | None = None

    @property
    def ts(self) -> datetime | None:
        """Group timestamp: source_time, falling back to received_time."""
        return self.source_time or self.received_time


def as_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
        except ValueError:
            return None
        return as_utc(parsed)
    return None


def fmt_ts(value: datetime) -> str:
    """Contract timestamp text ``YYYY-MM-DDTHH:mm:ss.SSSZ`` (UTC, 3 fraction digits)."""
    moment = as_utc(value)
    assert moment is not None
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class FilterState:
    """State of stateful filters. Reads see writes of the same pass; ``commit`` publishes them.

    ``base`` is owned by the caller (one dict per model). Evaluation writes go to an overlay, so a
    pass that is discarded (for example re-evaluated after ``value_at`` lookups) changes nothing.
    """

    def __init__(self, base: dict[Any, Any] | None = None) -> None:
        self.base: dict[Any, Any] = base if base is not None else {}
        self._overlay: dict[Any, Any] = {}

    def get(self, key: Any) -> Any:
        if key in self._overlay:
            return self._overlay[key]
        return self.base.get(key)

    def put(self, key: Any, value: Any) -> None:
        self._overlay[key] = value

    def commit(self) -> None:
        self.base.update(self._overlay)
        self._overlay = {}

    def discard(self) -> None:
        self._overlay = {}


# ============================================================================================
# Catalog: resources and signals used to resolve and render references
# ============================================================================================


@dataclass(frozen=True)
class ResourceInfo:
    id: str
    type_key: str
    name: str
    code: str
    parent_id: str | None
    active: bool = True


@dataclass(frozen=True)
class SignalInfo:
    id: str
    resource_id: str
    key: str
    name: str = ""
    data_type: str = ""
    unit: str | None = None
    active: bool = True


def _norm_id(value: Any) -> str:
    return str(value).lower()


class Catalog:
    """In-memory view of the resource tree and signals of one tenant (built per request/tick)."""

    def __init__(
        self,
        resources: Iterable[Mapping[str, Any] | ResourceInfo],
        signals: Iterable[Mapping[str, Any] | SignalInfo] = (),
        types: Iterable[str] | None = None,
    ) -> None:
        self.resources: dict[str, ResourceInfo] = {}
        for item in resources:
            info = item if isinstance(item, ResourceInfo) else ResourceInfo(
                id=_norm_id(item["id"]),
                type_key=str(item.get("type_key") or ""),
                name=str(item.get("name") or ""),
                code=str(item.get("code") or ""),
                parent_id=_norm_id(item["parent_id"]) if item.get("parent_id") else None,
                active=bool(item.get("active", True)),
            )
            self.resources[info.id] = info
        self.signals: dict[str, SignalInfo] = {}
        for item in signals:
            sig = item if isinstance(item, SignalInfo) else SignalInfo(
                id=_norm_id(item["id"]),
                resource_id=_norm_id(item["resource_id"]),
                key=str(item.get("key") or ""),
                name=str(item.get("name") or item.get("display_name") or ""),
                data_type=str(item.get("data_type") or ""),
                unit=item.get("unit"),
                active=bool(item.get("active", True)),
            )
            self.signals[sig.id] = sig
        self.types: set[str] = set(types or ()) | {r.type_key for r in self.resources.values() if r.type_key}
        self._by_type: dict[str, list[ResourceInfo]] = {}
        self._children: dict[str, list[ResourceInfo]] = {}
        for res in self.resources.values():
            if res.active:
                self._by_type.setdefault(res.type_key, []).append(res)
            if res.parent_id:
                self._children.setdefault(res.parent_id, []).append(res)
        self._sig_by_key: dict[tuple[str, str], SignalInfo] = {}
        self._sigs_of: dict[str, list[SignalInfo]] = {}
        for sig in self.signals.values():
            if sig.active:
                self._sig_by_key[(sig.resource_id, sig.key)] = sig
                self._sigs_of.setdefault(sig.resource_id, []).append(sig)

    # ---- tree -------------------------------------------------------------------------------

    def resource(self, resource_id: Any) -> ResourceInfo | None:
        return self.resources.get(_norm_id(resource_id)) if resource_id is not None else None

    def signal(self, signal_id: Any) -> SignalInfo | None:
        return self.signals.get(_norm_id(signal_id)) if signal_id is not None else None

    def ancestors(self, resource_id: str) -> list[ResourceInfo]:
        """Ancestors nearest first (the resource itself excluded). Cycle-safe."""
        out: list[ResourceInfo] = []
        seen = {resource_id}
        current = self.resources.get(resource_id)
        while current is not None and current.parent_id and current.parent_id not in seen and len(out) < 64:
            seen.add(current.parent_id)
            parent = self.resources.get(current.parent_id)
            if parent is None:
                break
            out.append(parent)
            current = parent
        return out

    def lineage(self, resource_id: str) -> list[ResourceInfo]:
        own = self.resources.get(resource_id)
        return ([own] if own else []) + self.ancestors(resource_id)

    def nearest_of_type(self, resource_id: str, type_key: str) -> ResourceInfo | None:
        for item in self.lineage(resource_id):
            if item.type_key == type_key:
                return item
        return None

    def path_names(self, resource_id: str) -> list[str]:
        return [item.name for item in reversed(self.lineage(resource_id))]

    def signals_of(self, resource_id: str) -> list[SignalInfo]:
        return list(self._sigs_of.get(resource_id, []))

    def signal_by_key(self, resource_id: str, key: str) -> SignalInfo | None:
        return self._sig_by_key.get((resource_id, key))

    def children(self, resource_id: str) -> list[ResourceInfo]:
        return list(self._children.get(resource_id, []))

    def descendants(self, resource_id: str) -> list[ResourceInfo]:
        children = self._children
        out: list[ResourceInfo] = []
        stack = list(children.get(resource_id, []))
        seen = {resource_id}
        while stack:
            item = stack.pop()
            if item.id in seen:
                continue
            seen.add(item.id)
            out.append(item)
            stack.extend(children.get(item.id, []))
        return out

    def signal_live(self, signal_id: str) -> bool:
        sig = self.signals.get(signal_id)
        if sig is None or not sig.active:
            return False
        res = self.resources.get(sig.resource_id)
        return res is not None and res.active

    def resource_live(self, resource_id: str) -> bool:
        res = self.resources.get(resource_id)
        return res is not None and res.active

    # ---- name matching ------------------------------------------------------------------------

    def match(self, type_key: str, name: str) -> list[ResourceInfo]:
        """Active resources of ``type_key`` named (or coded) ``name``; exact first, then case-insensitive."""
        pool = self._by_type.get(type_key, [])
        exact = [r for r in pool if r.name == name or r.code == name]
        if exact:
            return exact
        folded = name.casefold()
        return [r for r in pool if r.name.casefold() == folded or r.code.casefold() == folded]

    def resolve_chain(self, segments: list[tuple[str, str]]) -> list[ResourceInfo]:
        candidates = self.match(*segments[0])
        for type_key, name in segments[1:]:
            ids = {c.id for c in candidates}
            candidates = [r for r in self.match(type_key, name) if any(a.id in ids for a in self.ancestors(r.id))]
        return candidates

    # ---- rendering ----------------------------------------------------------------------------

    def resource_path_text(self, resource_id: str) -> str | None:
        """Shortest unambiguous ``$type[name](.type[name])*`` for an active resource."""
        res = self.resources.get(resource_id)
        if res is None:
            return None
        own = f"{res.type_key}[{escape_name(res.name)}]"
        if len(self.resolve_chain([(res.type_key, res.name)])) <= 1:
            return "$" + own
        lineage = self.ancestors(resource_id)
        for anc in lineage:
            if len(self.resolve_chain([(anc.type_key, anc.name), (res.type_key, res.name)])) == 1:
                return f"${anc.type_key}[{escape_name(anc.name)}].{own}"
        chain = [(a.type_key, a.name) for a in reversed(lineage)] + [(res.type_key, res.name)]
        if len(self.resolve_chain(chain)) == 1:
            return "$" + ".".join(f"{t}[{escape_name(n)}]" for t, n in chain)
        if res.code and res.code != res.name and len(self.resolve_chain([(res.type_key, res.code)])) == 1:
            return f"${res.type_key}[{escape_name(res.code)}]"
        return "$" + own

    def signal_text(self, signal_id: str) -> str | None:
        sig = self.signals.get(signal_id)
        if sig is None:
            return None
        base = self.resource_path_text(sig.resource_id)
        if base is None:
            return None
        return f"{base}.{key_text(sig.key)}"


def escape_name(name: str) -> str:
    return name.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def key_text(key: str) -> str:
    if _BARE_KEY_RE.match(key):
        return key
    return "`" + key.replace("\\", "\\\\").replace("`", "\\`") + "`"


def missing_text(label: str | None) -> str:
    """``$⚠missing[<label>]``; brackets are escaped only when the label is not bracket-balanced."""
    text = label or "reference"
    depth, balanced = 0, True
    for ch in text:
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth < 0:
                balanced = False
                break
    balanced = balanced and depth == 0 and "\\" not in text
    if not balanced:
        text = text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
    return f"${_MISSING}[{text}]"


# ============================================================================================
# Scanning: references inside rule text
# ============================================================================================


@dataclass(frozen=True)
class TokenRef:
    """Canonical reference ``{{sig:id}}`` / ``{{res:id}}.@a.@b``."""

    kind: str  # "sig" | "res"
    id: str
    attrs: tuple[str, ...]
    start: int
    end: int

    def token(self) -> str:
        return "{{" + f"{self.kind}:{self.id}" + "}}" + "".join(f".@{a}" for a in self.attrs)

    @property
    def label_key(self) -> str:
        return f"{self.kind}:{self.id}"


@dataclass(frozen=True)
class PathRef:
    """Typed reference ``$type[name](.type[name])*`` followed by ``.key`` or ``.@attr`` chain."""

    segments: tuple[tuple[str, str], ...]
    key: str | None
    attrs: tuple[str, ...]
    start: int
    end: int


@dataclass(frozen=True)
class MissingRef:
    label: str
    attrs: tuple[str, ...]
    start: int
    end: int


Ref = TokenRef | PathRef | MissingRef


@dataclass
class Scan:
    text: str
    parts: list[str | Ref]  # literal text pieces and references, in order
    issues: list[RuleError]
    max_paren_depth: int
    if_calls: list[int]  # offsets of functional ``if(`` in the original text

    @property
    def refs(self) -> list[Ref]:
        return [p for p in self.parts if not isinstance(p, str)]


def _read_bracket(text: str, i: int) -> tuple[str, int]:
    """``text[i] == '['``; returns (unescaped content, index after the closing bracket)."""
    assert text[i] == "["
    j, depth, out = i + 1, 1, []
    while j < len(text):
        ch = text[j]
        if ch == "\\" and j + 1 < len(text):
            out.append(text[j + 1])
            j += 2
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return "".join(out), j + 1
        out.append(ch)
        j += 1
    raise RuleError("BAD_REF", "Unclosed '[' in reference.", pos=i, end=len(text))


def _read_backquoted(text: str, i: int) -> tuple[str, int]:
    assert text[i] == "`"
    j, out = i + 1, []
    while j < len(text):
        ch = text[j]
        if ch == "\\" and j + 1 < len(text):
            out.append(text[j + 1])
            j += 2
            continue
        if ch == "`":
            return "".join(out), j + 1
        out.append(ch)
        j += 1
    raise RuleError("BAD_REF", "Unclosed '`' in signal key.", pos=i, end=len(text))


def _read_attrs(text: str, j: int) -> tuple[tuple[str, ...], int]:
    attrs: list[str] = []
    while text.startswith(".@", j):
        m = _IDENT_RE.match(text, j + 2)
        if not m:
            raise RuleError("BAD_REF", "Expected an attribute name after '.@'.", pos=j, end=j + 2)
        attrs.append(m.group(0))
        j = m.end()
    return tuple(attrs), j


def _scan_path_ref(text: str, i: int) -> tuple[Ref, int]:
    j = i + 1
    if text.startswith(_MISSING, j):
        k = j + len(_MISSING)
        if k < len(text) and text[k] == "[":
            label, end = _read_bracket(text, k)
            attrs, end = _read_attrs(text, end)
            return MissingRef(label, attrs, i, end), end
        raise RuleError("BAD_REF", "Malformed missing reference.", pos=i, end=k)
    segments: list[tuple[str, str]] = []
    key: str | None = None
    attrs: tuple[str, ...] = ()
    m = _IDENT_RE.match(text, j)
    if not m:
        raise RuleError("BAD_REF", "Expected a resource type after '$', for example $machine[M1].temp.", pos=i, end=i + 1)
    type_key = m.group(0)
    j = m.end()
    while True:
        if j >= len(text) or text[j] != "[":
            raise RuleError("BAD_REF", f"Expected '[name]' after '${type_key}'.", pos=i, end=j)
        name, j = _read_bracket(text, j)
        if not name.strip():
            raise RuleError("BAD_REF", "Empty resource name in reference.", pos=i, end=j)
        segments.append((type_key, name))
        if not text.startswith(".", j):
            break
        if text.startswith(".@", j):
            attrs, j = _read_attrs(text, j)
            break
        if text.startswith(".`", j):
            key, j = _read_backquoted(text, j + 1)
            break
        w = _WORD_RE.match(text, j + 1)
        if not w:
            raise RuleError("BAD_REF", "Expected a signal key or '.@attribute' after '.'.", pos=i, end=j + 1)
        if w.end() < len(text) and text[w.end()] == "[" and _IDENT_RE.fullmatch(w.group(0)):
            type_key = w.group(0)
            j = w.end()
            continue
        key = w.group(0)
        j = w.end()
        break
    if key is not None and text.startswith(".@", j):
        raise RuleError("BAD_REF", "Signal references have no attributes; use $type[name].@name for resource attributes.", pos=i, end=j + 2)
    return PathRef(tuple(segments), key, attrs, i, j), j


def _scan_token(text: str, i: int) -> tuple[Ref, int]:
    m = _TOKEN_RE.match(text, i)
    if not m:
        raise RuleError("BAD_REF", "Malformed reference token.", pos=i, end=min(len(text), i + 2))
    kind, ident = m.group(1), m.group(2).lower()
    attrs, j = _read_attrs(text, m.end())
    if kind == "sig" and attrs:
        raise RuleError("BAD_REF", "Signal references have no attributes.", pos=i, end=j)
    return TokenRef(kind, ident, attrs, i, j), j


def scan(text: str) -> Scan:
    """Split rule text into literal pieces and references. Strings and comments are skipped."""
    parts: list[str | Ref] = []
    issues: list[RuleError] = []
    i, n, buf_start = 0, len(text), 0
    depth = max_depth = 0
    last_operand = False  # previous significant token ends an operand (for functional ``if(``)
    if_calls: list[int] = []

    def flush(upto: int) -> None:
        if upto > buf_start:
            parts.append(text[buf_start:upto])

    while i < n:
        ch = text[i]
        if ch in "'\"":
            quote = text[i : i + 3] if text[i : i + 3] in ("'''", '"""') else ch
            j = i + len(quote)
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text.startswith(quote, j):
                    j += len(quote)
                    break
                j += 1
            else:
                j = n
            i = j
            last_operand = True
            continue
        if ch == "#":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "$" or text.startswith("{{", i):
            try:
                ref, j = _scan_path_ref(text, i) if ch == "$" else _scan_token(text, i)
            except RuleError as exc:
                issues.append(exc)
                i = exc.end if exc.end and exc.end > i else i + 1
                last_operand = True
                continue
            flush(i)
            parts.append(ref)
            i = buf_start = j
            last_operand = True
            continue
        m = _IDENT_RE.match(text, i) if (ch.isalpha() or ch == "_") else None
        if m is not None:
            word = m.group(0)
            if word.startswith("__") or "__" in word:
                issues.append(RuleError("NOT_ALLOWED", f"Names with '__' are not allowed: '{word}'.", pos=i, end=m.end()))
            if word == "if" and not last_operand:
                k = m.end()
                while k < n and text[k] in " \t\r\n":
                    k += 1
                if k < n and text[k] == "(":
                    if_calls.append(i)
            last_operand = word not in _KEYWORDS_BEFORE_OPERAND
            i = m.end()
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and text[i + 1].isdigit()):
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] in "._" or (text[j] in "+-" and text[j - 1] in "eE")):
                j += 1
            i = j
            last_operand = True
            continue
        if ch in "([{":
            depth += 1
            max_depth = max(max_depth, depth)
            last_operand = False
        elif ch in ")]}":
            if depth == 0:
                issues.append(RuleError("SYNTAX", f"Unmatched '{ch}'.", pos=i, end=i + 1))
            depth = max(0, depth - 1)
            last_operand = True
        elif not ch.isspace():
            last_operand = False
        i += 1
    flush(n)
    return Scan(text, parts, issues, max_depth, if_calls)


# ============================================================================================
# Resolution (typed text -> canonical tokens) and rendering (tokens -> current names)
# ============================================================================================


@dataclass
class Resolved:
    stored: str  # canonical text (tokens); unresolved references are kept as typed
    refs: list[TokenRef]
    issues: list[RuleError]
    labels: dict[str, str]
    spans: list[tuple[int, int, int, int]] = field(default_factory=list)  # (stored_start, stored_end, orig_start, orig_end)

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)

    def original_pos(self, stored_pos: int | None) -> int | None:
        """Offset in the submitted text for an offset in ``stored`` (compile errors point at what was typed)."""
        if stored_pos is None:
            return None
        shift = 0
        for s0, s1, o0, o1 in self.spans:
            if stored_pos < s0:
                break
            if stored_pos < s1:
                return o0
            shift = o1 - s1
        return stored_pos + shift


def _close(word: str, options: Iterable[str], n: int = 5) -> list[str]:
    pool = sorted(set(options))
    found = difflib.get_close_matches(word, pool, n=n, cutoff=0.5)
    if not found:
        folded = word.casefold()
        found = [o for o in pool if folded in o.casefold()][:n]
    return found


def _check_attrs(attrs: tuple[str, ...], catalog: Catalog, resource_id: str, ref_text: str, pos: int, end: int) -> RuleError | None:
    if not attrs:
        return RuleError(
            "BAD_REF",
            f"'{ref_text}' is a resource; add a signal key, .@name or .@code.",
            pos=pos,
            end=end,
            suggestions=[f"{ref_text}.@name", f"{ref_text}.@code"],
        )
    *hops, last = attrs
    for hop in hops:
        if hop in ATTR_FINAL:
            return RuleError("UNKNOWN_ATTRIBUTE", f"'.@{hop}' must be the last attribute.", pos=pos, end=end)
        if hop not in catalog.types:
            return RuleError(
                "UNKNOWN_TYPE",
                f"Unknown resource type '{hop}'.",
                pos=pos,
                end=end,
                suggestions=[f".@{t}" for t in _close(hop, catalog.types)],
            )
    if last not in ATTR_FINAL:
        if last in catalog.types:
            return RuleError(
                "UNKNOWN_ATTRIBUTE",
                f"Add .@name or .@code after '.@{last}'.",
                pos=pos,
                end=end,
                suggestions=[f"{ref_text}.{'.'.join('@' + a for a in attrs)}.@name"],
            )
        return RuleError(
            "UNKNOWN_ATTRIBUTE",
            f"Unknown attribute '.@{last}'. Use .@name, .@code, .@type or .@<type>.@name.",
            pos=pos,
            end=end,
            suggestions=[f".@{a}" for a in _close(last, list(ATTR_FINAL) + sorted(catalog.types))],
        )
    current = resource_id
    for hop in hops:
        found = catalog.nearest_of_type(current, hop)
        if found is None:
            own = catalog.resource(current)
            return RuleError(
                "NO_ANCESTOR",
                f"'{own.name if own else current}' has no {hop} above it.",
                pos=pos,
                end=end,
            )
        current = found.id
    return None


def resolve(text: str, catalog: Catalog, labels: Mapping[str, str] | None = None) -> Resolved:
    """Resolve typed references to canonical tokens. Never raises; problems are in ``issues``."""
    labels = dict(labels or {})
    reverse: dict[str, list[str]] = {}
    for key, label in labels.items():
        reverse.setdefault(label, []).append(key)
    issues: list[RuleError] = []
    if len(text) > MAX_EXPR_LEN:
        return Resolved(text, [], [RuleError("EXPR_TOO_LONG", f"A rule is limited to {MAX_EXPR_LEN} characters.")], labels)
    sc = scan(text)
    issues.extend(sc.issues)
    out: list[str] = []
    refs: list[TokenRef] = []
    new_labels: dict[str, str] = {}
    spans: list[tuple[int, int, int, int]] = []
    stored_len = 0
    for part in sc.parts:
        if isinstance(part, str):
            out.append(part)
            stored_len += len(part)
            continue
        original = text[part.start : part.end]
        token: TokenRef | None = None
        if isinstance(part, TokenRef):
            token = part
            live = catalog.signal_live(part.id) if part.kind == "sig" else catalog.resource_live(part.id)
            if not live:
                issues.append(
                    RuleError(
                        "MISSING_REF",
                        f"The referenced {'signal' if part.kind == 'sig' else 'resource'} {labels.get(part.label_key) or ''} no longer exists.".replace("  ", " "),
                        pos=part.start,
                        end=part.end,
                        severity="warning",
                    )
                )
            elif part.kind == "res":
                err = _check_attrs(part.attrs, catalog, part.id, catalog.resource_path_text(part.id) or original, part.start, part.end)
                if err:
                    issues.append(err)
        elif isinstance(part, MissingRef):
            keys = reverse.get(part.label, [])
            if len(keys) == 1:
                kind, ident = keys[0].split(":", 1)
                if kind == "sig" and part.attrs:
                    issues.append(RuleError("BAD_REF", "Signal references have no attributes.", pos=part.start, end=part.end))
                else:
                    token = TokenRef(kind, ident, part.attrs, part.start, part.end)
                    issues.append(
                        RuleError(
                            "MISSING_REF",
                            f"The referenced target {part.label} no longer exists.",
                            pos=part.start,
                            end=part.end,
                            severity="warning",
                        )
                    )
            else:
                issues.append(
                    RuleError(
                        "MISSING_REF",
                        f"The target {part.label} no longer exists. Pick a new data point.",
                        pos=part.start,
                        end=part.end,
                    )
                )
        else:
            token, err = _resolve_path(part, catalog, original)
            if err:
                issues.append(err)
        piece = original if token is None else token.token()
        spans.append((stored_len, stored_len + len(piece), part.start, part.end))
        out.append(piece)
        stored_len += len(piece)
        if token is None:
            continue
        refs.append(token)
        label = current_label(catalog, token.kind, token.id) or labels.get(token.label_key)
        if label:
            new_labels[token.label_key] = label
    return Resolved("".join(out), refs, issues, new_labels, spans)


def current_label(catalog: Catalog, kind: str, ident: str) -> str | None:
    """Current display text of a live target (``None`` when deleted/archived)."""
    if kind == "sig":
        return catalog.signal_text(ident) if catalog.signal_live(ident) else None
    return catalog.resource_path_text(ident) if catalog.resource_live(ident) else None


def _resolve_path(ref: PathRef, catalog: Catalog, original: str) -> tuple[TokenRef | None, RuleError | None]:
    pos, end = ref.start, ref.end
    for type_key, _name in ref.segments:
        if type_key not in catalog.types:
            return None, RuleError(
                "UNKNOWN_TYPE",
                f"Unknown resource type '{type_key}'.",
                pos=pos,
                end=end,
                suggestions=[f"${t}[...]" for t in _close(type_key, catalog.types)],
            )
    candidates = catalog.resolve_chain(list(ref.segments))
    seg_text = "".join(("$" if i == 0 else ".") + f"{t}[{escape_name(n)}]" for i, (t, n) in enumerate(ref.segments))
    tail = "" if ref.key is None and not ref.attrs else ("." + key_text(ref.key) if ref.key is not None else "." + ".".join("@" + a for a in ref.attrs))
    if not candidates:
        type_key, name = ref.segments[-1]
        pool = [r.name for r in catalog.resources.values() if r.active and r.type_key == type_key]
        suggestions = []
        for option in _close(name, pool):
            for res in catalog.match(type_key, option):
                text = catalog.resource_path_text(res.id)
                if text:
                    suggestions.append(text + tail)
        where = f"{type_key} '{name}'" if len(ref.segments) == 1 else f"{type_key} '{name}' under {seg_text.rsplit('.', 1)[0]}"
        return None, RuleError("UNKNOWN_RESOURCE", f"No {where}.", pos=pos, end=end, suggestions=suggestions[:5])
    if len(candidates) > 1:
        suggestions = sorted({(catalog.resource_path_text(c.id) or "") + tail for c in candidates})
        return None, RuleError(
            "AMBIGUOUS_REF",
            f"{seg_text} matches {len(candidates)} resources; add a parent to choose one.",
            pos=pos,
            end=end,
            suggestions=suggestions[:10],
        )
    res = candidates[0]
    if ref.key is not None:
        sig = catalog.signal_by_key(res.id, ref.key)
        if sig is None:
            keys = [s.key for s in catalog.signals_of(res.id)]
            base = catalog.resource_path_text(res.id) or seg_text
            if not keys:
                return None, RuleError("UNKNOWN_SIGNAL", f"{res.name} has no data points.", pos=pos, end=end)
            return None, RuleError(
                "UNKNOWN_SIGNAL",
                f"{res.name} has no data point '{ref.key}'.",
                pos=pos,
                end=end,
                suggestions=[f"{base}.{key_text(k)}" for k in _close(ref.key, keys)],
            )
        return TokenRef("sig", sig.id, (), pos, end), None
    err = _check_attrs(ref.attrs, catalog, res.id, catalog.resource_path_text(res.id) or seg_text, pos, end)
    if err:
        return None, err
    return TokenRef("res", res.id, ref.attrs, pos, end), None


def render(stored: str, catalog: Catalog, labels: Mapping[str, str] | None = None) -> tuple[str, list[str]]:
    """Display text of a stored rule with current names. Returns (text, missing token keys)."""
    labels = labels or {}
    sc = scan(stored)
    out: list[str] = []
    missing: list[str] = []
    for part in sc.parts:
        if isinstance(part, str):
            out.append(part)
        elif isinstance(part, TokenRef):
            text = current_label(catalog, part.kind, part.id)
            if text is None:
                missing.append(part.label_key)
                text = missing_text(labels.get(part.label_key) or ("signal" if part.kind == "sig" else "resource"))
            out.append(text + "".join(f".@{a}" for a in part.attrs))
        else:
            out.append(stored[part.start : part.end])
    return "".join(out), missing


def token_refs(stored: str) -> list[TokenRef]:
    return [p for p in scan(stored).refs if isinstance(p, TokenRef)]


def replace_tokens(stored: str, mapping: Mapping[str, str]) -> str:
    """Re-point tokens: ``mapping`` maps ``"sig:<id>"``/``"res:<id>"`` to a new id of the same kind."""
    sc = scan(stored)
    out: list[str] = []
    for part in sc.parts:
        if isinstance(part, str):
            out.append(part)
        elif isinstance(part, TokenRef) and part.label_key in mapping:
            out.append(TokenRef(part.kind, mapping[part.label_key], part.attrs, part.start, part.end).token())
        else:
            out.append(stored[part.start : part.end])
    return "".join(out)


# ============================================================================================
# Compilation (stored text -> Program)
# ============================================================================================


@dataclass(frozen=True)
class FnSpec:
    name: str
    group: str
    min_args: int
    max_args: int | None
    signature: str
    description: str
    ref_args: tuple[int, ...] = ()  # argument positions that must be signal references ("*" = all via -1)
    stateful: bool = False


_FN: dict[str, FnSpec] = {}


def _fn(name: str, group: str, lo: int, hi: int | None, signature: str, description: str, *, ref_args: tuple[int, ...] = (), stateful: bool = False) -> None:
    _FN[name] = FnSpec(name, group, lo, hi, signature, description, ref_args, stateful)


for _name, _sig, _desc in (
    ("abs", "abs(x)", "Absolute value."),
    ("floor", "floor(x)", "Largest integer <= x."),
    ("ceil", "ceil(x)", "Smallest integer >= x."),
    ("sqrt", "sqrt(x)", "Square root."),
    ("exp", "exp(x)", "e to the power x."),
    ("log10", "log10(x)", "Base-10 logarithm."),
    ("log2", "log2(x)", "Base-2 logarithm."),
    ("sin", "sin(x)", "Sine (radians)."),
    ("cos", "cos(x)", "Cosine (radians)."),
    ("tan", "tan(x)", "Tangent (radians)."),
    ("asin", "asin(x)", "Arc sine (radians)."),
    ("acos", "acos(x)", "Arc cosine (radians)."),
    ("atan", "atan(x)", "Arc tangent (radians)."),
    ("degrees", "degrees(x)", "Radians to degrees."),
    ("radians", "radians(x)", "Degrees to radians."),
    ("sign", "sign(x)", "-1, 0 or 1."),
):
    _fn(_name, "math", 1, 1, _sig, _desc)
_fn("round", "math", 1, 2, "round(x, digits=0)", "Round half away from zero.")
_fn("pow", "math", 2, 2, "pow(x, y)", "x to the power y.")
_fn("log", "math", 1, 2, "log(x, base=e)", "Logarithm.")
_fn("atan2", "math", 2, 2, "atan2(y, x)", "Arc tangent of y/x (radians).")
_fn("hypot", "math", 2, MAX_ARGS, "hypot(x, y, ...)", "Euclidean norm.")
_fn("min", "math", 1, MAX_ARGS, "min(a, b, ...)", "Smallest non-null argument.")
_fn("max", "math", 1, MAX_ARGS, "max(a, b, ...)", "Largest non-null argument.")
_fn("clamp", "math", 3, 3, "clamp(x, lo, hi)", "x limited to [lo, hi].")
_fn("if", "logic", 3, 3, "if(cond, a, b)", "a when cond is true, else b (only the chosen branch is evaluated).")
_fn("coalesce", "logic", 1, MAX_ARGS, "coalesce(a, b, ...)", "First argument that is not null.")
_fn("isnull", "logic", 1, 1, "isnull(x)", "true when x is null.")
_fn("str", "string", 1, 1, "str(x)", "Text of x (timestamps as ISO, booleans as true/false).")
_fn("int", "string", 1, 1, "int(x)", "Integer (truncates; timestamps as epoch ms).")
_fn("float", "string", 1, 1, "float(x)", "Number (timestamps as epoch ms).")
_fn("bool", "string", 1, 1, "bool(x)", "Boolean ('true/false/1/0/yes/no/on/off' for text).")
_fn("upper", "string", 1, 1, "upper(s)", "Upper case.")
_fn("lower", "string", 1, 1, "lower(s)", "Lower case.")
_fn("concat", "string", 1, MAX_ARGS, "concat(a, b, ...)", "Joined text; null counts as empty.")
_fn("len", "string", 1, 1, "len(s)", "Length of text (or of a JSON array/object).")
_fn("substr", "string", 2, 3, "substr(s, start, length)", "Part of s from 0-based start.")
_fn("replace", "string", 3, 3, "replace(s, old, new)", "Replace every occurrence of old with new.")
_fn("format", "string", 2, 2, "format(x, digits)", "Fixed-point text with the given number of decimals.")
_fn("now", "time", 0, 0, "now()", "Platform clock at sampling time.")
_fn("ts", "time", 1, 1, "ts($ref)", "Source timestamp of the signal's group (source time, else received time).", ref_args=(0,))
_fn("latest_ts", "time", 1, MAX_ARGS, "latest_ts($ref, ...)", "Latest ts() of the given signals (source_timestamp of a clean body).", ref_args=(-1,))
_fn("age", "time", 1, 1, "age($ref)", "Seconds since the signal value was received.", ref_args=(0,))
_fn("quality", "time", 1, 1, "quality($ref)", "Quality of the signal's latest sample: GOOD, UNCERTAIN or BAD.", ref_args=(0,))
_fn("value_at", "time", 2, 2, "value_at($ref, time)", "Value the signal had at a past instant (snapshot).", ref_args=(0,))
_fn("debounce", "filter", 2, 2, "debounce(x, ms)", "Changes only after x has been stable for ms.", stateful=True)
_fn("hold", "filter", 2, 2, "hold(x, ms)", "Keeps the last non-null value for ms.", stateful=True)
_fn("avg", "filter", 2, 2, "avg(x, n)", "Moving average of the last n samples.", stateful=True)
_fn("ema", "filter", 2, 2, "ema(x, alpha)", "Exponential moving average (0 < alpha <= 1).", stateful=True)
_fn("delta", "filter", 1, 1, "delta(x)", "Change since the previous sample.", stateful=True)
_fn("rate", "filter", 1, 1, "rate(x)", "Change per second since the previous sample.", stateful=True)
_fn("hysteresis", "filter", 3, 3, "hysteresis(x, low, high)", "true above high, false below low, else unchanged.", stateful=True)
_fn("changed", "filter", 1, 1, "changed(x)", "true when x differs from the previous sample.", stateful=True)
_fn("count_changes", "filter", 1, 1, "count_changes(x)", "Number of changes of x since start.", stateful=True)

FUNCTIONS: Mapping[str, FnSpec] = _FN

EXAMPLES: list[dict[str, str]] = [
    {"label": "Constant", "expr": '"ASSY"'},
    {"label": "Sum", "expr": "$machine[M1].energy_1 + $machine[M1].energy_2"},
    {"label": "Average", "expr": "(a + b) / 2  # replace a, b with $references"},
    {"label": "If / else", "expr": 'if($machine[M1].status == 1, "RUN", "STOP")'},
    {"label": "Debounce", "expr": "debounce($machine[M1].status, 3000)"},
    {"label": "Latest source timestamp", "expr": "latest_ts($machine[M1].status, $machine[M1].employee)"},
    {"label": "Value at completion time", "expr": "value_at($machine[M1].so, ts($machine[M1].lot_serial))"},
    {"label": "Zone name", "expr": "$machine[M1].@zone.@name"},
]


def function_catalog() -> list[dict[str, str]]:
    return [{"name": f.name, "signature": f.signature, "group": f.group, "description": f.description} for f in _FN.values()]


_BIN = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.FloorDiv: "//", ast.Mod: "%", ast.Pow: "**"}
_CMP = {ast.Eq: "==", ast.NotEq: "!=", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">="}
_LITERAL_NAMES = {"true": True, "True": True, "false": False, "False": False, "null": None, "None": None}


@dataclass(frozen=True)
class Program:
    text: str  # stored text
    tree: tuple[Any, ...]
    refs: tuple[TokenRef, ...]
    stateful_calls: int
    signal_ids: frozenset[str]
    resource_ids: frozenset[str]


class _Mapper:
    """Maps offsets of the placeholder text back to the stored text."""

    def __init__(self) -> None:
        self.anchors: list[tuple[int, int, int, int]] = []  # (sub_start, sub_end, orig_start, orig_end)

    def add(self, sub_start: int, sub_end: int, orig_start: int, orig_end: int) -> None:
        self.anchors.append((sub_start, sub_end, orig_start, orig_end))

    def orig(self, sub_offset: int) -> int:
        for s0, s1, o0, o1 in self.anchors:
            if s0 <= sub_offset < s1:
                if s1 - s0 == o1 - o0:
                    return o0 + (sub_offset - s0)
                return o0
        if self.anchors:
            s0, s1, o0, o1 = self.anchors[-1]
            return o1 + max(0, sub_offset - s1)
        return sub_offset


def _line_char_offset(text: str, lineno: int | None, col_chars: int | None) -> int | None:
    if lineno is None or col_chars is None:
        return None
    lines = text.split("\n")
    if lineno < 1 or lineno > len(lines):
        return None
    return sum(len(line) + 1 for line in lines[: lineno - 1]) + max(0, col_chars)


def _char_offset(text: str, lineno: int | None, col_bytes: int | None) -> int | None:
    if lineno is None or col_bytes is None:
        return None
    lines = text.split("\n")
    if lineno < 1 or lineno > len(lines):
        return None
    start = sum(len(line) + 1 for line in lines[: lineno - 1])
    prefix = lines[lineno - 1].encode("utf-8")[: max(0, col_bytes)].decode("utf-8", errors="ignore")
    return start + len(prefix)


def compile_rule(stored: str) -> Program:
    """Compile canonical rule text. Raises :class:`RuleError` with ``pos`` on any problem."""
    if not isinstance(stored, str) or not stored.strip():
        raise RuleError("EXPR_EMPTY", "The rule is empty.")
    if len(stored) > MAX_EXPR_LEN:
        raise RuleError("EXPR_TOO_LONG", f"A rule is limited to {MAX_EXPR_LEN} characters.")
    sc = scan(stored)
    if sc.issues:
        raise sc.issues[0]
    if sc.max_paren_depth > MAX_DEPTH:
        raise RuleError("LIMIT", f"The rule is nested too deeply (more than {MAX_DEPTH} levels).")
    refs: list[TokenRef] = []
    pieces: list[str] = []
    mapper = _Mapper()
    sub_len = 0
    offset = 0

    def emit(chunk: str, orig_start: int, orig_end: int) -> None:
        nonlocal sub_len
        pieces.append(chunk)
        mapper.add(sub_len, sub_len + len(chunk), orig_start, orig_end)
        sub_len += len(chunk)

    for part in sc.parts:
        if isinstance(part, str):
            start, k = offset, 0
            offset += len(part)
            cuts = sorted(p - start for p in sc.if_calls if start <= p < offset)
            for cut in [*cuts, len(part)]:
                if cut > k:
                    emit(part[k:cut], start + k, start + cut)
                if cut < len(part):
                    # functional ``if(`` is a Python keyword: parse it as a placeholder name
                    emit(_IF_PLACEHOLDER, start + cut, start + cut + 2)
                    k = cut + 2
            continue
        offset = part.end
        if isinstance(part, TokenRef):
            if part.kind == "res" and not part.attrs:
                raise RuleError("BAD_REF", "A resource reference needs .@name or .@code.", pos=part.start, end=part.end)
            emit(_PLACEHOLDER.format(len(refs)), part.start, part.end)
            refs.append(part)
        else:
            raise RuleError("BAD_REF", "Unresolved reference.", pos=part.start, end=part.end)
    source = "".join(pieces)
    wrapped = _wrap(source)
    try:
        tree = ast.parse(wrapped, mode="eval")
    except SyntaxError as exc:
        pos = _line_char_offset(wrapped, exc.lineno, (exc.offset or 1) - 1)
        pos = None if pos is None else mapper.orig(max(0, min(pos - 1, len(source) - 1)))
        message = (exc.msg or "invalid syntax").replace(_IF_PLACEHOLDER, "if").rstrip(".")
        suffix = "" if message.endswith("?") else "."
        raise RuleError("SYNTAX", f"Syntax error: {message}{suffix}", pos=pos) from None
    except (ValueError, RecursionError, MemoryError, OverflowError):
        raise RuleError("LIMIT", "The rule is too complex.") from None
    builder = _Builder(refs, mapper, wrapped)
    node = builder.build(tree)
    return Program(
        stored,
        node,
        tuple(refs),
        builder.stateful,
        frozenset(r.id for r in refs if r.kind == "sig"),
        frozenset(r.id for r in refs if r.kind == "res"),
    )


def _wrap(source: str) -> str:
    # Parenthesised so a multi-line rule parses; offsets are shifted by one (see SyntaxError path).
    return "(" + source + "\n)"


class _Builder:
    def __init__(self, refs: list[TokenRef], mapper: _Mapper, source: str) -> None:
        self.refs = refs
        self.mapper = mapper
        self.source = source
        self.stateful = 0

    def _pos(self, node: ast.AST) -> int | None:
        offset = _char_offset(self.source, getattr(node, "lineno", None), getattr(node, "col_offset", None))
        if offset is None:
            return None
        return self.mapper.orig(max(0, offset - 1))

    def _err(self, node: ast.AST, code: str, message: str, suggestions: list[str] | None = None) -> RuleError:
        return RuleError(code, message, pos=self._pos(node), suggestions=suggestions)

    def build(self, tree: ast.Expression) -> tuple[Any, ...]:
        count = 0
        stack: list[tuple[ast.AST, int]] = [(tree.body, 1)]
        while stack:
            node, depth = stack.pop()
            count += 1
            if count > MAX_NODES:
                raise RuleError("LIMIT", f"The rule is too long (more than {MAX_NODES} elements).")
            if depth > MAX_DEPTH:
                raise RuleError("LIMIT", f"The rule is nested too deeply (more than {MAX_DEPTH} levels).")
            stack.extend((child, depth + 1) for child in ast.iter_child_nodes(node))
        return self._node(tree.body)

    def _node(self, node: ast.AST) -> tuple[Any, ...]:
        if isinstance(node, ast.Constant):
            value = node.value
            if isinstance(value, bool) or value is None or isinstance(value, (str, float)):
                return ("const", value)
            if isinstance(value, int):
                if value.bit_length() > MAX_INT_BITS:
                    raise self._err(node, "LIMIT", "Number is too large.")
                return ("const", value)
            raise self._err(node, "NOT_ALLOWED", f"Literal of type {type(value).__name__} is not allowed.")
        if isinstance(node, ast.Name):
            if node.id in _LITERAL_NAMES:
                return ("const", _LITERAL_NAMES[node.id])
            if node.id.startswith("__fxr") and node.id.endswith("__"):
                try:
                    index = int(node.id[5:-2])
                except ValueError:
                    index = -1
                if 0 <= index < len(self.refs):
                    return ("ref", index)
            if node.id in _FN or node.id == _IF_PLACEHOLDER:
                name = "if" if node.id == _IF_PLACEHOLDER else node.id
                raise self._err(node, "SYNTAX", f"'{name}' is a function; call it like {_FN[name].signature}.")
            raise self._err(
                node,
                "UNKNOWN_NAME",
                f"Unknown name '{node.id}'. References start with $ (for example $machine[M1].temp); text needs quotes.",
                suggestions=_close(node.id, list(_FN)) or None,
            )
        if isinstance(node, ast.BinOp):
            op = _BIN.get(type(node.op))
            if op is None:
                raise self._err(node, "NOT_ALLOWED", "Operator is not allowed.")
            return ("bin", op, self._node(node.left), self._node(node.right))
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.USub):
                return ("neg", self._node(node.operand))
            if isinstance(node.op, ast.UAdd):
                return ("pos", self._node(node.operand))
            if isinstance(node.op, ast.Not):
                return ("not", self._node(node.operand))
            raise self._err(node, "NOT_ALLOWED", "Operator is not allowed.")
        if isinstance(node, ast.BoolOp):
            return ("and" if isinstance(node.op, ast.And) else "or", tuple(self._node(v) for v in node.values))
        if isinstance(node, ast.Compare):
            ops = []
            for op_node in node.ops:
                op = _CMP.get(type(op_node))
                if op is None:
                    raise self._err(node, "NOT_ALLOWED", "Only == != < <= > >= comparisons are allowed.")
                ops.append(op)
            return ("cmp", tuple(ops), tuple(self._node(v) for v in [node.left, *node.comparators]))
        if isinstance(node, ast.IfExp):
            return ("ifexp", self._node(node.test), self._node(node.body), self._node(node.orelse))
        if isinstance(node, ast.Call):
            return self._call(node)
        if isinstance(node, ast.Attribute):
            raise self._err(node, "NOT_ALLOWED", "Attribute access is not allowed; use $type[name].@name for resource attributes.")
        if isinstance(node, ast.Subscript):
            raise self._err(node, "NOT_ALLOWED", "Indexing is not allowed.")
        if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            raise self._err(node, "NOT_ALLOWED", "Lambdas and comprehensions are not allowed.")
        if isinstance(node, ast.JoinedStr):
            raise self._err(node, "NOT_ALLOWED", "f-strings are not allowed; use concat().")
        if isinstance(node, (ast.Tuple, ast.List, ast.Dict, ast.Set)):
            raise self._err(node, "NOT_ALLOWED", "Lists, tuples and dictionaries are not allowed.")
        if isinstance(node, ast.NamedExpr):
            raise self._err(node, "NOT_ALLOWED", "Assignment is not allowed inside a rule.")
        raise self._err(node, "NOT_ALLOWED", f"'{type(node).__name__}' is not allowed.")

    def _call(self, node: ast.Call) -> tuple[Any, ...]:
        if not isinstance(node.func, ast.Name):
            raise self._err(node, "NOT_ALLOWED", "Only built-in functions can be called.")
        name = "if" if node.func.id == _IF_PLACEHOLDER else node.func.id
        spec = _FN.get(name)
        if spec is None:
            raise self._err(
                node,
                "UNKNOWN_FUNCTION",
                f"Unknown function '{name}'.",
                suggestions=[_FN[n].signature for n in _close(name, list(_FN))] or None,
            )
        if node.keywords:
            raise self._err(node, "ARGS", f"{name}() takes positional arguments only: {spec.signature}.")
        if any(isinstance(a, ast.Starred) for a in node.args):
            raise self._err(node, "NOT_ALLOWED", "Star arguments are not allowed.")
        count = len(node.args)
        if count < spec.min_args or (spec.max_args is not None and count > spec.max_args):
            raise self._err(node, "ARGS", f"Wrong number of arguments: {spec.signature}.")
        args = tuple(self._node(a) for a in node.args)
        for index, arg in enumerate(args):
            needs_ref = -1 in spec.ref_args or index in spec.ref_args
            if needs_ref and not (arg[0] == "ref" and self.refs[arg[1]].kind == "sig"):
                raise self._err(node.args[index], "ARGS", f"{name}() needs a signal reference ($type[name].key) as argument {index + 1}.")
        call_id = -1
        if spec.stateful:
            call_id = self.stateful
            self.stateful += 1
        return ("call", name, args, call_id)


# ============================================================================================
# Evaluation
# ============================================================================================


@dataclass
class EvalContext:
    now: datetime
    samples: Mapping[str, Sample | None] = field(default_factory=dict)
    qualities: Mapping[str, str | None] = field(default_factory=dict)  # actual latest quality per signal
    catalog: Catalog | None = None
    lookup: Callable[[str, datetime], Sample | None] | None = None
    state: FilterState | None = None
    labels: Mapping[str, str] = field(default_factory=dict)


def _label(ctx: EvalContext, ref: TokenRef) -> str:
    return ctx.labels.get(ref.label_key) or ref.label_key


class _Eval:
    def __init__(self, program: Program, ctx: EvalContext, scope: Any) -> None:
        self.program = program
        self.ctx = ctx
        self.scope = scope
        self.steps = 0

    # ---- helpers -----------------------------------------------------------------------------

    def _tick(self) -> None:
        self.steps += 1
        if self.steps > MAX_STEPS:
            raise RuleRuntimeError("LIMIT", "The rule needed too many steps.")

    def sample(self, ref: TokenRef) -> Sample | None:
        if self.ctx.catalog is not None and not self.ctx.catalog.signal_live(ref.id):
            raise RuleRuntimeError("MISSING_REF", f"The referenced signal {_label(self.ctx, ref)} no longer exists.")
        return self.ctx.samples.get(ref.id)

    def ref_value(self, ref: TokenRef) -> Any:
        if ref.kind == "sig":
            sample = self.sample(ref)
            return None if sample is None else sample.value
        catalog = self.ctx.catalog
        if catalog is None or not catalog.resource_live(ref.id):
            raise RuleRuntimeError("MISSING_REF", f"The referenced resource {_label(self.ctx, ref)} no longer exists.")
        current = catalog.resource(ref.id)
        *hops, last = ref.attrs
        for hop in hops:
            assert current is not None
            found = catalog.nearest_of_type(current.id, hop)
            if found is None:
                raise RuleRuntimeError("NO_ANCESTOR", f"{current.name} has no {hop} above it.")
            current = found
        assert current is not None
        if last == "name":
            return current.name
        if last == "code":
            return current.code
        if last == "type":
            return current.type_key
        raise RuleRuntimeError("UNKNOWN_ATTRIBUTE", f"Unknown attribute .@{last}.")

    # ---- tree walk -----------------------------------------------------------------------------

    def run(self) -> Any:
        return self.ev(self.program.tree)

    def ev(self, node: tuple[Any, ...]) -> Any:
        self._tick()
        kind = node[0]
        if kind == "const":
            return node[1]
        if kind == "ref":
            return self.ref_value(self.program.refs[node[1]])
        if kind == "bin":
            return _binary(node[1], self.ev(node[2]), self.ev(node[3]))
        if kind == "neg":
            return _negate(self.ev(node[1]))
        if kind == "pos":
            value = self.ev(node[1])
            if value is None:
                return None
            if not _is_num(value):
                raise RuleRuntimeError("TYPE", f"Unary + needs a number, got {_tname(value)}.")
            return value
        if kind == "not":
            return not _truthy(self.ev(node[1]))
        if kind == "and":
            value: Any = True
            for item in node[1]:
                value = self.ev(item)
                if not _truthy(value):
                    return value
            return value
        if kind == "or":
            value = False
            for item in node[1]:
                value = self.ev(item)
                if _truthy(value):
                    return value
            return value
        if kind == "cmp":
            ops, operands = node[1], node[2]
            left = self.ev(operands[0])
            for op, right_node in zip(ops, operands[1:]):
                right = self.ev(right_node)
                outcome = _compare(op, left, right)
                if outcome is None:
                    return None
                if not outcome:
                    return False
                left = right
            return True
        if kind == "ifexp":
            return self.ev(node[2]) if _truthy(self.ev(node[1])) else self.ev(node[3])
        if kind == "call":
            return self.call(node[1], node[2], node[3])
        raise RuleRuntimeError("INTERNAL", f"Unknown node {kind}.")

    def call(self, name: str, args: tuple[Any, ...], call_id: int) -> Any:
        if name == "if":
            return self.ev(args[1]) if _truthy(self.ev(args[0])) else self.ev(args[2])
        if name == "coalesce":
            for arg in args:
                value = self.ev(arg)
                if value is not None:
                    return value
            return None
        if name == "now":
            return self.ctx.now
        if name in ("ts", "age", "quality", "latest_ts", "value_at"):
            return self.time_fn(name, args)
        values = [self.ev(a) for a in args]
        if _FN[name].stateful:
            return self.filter_fn(name, values, call_id)
        return _call_pure(name, values)

    def time_fn(self, name: str, args: tuple[Any, ...]) -> Any:
        refs = [self.program.refs[a[1]] for a in (args if name == "latest_ts" else args[:1])]
        if name == "latest_ts":
            times = [s.ts for s in (self.sample(r) for r in refs) if s is not None and s.ts is not None]
            return max(times) if times else None
        sample = self.sample(refs[0])
        if name == "ts":
            return None if sample is None else sample.ts
        if name == "age":
            if sample is None or sample.received_time is None:
                return None
            return (self.ctx.now - sample.received_time).total_seconds()
        if name == "quality":
            if refs[0].id in self.ctx.qualities:
                return self.ctx.qualities[refs[0].id]
            return None if sample is None else sample.quality
        # value_at
        when = self.ev(args[1])
        at = _to_instant(when)
        if at is None:
            return None
        if self.ctx.lookup is None:
            raise RuleRuntimeError("UNSUPPORTED", "value_at() is not available here.")
        found = self.ctx.lookup(refs[0].id, at)
        return None if found is None else found.value

    def filter_fn(self, name: str, values: list[Any], call_id: int) -> Any:
        state = self.ctx.state if self.ctx.state is not None else FilterState()
        key = (self.scope, call_id)
        prev = state.get(key)
        now = self.ctx.now
        x = values[0]
        if name == "debounce":
            ms = _param_ms(values[1], name)
            if prev is None:
                state.put(key, {"out": x, "cand": x, "since": now})
                return x
            out, cand, since = prev["out"], prev["cand"], prev["since"]
            if not _same(x, cand):
                cand, since = x, now
            if not _same(cand, out) and (now - since).total_seconds() * 1000 >= ms:
                out = cand
            state.put(key, {"out": out, "cand": cand, "since": since})
            return out
        if name == "hold":
            ms = _param_ms(values[1], name)
            if x is not None:
                state.put(key, {"last": x, "at": now})
                return x
            if prev is not None and (now - prev["at"]).total_seconds() * 1000 <= ms:
                return prev["last"]
            return None
        if name == "avg":
            n = values[1]
            if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= MAX_WINDOW:
                raise RuleRuntimeError("ARGS", f"avg(x, n) needs an integer n between 1 and {MAX_WINDOW}.")
            window = list(prev or [])
            if x is not None:
                if not _is_num(x):
                    raise RuleRuntimeError("TYPE", f"avg() needs numbers, got {_tname(x)}.")
                window.append(float(x))
            window = window[-n:]
            state.put(key, window)
            return _finite(sum(window) / len(window)) if window else None
        if name == "ema":
            alpha = values[1]
            if not _is_num(alpha) or not 0 < float(alpha) <= 1:
                raise RuleRuntimeError("ARGS", "ema(x, alpha) needs 0 < alpha <= 1.")
            if x is None:
                return prev
            if not _is_num(x):
                raise RuleRuntimeError("TYPE", f"ema() needs numbers, got {_tname(x)}.")
            value = float(x) if prev is None else float(alpha) * float(x) + (1 - float(alpha)) * prev
            value = _finite(value)
            state.put(key, value)
            return value
        if name in ("delta", "rate"):
            if x is None:
                return None
            if not _is_num(x):
                raise RuleRuntimeError("TYPE", f"{name}() needs numbers, got {_tname(x)}.")
            state.put(key, {"x": x, "at": now})
            if prev is None:
                return None
            diff = _binary("-", x, prev["x"])
            if name == "delta":
                return diff
            seconds = (now - prev["at"]).total_seconds()
            if seconds <= 0:
                return None
            return _finite(diff / seconds)
        if name == "hysteresis":
            low, high = values[1], values[2]
            if not _is_num(low) or not _is_num(high) or low > high:
                raise RuleRuntimeError("ARGS", "hysteresis(x, low, high) needs numbers with low <= high.")
            current = bool(prev) if prev is not None else False
            if x is None:
                return prev
            if not _is_num(x):
                raise RuleRuntimeError("TYPE", f"hysteresis() needs numbers, got {_tname(x)}.")
            if x >= high:
                current = True
            elif x <= low:
                current = False
            state.put(key, current)
            return current
        if name == "changed":
            state.put(key, {"x": x})
            return prev is not None and not _same(prev["x"], x)
        if name == "count_changes":
            if prev is None:
                state.put(key, {"x": x, "n": 0})
                return 0
            count = prev["n"] + (0 if _same(prev["x"], x) else 1)
            state.put(key, {"x": x, "n": count})
            return count
        raise RuleRuntimeError("INTERNAL", f"Unknown filter {name}.")


def evaluate_rule(program: Program, ctx: EvalContext, scope: Any = None) -> Any:
    """Evaluate a compiled rule. Raises :class:`RuleRuntimeError` (or :class:`LookupPending`)."""
    try:
        return _Eval(program, ctx, scope).run()
    except (RuleRuntimeError, LookupPending):
        raise
    except ZeroDivisionError:
        raise RuleRuntimeError("DIV0", "Division by zero.") from None
    except OverflowError:
        raise RuleRuntimeError("LIMIT", "Number out of range.") from None
    except RecursionError:
        raise RuleRuntimeError("LIMIT", "The rule is nested too deeply.") from None
    except (TypeError, ValueError) as exc:
        raise RuleRuntimeError("RUNTIME", str(exc) or "Invalid value.") from None


def evaluate_text(text: str, ctx: EvalContext, catalog: Catalog | None = None) -> Any:
    """Convenience for tests and previews: resolve (when a catalog is given), compile, evaluate."""
    if catalog is None:
        return evaluate_rule(compile_rule(text), ctx)
    resolved = resolve(text, catalog)
    errors = [i for i in resolved.issues if i.severity == "error"]
    if errors:
        raise errors[0]
    if ctx.catalog is None:
        ctx.catalog = catalog
    try:
        program = compile_rule(resolved.stored)
    except RuleError as exc:
        exc.pos, exc.end = resolved.original_pos(exc.pos), resolved.original_pos(exc.end)
        raise
    return evaluate_rule(program, ctx)


# ---- value semantics ------------------------------------------------------------------------


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float))


def _tname(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "text"
    if isinstance(value, datetime):
        return "timestamp"
    if isinstance(value, (list, dict)):
        return "JSON"
    return type(value).__name__


def _truthy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, datetime):
        return True
    return bool(value)


def _same(a: Any, b: Any) -> bool:
    if type(a) is not type(b) and not (_is_num(a) and _is_num(b)):
        return False
    return a == b


def _finite(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        raise RuleRuntimeError("RUNTIME", "The result is not a finite number.")
    if isinstance(value, int) and not isinstance(value, bool) and value.bit_length() > MAX_INT_BITS:
        raise RuleRuntimeError("LIMIT", "Number is too large.")
    return value


def _check_str(value: str) -> str:
    if len(value) > MAX_STR_LEN:
        raise RuleRuntimeError("LIMIT", f"Text longer than {MAX_STR_LEN} characters.")
    return value


def _binary(op: str, a: Any, b: Any) -> Any:
    if a is None or b is None:
        return None
    if op == "+":
        if _is_num(a) and _is_num(b):
            return _finite(a + b)
        if isinstance(a, str) and isinstance(b, str):
            if len(a) + len(b) > MAX_STR_LEN:
                raise RuleRuntimeError("LIMIT", f"Text longer than {MAX_STR_LEN} characters.")
            return a + b
        if isinstance(a, datetime) and _is_num(b) and not isinstance(b, bool):
            return a + timedelta(seconds=float(b))
        if _is_num(a) and not isinstance(a, bool) and isinstance(b, datetime):
            return b + timedelta(seconds=float(a))
        raise RuleRuntimeError("TYPE", f"Cannot add {_tname(a)} and {_tname(b)}; use concat() or str() for text.")
    if op == "-":
        if _is_num(a) and _is_num(b):
            return _finite(a - b)
        if isinstance(a, datetime) and isinstance(b, datetime):
            return (a - b).total_seconds()
        if isinstance(a, datetime) and _is_num(b) and not isinstance(b, bool):
            return a - timedelta(seconds=float(b))
        raise RuleRuntimeError("TYPE", f"Cannot subtract {_tname(b)} from {_tname(a)}.")
    if op == "*":
        if _is_num(a) and _is_num(b):
            return _finite(a * b)
        if isinstance(a, str) and isinstance(b, int) and not isinstance(b, bool):
            a, b = b, a
        if isinstance(a, int) and not isinstance(a, bool) and isinstance(b, str):
            if a * len(b) > MAX_STR_LEN:
                raise RuleRuntimeError("LIMIT", f"Text longer than {MAX_STR_LEN} characters.")
            return b * max(0, a)
        raise RuleRuntimeError("TYPE", f"Cannot multiply {_tname(a)} by {_tname(b)}.")
    if not (_is_num(a) and _is_num(b)):
        raise RuleRuntimeError("TYPE", f"Operator {op} needs numbers, got {_tname(a)} and {_tname(b)}.")
    if op == "/":
        if b == 0:
            raise RuleRuntimeError("DIV0", "Division by zero.")
        return _finite(a / b)
    if op == "//":
        if b == 0:
            raise RuleRuntimeError("DIV0", "Division by zero.")
        return _finite(a // b)
    if op == "%":
        if b == 0:
            raise RuleRuntimeError("DIV0", "Division by zero.")
        return _finite(a % b)
    if op == "**":
        return _power(a, b)
    raise RuleRuntimeError("INTERNAL", f"Unknown operator {op}.")


def _power(a: Any, b: Any) -> Any:
    if a == 0 and b < 0:
        raise RuleRuntimeError("DIV0", "Division by zero (0 to a negative power).")
    if isinstance(a, int) and isinstance(b, int) and not isinstance(b, bool) and b >= 0:
        base_bits = abs(int(a)).bit_length()
        if abs(a) > 1 and b * max(1, base_bits - 1) > MAX_INT_BITS:
            raise RuleRuntimeError("LIMIT", "Power result is too large.")
        return _finite(a**b)
    try:
        result = float(a) ** float(b)
    except OverflowError:
        raise RuleRuntimeError("LIMIT", "Power result is too large.") from None
    if isinstance(result, complex):
        raise RuleRuntimeError("RUNTIME", "Power of a negative number to a fractional exponent.")
    return _finite(result)


def _negate(value: Any) -> Any:
    if value is None:
        return None
    if not _is_num(value):
        raise RuleRuntimeError("TYPE", f"Cannot negate {_tname(value)}.")
    return -value


def _compare(op: str, a: Any, b: Any) -> bool | None:
    if op in ("==", "!="):
        equal = _same(a, b)
        return equal if op == "==" else not equal
    if a is None or b is None:
        return None
    comparable = (_is_num(a) and _is_num(b)) or (isinstance(a, str) and isinstance(b, str)) or (isinstance(a, datetime) and isinstance(b, datetime))
    if not comparable:
        raise RuleRuntimeError("TYPE", f"Cannot compare {_tname(a)} with {_tname(b)}.")
    if op == "<":
        return a < b
    if op == "<=":
        return a <= b
    if op == ">":
        return a > b
    return a >= b


def _to_instant(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return as_utc(value)
    if isinstance(value, str):
        parsed = as_utc(value)
        if parsed is None:
            raise RuleRuntimeError("TYPE", f"'{value[:40]}' is not a timestamp.")
        return parsed
    if _is_num(value) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            raise RuleRuntimeError("RUNTIME", "Timestamp out of range.") from None
    raise RuleRuntimeError("TYPE", f"Expected a timestamp, got {_tname(value)}.")


def _param_ms(value: Any, name: str) -> float:
    if not _is_num(value) or isinstance(value, bool) or not 0 <= value <= MAX_FILTER_MS:
        raise RuleRuntimeError("ARGS", f"{name}() needs milliseconds between 0 and {MAX_FILTER_MS}.")
    return float(value)


def to_text(value: Any) -> str:
    """Text form used by str(), concat() and the ``string`` value type."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return fmt_ts(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value) if not isinstance(value, float) else repr(value)


_TRUE_WORDS = {"true", "1", "yes", "on", "y", "t"}
_FALSE_WORDS = {"false", "0", "no", "off", "n", "f", ""}


def to_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise RuleRuntimeError("CAST", "Cannot convert a non-finite number to int.")
        return int(value)
    if isinstance(value, datetime):
        return int(round(as_utc(value).timestamp() * 1000))  # type: ignore[union-attr]
    if isinstance(value, str):
        text = value.strip()
        try:
            return int(text, 10)
        except ValueError:
            pass
        try:
            number = float(text)
        except ValueError:
            raise RuleRuntimeError("CAST", f"Cannot convert '{text[:40]}' to int.") from None
        return to_int(number)
    raise RuleRuntimeError("CAST", f"Cannot convert {_tname(value)} to int.")


def to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (bool, int, float)):
        result = float(value)
    elif isinstance(value, datetime):
        result = as_utc(value).timestamp() * 1000.0  # type: ignore[union-attr]
    elif isinstance(value, str):
        try:
            result = float(value.strip())
        except ValueError:
            raise RuleRuntimeError("CAST", f"Cannot convert '{value[:40]}' to float.") from None
    else:
        raise RuleRuntimeError("CAST", f"Cannot convert {_tname(value)} to float.")
    if not math.isfinite(result):
        raise RuleRuntimeError("CAST", "Not a finite number.")
    return result


def to_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        word = value.strip().lower()
        if word in _TRUE_WORDS:
            return True
        if word in _FALSE_WORDS:
            return False
        raise RuleRuntimeError("CAST", f"Cannot convert '{value[:40]}' to bool.")
    raise RuleRuntimeError("CAST", f"Cannot convert {_tname(value)} to bool.")


def _round_half_up(value: float | int, digits: int) -> Decimal:
    try:
        return Decimal(repr(value) if isinstance(value, float) else str(value)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise RuleRuntimeError("RUNTIME", "Cannot round this number.") from None


def _need_num(name: str, *values: Any) -> None:
    for value in values:
        if not _is_num(value):
            raise RuleRuntimeError("TYPE", f"{name}() needs numbers, got {_tname(value)}.")


def _digits(name: str, value: Any, lo: int, hi: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise RuleRuntimeError("ARGS", f"{name}() needs digits between {lo} and {hi}.")
    return value


_MATH1: dict[str, Callable[[float], float]] = {
    "sqrt": math.sqrt,
    "exp": math.exp,
    "log10": math.log10,
    "log2": math.log2,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
    "degrees": math.degrees,
    "radians": math.radians,
}


def _call_pure(name: str, values: list[Any]) -> Any:  # noqa: C901 - one dispatch table
    if name == "isnull":
        return values[0] is None
    if name in ("min", "max"):
        present = [v for v in values if v is not None]
        if not present:
            return None
        best = present[0]
        for item in present[1:]:
            outcome = _compare("<" if name == "min" else ">", item, best)
            if outcome:
                best = item
        return best
    if name == "concat":
        return _check_str("".join("" if v is None else to_text(v) for v in values))
    if name == "str":
        return None if values[0] is None else _check_str(to_text(values[0]))
    if name == "int":
        return to_int(values[0])
    if name == "float":
        return to_float(values[0])
    if name == "bool":
        return to_bool(values[0])
    if name in ("upper", "lower"):
        if values[0] is None:
            return None
        text = to_text(values[0])
        return text.upper() if name == "upper" else text.lower()
    if name == "len":
        value = values[0]
        if value is None:
            return None
        if isinstance(value, (str, list, dict)):
            return len(value)
        raise RuleRuntimeError("TYPE", f"len() needs text, got {_tname(value)}.")
    if name == "substr":
        if values[0] is None:
            return None
        text = to_text(values[0])
        start = values[1]
        if not isinstance(start, int) or isinstance(start, bool):
            raise RuleRuntimeError("ARGS", "substr(s, start, length) needs an integer start.")
        rest = text[start:] if start >= 0 else text[max(0, len(text) + start) :]
        if len(values) == 3 and values[2] is not None:
            length = values[2]
            if not isinstance(length, int) or isinstance(length, bool) or length < 0:
                raise RuleRuntimeError("ARGS", "substr(s, start, length) needs a length >= 0.")
            rest = rest[:length]
        return rest
    if name == "replace":
        if values[0] is None:
            return None
        text, old, new = to_text(values[0]), values[1], values[2]
        old = "" if old is None else to_text(old)
        new = "" if new is None else to_text(new)
        if old == "":
            raise RuleRuntimeError("ARGS", "replace() needs a non-empty text to replace.")
        if len(text) + text.count(old) * (len(new) - len(old)) > MAX_STR_LEN:
            raise RuleRuntimeError("LIMIT", f"Text longer than {MAX_STR_LEN} characters.")
        return text.replace(old, new)
    if name == "format":
        if values[0] is None:
            return None
        _need_num(name, values[0])
        digits = _digits(name, values[1], 0, 15)
        if isinstance(values[0], float) and not math.isfinite(values[0]):
            raise RuleRuntimeError("RUNTIME", "Cannot format a non-finite number.")
        return f"{_round_half_up(values[0], digits):f}"
    # math: null in -> null out
    if any(v is None for v in values):
        return None
    _need_num(name, *values)
    try:
        if name == "abs":
            return abs(values[0])
        if name == "round":
            digits = _digits(name, values[1], -15, 15) if len(values) == 2 else 0
            rounded = _round_half_up(values[0], digits)
            return int(rounded) if len(values) == 1 or digits <= 0 and isinstance(values[0], int) else float(rounded)
        if name == "floor":
            return math.floor(values[0])
        if name == "ceil":
            return math.ceil(values[0])
        if name == "sign":
            return (values[0] > 0) - (values[0] < 0)
        if name == "pow":
            return _power(values[0], values[1])
        if name == "log":
            if len(values) == 2:
                return _finite(math.log(values[0], values[1]))
            return _finite(math.log(values[0]))
        if name == "atan2":
            return math.atan2(values[0], values[1])
        if name == "hypot":
            return _finite(math.hypot(*values))
        if name == "clamp":
            x, lo, hi = values
            if lo > hi:
                raise RuleRuntimeError("ARGS", "clamp(x, lo, hi) needs lo <= hi.")
            return min(max(x, lo), hi)
        if name in _MATH1:
            return _finite(_MATH1[name](values[0]))
    except RuleRuntimeError:
        raise
    except ValueError:
        raise RuleRuntimeError("RUNTIME", f"Math domain error in {name}().") from None
    except ZeroDivisionError:
        raise RuleRuntimeError("DIV0", f"Division by zero in {name}().") from None
    except OverflowError:
        raise RuleRuntimeError("LIMIT", f"Number out of range in {name}().") from None
    raise RuleRuntimeError("INTERNAL", f"Unknown function {name}.")
