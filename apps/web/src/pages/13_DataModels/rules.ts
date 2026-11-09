// Custom Rule language helpers for the editor (spec §3): reference rendering / resolution against the
// catalog, a lightweight tokenizer for syntax highlighting, the function reference and `$` autocomplete.
// The server stays authoritative: it resolves typed references on save and renders stored tokens.
import type { Catalog, CatalogResource, CatalogSignal } from './types';

// ------------------------------------------------------------------ catalog index

export interface CatalogIndex {
  catalog: Catalog;
  resById: Map<string, CatalogResource>;
  sigById: Map<string, CatalogSignal>;
  childrenOf: Map<string, CatalogResource[]>;
  signalsOf: Map<string, CatalogSignal[]>;
  /** Resource type keys in hierarchy order of first appearance. */
  types: string[];
}

export function indexCatalog(catalog: Catalog): CatalogIndex {
  const resById = new Map(catalog.resources.map((r) => [r.id, r]));
  const sigById = new Map(catalog.signals.map((s) => [s.id, s]));
  const childrenOf = new Map<string, CatalogResource[]>();
  catalog.resources.forEach((r) => {
    const parent = r.parentId && resById.has(r.parentId) ? r.parentId : '';
    const list = childrenOf.get(parent) || [];
    list.push(r);
    childrenOf.set(parent, list);
  });
  const signalsOf = new Map<string, CatalogSignal[]>();
  catalog.signals.forEach((s) => {
    const list = signalsOf.get(s.resourceId) || [];
    list.push(s);
    signalsOf.set(s.resourceId, list);
  });
  const types: string[] = [];
  const visit = (parent: string, depth: number) => {
    if (depth > 32) return;
    (childrenOf.get(parent) || []).forEach((r) => {
      if (r.type && !types.includes(r.type)) types.push(r.type);
      visit(r.id, depth + 1);
    });
  };
  visit('', 0);
  return { catalog, resById, sigById, childrenOf, signalsOf, types };
}

/** Ancestors from the root down to (and including) the resource. */
export function resourcePath(index: CatalogIndex, resourceId: string): CatalogResource[] {
  const out: CatalogResource[] = [];
  let cursor = index.resById.get(resourceId);
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    out.unshift(cursor);
    cursor = cursor.parentId ? index.resById.get(cursor.parentId) : undefined;
  }
  return out;
}

export function resourceLabel(r: CatalogResource | undefined): string {
  return r ? r.name || r.code || r.id : '';
}

/** All signals under a resource (itself and descendants), in tree order. */
export function signalsUnder(index: CatalogIndex, resourceId: string): CatalogSignal[] {
  const out: CatalogSignal[] = [];
  const visit = (id: string, depth: number) => {
    if (depth > 32) return;
    (index.signalsOf.get(id) || []).forEach((s) => out.push(s));
    (index.childrenOf.get(id) || []).forEach((c) => visit(c.id, depth + 1));
  };
  visit(resourceId, 0);
  return out;
}

const bracket = (name: string) => `[${escapeName(name)}]`;

/**
 * Shortest unambiguous selector for a resource: `machine[M1]`, or `line[L1].machine[M1]` when another
 * machine has the same name.
 */
export function resourceSelector(index: CatalogIndex, resourceId: string): string {
  const res = index.resById.get(resourceId);
  if (!res) return '';
  if (res.ref && res.ref.startsWith('$')) return res.ref.slice(1);
  const label = resourceLabel(res);
  const same = index.catalog.resources.filter((r) => r.type === res.type && resourceLabel(r) === label);
  if (same.length <= 1) return `${res.type}${bracket(label)}`;
  const path = resourcePath(index, resourceId);
  // Walk up until the prefix makes the selector unique.
  for (let i = path.length - 2; i >= 0; i -= 1) {
    const prefix = path.slice(i, path.length - 1);
    const candidates = same.filter((r) => {
      const rp = resourcePath(index, r.id);
      return prefix.every((p) => rp.some((x) => x.type === p.type && resourceLabel(x) === resourceLabel(p)));
    });
    if (candidates.length === 1) {
      return [...prefix.map((p) => `${p.type}${bracket(resourceLabel(p))}`), `${res.type}${bracket(label)}`].join('.');
    }
  }
  return `${res.type}${bracket(label)}`;
}

