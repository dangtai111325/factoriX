// Pure body-tree logic for the Data Model v2 builder: wire conversion, tree edits, local validation,
// auto-mapping ("Map all"), the "Paste JSON" skeleton and the client-side duplicate preview.
import { JNode, parseOrderedJson } from '../06_AddDataWizard/jsonTree';
import {
  CatalogIndex,
  referencedResources,
  referencedSignals,
  resourceLabel,
  resourcePath,
  resourceSelector,
  signalRef,
  signalsUnder,
} from './rules';
import {
  ApiContainerNode,
  ApiFieldNode,
  ApiNode,
  ApiSpec,
  BodyNode,
  CatalogSignal,
  ContainerNode,
  DEPTH_MAX,
  FIELDS_MAX,
  FieldError,
  FieldNode,
  KEY_MAX,
  ValueType,
  VALUE_TYPES,
  isContainer,
} from './types';

let seq = 0;
export const newUid = (): string => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

export const emptyRoot = (): ContainerNode => ({ uid: 'root', type: 'object', key: '', children: [] });

export function newField(key: string, init: Partial<FieldNode> = {}): FieldNode {
  return {
    uid: newUid(),
    type: 'field',
    key,
    mode: 'mapping',
    valueType: 'auto',
    signalId: '',
    exprRaw: '',
    exprText: '',
    exprEdited: false,
    refDisplay: '',
    refTooltip: '',
    missing: false,
    ...init,
  };
}

export function newRule(key: string, expr: string, valueType: ValueType = 'auto'): FieldNode {
  return newField(key, { mode: 'calculated', exprText: expr, exprEdited: true, valueType });
}

export function newContainer(type: 'object' | 'array', key: string, children: BodyNode[] = []): ContainerNode {
  return { uid: newUid(), type, key, children };
}

// ------------------------------------------------------------------ wire conversion

/** Row ids are sent to the server as node `id` (≤ 64 chars) and echoed in errors as `node_id`. */
const keepId = (id: unknown): string | null => (typeof id === 'string' && id && id.length <= 64 ? id : null);

function refInfoText(f: ApiFieldNode): string {
  const info = f.ref_info;
  if (!info) return '';
  const lines = [`${info.path || info.resource_name || ''}${info.signal_key ? ` › ${info.signal_key}` : ''}${info.signal_name && info.signal_name !== info.signal_key ? ` (${info.signal_name})` : ''}`];
  const conn = [info.connection_name, info.protocol].filter(Boolean).join(' · ');
  if (conn) lines.push(`Connection: ${conn}`);
  if (info.data_type) lines.push(`Type: ${info.data_type}${info.unit ? ` [${info.unit}]` : ''}`);
  return lines.join('\n');
}

function fromApiNode(node: ApiNode, seen: Set<string>): BodyNode {
  const id = keepId(node.id);
  const uid = id && !seen.has(id) ? id : newUid();
  seen.add(uid);
  if (node.type === 'object' || node.type === 'array') {
    const c = node as ApiContainerNode;
    return { ...newContainer(c.type, String(c.key ?? ''), (c.children || []).map((ch) => fromApiNode(ch, seen))), uid };
  }
  const f = node as ApiFieldNode;
  const valueType = (VALUE_TYPES as string[]).includes(String(f.value_type)) ? (f.value_type as ValueType) : 'auto';
  const raw = f.expr ? String(f.expr) : '';
  return {
    ...newField(String(f.key ?? ''), {
      mode: f.mode === 'calculated' ? 'calculated' : 'mapping',
      valueType,
      signalId: f.ref?.signal_id ? String(f.ref.signal_id) : '',
      exprRaw: raw,
      exprText: f.expr_display ? String(f.expr_display) : raw,
      exprEdited: false,
      refDisplay: f.ref_display ? String(f.ref_display) : '',
      refTooltip: refInfoText(f),
      missing: Boolean(f.missing),
    }),
    uid,
  };
}

