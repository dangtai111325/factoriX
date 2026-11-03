"""Deterministic resource import plans; this module performs no I/O."""

from __future__ import annotations

import copy
import hashlib
import json
from collections import defaultdict, deque
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from factorix.domain.resources import ResourceInvariantError, validate_code


class ImportAction(StrEnum):
    CREATE = "CREATE"
    REUSE = "REUSE"


@dataclass(frozen=True)
class ModelNode:
    id: str
    code: str
    name: str
    type_key: str
    parent_id: str | None = None
    site_id: str | None = None
    archived: bool = False
    version: int = 1
    description: str = ""
    properties: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ImportIssue:
    row: int
    code: str
    message: str
    field: str = ""


@dataclass
class ImportItem:
    index: int
    row: int
    action: ImportAction
    path: str
    code: str
    name: str
    type_key: str
    parent_path: str = ""
    parent_id: str | None = None
    parent_index: int | None = None
    existing_id: str | None = None
    existing_version: int | None = None
    description: str = ""
    properties: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    timezone: str = "Asia/Ho_Chi_Minh"
    site_id: str | None = None
    site_index: int | None = None
    scope_key: str | None = None
    differences: dict[str, Any] = field(default_factory=dict)


@dataclass
class ImportPlan:
    items: list[ImportItem]
    errors: list[ImportIssue]
    warnings: list[ImportIssue]
    plan_hash: str | None


def plan_resources(rows: list[dict[str, Any]], model: list[ModelNode], types: dict[str, set[str]], *,
                   sites: dict[str, str | None] | None = None, site_id: str | None = None,
                   default_parent_id: str | None = None, hierarchy_mode: str = "guided") -> ImportPlan:
    return _Planner(rows, model, types, sites, site_id, default_parent_id, hierarchy_mode).plan()


class _Fault(ValueError):
    def __init__(self, code: str, message: str, field_name: str = ""):
        super().__init__(message)
        self.code, self.field = code, field_name


class _PendingParent(Exception):
    def __init__(self, indices: list[int]):
        self.indices = indices


@dataclass
class _Row:
    index: int
    number: int
    code: str
    name: str
    type_key: str
    path: tuple[str, ...] | None
    parent_path: tuple[str, ...] | None
    parent_id: str | None
    parent_code: str | None
    site_id: str | None
    timezone: str
    description: str
    properties: dict[str, Any]
    tags: list[str]
    provided: set[str]


@dataclass
class _Parent:
    path: tuple[str, ...]
    code: str
    type_key: str
    scope: str | None
    id: str | None = None
    index: int | None = None
    archived: bool = False


def _text(raw: dict[str, Any], key: str, default: str = "") -> str:
    value = raw.get(key, default)
    if not isinstance(value, str):
        raise _Fault("FIELD", f"{key} must be text.", key)
    return value


def _path(value: str) -> tuple[str, ...]:
    if not value.strip(" / "):
        return ()
    try:
        return tuple(validate_code(part) for part in value.strip().strip("/").split("/"))
    except ResourceInvariantError as exc:
        raise _Fault(exc.code, "A path contains an invalid resource code.", "path") from exc