export function signalRef(index: CatalogIndex, signalId: string): string | null {
  const sig = index.sigById.get(signalId);
  if (!sig) return null;
  if (sig.ref) return sig.ref;
  const sel = resourceSelector(index, sig.resourceId);
  return sel ? `$${sel}.${keyText(sig.key)}` : null;
}

/** Full path + connection, for tooltips. */
export function signalTooltip(index: CatalogIndex, signalId: string): string {
  const sig = index.sigById.get(signalId);
  if (!sig) return 'Signal not found in the catalog (deleted or archived).';
  const path = resourcePath(index, sig.resourceId).map(resourceLabel).join(' › ');
  const conn = [sig.connectionName, sig.protocol].filter(Boolean).join(' · ');
  return `${path} › ${sig.key}${sig.name && sig.name !== sig.key ? ` (${sig.name})` : ''}${conn ? `\nConnection: ${conn}` : ''}${
    sig.dataType ? `\nType: ${sig.dataType}${sig.unit ? ` [${sig.unit}]` : ''}` : ''
  }`;
}

// ------------------------------------------------------------------ reference parsing / resolution

export interface ParsedRef {
  selectors: Array<{ type: string; name: string }>;
  /** Signal key (when the reference ends with `.key`). */
  key: string | null;
  /** Attribute chain (`@zone`, `@name`) without the @. */
  attrs: string[];
}

// `$type[name](.type[name])*` then `.key`, ``.`odd-key` `` or `.@attr(.@attr)*`. `]` and `\` in names are escaped.
const NAME = String.raw`((?:\\.|[^\]\\\n])*)`;
const BQ = '`';
const REF_RE = new RegExp(
  String.raw`^\$([A-Za-z_]\w*)\[` +
    NAME +
    String.raw`\]((?:\.[A-Za-z_]\w*\[(?:\\.|[^\]\\\n])*\])*)((?:\.@[A-Za-z_]\w*)+|\.[A-Za-z0-9_]+|\.` +
    BQ +
    String.raw`(?:\\.|[^` +
    BQ +
    String.raw`\\\n])*` +
    BQ +
    ')?',
);
const SEL_RE = new RegExp(String.raw`\.([A-Za-z_]\w*)\[` + NAME + String.raw`\]`, 'g');

const unescapeName = (s: string) => s.replace(/\\(.)/g, '$1');
export const escapeName = (s: string) => s.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
export const keyText = (key: string) => (/^[A-Za-z0-9_]+$/.test(key) ? key : BQ + key.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + BQ);

export function parseRef(text: string): { ref: ParsedRef; length: number } | null {
  const m = REF_RE.exec(text);
  if (!m) return null;
  const selectors = [{ type: m[1], name: unescapeName(m[2]) }];
  const more = m[3] || '';
  SEL_RE.lastIndex = 0;
  let s: RegExpExecArray | null;
  while ((s = SEL_RE.exec(more))) selectors.push({ type: s[1], name: unescapeName(s[2]) });
  const tail = m[4] || '';
  const attrs = tail.startsWith('.@') ? tail.split('.').filter(Boolean).map((a) => a.slice(1)) : [];
  let key: string | null = null;
  if (tail && !tail.startsWith('.@')) {
    const raw = tail.slice(1);
    key = raw.startsWith(BQ) ? unescapeName(raw.slice(1, -1)) : raw;
  }
  return { ref: { selectors, key, attrs }, length: m[0].length };
}

/**
 * Readable text of a deleted reference `$⚠missing[<last label>]`: "humidity on M1" / "M1"
 * (R4-DM-12: the internal syntax is never shown in read-only views).
 */
export function missingLabel(display: string): string {
  const m = /^\$⚠missing\[([\s\S]*)\]$/.exec(display.trim());
  const inner = m ? m[1] : display;
  const parsed = parseRef(inner) || parseRef(inner.replace(/\\([\\[\]])/g, '$1'));
  if (!parsed) return inner || 'data point';
  const name = parsed.ref.selectors[parsed.ref.selectors.length - 1].name;
  return parsed.ref.key ? `${parsed.ref.key} on ${name}` : name;
}

export interface RefResolution {
  ok: boolean;
  resource?: CatalogResource;
  signal?: CatalogSignal;
  message?: string;
  suggestions?: string[];
}

