// Data Model (output group) types + tolerant normalisers for the /api/v1/output-groups contract.

export type ModelKind = 'STATE' | 'EVENT';
export type ModelStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type MemberKind = 'signal' | 'context' | 'constant' | 'system' | 'snapshot';
export type SystemField = 'source_timestamp' | 'publish_timestamp';
export type ConstantType = 'string' | 'number' | 'boolean' | 'null' | 'json';

/** Hierarchy levels a context field can read (backend domain/body.py CONTEXT_LEVELS). */
export const CONTEXT_LEVELS = ['zone', 'line', 'machine', 'self', 'area', 'cell', 'workshop', 'plant', 'site', 'enterprise'] as const;
export const CONTEXT_REFS: string[] = CONTEXT_LEVELS.flatMap((level) => [`${level}.name`, `${level}.code`]);

export const SYSTEM_FIELDS: SystemField[] = ['source_timestamp', 'publish_timestamp'];

export const MEMBER_KIND_LABEL: Record<MemberKind, string> = {
  signal: 'Signal',
  context: 'Context',
  constant: 'Constant',
  system: 'System timestamp',
  snapshot: 'Snapshot',
};

/** Row in the catalog list (GET /output-groups). */
export interface ModelListItem {
  id: string;
  key: string;
  display_name: string;
  topic_template: string;
  resource_id: string;
  resource_name?: string;
  resource_code?: string;
  status: ModelStatus;
  kind: ModelKind;
  version: number;
  member_count: number;
  updated_at?: string | null;
}

/** Member as sent to / received from the backend. */
export interface ApiMember {
  kind: MemberKind;
  alias: string;
  signal_id?: string | null;
  signal_key?: string | null;
  context_ref?: string | null;
  value?: unknown;
  field?: SystemField | null;
  contributes_ts?: boolean;
  is_trigger?: boolean;
}

export interface EmitPolicy {
  republish_ms: number | null;
}

export interface ModelDetail extends ModelListItem {
  emit_policy: EmitPolicy;
  members: ApiMember[];
}

/** Editable member row (client state). */
export interface MemberRow {
  uid: string;
  kind: MemberKind;
  alias: string;
  signalId: string;
  signalKey: string;
  contextRef: string;
  constantType: ConstantType;
  constantText: string;
  field: SystemField | '';
  contributesTs: boolean;
  isTrigger: boolean;
}

export interface ModelTemplate {
  id: string;
  key: string;
  display_name: string;
  kind: ModelKind;
  topic_template?: string;
  builtin: boolean;
  members: ApiMember[];
  emit_policy?: EmitPolicy;
}

export type ApplyStatus = 'created' | 'exists' | 'missing' | 'dry_run';

export interface ApplyResult {
  resource_id: string;
  resource_name: string;
  group_id: string | null;
  missing_keys: string[];
  status: ApplyStatus;
  published: boolean;
}

export interface PreviewField {
  alias: string;
  kind: MemberKind;
  value: unknown;
  quality: string | null;
  source_time: string | null;
  received_time: string | null;
  contributes_ts: boolean;
  signal_id: string | null;
  wins: boolean;
}

export interface PreviewResult {
  topic: string | null;
  topic_error: string | null;
  body: string | null;
  fields: PreviewField[];
  source_timestamp: string | null;
  source_timestamp_from: string | null;
}

export interface LatestResult {
  body: string | null;
  source_ts: string | null;
  published_at: string | null;
}

export interface ModelEventItem {
  id: string;
  source_ts: string | null;
  body: string;
}

export interface ResourceSignal {
  id: string;
  key: string;
  displayName: string;
  dataType: string;
  unit: string;
  resourceId: string;
}

export interface LatestValue {
  value: unknown;
  quality: string | null;
  receivedTime: string | null;
  sourceTime: string | null;
}

// ---------------------------------------------------------------- normalisers

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const optStr = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export function normKind(v: unknown): ModelKind {
  return str(v).toUpperCase() === 'EVENT' ? 'EVENT' : 'STATE';
}

export function normStatus(v: unknown): ModelStatus {
  const s = str(v).toUpperCase();
  return s === 'PUBLISHED' || s === 'ARCHIVED' ? s : 'DRAFT';
}

