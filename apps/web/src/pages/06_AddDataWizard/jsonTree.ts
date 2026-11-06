/**
 * Ordered JSON handling for the Add Data wizard.
 * JSON.parse keeps insertion order for most keys but loses number formatting (88.0 -> 88), and objects
 * stored by the Center (PostgreSQL jsonb) come back with re-ordered keys. When the original payload text is
 * available we parse it ourselves so the tree shows fields in payload order and float/int is known exactly.
 */

export type JNode =
  | { kind: 'object'; entries: Array<[string, JNode]> }
  | { kind: 'array'; items: JNode[] }
  | { kind: 'number'; value: number; raw: string; exact: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

export class JsonParseError extends Error {}

/** Parse JSON text preserving key order and number literals. Throws JsonParseError. */
export function parseOrderedJson(text: string): JNode {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i += 1;
  };
  const fail = (msg: string): never => {
    throw new JsonParseError(`${msg} at position ${i}`);
  };
  const parseString = (): string => {
    if (text[i] !== '"') fail('Expected a string');
    const start = i;
    i += 1;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return JSON.parse(text.slice(start, i)) as string;
      }
      i += 1;
    }
    return fail('Unterminated string');
  };
  const parseValue = (): JNode => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i += 1;
      const entries: Array<[string, JNode]> = [];
      ws();
      if (text[i] === '}') {
        i += 1;
        return { kind: 'object', entries };
      }
      for (;;) {
        ws();
        const key = parseString();
        ws();
        if (text[i] !== ':') fail('Expected ":"');
        i += 1;
        const value = parseValue();
        const existing = entries.findIndex(([k]) => k === key);
        if (existing >= 0) entries[existing] = [key, value];
        else entries.push([key, value]);
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return { kind: 'object', entries };
        }
        fail('Expected "," or "}"');
      }
    }
    if (ch === '[') {
      i += 1;
      const items: JNode[] = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(parseValue());
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return { kind: 'array', items };
        }
        fail('Expected "," or "]"');
      }
    }
    if (ch === '"') return { kind: 'string', value: parseString() };
    if (text.startsWith('true', i)) {
      i += 4;
      return { kind: 'boolean', value: true };
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return { kind: 'boolean', value: false };
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return { kind: 'null' };
    }
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (match) {
      i += match[0].length;
      return { kind: 'number', value: Number(match[0]), raw: match[0], exact: true };
    }
    return fail('Unexpected token');
  };
  const root = parseValue();
  ws();
  if (i < n) fail('Unexpected trailing characters');
  return root;
}

/** Build a node from an already-parsed value (number formatting is not known: exact=false). */
export function fromValue(value: unknown): JNode {
  if (value === null || value === undefined) return { kind: 'null' };
  if (Array.isArray(value)) return { kind: 'array', items: value.map(fromValue) };
  if (typeof value === 'object') {
    return { kind: 'object', entries: Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromValue(v)]) };
  }
  if (typeof value === 'number') return { kind: 'number', value, raw: String(value), exact: false };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  return { kind: 'string', value: String(value) };
}