function matchesName(r: CatalogResource, name: string): boolean {
  return resourceLabel(r) === name || r.code === name;
}

function closest(options: string[], wanted: string, limit = 3): string[] {
  const w = wanted.toLowerCase();
  const scored = options
    .map((o) => {
      const l = o.toLowerCase();
      let score = 0;
      if (l === w) score = 100;
      else if (l.startsWith(w) || w.startsWith(l)) score = 60;
      else if (l.includes(w) || w.includes(l)) score = 40;
      else {
        let common = 0;
        for (const ch of new Set(w)) if (l.includes(ch)) common += 1;
        score = (common / Math.max(1, new Set(w).size)) * 30;
      }
      return { o, score };
    })
    .filter((x) => x.score >= 15)
    .sort((a, b) => b.score - a.score);
  return Array.from(new Set(scored.map((x) => x.o))).slice(0, limit);
}

export function resolveRef(index: CatalogIndex, ref: ParsedRef): RefResolution {
  let candidates = index.catalog.resources;
  let scope: CatalogResource | undefined;
  for (const sel of ref.selectors) {
    const ofType = candidates.filter((r) => r.type === sel.type);
    if (ofType.length === 0 && !index.types.includes(sel.type)) {
      return { ok: false, message: `Unknown resource type "${sel.type}".`, suggestions: closest(index.types, sel.type) };
    }
    let named = ofType.filter((r) => matchesName(r, sel.name));
    if (!named.length) {
      // Case-insensitive match is accepted when it is unique (same rule as the server).
      const lower = sel.name.toLowerCase();
      const ci = ofType.filter((r) => resourceLabel(r).toLowerCase() === lower || r.code.toLowerCase() === lower);
      if (ci.length === 1) named = ci;
    }
    if (named.length === 0) {
      return {
        ok: false,
        message: `No ${sel.type} named "${sel.name}".`,
        suggestions: closest(Array.from(new Set(ofType.map(resourceLabel))), sel.name).map((n) => `$${sel.type}[${n}]`),
      };
    }
    if (named.length > 1 && sel === ref.selectors[ref.selectors.length - 1]) {
      return {
        ok: false,
        message: `"${sel.name}" matches ${named.length} ${sel.type} resources. Add a parent, e.g. $${resourceSelector(index, named[0].id)}.`,
        suggestions: named.map((r) => `$${resourceSelector(index, r.id)}`),
      };
    }
    scope = named[0];
    // Next selector searches the descendants of this one.
    const ids = new Set<string>();
    const collect = (id: string, depth: number) => {
      if (depth > 32) return;
      (index.childrenOf.get(id) || []).forEach((c) => {
        ids.add(c.id);
        collect(c.id, depth + 1);
      });
    };
    named.forEach((r) => collect(r.id, 0));
    candidates = index.catalog.resources.filter((r) => ids.has(r.id));
  }
  if (!scope) return { ok: false, message: 'Incomplete reference.' };
  if (ref.attrs.length) {
    const [first, ...rest] = ref.attrs;
    if (first === 'name' || first === 'code' || first === 'type') return rest.length ? { ok: false, message: `"@${first}" has no attributes.` } : { ok: true, resource: scope };
    // Nearest resource of that type: the resource itself first, then its ancestors.
    const anc = resourcePath(index, scope.id).filter((r) => r.type === first);
    if (!anc.length) return { ok: false, message: `${resourceLabel(scope)} has no ${first} ancestor.`, suggestions: resourcePath(index, scope.id).slice(0, -1).map((r) => `@${r.type}`) };
    if (!rest.length) return { ok: false, message: `Add .@name or .@code after @${first}.` };
    if (!['name', 'code', 'type'].includes(rest[0])) return { ok: false, message: `Use .@name or .@code after @${first}.` };
    return { ok: true, resource: anc[anc.length - 1] };
  }
  if (!ref.key) return { ok: false, message: 'Add a signal key (".key") or an attribute (".@name").' };
  const sig = (index.signalsOf.get(scope.id) || []).find((s) => s.key === ref.key);
  if (!sig) {
    return {
      ok: false,
      message: `${resourceLabel(scope)} has no signal "${ref.key}".`,
      suggestions: closest((index.signalsOf.get(scope.id) || []).map((s) => s.key), ref.key).map((k) => `$${resourceSelector(index, scope!.id)}.${k}`),
    };
  }
  return { ok: true, resource: scope, signal: sig };
}

