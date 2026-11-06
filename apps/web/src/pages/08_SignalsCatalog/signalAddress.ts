/**
 * Source-address editing of bound signals (R2-SG-03). Pure model + API calls, no React.
 *
 * Endpoints (Center):
 *   PATCH /api/v1/signals/{id}          {version, address_patch: {...}, ...definition fields}
 *   POST  /api/v1/signals/bulk-address  {items: [{signal_id, version, address_patch}]}  (1–1000, all or nothing)
 * In an address_patch a `null` value removes the key (back to the default); node_id, jsonpath, topic and
 * path cannot be removed. `timestamp_path: ""` disables the sibling source_timestamp rule.
 */
import { api, ApiError } from '../../api/client';
import { ProtocolType, SignalItem } from '../../types';

export type AddressFieldKind = 'text' | 'int' | 'select' | 'bool' | 'timestamp_path';

export interface AddressFieldSpec {
  key: string;
  label: string;
  kind: AddressFieldKind;
  /** Free-text fields that can carry a machine code / namespace (offered for find/replace and patterns). */
  textual?: boolean;
  required?: boolean;
  /** Optional key that can be removed (back to the default). */
  removable?: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
}

const NODE_ID = /^(?:(?:ns=\d+|nsu=[^;]+);)?[isgb]=.+$/s;

const COMMON: AddressFieldSpec[] = [
  { key: 'nullable', label: 'Null is Good', kind: 'bool', help: 'A null value from a successful read is Good, not Bad.' },
  { key: 'round_digits', label: 'Round digits', kind: 'int', min: 0, max: 10, removable: true, placeholder: 'No rounding' },
];

const TIMESTAMP_PATH: AddressFieldSpec = {
  key: 'timestamp_path',
  label: 'Source time',
  kind: 'timestamp_path',
  textual: true,
  removable: true,
  placeholder: '$.meta.source_timestamp',
  help: 'Default: the source_timestamp next to the field in the same object.',
};