function normMemberKind(v: unknown): MemberKind {
  const s = str(v).toLowerCase();
  if (s === 'context' || s === 'constant' || s === 'system' || s === 'snapshot') return s;
  return 'signal';
}

export function normMember(raw: Raw): ApiMember {
  const kind = normMemberKind(raw.kind ?? raw.member_kind);
  let value: unknown = raw.value;
  if (value === undefined && raw.constant_json !== undefined) {
    const cj = raw.constant_json as Raw | null;
    value = cj && typeof cj === 'object' && 'v' in cj ? cj.v : cj;
  }
  const field = optStr(raw.field ?? raw.system_field);
  return {
    kind,
    alias: str(raw.alias ?? raw.output_alias),
    signal_id: optStr(raw.signal_id),
    signal_key: optStr(raw.signal_key),
    context_ref: optStr(raw.context_ref),
    value,
    field: field === 'source_timestamp' || field === 'publish_timestamp' ? field : null,
    contributes_ts: raw.contributes_ts === undefined ? kind === 'signal' : Boolean(raw.contributes_ts),
    is_trigger: Boolean(raw.is_trigger),
  };
}

export function normListItem(raw: Raw): ModelListItem {
  return {
    id: str(raw.id),
    key: str(raw.key),
    display_name: str(raw.display_name || raw.key),
    topic_template: str(raw.topic_template),
    resource_id: str(raw.resource_id),
    resource_name: optStr(raw.resource_name) ?? undefined,
    resource_code: optStr(raw.resource_code) ?? undefined,
    status: normStatus(raw.status),
    kind: normKind(raw.kind),
    version: Number(raw.version ?? 1),
    member_count: Number(raw.member_count ?? (Array.isArray(raw.members) ? raw.members.length : 0)),
    updated_at: optStr(raw.updated_at),
  };
}

function normEmitPolicy(raw: unknown): EmitPolicy {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const ms = obj.republish_ms;
  return { republish_ms: ms === null || ms === undefined || ms === '' ? null : Number(ms) };
}

export function normDetail(raw: Raw): ModelDetail {
  const members = Array.isArray(raw.members) ? (raw.members as Raw[]).map(normMember) : [];
  return {
    ...normListItem(raw),
    member_count: members.length,
    emit_policy: normEmitPolicy(raw.emit_policy ?? raw.emit_policy_json),
    members,
  };
}

export function normTemplate(raw: Raw): ModelTemplate {
  const list = (raw.members ?? raw.fields ?? raw.fields_json) as Raw[] | undefined;
  return {
    id: str(raw.id),
    key: str(raw.key),
    display_name: str(raw.display_name || raw.key),
    kind: normKind(raw.kind),
    topic_template: optStr(raw.topic_template) ?? undefined,
    builtin: Boolean(raw.builtin ?? raw.is_builtin ?? raw.system),
    members: Array.isArray(list) ? list.map(normMember) : [],
    emit_policy: raw.emit_policy || raw.emit_policy_json ? normEmitPolicy(raw.emit_policy ?? raw.emit_policy_json) : undefined,
  };
}

export function normPreview(raw: Raw | null | undefined): PreviewResult {
  const r: Raw = raw || {};
  let fields: PreviewField[] = [];
  if (Array.isArray(r.fields)) {
    fields = (r.fields as Raw[]).map((f) => ({
      alias: str(f.alias),
      kind: normMemberKind(f.kind),
      value: f.value,
      quality: optStr(f.quality),
      source_time: optStr(f.source_time),
      received_time: optStr(f.received_time),
      contributes_ts: Boolean(f.contributes_ts),
      signal_id: optStr(f.signal_id),
      wins: Boolean(f.wins_source_timestamp),
    }));
  }
  let body: string | null = null;
  if (typeof r.body === 'string') body = r.body;
  else if (r.body && typeof r.body === 'object') body = JSON.stringify(r.body);
  return {
    topic: optStr(r.topic),
    topic_error: optStr(r.topic_error),
    body,
    fields,
    source_timestamp: optStr(r.source_timestamp),
    source_timestamp_from: optStr(r.source_timestamp_from) ?? fields.find((f) => f.wins)?.alias ?? null,
  };
}