// ------------------------------------------------------------------ functions

export interface RuleFunction {
  name: string;
  signature: string;
  description: string;
  example: string;
  group: 'math' | 'logic' | 'string' | 'time' | 'filter';
}

export const RULE_FUNCTIONS: RuleFunction[] = [
  { group: 'math', name: 'abs', signature: 'abs(x)', description: 'Absolute value.', example: 'abs(x)' },
  { group: 'math', name: 'min', signature: 'min(a, b, …)', description: 'Smallest argument.', example: 'min(a, b)' },
  { group: 'math', name: 'max', signature: 'max(a, b, …)', description: 'Largest argument.', example: 'max(a, b)' },
  { group: 'math', name: 'round', signature: 'round(x, digits)', description: 'Round to a number of digits.', example: 'round(x, 2)' },
  { group: 'math', name: 'floor', signature: 'floor(x)', description: 'Round down.', example: 'floor(x)' },
  { group: 'math', name: 'ceil', signature: 'ceil(x)', description: 'Round up.', example: 'ceil(x)' },
  { group: 'math', name: 'sqrt', signature: 'sqrt(x)', description: 'Square root.', example: 'sqrt(x)' },
  { group: 'math', name: 'pow', signature: 'pow(x, y)', description: 'x to the power y.', example: 'pow(x, 2)' },
  { group: 'math', name: 'exp', signature: 'exp(x)', description: 'e to the power x.', example: 'exp(x)' },
  { group: 'math', name: 'log', signature: 'log(x)', description: 'Natural logarithm.', example: 'log(x)' },
  { group: 'math', name: 'log10', signature: 'log10(x)', description: 'Base-10 logarithm.', example: 'log10(x)' },
  { group: 'math', name: 'log2', signature: 'log2(x)', description: 'Base-2 logarithm.', example: 'log2(x)' },
  { group: 'math', name: 'sin', signature: 'sin(x)', description: 'Sine (radians).', example: 'sin(x)' },
  { group: 'math', name: 'cos', signature: 'cos(x)', description: 'Cosine (radians).', example: 'cos(x)' },
  { group: 'math', name: 'tan', signature: 'tan(x)', description: 'Tangent (radians).', example: 'tan(x)' },
  { group: 'math', name: 'asin', signature: 'asin(x)', description: 'Arc sine.', example: 'asin(x)' },
  { group: 'math', name: 'acos', signature: 'acos(x)', description: 'Arc cosine.', example: 'acos(x)' },
  { group: 'math', name: 'atan', signature: 'atan(x)', description: 'Arc tangent.', example: 'atan(x)' },
  { group: 'math', name: 'atan2', signature: 'atan2(y, x)', description: 'Arc tangent of y/x.', example: 'atan2(y, x)' },
  { group: 'math', name: 'degrees', signature: 'degrees(x)', description: 'Radians to degrees.', example: 'degrees(x)' },
  { group: 'math', name: 'radians', signature: 'radians(x)', description: 'Degrees to radians.', example: 'radians(x)' },
  { group: 'math', name: 'clamp', signature: 'clamp(x, lo, hi)', description: 'Limit x to the range lo…hi.', example: 'clamp(x, 0, 100)' },
  { group: 'math', name: 'sign', signature: 'sign(x)', description: '-1, 0 or 1.', example: 'sign(x)' },
  { group: 'math', name: 'hypot', signature: 'hypot(x, y)', description: 'Euclidean length.', example: 'hypot(x, y)' },
  { group: 'logic', name: 'if', signature: 'if(cond, a, b)', description: 'a when cond is true, otherwise b.', example: 'if(x > 0, "RUN", "STOP")' },
  { group: 'logic', name: 'coalesce', signature: 'coalesce(a, b, …)', description: 'First argument that is not null.', example: 'coalesce(a, 0)' },
  { group: 'logic', name: 'isnull', signature: 'isnull(x)', description: 'True when x is null.', example: 'isnull(x)' },
  { group: 'string', name: 'str', signature: 'str(x)', description: 'Convert to text.', example: 'str(x)' },
  { group: 'string', name: 'int', signature: 'int(x)', description: 'Convert to an integer.', example: 'int(x)' },
  { group: 'string', name: 'float', signature: 'float(x)', description: 'Convert to a number.', example: 'float(x)' },
  { group: 'string', name: 'bool', signature: 'bool(x)', description: 'Convert to true / false.', example: 'bool(x)' },
  { group: 'string', name: 'upper', signature: 'upper(s)', description: 'Upper case.', example: 'upper(s)' },
  { group: 'string', name: 'lower', signature: 'lower(s)', description: 'Lower case.', example: 'lower(s)' },
  { group: 'string', name: 'concat', signature: 'concat(a, b, …)', description: 'Join texts.', example: 'concat(a, "-", b)' },
  { group: 'string', name: 'len', signature: 'len(s)', description: 'Length of a text.', example: 'len(s)' },
  { group: 'string', name: 'substr', signature: 'substr(s, start, len)', description: 'Part of a text (start at 0).', example: 'substr(s, 0, 4)' },
  { group: 'string', name: 'replace', signature: 'replace(s, a, b)', description: 'Replace every a with b.', example: 'replace(s, "_", " ")' },
  { group: 'string', name: 'format', signature: 'format(x, digits)', description: 'Number as text with fixed digits.', example: 'format(x, 1)' },
  { group: 'time', name: 'now', signature: 'now()', description: 'Platform clock (publish time).', example: 'now()' },
  { group: 'time', name: 'ts', signature: 'ts(ref)', description: "Source timestamp of the signal's raw group (source time, else received time).", example: 'ts(ref)' },
  { group: 'time', name: 'latest_ts', signature: 'latest_ts(ref, …)', description: 'Latest ts() over the references: the body source timestamp.', example: 'latest_ts(a, b)' },
  { group: 'time', name: 'age', signature: 'age(ref)', description: 'Seconds since the value was received.', example: 'age(ref)' },
  { group: 'time', name: 'quality', signature: 'quality(ref)', description: 'Quality of the latest value ("GOOD", …).', example: 'quality(ref)' },
  { group: 'time', name: 'value_at', signature: 'value_at(ref, time)', description: 'Value of the signal as of a past instant (snapshot semantics).', example: 'value_at(a, ts(b))' },
  { group: 'filter', name: 'debounce', signature: 'debounce(x, ms)', description: 'Changes only after x was stable for ms.', example: 'debounce(x, 2000)' },
  { group: 'filter', name: 'hold', signature: 'hold(x, ms)', description: 'Keeps the last non-null value for ms.', example: 'hold(x, 5000)' },
  { group: 'filter', name: 'avg', signature: 'avg(x, n)', description: 'Moving average over the last n samples.', example: 'avg(x, 10)' },
  { group: 'filter', name: 'ema', signature: 'ema(x, alpha)', description: 'Exponential moving average.', example: 'ema(x, 0.2)' },
  { group: 'filter', name: 'delta', signature: 'delta(x)', description: 'Change since the previous sample.', example: 'delta(x)' },
  { group: 'filter', name: 'rate', signature: 'rate(x)', description: 'Change per second.', example: 'rate(x)' },
  { group: 'filter', name: 'hysteresis', signature: 'hysteresis(x, low, high)', description: 'True above high, false below low, unchanged between.', example: 'hysteresis(x, 40, 60)' },
  { group: 'filter', name: 'changed', signature: 'changed(x)', description: 'True when x differs from the previous sample.', example: 'changed(x)' },
  { group: 'filter', name: 'count_changes', signature: 'count_changes(x)', description: 'Number of changes since the model started.', example: 'count_changes(x)' },
];