export function toPlain(node: JNode): unknown {
  switch (node.kind) {
    case 'object': {
      const out: Record<string, unknown> = {};
      node.entries.forEach(([k, v]) => {
        out[k] = toPlain(v);
      });
      return out;
    }
    case 'array':
      return node.items.map(toPlain);
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;
    default:
      return null;
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Append a key or index to a JSONPath, using bracket notation for keys such as "line-01". */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  if (IDENT.test(key)) return `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}

type Segment = string | number;

/** Parse a simple JSONPath ($, .key, ["key"], ['key'], [n]). Returns null for unsupported syntax. */
export function parsePath(path: string): Segment[] | null {
  const p = path.trim();
  if (!p.startsWith('$')) return null;
  const out: Segment[] = [];
  let i = 1;
  while (i < p.length) {
    if (p[i] === '.') {
      const m = /^\.([A-Za-z_$][A-Za-z0-9_$-]*)/.exec(p.slice(i));
      if (!m) return null;
      out.push(m[1]);
      i += m[0].length;
    } else if (p[i] === '[') {
      const rest = p.slice(i);
      const num = /^\[(\d+)\]/.exec(rest);
      if (num) {
        out.push(Number(num[1]));
        i += num[0].length;
        continue;
      }
      const dq = /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest);
      if (dq) {
        out.push(JSON.parse(`"${dq[1]}"`) as string);
        i += dq[0].length;
        continue;
      }
      const sq = /^\['((?:[^'\\]|\\.)*)'\]/.exec(rest);
      if (sq) {
        out.push(sq[1].replace(/\\'/g, "'"));
        i += sq[0].length;
        continue;
      }
      return null;
    } else {
      return null;
    }
  }
  return out;
}

/** Resolve a simple JSONPath in a node tree. Returns undefined when not found. */
export function evaluateNode(root: JNode, path: string): JNode | undefined {
  const segments = parsePath(path);
  if (!segments) return undefined;
  let cur: JNode | undefined = root;
  for (const seg of segments) {
    if (!cur) return undefined;
    if (typeof seg === 'number') {
      cur = cur.kind === 'array' ? cur.items[seg] : undefined;
    } else {
      cur = cur.kind === 'object' ? cur.entries.find(([k]) => k === seg)?.[1] : undefined;
    }
  }
  return cur;
}

/** Last key of a JSONPath (used as the default signal key). */
export function lastKey(path: string): string {
  const segments = parsePath(path);
  if (!segments || segments.length === 0) return '';
  const last = segments[segments.length - 1];
  return typeof last === 'number' ? `item_${last}` : last;
}

/** Path of the parent object of a JSONPath, or null for "$". */
export function parentPath(path: string): string | null {
  const segments = parsePath(path);
  if (!segments || segments.length === 0) return null;
  let out = '$';
  segments.slice(0, -1).forEach((seg) => {
    out = childPath(out, seg);
  });
  return out;
}

/** True when the parent object of `path` has a `source_timestamp` key (the sibling timestamp rule). */
export function hasSiblingTimestamp(root: JNode, path: string): boolean {
  const parent = parentPath(path);
  if (parent === null) return false;
  const node = evaluateNode(root, parent);
  return Boolean(node && node.kind === 'object' && node.entries.some(([k]) => k === 'source_timestamp'));
}

export interface Leaf {
  path: string;
  key: string;
  node: JNode;
}

/** All scalar leaves under a node, in document order. */
export function collectLeaves(node: JNode, basePath = '$'): Leaf[] {
  const out: Leaf[] = [];
  const walk = (n: JNode, path: string, key: string) => {
    if (n.kind === 'object') n.entries.forEach(([k, v]) => walk(v, childPath(path, k), k));
    else if (n.kind === 'array') n.items.forEach((v, idx) => walk(v, childPath(path, idx), `${key}_${idx}`));
    else out.push({ path, key, node: n });
  };
  walk(node, basePath, '');
  return out;
}

/** Signal data type suggested from a sample node. */
export function inferDataType(node: JNode | undefined): { dataType: 'float64' | 'int64' | 'bool' | 'string'; warning?: string } {
  if (!node) return { dataType: 'float64' };
  switch (node.kind) {
    case 'boolean':
      return { dataType: 'bool' };
    case 'string':
      return { dataType: 'string' };
    case 'number':
      if (/[.eE]/.test(node.raw)) return { dataType: 'float64' };
      if (node.exact) return { dataType: 'int64' };
      return {
        dataType: 'int64',
        warning: 'Whole-number sample. Choose Number if this field can carry decimals.',
      };
    case 'null':
      return { dataType: 'string', warning: 'Sample is null. Check the type.' };
    default:
      return { dataType: 'string', warning: 'Objects and arrays are stored as text.' };
  }
}

export function nodePreview(node: JNode | undefined): string {
  if (!node) return '—';
  switch (node.kind) {
    case 'number':
      return node.raw;
    case 'string':
      return JSON.stringify(node.value);
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array':
      return `[${node.items.length}]`;
    default:
      return `{${node.entries.length}}`;
  }
}