export const ADDRESS_FIELDS: Record<ProtocolType, AddressFieldSpec[]> = {
  modbus: [
    { key: 'unit_id', label: 'Unit ID', kind: 'int', min: 0, max: 247, removable: true, placeholder: 'Connection default' },
    {
      key: 'register_area',
      label: 'Register area',
      kind: 'select',
      options: ['holding', 'input', 'coil', 'discrete'].map((v) => ({ value: v, label: v })),
    },
    { key: 'offset', label: 'Offset', kind: 'int', min: 0, max: 65535, help: '0-based PDU address (holding register 0 = 40001).' },
    {
      key: 'native_type',
      label: 'Native type',
      kind: 'select',
      options: ['bool', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64', 'float32', 'float64', 'ascii'].map((v) => ({ value: v, label: v })),
    },
    { key: 'register_count', label: 'Register count', kind: 'int', min: 1, max: 125, removable: true, placeholder: 'From the type' },
    {
      key: 'word_order',
      label: 'Word order',
      kind: 'select',
      options: [
        { value: 'big', label: 'big (high word first)' },
        { value: 'little', label: 'little' },
      ],
    },
    {
      key: 'role',
      label: 'Role',
      kind: 'select',
      removable: true,
      options: [
        { value: '', label: 'Value' },
        { value: 'source_timestamp', label: 'Source timestamp of the unit' },
      ],
    },
    ...COMMON,
  ],
  opcua: [
    { key: 'node_id', label: 'Node ID', kind: 'text', textual: true, required: true, placeholder: 'ns=2;s=Device.Group.field' },
    {
      key: 'timestamp_node_id',
      label: 'Source time node',
      kind: 'text',
      textual: true,
      removable: true,
      placeholder: 'Empty = DataValue.SourceTimestamp of the node',
      help: 'Node holding the group timestamp, read in the same batch.',
    },
    ...COMMON,
  ],
  mqtt: [
    { key: 'topic', label: 'Topic', kind: 'text', textual: true, required: true, placeholder: 'plant/line/machine/telemetry' },
    { key: 'jsonpath', label: 'JSONPath', kind: 'text', textual: true, required: true, placeholder: '$.field' },
    TIMESTAMP_PATH,
    {
      key: 'qos',
      label: 'QoS',
      kind: 'select',
      removable: true,
      options: [
        { value: '0', label: '0 – at most once' },
        { value: '1', label: '1 – at least once' },
        { value: '2', label: '2 – exactly once' },
      ],
    },
    ...COMMON,
  ],
  http: [
    {
      key: 'method',
      label: 'Method',
      kind: 'select',
      options: [
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' },
      ],
    },
    { key: 'path', label: 'Path', kind: 'text', textual: true, required: true, placeholder: '/api/v1/…' },
    { key: 'jsonpath', label: 'JSONPath', kind: 'text', textual: true, required: true, placeholder: '$.field' },
    TIMESTAMP_PATH,
    ...COMMON,
  ],
  websocket: [
    { key: 'jsonpath', label: 'JSONPath', kind: 'text', textual: true, required: true, placeholder: '$.field' },
    TIMESTAMP_PATH,
    ...COMMON,
  ],
};

export function protocolOfSignal(signal: SignalItem): ProtocolType | null {
  const raw = (signal.connectionProtocol || signal.addressKind || '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('modbus')) return 'modbus';
  if (raw.includes('opc')) return 'opcua';
  if (raw.includes('mqtt')) return 'mqtt';
  if (raw.includes('websocket') || raw === 'ws') return 'websocket';
  if (raw.includes('http')) return 'http';
  return null;
}

export function fieldSpec(protocol: ProtocolType, key: string): AddressFieldSpec | undefined {
  return ADDRESS_FIELDS[protocol].find((spec) => spec.key === key);
}

/** Client-side check of one address value (same rules as the Center); null = valid. */
export function validateAddressValue(protocol: ProtocolType, key: string, value: unknown): string | null {
  const spec = fieldSpec(protocol, key);
  if (!spec) return `${key} is not an address field of this protocol.`;
  if (value === null || value === undefined) return spec.required ? `${spec.label} cannot be removed.` : null;
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean' ? null : `${spec.label} must be true or false.`;
    case 'int': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (String(value).trim() === '' || !Number.isInteger(n)) return `${spec.label} must be a whole number.`;
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return `${spec.label}: ${spec.min}–${spec.max}.`;
      return null;
    }
    case 'select':
      return spec.options?.some((o) => o.value === String(value)) ? null : `Choose a ${spec.label.toLowerCase()}.`;
    case 'timestamp_path': {
      const text = String(value).trim();
      if (text === '') return null;
      return text.startsWith('$') ? null : 'The source time JSONPath starts with $.';
    }
    default: {
      const text = String(value).trim();
      if (!text) return spec.required ? `Enter the ${spec.label.toLowerCase()}.` : null;
      if (text.length > 1024) return `${spec.label} is too long.`;
      if (key === 'node_id' || key === 'timestamp_node_id') {
        return NODE_ID.test(text) ? null : 'Node ID format: ns=<index>;s=<identifier> (or i=, g=, b=).';
      }
      if (key === 'jsonpath') return text.startsWith('$') ? null : 'JSONPath starts with $ (e.g. $.status).';
      if (key === 'path') return text.startsWith('/') && !text.includes('://') && !text.startsWith('//') ? null : 'Path starts with / and is relative to the base URL.';
      if (key === 'topic') {
        if (/[#+]/.test(text)) return 'Use the exact topic, not a filter with + or #.';
        if (text.startsWith('$')) return 'Topics starting with $ are reserved by the broker.';
        return null;
      }
      return null;
    }
  }
}

/** Normalise a form value to what address_json stores (numbers for int / numeric selects). */
export function normaliseValue(protocol: ProtocolType, key: string, value: unknown): unknown {
  const spec = fieldSpec(protocol, key);
  if (!spec || value === null || value === undefined) return value;
  if (spec.kind === 'int') return String(value).trim() === '' ? null : Number(String(value).trim());
  if (key === 'qos') return String(value) === '' ? null : Number(value);
  if (key === 'role' && value === '') return null;
  if (spec.kind === 'text') {
    const text = String(value).trim();
    return text === '' && spec.removable ? null : text;
  }
  if (spec.kind === 'timestamp_path') return String(value).trim();
  return value;
}

/** Keys whose value differs between the stored address and the edited one (null = remove the key). */
export function addressPatch(current: Record<string, unknown>, edited: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(current), ...Object.keys(edited)]);
  keys.forEach((key) => {
    if (!(key in edited)) return;
    const before = key in current ? current[key] : undefined;
    const after = edited[key];
    if (after === null || after === undefined) {
      if (before !== undefined && before !== null) patch[key] = null;
      return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) patch[key] = after;
  });
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Bulk rules: set a field from a per-signal pattern, or find/replace text in address fields.
// Placeholders: {machine} = code of the signal's resource, {resource} = its name, {ns} = namespace
// index of the signal's own node_id, {key} = signal key.
// ---------------------------------------------------------------------------------------------

export type BulkRule =
  | { mode: 'set'; field: string; pattern: string; remove: boolean }
  | { mode: 'replace'; field: string; find: string; replace: string };

export interface PlaceholderContext {
  machine: string;
  resource: string;
  key: string;
  ns: string;
}

export function placeholderContext(signal: SignalItem, resourceCode: string, resourceName: string): PlaceholderContext {
  const nodeId = String((signal.addressJson || {}).node_id || '');
  const ns = /^ns=(\d+);/.exec(nodeId)?.[1] || '';
  return { machine: resourceCode, resource: resourceName, key: signal.key || '', ns };
}

export const PLACEHOLDERS: Array<{ token: string; description: string }> = [
  { token: '{machine}', description: 'code of the signal’s resource' },
  { token: '{resource}', description: 'name of the signal’s resource' },
  { token: '{ns}', description: 'namespace index of the signal’s node ID' },
  { token: '{key}', description: 'signal key' },
];

export function expandPattern(pattern: string, ctx: PlaceholderContext): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = pattern.replace(/\{(machine|resource|ns|key)\}/g, (_match, token: keyof PlaceholderContext) => {
    if (!ctx[token]) missing.push(`{${token}}`);
    return ctx[token];
  });
  return { value, missing };
}