export const FUNCTION_GROUP_LABEL: Record<RuleFunction['group'], string> = {
  math: 'Math',
  logic: 'Logic',
  string: 'Text & conversion',
  time: 'Time & quality',
  filter: 'Stateful filters (state resets on restart)',
};

const FUNCTION_NAMES = new Set(RULE_FUNCTIONS.map((f) => f.name));
const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'true', 'false', 'null', 'True', 'False', 'None']);

// ------------------------------------------------------------------ tokenizer

export type TokenKind = 'ref' | 'broken' | 'string' | 'number' | 'keyword' | 'func' | 'ident' | 'op' | 'punct' | 'space' | 'error';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  /** For `ref` / `broken` / unknown identifiers. */
  message?: string;
  suggestions?: string[];
  signalId?: string;
}

const MISSING_PREFIX = '$⚠missing[';

/**
 * Length of a `$⚠missing[<label>](.@attr)*` reference at the start of `text`, else 0. The label is the
 * server's last known reference text, e.g. `$machine[M1].humidity`: brackets inside are balanced (or
 * escaped with `\`), so the closing bracket is found by depth, not by the first `]`.
 */
function missingRefLength(text: string): number {
  if (!text.startsWith(MISSING_PREFIX)) return 0;
  let depth = 1;
  let i = MISSING_PREFIX.length;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '\\') i += 2;
    else {
      if (c === '[') depth += 1;
      else if (c === ']') depth -= 1;
      else if (c === '\n') return 0;
      i += 1;
    }
  }
  if (depth !== 0) return 0;
  const attrs = /^(?:\.@[A-Za-z_]\w*)*/.exec(text.slice(i));
  return i + (attrs ? attrs[0].length : 0);
}