def _properties(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if isinstance(value, str) else copy.deepcopy(value)
        if not isinstance(parsed, dict):
            raise ValueError("object")
        json.dumps(parsed, allow_nan=False)
        return parsed
    except (TypeError, ValueError, RecursionError) as exc:
        raise _Fault("PROPERTIES", "Properties must be a JSON object with finite numbers.", "properties") from exc


def _tags(value: Any) -> list[str]:
    try:
        parsed = json.loads(value) if isinstance(value, str) and value.lstrip().startswith("[") else value
        if isinstance(parsed, str):
            parsed = [tag.strip() for tag in parsed.split(";") if tag.strip()]
        if not isinstance(parsed, list) or len(parsed) > 32 or any(not isinstance(tag, str) for tag in parsed):
            raise ValueError("tags")
        return parsed
    except (TypeError, ValueError) as exc:
        raise _Fault("TAGS", "Use at most 32 text tags, as a JSON array or separated by semicolons.", "tags") from exc


class _Planner:
    def __init__(self, raw_rows, model, types, sites, site_id, default_parent_id, hierarchy_mode):
        self.raw_rows, self.types = raw_rows, types
        self.model = {node.id: node for node in model}
        self.model_codes: dict[str, list[ModelNode]] = defaultdict(list)
        for node in model:
            self.model_codes[node.code].append(node)
        self.sites = dict(sites) if sites is not None else {node.site_id: None for node in model if node.site_id}
        if sites is None:
            self.sites.update({node.site_id: node.id for node in model if node.site_id and node.type_key == "site"})
        self.default_site, self.default_parent, self.mode = site_id, default_parent_id, hierarchy_mode
        self.errors: list[ImportIssue] = []
        self.warnings: list[ImportIssue] = []
        self.paths: dict[str, tuple[str, ...]] = {}
        self.existing_paths: dict[tuple[str, ...], ModelNode] = {}
        self.rows: dict[int, _Row] = {}
        self.row_codes: dict[str, list[_Row]] = defaultdict(list)
        self.declared: dict[tuple[str, ...], list[int]] = {}
        self.invalid: set[int] = set()
        self.resolved: dict[int, ImportItem] = {}
        self.resolved_paths: dict[tuple[str, ...], int] = {}
        self.reserved_scopes: dict[str, int] = {}

    def plan(self) -> ImportPlan:
        try:
            self._context()
        except _Fault as exc:
            return ImportPlan([], [ImportIssue(0, exc.code, str(exc), exc.field)], [], None)
        for index, raw in enumerate(self.raw_rows):
            number = index + 1
            try:
                number = int(raw.get("source_row", number))
                if number < 1:
                    raise ValueError("source row")
                row = self._parse(index, number, raw)
                self.rows[index] = row
                self.row_codes[row.code].append(row)
                declared = self._declared_path(row)
                if declared is not None:
                    self.declared.setdefault(declared, []).append(index)
            except _Fault as exc:
                self._error(index, number, exc)
            except (TypeError, ValueError):
                self._error(index, index + 1, _Fault("ROW", "Invalid source row number.", "source_row"))
        for path, indices in self.declared.items():
            if len(indices) > 1:
                for index in indices:
                    self._error(index, self.rows[index].number, _Fault("DUPLICATE", f"Duplicate import path: {'/'.join(path)}.", "path"))
        ready = deque(index for index in self.rows if index not in self.invalid)
        waiting: dict[int, set[int]] = defaultdict(set)
        blocked: dict[int, set[int]] = {}
        while ready:
            index = ready.popleft()
            row = self.rows[index]
            try:
                item = self._resolve(row)
                self.resolved[index] = item
                self.resolved_paths[tuple(item.path.split("/"))] = index
            except _PendingParent as pending:
                blocked[index] = set(pending.indices)
                for dependency in pending.indices:
                    waiting[dependency].add(index)
                continue
            except _Fault as exc:
                self._error(index, row.number, exc)
            for child in sorted(waiting.pop(index, ())):
                dependencies = blocked[child]
                dependencies.discard(index)
                if not dependencies:
                    del blocked[child]
                    ready.append(child)
        for index in self.rows.keys() - self.resolved.keys() - self.invalid:
            self._error(index, self.rows[index].number, _Fault("CYCLE", "The unresolved parent references form a cycle or depend on one.", "parent"))
        items = list(self.resolved.values())
        digest = None
        if not self.errors:
            payload = {"items": [asdict(item) for item in items], "warnings": [asdict(item) for item in self.warnings]}
            digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        return ImportPlan(items, self.errors, self.warnings, digest)

    def _error(self, index: int, number: int, fault: _Fault) -> None:
        self.invalid.add(index)
        self.errors.append(ImportIssue(number, fault.code, str(fault), fault.field))

    def _context(self) -> None:
        if not self.raw_rows or len(self.raw_rows) > 2000:
            raise _Fault("LIMIT", "Import between 1 and 2000 resource rows.")
        if self.mode not in {"guided", "strict"}:
            raise _Fault("HIERARCHY", "Hierarchy mode must be guided or strict.")
        if self.default_site and self.default_site not in self.sites:
            raise _Fault("SITE_SCOPE", "The selected Site scope does not exist.")
        if self.default_parent and self.default_parent not in self.model:
            raise _Fault("MISSING_PARENT", "The selected default parent does not exist.")
        for node in self.model.values():
            chain, seen, current = [], set(), node.id
            while current is not None and current not in self.paths:
                if current in seen or current not in self.model:
                    raise _Fault("MODEL", "The existing model has an invalid parent chain; resolve it before importing.")
                seen.add(current)
                current_node = self.model[current]
                chain.append(current_node)
                current = current_node.parent_id
            path = self.paths.get(current, ())
            for ancestor in reversed(chain):
                path = (*path, ancestor.code)
                self.paths[ancestor.id] = path
                if path in self.existing_paths:
                    raise _Fault("MODEL", "The existing model has duplicate paths; resolve them before importing.")
                self.existing_paths[path] = ancestor

    def _parse(self, index: int, number: int, raw: dict[str, Any]) -> _Row:
        name, type_key = _text(raw, "name").strip(), _text(raw, "type_key").strip()
        if not name or len(name) > 200:
            raise _Fault("NAME", "Name must contain between 1 and 200 characters.", "name")
        if type_key not in self.types:
            raise _Fault("UNKNOWN_TYPE", "Resource type does not exist.", "type_key")
        path_text = _text(raw, "path").strip()
        path = _path(path_text) if path_text else None
        if path == ():
            raise _Fault("PATH", "Resource paths need a final code.", "path")
        try:
            code = validate_code(_text(raw, "code").strip() or (path[-1] if path else ""))
        except ResourceInvariantError as exc:
            raise _Fault(exc.code, str(exc), "code") from exc
        if path and code != path[-1]:
            raise _Fault("PATH_CODE", "Code must match the last segment of the resource path.", "code")
        parent_text = _text(raw, "parent_path").strip()
        parent_path = _path(parent_text) if parent_text else None
        if path and parent_path is not None and path[:-1] != parent_path:
            raise _Fault("PARENT_CONFLICT", "Path and parent_path refer to different parents.", "parent_path")
        scope = _text(raw, "site_id").strip() or None
        if scope and scope not in self.sites:
            raise _Fault("SITE_SCOPE", "Site scope does not exist.", "site_id")
        timezone = _text(raw, "timezone").strip() or "Asia/Ho_Chi_Minh"
        if type_key == "site":
            try:
                ZoneInfo(timezone)
            except (ValueError, ZoneInfoNotFoundError) as exc:
                raise _Fault("TIMEZONE", "Select a valid IANA timezone.", "timezone") from exc
        props = _properties(raw["properties"]) if "properties" in raw and raw["properties"] != "" else {}
        tags = _tags(raw["tags"]) if "tags" in raw and raw["tags"] != "" else []
        provided = {"name"}
        if "description" in raw:
            provided.add("description")
        provided.update(key for key in ("properties", "tags") if key in raw and raw[key] != "")
        return _Row(index, number, code, name, type_key, path, parent_path,
                    _text(raw, "parent_id").strip() or None, _text(raw, "parent_code").strip() or None,
                    scope, timezone, _text(raw, "description"), props, tags, provided)

    def _declared_path(self, row: _Row) -> tuple[str, ...] | None:
        if row.path is not None:
            return row.path
        if row.parent_path is not None:
            return (*row.parent_path, row.code)
        if row.parent_id in self.paths:
            return (*self.paths[row.parent_id], row.code)
        if not row.parent_code and not row.parent_id:
            return (*self.paths.get(self.default_parent, ()), row.code)
        return None

    def _model_parent(self, node_id: str) -> _Parent:
        node = self.model.get(node_id)
        if node is None:
            raise _Fault("MISSING_PARENT", "Parent ID does not exist in this model.", "parent_id")
        return _Parent(self.paths[node.id], node.code, node.type_key, node.site_id, id=node.id, archived=node.archived)

    def _row_parent(self, index: int) -> _Parent:
        if index in self.invalid:
            raise _Fault("PARENT_INVALID", "The referenced parent row has errors.", "parent")
        item = self.resolved.get(index)
        if item is None:
            raise _PendingParent([index])
        return _Parent(tuple(item.path.split("/")), item.code, item.type_key, item.scope_key,
                       id=item.existing_id, index=index)

    def _path_parent(self, path: tuple[str, ...]) -> _Parent | None:
        if not path:
            return None
        candidates = self.declared.get(path, [])
        if len(candidates) > 1:
            raise _Fault("AMBIGUOUS_PARENT", "More than one import row declares the parent path.", "parent_path")
        if candidates:
            return self._row_parent(candidates[0])
        if path in self.resolved_paths:
            return self._row_parent(self.resolved_paths[path])
        if path in self.existing_paths:
            return self._model_parent(self.existing_paths[path].id)
        possible = [row.index for row in self.row_codes.get(path[-1], [])
                    if self._declared_path(row) is None and row.index not in self.resolved and row.index not in self.invalid]
        if possible:
            raise _PendingParent(possible)
        raise _Fault("MISSING_PARENT", f"Parent path not found: {'/'.join(path)}.", "parent_path")

    def _code_parent(self, code: str) -> _Parent:
        imported = self.row_codes.get(code, [])
        unresolved = [row.index for row in imported if row.index not in self.resolved and row.index not in self.invalid]
        if unresolved:
            raise _PendingParent(unresolved)
        matches = {self.paths[node.id]: self._model_parent(node.id) for node in self.model_codes.get(code, [])}
        for row in imported:
            parent = self._row_parent(row.index)
            matches[parent.path] = parent
        if not matches:
            raise _Fault("MISSING_PARENT", f"Parent code not found: {code}.", "parent_code")
        if len(matches) > 1:
            raise _Fault("AMBIGUOUS_PARENT", f"Parent code {code} is ambiguous. Use parent_path or parent_id.", "parent_code")
        return next(iter(matches.values()))

    def _parent(self, row: _Row) -> _Parent | None:
        references = []
        if row.path is not None:
            references.append(self._path_parent(row.path[:-1]))
        if row.parent_path is not None:
            references.append(self._path_parent(row.parent_path))
        if row.parent_id:
            references.append(self._model_parent(row.parent_id))
        if references:
            parent = references[0]
            if any((ref.path if ref else ()) != (parent.path if parent else ()) for ref in references[1:]):
                raise _Fault("PARENT_CONFLICT", "The supplied references point to different parents.", "parent")
            if row.parent_code and (parent is None or parent.code != row.parent_code):
                raise _Fault("PARENT_CONFLICT", "The parent code does not match the explicit parent reference.", "parent_code")
            return parent
        if row.parent_code:
            return self._code_parent(row.parent_code)
        return self._model_parent(self.default_parent) if self.default_parent else None

    def _resolve(self, row: _Row) -> ImportItem:
        parent = self._parent(row)
        path = (*(parent.path if parent else ()), row.code)
        if row.path is not None and row.path != path:
            raise _Fault("PARENT_CONFLICT", "The resource path does not match its resolved parent.", "path")
        if path in self.resolved_paths:
            other = self.rows[self.resolved_paths[path]]
            self._error(other.index, other.number, _Fault("DUPLICATE", "Another row resolves to the same sibling identity.", "path"))
            raise _Fault("DUPLICATE", "Another row resolves to the same sibling identity.", "path")
        existing = self.existing_paths.get(path)
        if existing and existing.archived:
            raise _Fault("ARCHIVED", "This identity is archived. Restore it explicitly before importing it.", "path")
        if parent and parent.archived:
            raise _Fault("ARCHIVED_PARENT", "Restore the parent resource before adding children.", "parent")
        if existing and existing.type_key != row.type_key:
            raise _Fault("TYPE_CONFLICT", "The existing resource has a different type. Import cannot retype it.", "type_key")
        item = ImportItem(row.index, row.number, ImportAction.REUSE if existing else ImportAction.CREATE, "/".join(path),
                          row.code, row.name, row.type_key, parent_path="/".join(parent.path) if parent else "",
                          parent_id=parent.id if parent else None, parent_index=parent.index if parent else None,
                          description=row.description, properties=row.properties, tags=row.tags, timezone=row.timezone)
        if existing:
            if row.site_id and row.site_id != existing.site_id:
                raise _Fault("SITE_SCOPE", "The existing resource belongs to a different Site scope.", "site_id")
            for key in row.provided:
                incoming, current = getattr(row, key), getattr(existing, key)
                if json.dumps(incoming, sort_keys=True, allow_nan=False) != json.dumps(current, sort_keys=True, allow_nan=False):
                    item.differences[key] = {"incoming": incoming, "existing": copy.deepcopy(current)}
            item.existing_id, item.existing_version = existing.id, existing.version
            item.name, item.description = existing.name, existing.description
            item.properties, item.tags = copy.deepcopy(existing.properties), list(existing.tags)
            item.site_id, item.scope_key = existing.site_id, existing.site_id
            if item.differences:
                self.warnings.append(ImportIssue(row.number, "EXISTING_VALUES_KEPT", "Existing data is retained; incoming differences will not be applied."))
            return item
        self._placement(row, parent)
        if row.type_key == "site":
            if parent and parent.scope:
                raise _Fault("SITE_SCOPE", "A physical Site cannot be nested inside another Site scope.", "parent")
            scope = row.site_id or self.default_site
            if scope:
                if self.sites[scope] is not None or scope in self.reserved_scopes:
                    raise _Fault("SITE_ANCHORED", "This Site scope already has a model anchor.", "site_id")
                self.reserved_scopes[scope] = row.index
                item.site_id, item.scope_key = scope, scope
            else:
                item.site_index, item.scope_key = row.index, f"$new-site:{row.index}"
        else:
            scope = parent.scope if parent else None
            if scope and row.site_id and row.site_id != scope:
                raise _Fault("SITE_SCOPE", "The resource must use its parent's Site scope.", "site_id")
            scope = scope or row.site_id or (self.default_site if row.type_key != "enterprise" else None)
            item.scope_key = scope
            if scope and scope.startswith("$new-site:"):
                item.site_index = int(scope.split(":", 1)[1])
            else:
                item.site_id = scope
            if scope is None and row.type_key != "enterprise":
                self.warnings.append(ImportIssue(row.number, "SITE_UNASSIGNED", "Assign this resource to a Site before mapping a data source."))
        return item

    def _placement(self, row: _Row, parent: _Parent | None) -> None:
        recommended = parent.type_key in self.types[row.type_key] if parent else row.type_key == "enterprise"
        if not recommended:
            if self.mode == "strict":
                raise _Fault("ADJACENCY", "This placement is outside the recommended type hierarchy.", "parent")
            self.warnings.append(ImportIssue(row.number, "NOT_RECOMMENDED", "This placement is outside the recommended type hierarchy."))