/** Keys a rule may target for every protocol in `protocols` (intersection). */
export function commonFields(protocols: ProtocolType[]): AddressFieldSpec[] {
  if (!protocols.length) return [];
  const [first, ...rest] = protocols;
  return ADDRESS_FIELDS[first].filter((spec) => rest.every((p) => ADDRESS_FIELDS[p].some((other) => other.key === spec.key)));
}

export interface BulkPreviewRow {
  signal: SignalItem;
  protocol: ProtocolType | null;
  field: string;
  before: unknown;
  after: unknown;
  patch: Record<string, unknown>;
  error: string | null;
  unchanged: boolean;
}

export const ALL_TEXT_FIELDS = '*';

export function previewRule(signal: SignalItem, protocol: ProtocolType | null, rule: BulkRule, ctx: PlaceholderContext): BulkPreviewRow[] {
  const address = (signal.addressJson || {}) as Record<string, unknown>;
  const base = { signal, protocol };
  if (!protocol) {
    return [{ ...base, field: rule.field, before: undefined, after: undefined, patch: {}, error: 'No source binding: the address cannot be edited.', unchanged: false }];
  }
  if (rule.mode === 'set') {
    const spec = fieldSpec(protocol, rule.field);
    if (!spec) return [{ ...base, field: rule.field, before: undefined, after: undefined, patch: {}, error: 'Not an address field of this protocol.', unchanged: false }];
    const before = address[rule.field];
    if (rule.remove) {
      const patch = addressPatch(address, { [rule.field]: null });
      return [{ ...base, field: rule.field, before, after: undefined, patch, error: spec.required ? `${spec.label} cannot be removed.` : null, unchanged: !Object.keys(patch).length }];
    }
    const { value, missing } = expandPattern(rule.pattern, ctx);
    const after = normaliseValue(protocol, rule.field, spec.kind === 'bool' ? value === 'true' : value);
    const error = missing.length ? `${missing.join(', ')} has no value for this signal.` : validateAddressValue(protocol, rule.field, after);
    const patch = error ? {} : addressPatch(address, { [rule.field]: after });
    return [{ ...base, field: rule.field, before, after, patch, error, unchanged: !error && !Object.keys(patch).length }];
  }
  // Find / replace in one or every textual field.
  const keys =
    rule.field === ALL_TEXT_FIELDS
      ? ADDRESS_FIELDS[protocol].filter((spec) => spec.textual).map((spec) => spec.key)
      : [rule.field];
  const rows: BulkPreviewRow[] = [];
  const edited: Record<string, unknown> = {};
  keys.forEach((key) => {
    const before = address[key];
    if (typeof before !== 'string' || !rule.find || !before.includes(rule.find)) return;
    const { value: replacement, missing } = expandPattern(rule.replace, ctx);
    const after = before.split(rule.find).join(replacement);
    const error = missing.length ? `${missing.join(', ')} has no value for this signal.` : validateAddressValue(protocol, key, after);
    if (!error) edited[key] = after;
    rows.push({ ...base, field: key, before, after, patch: {}, error, unchanged: before === after });
  });
  if (!rows.length) {
    return [{ ...base, field: rule.field === ALL_TEXT_FIELDS ? '—' : rule.field, before: undefined, after: undefined, patch: {}, error: null, unchanged: true }];
  }
  const patch = rows.some((row) => row.error) ? {} : addressPatch(address, edited);
  // The patch of the signal is carried by its first row.
  rows[0] = { ...rows[0], patch };
  return rows;
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export interface BulkAddressItem {
  signal_id: string;
  version: number;
  address_patch: Record<string, unknown>;
}

export interface BulkAddressResult {
  updated: Array<{ signal_id: string; version: number }>;
  unchanged: string[];
  count: number;
}

export function bulkEditAddresses(items: BulkAddressItem[]): Promise<BulkAddressResult> {
  return api<BulkAddressResult>('/api/v1/signals/bulk-address', { method: 'POST', body: JSON.stringify({ items }) });
}

/** Human message for an address edit error, with per-field / per-item messages when the Center sent them. */
export function describeAddressError(error: unknown): { message: string; fields: Record<string, string>; items: Record<string, string> } {
  const fields: Record<string, string> = {};
  const items: Record<string, string> = {};
  if (!(error instanceof ApiError)) {
    return { message: error instanceof Error ? error.message : 'The request failed.', fields, items };
  }
  error.fieldErrors.forEach((fe) => {
    const key = fe.path.replace(/^address_patch\.?/, '') || 'address';
    fields[key] = fe.message || fe.code;
  });
  error.itemErrors.forEach((ie) => {
    if (!ie.signal_id) return;
    const key = ie.path.replace(/^address_patch\.?/, '');
    const text = `${key ? `${key}: ` : ''}${ie.message || ie.code}`;
    items[ie.signal_id] = items[ie.signal_id] ? `${items[ie.signal_id]}; ${text}` : text;
  });
  let message = error.message || 'The request failed.';
  if (error.code === 'RESOURCE_VERSION_CONFLICT') {
    message = 'A signal was changed elsewhere in the meantime. Refresh the list and apply again.';
  } else if (error.code === 'BULK_ADDRESS_REJECTED') {
    message = `Nothing was changed: ${error.itemErrors.length || 'some'} signal(s) were rejected. Fix the rows marked red.`;
  } else if (error.code === 'ADDRESS_AND_MOVE') {
    message = 'Change the address or move the signal to another connection, not both at once.';
  }
  return { message, fields, items };
}