/** Tokenize a rule expression. With an index, references are resolved and unresolved ones marked broken. */
export function tokenize(text: string, index?: CatalogIndex | null): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, len: number, extra: Partial<Token> = {}) => {
    out.push({ kind, text: text.slice(i, i + len), start: i, ...extra });
    i += len;
  };
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest)!;
      push('space', m[0].length);
      continue;
    }
    if (ch === '$') {
      const missingLen = missingRefLength(rest);
      if (missingLen) {
        push('broken', missingLen, { message: 'This reference points to a deleted or archived signal or resource.' });
        continue;
      }
      const parsed = parseRef(rest);
      if (parsed) {
        if (index) {
          const res = resolveRef(index, parsed.ref);
          push(res.ok ? 'ref' : 'broken', parsed.length, {
            message: res.ok ? undefined : res.message,
            suggestions: res.suggestions,
            signalId: res.signal?.id,
          });
        } else push('ref', parsed.length);
        continue;
      }
      const partial = /^\$[^\s()+*/%,<>=!]*/.exec(rest)!;
      push('error', Math.max(1, partial[0].length), { message: 'Incomplete reference. Use $type[name].signal_key.' });
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      const closed = j < text.length;
      push(closed ? 'string' : 'error', Math.min(text.length, j + 1) - i, closed ? {} : { message: 'Unterminated string.' });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)!;
      push('number', m[0].length);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_]\w*/.exec(rest)!;
      const word = m[0];
      const after = text.slice(i + word.length).trimStart();
      if (after.startsWith('(') && (FUNCTION_NAMES.has(word) || word === 'if')) push('func', word.length);
      else if (KEYWORDS.has(word)) push('keyword', word.length);
      else if (after.startsWith('(')) push('error', word.length, { message: `Unknown function "${word}".`, suggestions: closest(Array.from(FUNCTION_NAMES), word) });
      else push('ident', word.length, { message: `"${word}" is not defined. References start with $, text needs quotes.` });
      continue;
    }
    const op = /^(\*\*|\/\/|==|!=|<=|>=|[+\-*/%<>])/.exec(rest);
    if (op) {
      push('op', op[0].length);
      continue;
    }
    if ('(),'.includes(ch)) {
      push('punct', 1);
      continue;
    }
    push('error', 1, { message: `Unexpected character "${ch}".` });
  }
  return out;
}