export function fromApi(spec: ApiSpec): ContainerNode {
  const root = emptyRoot();
  const seen = new Set<string>([root.uid]);
  root.children = (spec.root?.children || []).map((c) => fromApiNode(c, seen));
  return root;
}

function toApiNode(node: BodyNode, inArray: boolean): ApiNode {
  const keyPart = inArray ? { id: node.uid } : { id: node.uid, key: node.key };
  if (isContainer(node)) return { ...keyPart, type: node.type, children: node.children.map((c) => toApiNode(c, node.type === 'array')) };
  if (node.mode === 'mapping') {
    return { ...keyPart, type: 'field', mode: 'mapping', value_type: node.valueType, ref: node.signalId ? { signal_id: node.signalId } : null };
  }
  // Unchanged rules keep their canonical tokens; edited ones send the typed text (the server resolves it).
  const expr = node.exprEdited || !node.exprRaw ? node.exprText : node.exprRaw;
  return { ...keyPart, type: 'field', mode: 'calculated', value_type: node.valueType, expr };
}

export function toApi(root: ContainerNode, labels?: Record<string, string>): ApiSpec {
  const spec: ApiSpec = { version: 2, root: { type: 'object', children: root.children.map((c) => toApiNode(c, false)) } };
  if (labels && Object.keys(labels).length) spec.labels = labels;
  return spec;
}

/** Stable text of the spec (dirty check). */
export function specFingerprint(root: ContainerNode): string {
  return JSON.stringify(toApi(root));
}

// ------------------------------------------------------------------ traversal

export interface Located {
  node: BodyNode;
  parent: ContainerNode;
  index: number;
  depth: number;
}

