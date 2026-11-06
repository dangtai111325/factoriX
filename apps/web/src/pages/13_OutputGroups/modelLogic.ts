// Pure helpers for the Data Model screens: validation, JSON auto-mapping, hierarchy context,
// topic preview and order-preserving JSON formatting. No React here.
import type { ResourceNode } from '../../types';
import {
  CONTEXT_REFS,
  MemberRow,
  ModelKind,
  ResourceSignal,
  blankRow,
  parseConstant,
} from './types';

export const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Topic placeholders accepted by the backend (collect.ALLOWED_TEMPLATE_VARS). */
export const TOPIC_TOKENS = ['enterprise', 'site', 'plant', 'area', 'zone', 'workshop', 'line', 'cell', 'machine', 'resource', 'group'] as const;
/** Same default as the backend (domain/body.py DEFAULT_TEMPLATE_TOPIC). */
export const DEFAULT_TOPIC = '{enterprise}/{site}/{area}/{zone}/{line}/{machine}/{group}';
export const MAX_REPUBLISH_SEC = 86400;
/** Model key rule of the backend (collect.GROUP_KEY_RE). */
export const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ---------------------------------------------------------------- time formatting

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** UTC timestamp in the platform text format YYYY-MM-DDTHH:mm:ss.SSSZ (raw value kept when unparsable). */
export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString();
}

/** "5 s", "2 min", "1 h 30 min" for a duration in seconds. */
export function durationLabel(totalSec: number): string {
  const s = Math.round(totalSec);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (rest) parts.push(`${rest} s`);
  return parts.join(' ');
}

/** Human description of emit_policy.republish_ms. Event models never re-publish. */
export function republishLabel(republishMs: number | null | undefined, kind: ModelKind): string {
  if (kind === 'EVENT') return 'One body per trigger; no periodic re-publish';
  if (!republishMs) return 'No periodic re-publish (emits on change only)';
  return `Re-publish every ${durationLabel(republishMs / 1000)} when unchanged`;
}

// ---------------------------------------------------------------- hierarchy

export function ancestorsOf(resources: ResourceNode[], resourceId: string): ResourceNode[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const chain: ResourceNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(resourceId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/** "Site / Zone / Line" path above a resource (excluding the resource itself). */
export function parentPathLabel(resources: ResourceNode[], resourceId: string): string {
  const chain = ancestorsOf(resources, resourceId);
  return chain
    .slice(0, -1)
    .map((r) => r.name)
    .join(' / ');
}

/** Client-side estimate of what a context ref resolves to (the backend is authoritative). */
export function resolveContextRef(resources: ResourceNode[], resourceId: string, ref: string): string | null {
  const chain = ancestorsOf(resources, resourceId);
  const self = chain[chain.length - 1];
  if (!self) return null;
  const [level, attr] = ref.split('.');
  let node: ResourceNode | undefined;
  if (level === 'self') node = self;
  else node = [...chain].reverse().find((r) => String(r.type).toLowerCase() === level);
  if (!node) return null;
  return attr === 'code' ? node.code : node.name;
}

export function resolveTopicPreview(
  resources: ResourceNode[],
  resourceId: string,
  template: string,
  groupKey: string,
): string {
  if (!template) return '—';
  const chain = ancestorsOf(resources, resourceId);
  const self = chain[chain.length - 1];
  const codes: Record<string, string> = {};
  for (const r of chain) codes[String(r.type).toLowerCase()] = r.code;
  if (self) codes.resource = self.code;
  codes.group = groupKey || 'group';
  return template.replace(/\{([^}]+)\}/g, (all, name: string) => codes[name] ?? all);
}

/**
 * Lower-cased text a catalog search matches against: name, key, the resolved topic and the whole
 * breadcrumb of the scope resource (names and codes of every ancestor).
 */
export function modelSearchText(
  resources: ResourceNode[],
  model: { display_name: string; key: string; topic_template: string; resource_id: string; resource_name?: string; resource_code?: string },
): string {
  const chain = ancestorsOf(resources, model.resource_id);
  const parts = [
    model.display_name,
    model.key,
    model.topic_template,
    model.resource_name || '',
    model.resource_code || '',
    ...chain.flatMap((r) => [r.name, r.code]),
  ];
  if (chain.length) parts.push(resolveTopicPreview(resources, model.resource_id, model.topic_template || DEFAULT_TOPIC, model.key));
  return parts.join('\n').toLowerCase();
}

export function topicErrors(template: string): string | null {
  const t = template.trim();
  if (!t) return 'Enter a topic template.';
  if (t.startsWith('/')) return 'Topic templates must not start with "/".';
  if (t.includes('#') || t.includes('+')) return 'Topic templates must not contain the MQTT wildcards # or +.';
  const unknown = Array.from(t.matchAll(/\{([^}]*)\}/g))
    .map((m) => m[1])
    .filter((v) => !(TOPIC_TOKENS as readonly string[]).includes(v));
  if (unknown.length) return `Unknown placeholder ${unknown.map((u) => `{${u}}`).join(', ')}. Allowed: ${TOPIC_TOKENS.map((v) => `{${v}}`).join(' ')}`;
  return null;
}