/** Local problems (unresolved references, unknown names, bad characters, unbalanced parentheses). */
export function localProblems(tokens: Token[]): string[] {
  const problems: string[] = [];
  tokens.forEach((t) => {
    if ((t.kind === 'broken' || t.kind === 'error' || t.kind === 'ident') && t.message) problems.push(`${t.text}: ${t.message}`);
  });
  let depth = 0;
  for (const t of tokens) {
    if (t.text === '(') depth += 1;
    if (t.text === ')') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push('Unbalanced parentheses.');
  return Array.from(new Set(problems));
}

/** Signal ids referenced by an expression (resolved references only). */
export function referencedSignals(text: string, index: CatalogIndex | null): string[] {
  if (!index) return [];
  return tokenize(text, index)
    .filter((t) => t.kind === 'ref' && t.signalId)
    .map((t) => t.signalId!);
}

/** Resource ids referenced (signals' owners and attribute references). */
export function referencedResources(text: string, index: CatalogIndex | null): string[] {
  if (!index) return [];
  const out: string[] = [];
  tokenize(text, index).forEach((t) => {
    if (t.kind !== 'ref') return;
    const parsed = parseRef(t.text);
    if (!parsed) return;
    // The selected resource itself (not the ancestor an attribute chain points at).
    const scope = resolveRef(index, { ...parsed.ref, attrs: ['name'], key: null }).resource;
    if (scope) out.push(scope.id);
  });
  return out;
}

// ------------------------------------------------------------------ autocomplete

export interface Completion {
  label: string;
  /** Text inserted in place of [from, cursor). */
  insert: string;
  from: number;
  detail?: string;
  /** Live value (formatted by the caller). */
  value?: unknown;
  kind: 'type' | 'resource' | 'signal' | 'attr' | 'func';
}

export function completions(text: string, cursor: number, index: CatalogIndex | null): Completion[] {
  const before = text.slice(0, cursor);
  const dollar = before.lastIndexOf('$');
  if (index && dollar >= 0) {
    const frag = before.slice(dollar);
    // Fragment must not contain whitespace / operators outside brackets.
    const inBracket = (frag.match(/\[/g) || []).length > (frag.match(/\]/g) || []).length;
    if (inBracket || !/[\s()+*/%,<>=!]/.test(frag.replace(/\[[^\]]*\]/g, ''))) {
      return refCompletions(frag, dollar, index);
    }
  }
  const word = /[A-Za-z_]\w*$/.exec(before);
  if (word && word[0].length >= 2) {
    const w = word[0].toLowerCase();
    return RULE_FUNCTIONS.filter((f) => f.name.startsWith(w) && f.name !== w)
      .slice(0, 8)
      .map((f) => ({ label: f.signature, insert: `${f.name}(`, from: cursor - word[0].length, detail: f.description, kind: 'func' as const }));
  }
  return [];
}

function refCompletions(frag: string, from: number, index: CatalogIndex): Completion[] {
  // 1) `$` or `$ty` → types
  const typeOnly = /^\$([A-Za-z_]\w*)?$/.exec(frag);
  if (typeOnly) {
    const w = (typeOnly[1] || '').toLowerCase();
    return index.types
      .filter((t) => t.toLowerCase().startsWith(w))
      .map((t) => ({
        label: `$${t}`,
        insert: `$${t}[`,
        from,
        detail: `${index.catalog.resources.filter((r) => r.type === t).length} resource(s)`,
        kind: 'type' as const,
      }));
  }
  // 2) `…type[na` → names of that type (inside the previous scope)
  const openName = /^(.*?)([A-Za-z_]\w*)\[([^\]]*)$/.exec(frag);
  if (openName) {
    const [, prefix, type, partial] = openName;
    let pool = index.catalog.resources.filter((r) => r.type === type);
    const scopeRef = prefix.replace(/\.$/, '');
    if (scopeRef.length > 1) {
      const parsed = parseRef(scopeRef);
      const scope = parsed ? resolveRef(index, { ...parsed.ref, attrs: ['name'] }).resource : undefined;
      if (scope) {
        const ids = new Set(signalsUnderResources(index, scope.id));
        pool = pool.filter((r) => ids.has(r.id));
      }
    }
    const p = partial.toLowerCase();
    const head = from + prefix.length;
    return pool
      .filter((r) => resourceLabel(r).toLowerCase().includes(p) || r.code.toLowerCase().includes(p))
      .slice(0, 30)
      .map((r) => ({
        label: resourceLabel(r),
        // At the start of a reference, an ambiguous name gets its parent chain inserted too.
        insert: prefix === '$' ? resourceSelector(index, r.id) : `${type}${bracket(resourceLabel(r))}`,
        from: head,
        detail: resourcePath(index, r.id).slice(0, -1).map(resourceLabel).join(' › '),
        kind: 'resource' as const,
      }));
  }
  // 3) `$type[Name].` / `.ke` / `.@` → keys, attributes and child selectors
  const afterSel = /^(\$.*\])\.(@?[A-Za-z_]?\w*)$/.exec(frag);
  if (afterSel) {
    const [, selText, partialRaw] = afterSel;
    const parsed = parseRef(selText);
    if (!parsed) return [];
    const res = resolveRef(index, { ...parsed.ref, attrs: ['name'], key: null });
    const scope = res.resource;
    if (!scope) return [];
    const head = from + selText.length + 1;
    const partial = partialRaw.toLowerCase();
    const out: Completion[] = [];
    (index.signalsOf.get(scope.id) || [])
      .filter((s) => s.key.toLowerCase().startsWith(partial) || (!partial.startsWith('@') && s.key.toLowerCase().includes(partial)))
      .forEach((s) => out.push({ label: s.key, insert: s.key, from: head, detail: s.name !== s.key ? s.name : s.dataType, value: s.value, kind: 'signal' }));
    const attrs = ['@name', '@code', ...resourcePath(index, scope.id).slice(0, -1).map((r) => `@${r.type}.@name`)];
    attrs
      .filter((a) => a.toLowerCase().startsWith(partial.startsWith('@') ? partial : `@${partial}`))
      .forEach((a) => {
        const anc = a.split('.')[0].slice(1);
        const target = a === '@name' || a === '@code' ? scope : resourcePath(index, scope.id).find((r) => r.type === anc);
        out.push({ label: a, insert: a, from: head, detail: 'attribute', value: a === '@code' ? target?.code : resourceLabel(target), kind: 'attr' });
      });
    if (!partial.startsWith('@')) {
      const childTypes = Array.from(new Set((index.childrenOf.get(scope.id) || []).map((c) => c.type)));
      childTypes
        .filter((t) => t.startsWith(partial))
        .forEach((t) => out.push({ label: `${t}[…]`, insert: `${t}[`, from: head, detail: 'narrow to a child', kind: 'type' }));
    }
    return out.slice(0, 60);
  }
  // 4) `$type[Name].@zone.` → @name / @code
  const attrNext = /^(\$.*\]\.@[A-Za-z_]\w*)\.(@?\w*)$/.exec(frag);
  if (attrNext) {
    const head = from + attrNext[1].length + 1;
    return ['@name', '@code'].map((a) => ({ label: a, insert: a, from: head, detail: 'attribute', kind: 'attr' as const }));
  }
  return [];
}