export function locate(root: ContainerNode, uid: string): Located | null {
  const walk = (parent: ContainerNode, depth: number): Located | null => {
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i];
      if (child.uid === uid) return { node: child, parent, index: i, depth };
      if (isContainer(child)) {
        const hit = walk(child, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  if (uid === root.uid) return null;
  return walk(root, 1);
}

export function findContainer(root: ContainerNode, uid: string | null): ContainerNode {
  if (!uid || uid === root.uid) return root;
  const hit = locate(root, uid);
  return hit && isContainer(hit.node) ? hit.node : root;
}

export interface FlatRow {
  node: BodyNode;
  parent: ContainerNode;
  depth: number;
  index: number;
  /** Dotted key path with array indexes: "electrical.voltage_1", "temps[0]". */
  path: string;
  /** JSON pointer, as the server reports errors: "/electrical/voltage_1", "/temps/0". */
  pointer: string;
  segments: Array<string | number>;
}

export const pointerOf = (segments: Array<string | number>): string =>
  segments.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

/** Visible rows in display order (collapsed containers hide their children). */
export function flatten(root: ContainerNode, collapsed: Set<string> = new Set()): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (parent: ContainerNode, depth: number, prefix: string, segs: Array<string | number>) => {
    parent.children.forEach((node, index) => {
      const seg: string | number = parent.type === 'array' ? index : node.key;
      const path = parent.type === 'array' ? `${prefix}[${index}]` : prefix ? `${prefix}.${node.key}` : node.key;
      const segments = [...segs, seg];
      out.push({ node, parent, depth, index, path, pointer: pointerOf(segments), segments });
      if (isContainer(node) && !collapsed.has(node.uid)) walk(node, depth + 1, path, segments);
    });
  };
  walk(root, 0, '', []);
  return out;
}

export function allFields(root: ContainerNode): FieldNode[] {
  const out: FieldNode[] = [];
  const walk = (n: ContainerNode) =>
    n.children.forEach((c) => {
      if (isContainer(c)) walk(c);
      else out.push(c);
    });
  walk(root);
  return out;
}

export function maxDepth(root: ContainerNode): number {
  const walk = (n: ContainerNode, d: number): number => n.children.reduce((m, c) => Math.max(m, isContainer(c) ? walk(c, d + 1) : d), d);
  return walk(root, 0);
}

// ------------------------------------------------------------------ immutable edits

function cloneTree<T extends BodyNode>(node: T): T {
  if (isContainer(node)) return { ...node, children: node.children.map(cloneTree) } as T;
  return { ...node };
}

/** Apply a mutation to a deep copy of the tree. */
export function edit(root: ContainerNode, mutate: (draft: ContainerNode) => void): ContainerNode {
  const draft = cloneTree(root);
  mutate(draft);
  return draft;
}

export function uniqueKey(parent: ContainerNode, base: string, exceptUid?: string): string {
  if (parent.type === 'array') return '';
  const taken = new Set(parent.children.filter((c) => c.uid !== exceptUid).map((c) => c.key));
  const clean = (base || 'field').slice(0, KEY_MAX);
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${clean.slice(0, KEY_MAX - String(i).length - 1)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${clean}_${Date.now()}`;
}

export function insertNodes(root: ContainerNode, parentUid: string | null, nodes: BodyNode[], atIndex?: number): ContainerNode {
  return edit(root, (draft) => {
    const parent = findContainer(draft, parentUid);
    // Unique keys are assigned in order, so nodes of one batch do not collide with each other either.
    const placed: BodyNode[] = [];
    nodes.forEach((n) => {
      const copy = cloneTree(n);
      copy.key = parent.type === 'array' ? '' : uniqueKey({ ...parent, children: [...parent.children, ...placed] }, copy.key);
      placed.push(copy);
    });
    const index = atIndex === undefined ? parent.children.length : Math.max(0, Math.min(parent.children.length, atIndex));
    parent.children.splice(index, 0, ...placed);
  });
}

export function updateNode(root: ContainerNode, uid: string, patch: Partial<FieldNode> | Partial<ContainerNode>): ContainerNode {
  return edit(root, (draft) => {
    const hit = locate(draft, uid);
    if (!hit) return;
    hit.parent.children[hit.index] = { ...hit.node, ...patch } as BodyNode;
  });
}

export function removeNodes(root: ContainerNode, uids: string[]): ContainerNode {
  const set = new Set(uids);
  const strip = (n: ContainerNode): ContainerNode => ({
    ...n,
    children: n.children.filter((c) => !set.has(c.uid)).map((c) => (isContainer(c) ? strip(c) : c)),
  });
  return strip(root);
}

export function moveSibling(root: ContainerNode, uid: string, delta: number): ContainerNode {
  return edit(root, (draft) => {
    const hit = locate(draft, uid);
    if (!hit) return;
    const to = hit.index + delta;
    if (to < 0 || to >= hit.parent.children.length) return;
    const [item] = hit.parent.children.splice(hit.index, 1);
    hit.parent.children.splice(to, 0, item);
  });
}

function contains(node: BodyNode, uid: string): boolean {
  if (node.uid === uid) return true;
  return isContainer(node) && node.children.some((c) => contains(c, uid));
}

/** Move a node into a container at an index (drag & drop, "indent into object"). */
export function moveNode(root: ContainerNode, uid: string, targetParentUid: string | null, atIndex?: number): ContainerNode {
  const hit = locate(root, uid);
  if (!hit) return root;
  if (targetParentUid && contains(hit.node, targetParentUid)) return root; // no cycles
  return edit(root, (draft) => {
    const src = locate(draft, uid)!;
    const [item] = src.parent.children.splice(src.index, 1);
    const target = findContainer(draft, targetParentUid);
    if (target.type === 'array') item.key = '';
    else item.key = uniqueKey(target, item.key || 'field');
    let index = atIndex === undefined ? target.children.length : atIndex;
    if (target === src.parent && atIndex !== undefined && src.index < atIndex) index -= 1;
    target.children.splice(Math.max(0, Math.min(target.children.length, index)), 0, item);
  });
}

/** Indent: move the node into the previous sibling when it is an object/array. */
export function indentNode(root: ContainerNode, uid: string): ContainerNode {
  const hit = locate(root, uid);
  if (!hit || hit.index === 0) return root;
  const prev = hit.parent.children[hit.index - 1];
  if (!isContainer(prev)) return root;
  return moveNode(root, uid, prev.uid);
}

/** Outdent: move the node out of its container, right after it. */
export function outdentNode(root: ContainerNode, uid: string): ContainerNode {
  const hit = locate(root, uid);
  if (!hit || hit.parent.uid === root.uid) return root;
  const parentHit = locate(root, hit.parent.uid);
  if (!parentHit) return root;
  return moveNode(root, uid, parentHit.parent.uid === root.uid ? null : parentHit.parent.uid, parentHit.index + 1);
}

function reUid<T extends BodyNode>(node: T): T {
  if (isContainer(node)) return { ...node, uid: newUid(), children: node.children.map(reUid) } as T;
  return { ...node, uid: newUid() };
}

export function duplicateNode(root: ContainerNode, uid: string): ContainerNode {
  const hit = locate(root, uid);
  if (!hit) return root;
  const copy = reUid(hit.node);
  copy.key = hit.parent.type === 'array' ? '' : uniqueKey(hit.parent, `${hit.node.key}_copy`);
  return edit(root, (draft) => {
    const parent = findContainer(draft, hit.parent.uid);
    parent.children.splice(hit.index + 1, 0, copy);
  });
}

/** Wrap the given rows (siblings or not) into a new object placed where the first one was. */
export function wrapIntoObject(root: ContainerNode, uids: string[], key: string): { root: ContainerNode; uid: string | null } {
  const order = flatten(root).filter((r) => uids.includes(r.node.uid));
  // Drop rows whose ancestor is also selected.
  const top = order.filter((r) => !order.some((o) => o !== r && isContainer(o.node) && contains(o.node, r.node.uid)));
  if (!top.length) return { root, uid: null };
  const first = top[0];
  const parentUid = first.parent.uid;
  const insertAt = first.index;
  const moved = top.map((r) => cloneTree(r.node));
  let next = removeNodes(root, top.map((r) => r.node.uid));
  const parent = findContainer(next, parentUid === root.uid ? null : parentUid);
  const obj = newContainer('object', uniqueKey(parent, key || 'group'), []);
  const children: BodyNode[] = [];
  moved.forEach((m) => {
    m.key = uniqueKey({ ...obj, children }, m.key || 'field');
    children.push(m);
  });
  obj.children = children;
  next = edit(next, (draft) => {
    const p = findContainer(draft, parentUid === root.uid ? null : parentUid);
    p.children.splice(Math.min(insertAt, p.children.length), 0, obj);
  });
  return { root: next, uid: obj.uid };
}

/** Mapping ↔ rule. A mapping becomes a rule referencing the same signal; a single-ref rule becomes a mapping. */
export function convertField(field: FieldNode, index: CatalogIndex | null): Partial<FieldNode> {
  if (field.mode === 'mapping') {
    const ref = (index && field.signalId && signalRef(index, field.signalId)) || field.refDisplay || '';
    return { mode: 'calculated', exprText: ref, exprEdited: true, exprRaw: '' };
  }
  const text = field.exprText.trim();
  const sigs = referencedSignals(text, index);
  const single = sigs.length === 1 && /^\$[^\s()+*/%,<>=!]+$/.test(text);
  return { mode: 'mapping', signalId: single ? sigs[0] : '', exprText: '', exprRaw: '', exprEdited: false };
}

// ------------------------------------------------------------------ validation (local, instant)

export function localErrors(root: ContainerNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (parent: ContainerNode, depth: number) => {
    const seen = new Map<string, string>();
    parent.children.forEach((node) => {
      if (parent.type !== 'array') {
        const key = node.key;
        if (!key.trim()) out.set(node.uid, 'Key is required.');
        else if (key.length > KEY_MAX) out.set(node.uid, `Key is longer than ${KEY_MAX} characters.`);
        else if (seen.has(key)) {
          out.set(node.uid, `Duplicate key "${key}" in this object.`);
          out.set(seen.get(key)!, `Duplicate key "${key}" in this object.`);
        } else seen.set(key, node.uid);
      }
      if (isContainer(node)) {
        if (depth + 1 > DEPTH_MAX) out.set(node.uid, `Nesting deeper than ${DEPTH_MAX} levels.`);
        walk(node, depth + 1);
      } else if (!out.has(node.uid)) {
        if (node.mode === 'mapping' && !node.signalId) out.set(node.uid, 'Not mapped: pick a signal in the data tree.');
        if (node.mode === 'calculated' && !node.exprText.trim()) out.set(node.uid, 'The rule is empty.');
      }
    });
  };
  walk(root, 0);
  const count = allFields(root).length;
  if (count > FIELDS_MAX) out.set(root.uid, `A model can have at most ${FIELDS_MAX} fields (${count}).`);
  return out;
}

/**
 * Map server issues onto row uids: by `node_id` (our row id) first, then by JSON pointer.
 * Issues that match no row are kept under the root uid.
 */
export function errorsByUid(root: ContainerNode, errors: FieldError[]): Map<string, FieldError[]> {
  const rows = flatten(root);
  const uids = new Set(rows.map((r) => r.node.uid));
  const byPointer = new Map(rows.map((r) => [r.pointer, r.node.uid]));
  const byDotted = new Map(rows.map((r) => [r.path, r.node.uid]));
  const out = new Map<string, FieldError[]>();
  errors.forEach((e) => {
    let uid: string | undefined;
    if (e.nodeId && uids.has(e.nodeId)) uid = e.nodeId;
    if (!uid && e.path) uid = byPointer.get(e.path) || byDotted.get(e.path.replace(/^\$\.?/, ''));
    const key = uid || root.uid;
    out.set(key, [...(out.get(key) || []), e]);
  });
  return out;
}

// ------------------------------------------------------------------ references / summary

export function bodySignalIds(root: ContainerNode, index: CatalogIndex | null): string[] {
  const ids = new Set<string>();
  allFields(root).forEach((f) => {
    if (f.mode === 'mapping' && f.signalId) ids.add(f.signalId);
    if (f.mode === 'calculated') referencedSignals(f.exprText, index).forEach((id) => ids.add(id));
  });
  return Array.from(ids);
}

/** Owners (resources) of every referenced signal or resource, by label. */
export function bodyMachines(root: ContainerNode, index: CatalogIndex | null): string[] {
  if (!index) return [];
  const ids = new Set<string>();
  bodySignalIds(root, index).forEach((sid) => {
    const s = index.sigById.get(sid);
    if (s) ids.add(s.resourceId);
  });
  allFields(root).forEach((f) => {
    if (f.mode === 'calculated') referencedResources(f.exprText, index).forEach((id) => ids.add(id));
  });
  return Array.from(ids)
    .map((id) => resourceLabel(index.resById.get(id)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function mappedRefsIn(container: ContainerNode, index: CatalogIndex | null): string[] {
  if (!index) return [];
  const refs: string[] = [];
  const walk = (n: ContainerNode) =>
    n.children.forEach((c) => {
      if (isContainer(c)) walk(c);
      else if (c.mode === 'mapping' && c.signalId) {
        const r = signalRef(index, c.signalId);
        if (r && !refs.includes(r)) refs.push(r);
      }
    });
  walk(container);
  return refs;
}

// ------------------------------------------------------------------ auto-mapping ("Map all")

export type MapLayout = 'flat' | 'nested' | 'grouped';

/** Keys generated by "Add source_timestamp and publish_timestamp". */
export const TIMESTAMP_KEYS = new Set(['source_timestamp', 'publish_timestamp']);

export interface MapAllOptions {
  layout: MapLayout;
  /** Context levels (resource type keys of the resource and its ancestors) to add as `<type>_name` rules. */
  contextTypes: string[];
  includeTimestamps: boolean;
}

/** Context levels offered for a resource: its ancestors (root first) and itself. */
export function contextLevels(index: CatalogIndex, resourceId: string): Array<{ type: string; label: string }> {
  return resourcePath(index, resourceId).map((r) => ({ type: r.type, label: resourceLabel(r) }));
}

export function contextRule(index: CatalogIndex, resourceId: string, type: string): FieldNode | null {
  const res = index.resById.get(resourceId);
  if (!res) return null;
  const sel = resourceSelector(index, resourceId);
  const expr = type === res.type ? `$${sel}.@name` : `$${sel}.@${type}.@name`;
  return newRule(`${type}_name`, expr, 'string');
}

const keyFromLabel = (label: string) => (label || 'item').trim().slice(0, KEY_MAX);

export function buildAutoMap(index: CatalogIndex, resourceId: string, opts: MapAllOptions): BodyNode[] {
  const res = index.resById.get(resourceId);
  if (!res) return [];
  // With generated timestamps, raw per-group timestamp signals would only duplicate them.
  const sigs = signalsUnder(index, resourceId).filter((s) => !opts.includeTimestamps || !TIMESTAMP_KEYS.has(s.key));
  const out: BodyNode[] = [];
  opts.contextTypes.forEach((t) => {
    const rule = contextRule(index, resourceId, t);
    if (rule) out.push(rule);
  });
  const tsInsertAt = out.length;

  const mapping = (s: CatalogSignal, key: string) => newField(key, { signalId: s.id, mode: 'mapping' });
  const owners = Array.from(new Set(sigs.map((s) => s.resourceId)));

  if (opts.layout === 'flat') {
    const counts = new Map<string, number>();
    sigs.forEach((s) => counts.set(s.key, (counts.get(s.key) || 0) + 1));
    const used = new Set<string>();
    sigs.forEach((s) => {
      let key = s.key;
      if ((counts.get(s.key) || 0) > 1) key = `${keyFromLabel(resourceLabel(index.resById.get(s.resourceId)))}_${s.key}`;
      while (used.has(key)) key = `${key}_2`;
      used.add(key);
      out.push(mapping(s, key));
    });
  } else if (opts.layout === 'nested') {
    // Objects follow the hierarchy below the clicked resource; its own signals stay at the top level.
    const build = (id: string, depth: number): BodyNode[] => {
      if (depth > DEPTH_MAX - 1) return [];
      const nodes: BodyNode[] = (index.signalsOf.get(id) || []).map((s) => mapping(s, s.key));
      (index.childrenOf.get(id) || []).forEach((child) => {
        const inner = build(child.id, depth + 1);
        if (inner.length) nodes.push(newContainer('object', keyFromLabel(resourceLabel(child)), inner));
      });
      return nodes;
    };
    out.push(...build(resourceId, 1));
  } else {
    const byGroup = (list: CatalogSignal[]): BodyNode[] => {
      const groups = new Map<string, CatalogSignal[]>();
      list.forEach((s) => {
        const g = s.group || s.connectionName || 'signals';
        groups.set(g, [...(groups.get(g) || []), s]);
      });
      return Array.from(groups.entries()).map(([g, ss]) => newContainer('object', keyFromLabel(g), ss.map((s) => mapping(s, s.key))));
    };
    if (owners.length <= 1) out.push(...byGroup(sigs));
    else
      owners.forEach((owner) => {
        out.push(newContainer('object', keyFromLabel(resourceLabel(index.resById.get(owner))), byGroup(sigs.filter((s) => s.resourceId === owner))));
      });
  }

  if (opts.includeTimestamps && sigs.length) {
    // Every mapped signal contributes its raw group's timestamp (ts); the body takes the latest.
    const refs = sigs.map((s) => signalRef(index, s.id)).filter(Boolean) as string[];
    out.splice(tsInsertAt, 0, newRule('source_timestamp', `latest_ts(${refs.join(', ')})`, 'timestamp'), newRule('publish_timestamp', 'now()', 'timestamp'));
  }
  // Unique keys within each object.
  const dedupe = (nodes: BodyNode[]) => {
    const seen = new Set<string>();
    nodes.forEach((n) => {
      let k = n.key;
      let i = 2;
      while (seen.has(k)) k = `${n.key}_${i++}`;
      n.key = k;
      seen.add(k);
      if (isContainer(n)) dedupe(n.children);
    });
  };
  dedupe(out);
  return out;
}

// ------------------------------------------------------------------ Paste JSON skeleton

export class SkeletonError extends Error {}

/**
 * Parse a pasted sample body. Accepts real JSON, or a key list such as `{ "a", "b", "c" }`
 * (the form used in written body specifications).
 */
export function parseSkeleton(text: string): JNode {
  const trimmed = text.trim();
  if (!trimmed) throw new SkeletonError('Paste a JSON body first.');
  try {
    return parseOrderedJson(trimmed);
  } catch (err) {
    const list = /^\{?\s*((?:"[^"\n]+"\s*,?\s*)+)\}?$/.exec(trimmed);
    if (list) {
      const keys = Array.from(list[1].matchAll(/"([^"\n]+)"/g)).map((m) => m[1]);
      return { kind: 'object', entries: keys.map((k) => [k, { kind: 'null' } as JNode]) };
    }
    throw new SkeletonError(err instanceof Error ? err.message : 'Invalid JSON.');
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface SkeletonStats {
  fields: number;
  matched: number;
  context: number;
  timestamps: number;
  unmatched: string[];
}

/**
 * Build body nodes from a sample: leaves are matched to signals of the scope resource (exact key, then
 * case/punctuation-insensitive); `<type>_name` / `<type>_code` keys become context rules when the scope
 * has a resource of that type in its path; `source_timestamp` / `publish_timestamp` become timestamp rules.
 */
export function buildSkeleton(
  sample: JNode,
  index: CatalogIndex | null,
  scopeId: string | null,
  recognise: boolean,
): { nodes: BodyNode[]; stats: SkeletonStats } {
  const stats: SkeletonStats = { fields: 0, matched: 0, context: 0, timestamps: 0, unmatched: [] };
  const pool = index && scopeId ? signalsUnder(index, scopeId) : [];
  const path = index && scopeId ? resourcePath(index, scopeId) : [];
  const scopeSel = index && scopeId ? resourceSelector(index, scopeId) : '';

  const matchSignal = (key: string): CatalogSignal | undefined =>
    pool.find((s) => s.key === key) || pool.find((s) => s.key.toLowerCase() === key.toLowerCase()) || pool.find((s) => norm(s.key) === norm(key));

  const leaf = (key: string, sampleNode: JNode): FieldNode => {
    stats.fields += 1;
    if (recognise && scopeSel) {
      const ctx = /^([a-z_]+?)_(name|code)$/i.exec(key);
      if (ctx) {
        const type = ctx[1].toLowerCase();
        const attr = ctx[2].toLowerCase();
        const scope = index!.resById.get(scopeId!)!;
        if (type === scope.type || path.some((r) => r.type === type)) {
          stats.context += 1;
          const expr = type === scope.type ? `$${scopeSel}.@${attr}` : `$${scopeSel}.@${type}.@${attr}`;
          return newRule(key, expr, 'string');
        }
      }
      if (key === 'publish_timestamp') {
        stats.timestamps += 1;
        return newRule(key, 'now()', 'timestamp');
      }
      if (key === 'source_timestamp') {
        stats.timestamps += 1;
        // Filled with the mapped siblings once the object is built.
        return newRule(key, '', 'timestamp');
      }
    }
    const sig = matchSignal(key);
    if (sig) {
      stats.matched += 1;
      return newField(key, { signalId: sig.id });
    }
    stats.unmatched.push(key);
    const vt: ValueType = sampleNode.kind === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(sampleNode.value) ? 'timestamp' : 'auto';
    return newField(key, { valueType: vt });
  };

  const fill = (container: ContainerNode) => {
    container.children.forEach((c) => {
      if (isContainer(c)) fill(c);
    });
    container.children.forEach((c) => {
      if (!isContainer(c) && c.mode === 'calculated' && c.key === 'source_timestamp' && !c.exprText) {
        const refs = mappedRefsIn(container, index);
        c.exprText = refs.length ? `latest_ts(${refs.join(', ')})` : 'now()';
      }
    });
  };

  const build = (node: JNode, key: string, depth: number): BodyNode => {
    if (node.kind === 'object' && depth < DEPTH_MAX) {
      return newContainer('object', key, node.entries.map(([k, v]) => build(v, k, depth + 1)));
    }
    if (node.kind === 'array' && depth < DEPTH_MAX) {
      return newContainer('array', key, node.items.map((v) => build(v, '', depth + 1)));
    }
    return leaf(key, node);
  };

  const top = sample.kind === 'object' ? sample.entries.map(([k, v]) => build(v, k, 1)) : [build(sample, 'value', 1)];
  const holder = newContainer('object', '', top);
  fill(holder);
  return { nodes: holder.children, stats };
}

// ------------------------------------------------------------------ duplicate preview (client side)

const SIG_TOKEN = /\{\{sig:([0-9a-fA-F-]{8,})\}\}/g;

/** Signal ids referenced by a stored (wire) spec: mapping refs and {{sig:…}} tokens in rules. */
export function wireSignalIds(spec: ApiSpec): string[] {
  const ids = new Set<string>();
  const walk = (n: ApiNode) => {
    if (n.type === 'field') {
      const f = n as ApiFieldNode;
      if (f.ref?.signal_id) ids.add(String(f.ref.signal_id));
      if (f.expr) for (const m of String(f.expr).matchAll(SIG_TOKEN)) ids.add(m[1]);
    } else (n as ApiContainerNode).children?.forEach(walk);
  };
  walk(spec.root);
  return Array.from(ids);
}

/** Resources owning the referenced signals (candidates for "source" in Duplicate to machines). */
export function wireOwners(spec: ApiSpec, index: CatalogIndex): string[] {
  const owners = new Set<string>();
  wireSignalIds(spec).forEach((id) => {
    const s = index.sigById.get(id);
    if (s) owners.add(s.resourceId);
  });
  for (const m of JSON.stringify(spec).matchAll(/\{\{res:([0-9a-fA-F-]{8,})\}\}/g)) owners.add(m[1]);
  return Array.from(owners).filter((id) => index.resById.has(id));
}

/** Keys of signals under `fromId` that the target has no matching signal for. */
export function unmatchedForTarget(spec: ApiSpec, index: CatalogIndex, fromId: string, targetId: string): string[] {
  const under = new Set(signalsUnder(index, fromId).map((s) => s.id));
  const targetKeys = new Set(signalsUnder(index, targetId).map((s) => s.key));
  const missing: string[] = [];
  wireSignalIds(spec).forEach((id) => {
    if (!under.has(id)) return;
    const s = index.sigById.get(id);
    if (s && !targetKeys.has(s.key) && !missing.includes(s.key)) missing.push(s.key);
  });
  return missing;
}

/** "State AA-1" with source "AA-1" and target "BB-2" → "State BB-2" (or "<name> (BB-2)"). */
export function retargetName(name: string, sourceLabel: string, targetLabel: string): string {
  if (sourceLabel && name.includes(sourceLabel)) return name.split(sourceLabel).join(targetLabel);
  return `${name} (${targetLabel})`;
}