export function modelKeyFromName(name: string): string {
  const k = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return k || 'model';
}

// ---------------------------------------------------------------- validation

export interface ValidationResult {
  ok: boolean;
  form: Record<string, string>;
  rows: Record<string, string[]>;
  rowWarnings: Record<string, string[]>;
  formWarnings: string[];
}

export function validateModel(input: {
  name: string;
  resourceId: string;
  topic: string;
  kind: ModelKind;
  republishSec: string;
  rows: MemberRow[];
  signalIds: Set<string> | null;
  resources: ResourceNode[];
}): ValidationResult {
  const form: Record<string, string> = {};
  const rows: Record<string, string[]> = {};
  const rowWarnings: Record<string, string[]> = {};
  const formWarnings: string[] = [];
  const addRow = (uid: string, msg: string) => (rows[uid] = [...(rows[uid] || []), msg]);
  const warnRow = (uid: string, msg: string) => (rowWarnings[uid] = [...(rowWarnings[uid] || []), msg]);

  if (!input.name.trim()) form.name = 'Enter a model name.';
  if (!input.resourceId) form.scope = 'Choose the resource this model belongs to.';
  const te = topicErrors(input.topic);
  if (te) form.topic = te;
  if (input.kind === 'STATE' && input.republishSec.trim() !== '') {
    const n = Number(input.republishSec);
    if (!Number.isFinite(n) || n < 1 || n > MAX_REPUBLISH_SEC)
      form.republish = `Re-publish interval must be between 1 and ${MAX_REPUBLISH_SEC} seconds, or empty.`;
  }

  if (input.rows.length === 0) form.rows = 'Add at least one field.';

  const seen = new Map<string, string>();
  for (const r of input.rows) {
    const alias = r.alias.trim();
    if (!alias) addRow(r.uid, 'Alias is required.');
    else if (!ALIAS_RE.test(alias)) addRow(r.uid, 'Alias must start with a letter or _ and use only letters, digits, _ (max 64).');
    else {
      const low = alias.toLowerCase();
      if (seen.has(low)) addRow(r.uid, `Duplicate alias (also used as "${seen.get(low)}"; aliases are case-insensitive).`);
      else seen.set(low, alias);
    }

    switch (r.kind) {
      case 'signal':
      case 'snapshot':
        if (!r.signalId) addRow(r.uid, r.signalKey ? `No signal selected (expected key "${r.signalKey}").` : 'Select a source signal.');
        else if (input.signalIds && !input.signalIds.has(r.signalId))
          addRow(r.uid, 'The selected signal does not belong to this resource or is no longer active.');
        if (r.kind === 'snapshot' && input.kind !== 'EVENT') addRow(r.uid, 'Snapshot fields are only valid in Event models.');
        break;
      case 'context':
        if (!CONTEXT_REFS.includes(r.contextRef)) addRow(r.uid, 'Choose a context reference.');
        else if (input.resourceId && resolveContextRef(input.resources, input.resourceId, r.contextRef) === null)
          warnRow(r.uid, `"${r.contextRef}" is not found above this resource in the hierarchy; it will be null.`);
        break;
      case 'constant': {
        const p = parseConstant(r);
        if (!p.ok) addRow(r.uid, p.error);
        break;
      }
      case 'system':
        if (!r.field) addRow(r.uid, 'Choose a system field.');
        break;
    }
  }

  const sourceTs = input.rows.filter((r) => r.kind === 'system' && r.field === 'source_timestamp');
  const publishTs = input.rows.filter((r) => r.kind === 'system' && r.field === 'publish_timestamp');
  if (sourceTs.length === 0) form.sourceTs = 'Add exactly one "source_timestamp" system field.';
  if (sourceTs.length > 1) {
    form.sourceTs = 'Only one source_timestamp field is allowed.';
    sourceTs.slice(1).forEach((r) => addRow(r.uid, 'Second source_timestamp field.'));
  }
  if (publishTs.length > 1) publishTs.slice(1).forEach((r) => addRow(r.uid, 'Only one publish_timestamp field is allowed.'));
  if (publishTs.length === 0) formWarnings.push('No publish_timestamp field: consumers will not see when the platform emitted the body.');

  const signalRows = input.rows.filter((r) => r.kind === 'signal');
  if (signalRows.length > 0 && !signalRows.some((r) => r.contributesTs))
    formWarnings.push('No signal contributes to source_timestamp; it will always be null.');

  if (input.kind === 'EVENT') {
    if (!input.rows.some((r) => r.kind === 'signal' && r.isTrigger))
      form.trigger = 'Event models need at least one trigger signal (toggle "Trigger" on a signal row).';
  }

  return {
    ok: Object.keys(form).length === 0 && Object.keys(rows).length === 0,
    form,
    rows,
    rowWarnings,
    formWarnings,
  };
}