function signalsUnderResources(index: CatalogIndex, rootId: string): string[] {
  const out: string[] = [];
  const visit = (id: string, depth: number) => {
    if (depth > 32) return;
    (index.childrenOf.get(id) || []).forEach((c) => {
      out.push(c.id);
      visit(c.id, depth + 1);
    });
  };
  visit(rootId, 0);
  return out;
}

// ------------------------------------------------------------------ examples

export interface RuleExample {
  label: string;
  build: (refs: string[]) => string;
  valueType?: 'string' | 'float' | 'timestamp' | 'auto';
}

/** `$machine[M1].status` → `$machine[M1]` (the resource part of a signal reference). */
function selectorOf(ref: string): string {
  const parsed = parseRef(ref);
  if (!parsed || !parsed.ref.key) return ref;
  return parsed.ref.selectors.map((s, i) => `${i === 0 ? '$' : '.'}${s.type}${bracket(s.name)}`).join('');
}

const pick = (refs: string[], i: number) => refs[i] || refs[0] || '$machine[NAME].signal_key';

export const RULE_EXAMPLES: RuleExample[] = [
  { label: 'Constant text', build: () => '"TEXT"', valueType: 'string' },
  { label: 'Sum', build: (r) => `${pick(r, 0)} + ${pick(r, 1)}`, valueType: 'float' },
  { label: 'Average', build: (r) => `(${pick(r, 0)} + ${pick(r, 1)}) / 2`, valueType: 'float' },
  { label: 'If / else', build: (r) => `"HIGH" if ${pick(r, 0)} > 50 else "NORMAL"`, valueType: 'string' },
  { label: 'Debounce', build: (r) => `debounce(${pick(r, 0)}, 2000)` },
  { label: 'Source timestamp (latest_ts)', build: (r) => `latest_ts(${(r.length ? r : [pick(r, 0)]).join(', ')})`, valueType: 'timestamp' },
  { label: 'Publish timestamp (now)', build: () => 'now()', valueType: 'timestamp' },
  { label: 'Value at a past instant (value_at)', build: (r) => `value_at(${pick(r, 0)}, ts(${pick(r, 1)}))` },
  {
    label: 'Name from the hierarchy',
    build: (r) => `${selectorOf(r[0] || '$machine[NAME].key')}.@zone.@name`,
    valueType: 'string',
  },
];
