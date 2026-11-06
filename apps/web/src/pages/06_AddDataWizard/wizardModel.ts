/**
 * Pure model of the Add Data wizard: field rows, per-protocol address_json, Modbus register maps,
 * and the "apply to similar machines" rewrite rules. No React here.
 *
 * address_json written per protocol (release contract "Source field address schemas"):
 *   mqtt       {topic, jsonpath, qos, timestamp_path?, nullable?, round_digits?}
 *   http       {method:"GET", path, jsonpath, timestamp_path?, nullable?, round_digits?}
 *   websocket  {jsonpath, timestamp_path?, nullable?, round_digits?}
 *   opcua      {node_id, timestamp_node_id?, nullable?, round_digits?}
 *   modbus_tcp {unit_id, register_area, offset, native_type, register_count, word_order, role?, nullable?, round_digits?}
 * `timestamp_path` is omitted for the default sibling `source_timestamp` rule, "" disables it.
 */
import { ProtocolType } from '../../types';

export type SignalDataType = 'float64' | 'int64' | 'bool' | 'string';
export type ModbusNativeType =
  | 'bool'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'uint64'
  | 'int64'
  | 'float32'
  | 'float64'
  | 'ascii';
export type RegisterArea = 'holding' | 'input' | 'coil' | 'discrete';
export type TimestampMode = 'sibling' | 'custom' | 'none';

export const DATA_TYPE_LABEL: Record<SignalDataType, string> = {
  float64: 'Number',
  int64: 'Integer',
  bool: 'Boolean',
  string: 'Text',
};