// ---------------------------------------------------------------- paste-JSON auto-mapping

const CONTEXT_KEY_MAP: Record<string, string> = {
  zone_name: 'zone.name',
  line_name: 'line.name',
  machine_name: 'machine.name',
  area_name: 'area.name',
  site_name: 'site.name',
  enterprise_name: 'enterprise.name',
};

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Flatten nested objects into a_b keys, keeping document key order. */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenKeys(v as Record<string, unknown>, key));
    else out.push([key, v]);
  }
  return out;
}

export interface JsonMappingResult {
  rows: MemberRow[];
  matched: number;
  unmatched: string[];
  context: number;
  system: number;
}

export function mapSampleJson(text: string, signals: ResourceSignal[], kind: ModelKind): JsonMappingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Paste a JSON object, e.g. {"status": 1, "mode": 2}.');
  const entries = flattenKeys(parsed as Record<string, unknown>);
  if (entries.length === 0) throw new Error('The JSON object has no fields.');

  const exact = new Map(signals.map((s) => [s.key.toLowerCase(), s]));
  const loose = new Map(signals.map((s) => [normKey(s.key), s]));
  const result: JsonMappingResult = { rows: [], matched: 0, unmatched: [], context: 0, system: 0 };

  for (const [rawKey] of entries) {
    const alias = ALIAS_RE.test(rawKey) ? rawKey : rawKey.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 64);
    const low = rawKey.toLowerCase();
    if (CONTEXT_KEY_MAP[low]) {
      const row = blankRow('context', alias);
      row.contextRef = CONTEXT_KEY_MAP[low];
      result.rows.push(row);
      result.context += 1;
      continue;
    }
    if (low === 'source_timestamp' || low === 'publish_timestamp') {
      const row = blankRow('system', alias);
      row.field = low;
      result.rows.push(row);
      result.system += 1;
      continue;
    }
    const sig = exact.get(low) || loose.get(normKey(rawKey));
    const row = blankRow('signal', alias);
    if (sig) {
      row.signalId = sig.id;
      row.signalKey = sig.key;
      result.matched += 1;
    } else {
      row.signalKey = rawKey;
      result.unmatched.push(rawKey);
    }
    result.rows.push(row);
  }
  return result;
}

/** Standard header rows used by every clean body: context then the two timestamps. */
export function standardHeaderRows(includeMachine: boolean): MemberRow[] {
  const refs: Array<[string, string]> = [
    ['zone_name', 'zone.name'],
    ['line_name', 'line.name'],
  ];
  if (includeMachine) refs.push(['machine_name', 'machine.name']);
  const rows = refs.map(([alias, ref]) => {
    const r = blankRow('context', alias);
    r.contextRef = ref;
    return r;
  });
  const st = blankRow('system', 'source_timestamp');
  st.field = 'source_timestamp';
  const pt = blankRow('system', 'publish_timestamp');
  pt.field = 'publish_timestamp';
  return [...rows, st, pt];
}

// ---------------------------------------------------------------- JSON text formatting

/**
 * Pretty-print JSON text without re-serialising values: key order and number literals are kept
 * exactly as emitted (JSON.parse/stringify would e.g. turn 1.50 into 1.5).
 */
export function prettyJsonText(text: string, indent = 2): string {
  let out = '';
  let level = 0;
  let inStr = false;
  let esc = false;
  const pad = (n: number) => '\n' + ' '.repeat(n * indent);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '{' || ch === '[') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === (ch === '{' ? '}' : ']')) {
        out += ch + text[j];
        i = j;
      } else {
        level += 1;
        out += ch + pad(level);
      }
    } else if (ch === '}' || ch === ']') {
      level = Math.max(0, level - 1);
      out += pad(level) + ch;
    } else if (ch === ',') {
      out += ',' + pad(level);
    } else if (ch === ':') {
      out += ': ';
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

export function displayValue(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