export function normEvent(raw: Raw): ModelEventItem {
  return {
    id: str(raw.id ?? raw.event_id),
    source_ts: optStr(raw.source_ts),
    body: typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body ?? null),
  };
}

// ---------------------------------------------------------------- row helpers

let uidCounter = 0;
export function newUid(): string {
  uidCounter += 1;
  return `r${Date.now().toString(36)}${uidCounter}`;
}

export function blankRow(kind: MemberKind, alias = ''): MemberRow {
  return {
    uid: newUid(),
    kind,
    alias,
    signalId: '',
    signalKey: '',
    contextRef: kind === 'context' ? 'self.name' : '',
    constantType: 'string',
    constantText: '',
    field: kind === 'system' ? 'source_timestamp' : '',
    contributesTs: kind === 'signal',
    isTrigger: false,
  };
}

function constantToRow(value: unknown): { constantType: ConstantType; constantText: string } {
  if (value === null || value === undefined) return { constantType: 'null', constantText: '' };
  if (typeof value === 'number') return { constantType: 'number', constantText: String(value) };
  if (typeof value === 'boolean') return { constantType: 'boolean', constantText: String(value) };
  if (typeof value === 'string') return { constantType: 'string', constantText: value };
  return { constantType: 'json', constantText: JSON.stringify(value) };
}

export function memberToRow(m: ApiMember): MemberRow {
  const c = m.kind === 'constant' ? constantToRow(m.value) : { constantType: 'string' as ConstantType, constantText: '' };
  return {
    uid: newUid(),
    kind: m.kind,
    alias: m.alias,
    signalId: m.signal_id || '',
    signalKey: m.signal_key || '',
    contextRef: m.context_ref || '',
    constantType: c.constantType,
    constantText: c.constantText,
    field: m.field || '',
    contributesTs: m.kind === 'signal' ? m.contributes_ts !== false : false,
    isTrigger: Boolean(m.is_trigger),
  };
}

/** Parse a constant row; returns {ok:false} when the text does not match the chosen type. */
export function parseConstant(row: Pick<MemberRow, 'constantType' | 'constantText'>): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = row.constantText;
  switch (row.constantType) {
    case 'null':
      return { ok: true, value: null };
    case 'string':
      return { ok: true, value: t };
    case 'number': {
      if (t.trim() === '' || !Number.isFinite(Number(t))) return { ok: false, error: 'Enter a valid number.' };
      return { ok: true, value: Number(t) };
    }
    case 'boolean': {
      if (t !== 'true' && t !== 'false') return { ok: false, error: 'Choose true or false.' };
      return { ok: true, value: t === 'true' };
    }
    case 'json':
    default:
      try {
        return { ok: true, value: JSON.parse(t) };
      } catch {
        return { ok: false, error: 'Enter valid JSON (e.g. {"a": 1} or [1, 2]).' };
      }
  }
}

export function rowToMember(row: MemberRow, modelKind: ModelKind, signalKeyById: Map<string, string>): ApiMember {
  const alias = row.alias.trim();
  switch (row.kind) {
    case 'signal':
    case 'snapshot':
      return {
        kind: row.kind,
        alias,
        signal_id: row.signalId || null,
        signal_key: signalKeyById.get(row.signalId) || row.signalKey || null,
        contributes_ts: row.kind === 'signal' ? row.contributesTs : false,
        is_trigger: modelKind === 'EVENT' && row.kind === 'signal' ? row.isTrigger : false,
      };
    case 'context':
      return { kind: 'context', alias, context_ref: row.contextRef, contributes_ts: false, is_trigger: false };
    case 'constant': {
      const parsed = parseConstant(row);
      return { kind: 'constant', alias, value: parsed.ok ? parsed.value : null, contributes_ts: false, is_trigger: false };
    }
    case 'system':
    default:
      return { kind: 'system', alias, field: (row.field || 'source_timestamp') as SystemField, contributes_ts: false, is_trigger: false };
  }
}