export const MODBUS_TYPES: ModbusNativeType[] = ['bool', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64', 'float32', 'float64', 'ascii'];
export const REGISTER_AREAS: RegisterArea[] = ['holding', 'input', 'coil', 'discrete'];

export interface FieldRow {
  id: string;
  /** Signal key = raw source field name (e.g. status, voltage_1, so). Data Model templates rely on it. */
  key: string;
  displayName: string;
  dataType: SignalDataType;
  unit: string;
  nullable: boolean;
  /** Empty string = no rounding. */
  roundDigits: string;
  sample?: string;
  sampleWarning?: string;
  error?: string;
  warning?: string;
  // JSON protocols
  topic?: string;
  path?: string;
  jsonpath?: string;
  // OPC UA
  nodeId?: string;
  // Modbus
  registerArea?: RegisterArea;
  offset?: string;
  nativeType?: ModbusNativeType;
  registerCount?: string;
  wordOrder?: 'big' | 'little';
  isTimestamp?: boolean;
}

export interface AddressSettings {
  protocol: ProtocolType;
  mqttQos: number;
  timestampMode: TimestampMode;
  timestampPath: string;
  opcTimestampNodeId: string;
  modbusUnitId: number;
}

export function newRowId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function emptyRow(protocol: ProtocolType, partial: Partial<FieldRow> = {}): FieldRow {
  const base: FieldRow = {
    id: newRowId(),
    key: '',
    displayName: '',
    dataType: 'float64',
    unit: '',
    nullable: false,
    roundDigits: '',
  };
  if (protocol === 'modbus') {
    Object.assign(base, { registerArea: 'holding', offset: '', nativeType: 'uint16', registerCount: '1', wordOrder: 'big', dataType: 'int64' });
  }
  return { ...base, ...partial };
}

/** Number of 16-bit registers for a native type (ascii is user-defined, bool on coils is one bit). */
export function registersFor(type: ModbusNativeType): number | null {
  switch (type) {
    case 'bool':
    case 'uint16':
    case 'int16':
      return 1;
    case 'uint32':
    case 'int32':
    case 'float32':
      return 2;
    case 'uint64':
    case 'int64':
    case 'float64':
      return 4;
    default:
      return null;
  }
}

export function dataTypeForNative(type: ModbusNativeType, isTimestamp = false): SignalDataType {
  if (isTimestamp) return 'string';
  if (type === 'bool') return 'bool';
  if (type === 'ascii') return 'string';
  if (type === 'float32' || type === 'float64') return 'float64';
  return 'int64';
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default signal key from a raw source name: keep it verbatim when it is already a valid identifier. */
export function keyFromRawName(raw: string): string {
  const trimmed = raw.trim();
  if (IDENT.test(trimmed)) return trimmed;
  let cleaned = trimmed.replace(/[\s.\-/]+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
  if (/^[0-9]/.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.slice(0, 64);
}

export function nodeIdField(nodeId: string): string {
  const s = /;s=(.*)$/.exec(nodeId)?.[1] ?? nodeId;
  const parts = s.split('.');
  return parts[parts.length - 1] || s;
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function commonExtras(row: FieldRow): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (row.nullable) extras.nullable = true;
  const digits = intOrNull(row.roundDigits);
  if (digits !== null) extras.round_digits = digits;
  return extras;
}

function timestampExtras(settings: AddressSettings): Record<string, unknown> {
  if (settings.timestampMode === 'none') return { timestamp_path: '' };
  if (settings.timestampMode === 'custom' && settings.timestampPath.trim()) return { timestamp_path: settings.timestampPath.trim() };
  return {};
}

export function addressKindFor(protocol: ProtocolType): string {
  switch (protocol) {
    case 'modbus':
      return 'modbus_register';
    case 'opcua':
      return 'opcua_node';
    case 'mqtt':
      return 'mqtt_jsonpath';
    case 'http':
      return 'http_jsonpath';
    default:
      return 'websocket_jsonpath';
  }
}

/** address_json for one field (see file header for the schema per protocol). */
export function buildAddress(row: FieldRow, settings: AddressSettings): Record<string, unknown> {
  const extras = commonExtras(row);
  switch (settings.protocol) {
    case 'mqtt':
      return { topic: (row.topic || '').trim(), jsonpath: (row.jsonpath || '$').trim(), qos: settings.mqttQos, ...timestampExtras(settings), ...extras };
    case 'http':
      return { method: 'GET', path: (row.path || '/').trim(), jsonpath: (row.jsonpath || '$').trim(), ...timestampExtras(settings), ...extras };
    case 'websocket':
      return { jsonpath: (row.jsonpath || '$').trim(), ...timestampExtras(settings), ...extras };
    case 'opcua': {
      const out: Record<string, unknown> = { node_id: (row.nodeId || '').trim(), ...extras };
      if (settings.opcTimestampNodeId.trim()) out.timestamp_node_id = settings.opcTimestampNodeId.trim();
      return out;
    }
    case 'modbus': {
      const type = row.nativeType || 'uint16';
      const out: Record<string, unknown> = {
        unit_id: settings.modbusUnitId,
        register_area: row.registerArea || 'holding',
        offset: intOrNull(row.offset) ?? 0,
        native_type: type,
        register_count: intOrNull(row.registerCount) ?? registersFor(type) ?? 1,
        word_order: row.wordOrder || 'big',
        ...extras,
      };
      if (row.isTimestamp) out.role = 'source_timestamp';
      return out;
    }
    default:
      return extras;
  }
}

export function describeAddress(row: FieldRow, protocol: ProtocolType): string {
  switch (protocol) {
    case 'mqtt':
      return `${row.topic || '?'} · ${row.jsonpath || '$'}`;
    case 'http':
      return `GET ${row.path || '/'} · ${row.jsonpath || '$'}`;
    case 'websocket':
      return row.jsonpath || '$';
    case 'opcua':
      return row.nodeId || '?';
    case 'modbus': {
      const count = Number(row.registerCount) || 1;
      const start = Number(row.offset);
      const range = Number.isInteger(start) ? (count > 1 ? `${start}–${start + count - 1}` : String(start)) : '?';
      return `${row.registerArea || 'holding'} ${range} (${row.nativeType || 'uint16'})`;
    }
    default:
      return '';
  }
}

/** Validate rows; returns rows with `error` / `warning` set and whether any error exists. */
export function validateRows(
  rows: FieldRow[],
  protocol: ProtocolType,
  existingKeys: Set<string>,
): { rows: FieldRow[]; hasError: boolean } {
  let hasError = false;
  const seen = new Map<string, number>();
  rows.forEach((row) => seen.set(row.key.trim(), (seen.get(row.key.trim()) || 0) + 1));
  // Register occupancy for overlap detection.
  const occupied = new Map<string, string>();
  const tsRows = rows.filter((row) => row.isTimestamp);
  const out = rows.map((row) => {
    let error: string | undefined;
    let warning: string | undefined = row.sampleWarning;
    const key = row.key.trim();
    if (!key) error = 'Enter a signal key.';
    else if (!IDENT.test(key)) error = 'Key: letters, digits and "_" only; it cannot start with a digit.';
    else if (key.length > 64) error = 'Key is longer than 64 characters.';
    else if ((seen.get(key) || 0) > 1) error = `Another row uses the key "${key}".`;
    else if (existingKeys.has(key)) error = `This resource already has a signal "${key}".`;

    if (!error && protocol === 'mqtt') {
      const topic = (row.topic || '').trim();
      if (!topic) error = 'Enter the topic.';
      else if (/[#+]/.test(topic)) error = 'Use the exact topic of the message, not a filter with + or #.';
    }
    if (!error && (protocol === 'mqtt' || protocol === 'http' || protocol === 'websocket')) {
      if (!(row.jsonpath || '').trim().startsWith('$')) error = 'JSONPath starts with $ (e.g. $.status).';
    }
    if (!error && protocol === 'http' && !(row.path || '').trim().startsWith('/')) error = 'Path starts with /.';
    if (!error && protocol === 'opcua') {
      const nodeId = (row.nodeId || '').trim();
      if (!nodeId) error = 'Enter the node ID.';
      else if (!/^(ns=\d+;|nsu=[^;]+;)?[isgb]=.+$/.test(nodeId)) error = 'Node ID format: ns=<index>;s=<identifier> (or i=, g=, b=).';
    }
    if (!error && protocol === 'modbus') {
      const offset = Number(row.offset);
      const type = row.nativeType || 'uint16';
      const count = Number(row.registerCount);
      const expected = registersFor(type);
      if (row.offset === undefined || row.offset.trim() === '' || !Number.isInteger(offset) || offset < 0 || offset > 65535) {
        error = 'Offset: 0–65535 (0-based PDU address, not 40001-style).';
      } else if (!Number.isInteger(count) || count < 1 || count > 125) {
        error = 'Register count: 1–125.';
      } else if (expected !== null && (row.registerArea === 'coil' || row.registerArea === 'discrete') && type !== 'bool') {
        error = 'Coils and discrete inputs only hold bool values.';
      } else if (expected !== null && count !== expected && !(type === 'bool')) {
        error = `${type} uses ${expected} register(s).`;
      } else if (row.isTimestamp && type !== 'uint64' && type !== 'int64') {
        error = 'The source timestamp must be uint64 (epoch milliseconds).';
      } else {
        const area = row.registerArea || 'holding';
        for (let r = offset; r < offset + count; r += 1) {
          const slot = `${area}:${r}`;
          const owner = occupied.get(slot);
          if (owner && owner !== row.id) {
            warning = `Overlaps register ${r} of another row.`;
            break;
          }
          occupied.set(slot, row.id);
        }
      }
    }
    if (!error && row.roundDigits.trim() !== '') {
      const d = Number(row.roundDigits);
      if (!Number.isInteger(d) || d < 0 || d > 12) error = 'Round digits: 0–12 or empty.';
    }
    if (protocol === 'modbus' && tsRows.length > 1 && row.isTimestamp) error = error || 'Only one source timestamp per machine.';
    if (error) hasError = true;
    return { ...row, error, warning };
  });
  return { rows: out, hasError };
}

// ---------------------------------------------------------------------------------------------
// Modbus register map paste: one field per line, "name, type, offset[, count][, unit]".
// Offsets may be ranges ("102-109" / "102–109"); "ASCII 16 byte" sets 8 registers.
// ---------------------------------------------------------------------------------------------

const TYPE_ALIASES: Array<[RegExp, ModbusNativeType]> = [
  [/^(bool|boolean|bit|coil)$/i, 'bool'],
  [/^(uint16|u16|word|ushort)$/i, 'uint16'],
  [/^(int16|i16|short)$/i, 'int16'],
  [/^(uint32|u32|dword|udint)$/i, 'uint32'],
  [/^(int32|i32|dint)$/i, 'int32'],
  [/^(uint64|u64|ulint)$/i, 'uint64'],
  [/^(int64|i64|lint)$/i, 'int64'],
  [/^(float32|float|real|f32)$/i, 'float32'],
  [/^(float64|double|lreal|f64)$/i, 'float64'],
  [/^(ascii|string|char|text)$/i, 'ascii'],
];

function typeOf(token: string): ModbusNativeType | null {
  for (const [re, type] of TYPE_ALIASES) if (re.test(token)) return type;
  return null;
}

const RANGE = /^(\d+)\s*(?:[-–—]|\.\.)\s*(\d+)$/;

export function parseRegisterMap(text: string): { rows: Array<Partial<FieldRow>>; errors: string[] } {
  const rows: Array<Partial<FieldRow>> = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim().replace(/^\||\|$/g, '');
    if (!line || /^[-|:\s]+$/.test(line)) return;
    const tokens = (/[\t,;|]/.test(line) ? line.split(/[\t,;|]+/) : line.split(/\s+/)).map((t) => t.trim()).filter(Boolean);
    let name = '';
    let type: ModbusNativeType | null = null;
    let offset: number | null = null;
    let count: number | null = null;
    let unit = '';
    const byteMatch = /(\d+)\s*-?\s*bytes?/i.exec(line);
    for (const token of tokens) {
      const firstWord = token.split(/\s+/)[0];
      const t = typeOf(firstWord);
      if (t && !type) {
        type = t;
        continue;
      }
      const range = RANGE.exec(token);
      if (range && offset === null) {
        offset = Number(range[1]);
        count = Number(range[2]) - Number(range[1]) + 1;
        continue;
      }
      if (/^\d+$/.test(token)) {
        if (offset === null) offset = Number(token);
        else if (count === null) count = Number(token);
        continue;
      }
      if (/bytes?$/i.test(token)) continue;
      if (!name && IDENT.test(token)) {
        name = token;
        continue;
      }
      if (!unit && token.length <= 12) unit = token;
    }
    if (!name && !type && offset === null) return; // header or prose line
    if (/^(field|name|tag)$/i.test(name) && offset === null) return; // header row
    if (!name) {
      errors.push(`Line ${index + 1}: no field name.`);
      return;
    }
    if (offset === null) {
      errors.push(`Line ${index + 1} (${name}): no register offset.`);
      return;
    }
    const nativeType: ModbusNativeType = type || 'uint16';
    if (nativeType === 'ascii' && byteMatch && count === null) count = Math.ceil(Number(byteMatch[1]) / 2);
    const expected = registersFor(nativeType);
    const registerCount = nativeType === 'ascii' ? count ?? 8 : expected ?? 1;
    if (expected !== null && count !== null && count !== expected) {
      errors.push(`Line ${index + 1} (${name}): ${nativeType} uses ${expected} register(s), not ${count}.`);
    }
    const isTimestamp = name === 'source_timestamp';
    rows.push({
      key: name,
      displayName: name,
      nativeType,
      registerCount: String(registerCount),
      offset: String(offset),
      registerArea: nativeType === 'bool' ? 'coil' : 'holding',
      wordOrder: 'big',
      unit,
      isTimestamp,
      dataType: dataTypeForNative(nativeType, isTimestamp),
      nullable: nativeType === 'ascii',
    });
  });
  return { rows, errors };
}

/** Start offsets from a pasted row such as "710 712 714–721 722–723" or a markdown table row. */
export function parseOffsetList(text: string): number[] {
  return text
    .replace(/\|/g, ' ')
    .split(/[\s,;\t]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const range = RANGE.exec(token);
      if (range) return Number(range[1]);
      return /^\d+$/.test(token) ? Number(token) : NaN;
    })
    .filter((n) => Number.isInteger(n));
}

// ---------------------------------------------------------------------------------------------
// Apply to similar machines (never copy the source addresses silently).
// ---------------------------------------------------------------------------------------------

export interface TargetRewrite {
  resourceId: string;
  resourceName: string;
  resourceCode: string;
  /** Text substitution for topics, HTTP paths, JSONPaths and OPC node ids. */
  find: string;
  replace: string;
  /** OPC UA namespace index rewrite (ns=<from>; -> ns=<to>;). */
  nsFrom: string;
  nsTo: string;
  /** Modbus unit id for the target machine. */
  unitId: string;
  /** Modbus start offset per source row id. */
  offsets: Record<string, string>;
}

function trailingNumber(code: string): number | null {
  const m = /(\d+)$/.exec(code);
  return m ? Number(m[1]) : null;
}

/** Suggested values only; the dialog requires the user to review them. Modbus offsets stay empty. */
export function defaultRewrite(
  protocol: ProtocolType,
  source: { code: string },
  target: { id: string; name: string; code: string },
  rows: FieldRow[],
  sourceUnitId: number,
): TargetRewrite {
  const diff =
    trailingNumber(source.code) !== null && trailingNumber(target.code) !== null
      ? (trailingNumber(target.code) as number) - (trailingNumber(source.code) as number)
      : null;
  const nsMatch = rows.map((row) => /^ns=(\d+);/.exec(row.nodeId || '')).find(Boolean);
  const nsFrom = nsMatch ? nsMatch[1] : '';
  return {
    resourceId: target.id,
    resourceName: target.name,
    resourceCode: target.code,
    find: source.code,
    replace: target.code,
    nsFrom,
    nsTo: protocol === 'opcua' && nsFrom && diff !== null ? String(Number(nsFrom) + diff) : '',
    unitId: protocol === 'modbus' && diff !== null && sourceUnitId + diff >= 0 && sourceUnitId + diff <= 247 ? String(sourceUnitId + diff) : '',
    offsets: {},
  };
}

function replaceAll(value: string | undefined, find: string, replace: string): string | undefined {
  if (value === undefined || !find) return value;
  return value.split(find).join(replace);
}

/** Rewrite one row for a target machine. */
export function applyRewrite(protocol: ProtocolType, row: FieldRow, rewrite: TargetRewrite): FieldRow {
  const next: FieldRow = { ...row, id: `${row.id}@${rewrite.resourceId}` };
  if (protocol === 'modbus') {
    next.offset = rewrite.offsets[row.id] ?? '';
    return next;
  }
  next.topic = replaceAll(row.topic, rewrite.find, rewrite.replace);
  next.path = replaceAll(row.path, rewrite.find, rewrite.replace);
  next.jsonpath = replaceAll(row.jsonpath, rewrite.find, rewrite.replace);
  next.nodeId = replaceAll(row.nodeId, rewrite.find, rewrite.replace);
  if (protocol === 'opcua' && rewrite.nsFrom !== '' && rewrite.nsTo !== '' && next.nodeId) {
    next.nodeId = next.nodeId.replace(new RegExp(`^ns=${rewrite.nsFrom};`), `ns=${rewrite.nsTo};`);
  }
  return next;
}

export function rewriteText(value: string, protocol: ProtocolType, rewrite: TargetRewrite): string {
  let out = replaceAll(value, rewrite.find, rewrite.replace) || '';
  if (protocol === 'opcua' && rewrite.nsFrom !== '' && rewrite.nsTo !== '') {
    out = out.replace(new RegExp(`^ns=${rewrite.nsFrom};`), `ns=${rewrite.nsTo};`);
  }
  return out;
}

/** Problems that block confirming a target rewrite. */
export function rewriteProblems(protocol: ProtocolType, rows: FieldRow[], rewrite: TargetRewrite): string[] {
  const problems: string[] = [];
  if (protocol === 'modbus') {
    const unit = Number(rewrite.unitId);
    if (rewrite.unitId.trim() === '' || !Number.isInteger(unit) || unit < 0 || unit > 247) problems.push('Enter the unit ID (0–247).');
    const missing = rows.filter((row) => {
      const v = rewrite.offsets[row.id];
      return v === undefined || v.trim() === '' || !Number.isInteger(Number(v)) || Number(v) < 0;
    });
    if (missing.length) problems.push(`Enter the offset of ${missing.map((r) => r.key || '?').join(', ')}.`);
    return problems;
  }
  if (!rewrite.find) problems.push('Enter the text to replace (the source machine identifier).');
  if (protocol === 'opcua' && (rewrite.nsFrom === '') !== (rewrite.nsTo === '')) problems.push('Enter both namespace indexes or none.');
  const unchanged = rows.filter((row) => {
    const out = applyRewrite(protocol, row, rewrite);
    return out.topic === row.topic && out.path === row.path && out.jsonpath === row.jsonpath && out.nodeId === row.nodeId;
  });
  if (unchanged.length) {
    problems.push(`${unchanged.length} field address(es) would stay identical to the source machine (${unchanged.map((r) => r.key).slice(0, 4).join(', ')}).`);
  }
  return problems;
}

/** Parse a pasted offset table: one machine per line, "<code> <offsets in field order>". */
export function parseOffsetMatrix(text: string, codes: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  text.split(/\r?\n/).forEach((line) => {
    const clean = line.replace(/\|/g, ' ').trim();
    if (!clean) return;
    const code = codes.find((c) => clean.split(/\s+/)[0] === c) || codes.find((c) => clean.startsWith(c));
    if (!code) return;
    out.set(code, parseOffsetList(clean.slice(clean.indexOf(code) + code.length)));
  });
  return out;
}
