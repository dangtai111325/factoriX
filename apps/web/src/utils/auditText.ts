/**
 * Turns raw audit events (GET /api/v1/audit-events) into short, human-readable sentences.
 * Names are resolved from the lookup tables the caller passes in; raw codes are never shown
 * when a name is known.
 */

export interface AuditRow {
  id: string;
  event_type: string;
  actor_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  before_json?: Record<string, unknown> | null;
  after_json?: Record<string, unknown> | null;
  occurred_at: string;
  severity?: string | null;
}

export interface AuditLookups {
  /** id -> display name, for any entity kind (resources, connections, signals, edges, models, templates). */
  names: Map<string, string>;
  /** Id of the signed-in administrator, shown as "You". */
  currentActorId?: string;
  currentActorName?: string;
}

export interface AuditText {
  actor: string;
  /** Sentence without the actor, e.g. "archived Line 1". */
  action: string;
  /** Optional second line with the most useful detail. */
  detail?: string;
  tone: 'info' | 'warning' | 'error' | 'success';
}

type Verb = { verb: string; noun?: string; system?: boolean; tone?: AuditText['tone'] };

/**
 * One entry per event type the Center records (grep `event_type=` in apps/center/src). The sentence is
 * "<actor> <verb> <target>", e.g. "You archived Line 1". The dynamic SIGNAL_BULK_<ACTION> types and the
 * template "apply" summary are composed in describeAudit.
 */
const EVENTS: Record<string, Verb> = {
  RESOURCE_CREATE: { verb: 'added', noun: 'resource' },
  RESOURCE_UPDATE: { verb: 'updated', noun: 'resource' },
  RESOURCE_MOVE: { verb: 'moved', noun: 'resource' },
  RESOURCE_ARCHIVE: { verb: 'archived', noun: 'resource', tone: 'warning' },
  RESOURCE_RESTORE: { verb: 'restored', noun: 'resource', tone: 'success' },
  SITE_CREATE: { verb: 'added site', noun: '' },
  TYPE_CREATE: { verb: 'added resource type', noun: '' },
  HIERARCHY_DRAFT: { verb: 'saved hierarchy template', noun: '' },
  SIGNAL_BULK: { verb: 'added signals to', noun: 'resource' },
  SIGNAL_UPDATE: { verb: 'updated signal', noun: '' },
  SIGNAL_DELETE: { verb: 'deleted signal', noun: '', tone: 'warning' },
  CONNECTION_CREATE: { verb: 'added connection', noun: '' },
  CONNECTION_UPDATE: { verb: 'updated connection', noun: '' },
  CONNECTION_PAUSE: { verb: 'paused connection', noun: '', tone: 'warning' },
  CONNECTION_RESUME: { verb: 'resumed connection', noun: '', tone: 'success' },
  CONNECTION_ARCHIVE: { verb: 'deleted connection', noun: '', tone: 'warning' },
  CONNECTION_DEGRADED: { verb: 'stopped receiving data from connection', noun: '', system: true, tone: 'warning' },
  CONNECTION_RECOVERED: { verb: 'resumed receiving data from connection', noun: '', system: true, tone: 'success' },
  CAPTURE_REQUEST: { verb: 'captured a sample from', noun: 'connection' },
  COMMISSION_REQUEST: { verb: 'tested connection', noun: '' },
  COMMISSION_FAILED: { verb: 'could not finish a connection test', noun: '', system: true, tone: 'error' },
  CONFIG_PUBLISH: { verb: 'sent a new configuration to collector', noun: '' },
  EDGE_CREATE: { verb: 'registered collector', noun: '' },
  EDGE_RENAME: { verb: 'renamed collector', noun: '' },
  EDGE_DELETE: { verb: 'removed collector', noun: '', tone: 'warning' },
  EDGE_ENROLL_TOKEN: { verb: 'issued an enrollment token for collector', noun: '' },
  EDGE_OFFLINE: { verb: 'lost contact with collector', noun: '', system: true, tone: 'error' },
  EDGE_ONLINE: { verb: 'reconnected to collector', noun: '', system: true, tone: 'success' },
  DATA_MODEL_CREATED: { verb: 'created data model', noun: '' },
  DATA_MODEL_UPDATED: { verb: 'updated data model', noun: '' },
  DATA_MODEL_DELETED: { verb: 'deleted data model', noun: '', tone: 'warning' },
  DATA_MODEL_PAUSED: { verb: 'paused data model', noun: '' },
  DATA_MODEL_RESUMED: { verb: 'resumed data model', noun: '', tone: 'success' },
  DATA_MODEL_DUPLICATED: { verb: 'duplicated a data model as', noun: '' },
  // Data Model v1 events, kept so older activity rows still read well.
  OUTPUT_GROUP_DRAFT: { verb: 'created data model', noun: '' },
  OUTPUT_GROUP_UPDATE: { verb: 'updated data model', noun: '' },
  OUTPUT_GROUP_DELETE: { verb: 'archived data model', noun: '', tone: 'warning' },
  OUTPUT_GROUP_PUBLISH: { verb: 'published data model', noun: '', tone: 'success' },
  OUTPUT_GROUP_UNPUBLISH: { verb: 'unpublished data model', noun: '' },
  OUTPUT_GROUP_DUPLICATE: { verb: 'duplicated a data model as', noun: '' },
  MODEL_TEMPLATE_CREATE: { verb: 'created data model template', noun: '' },
  MODEL_TEMPLATE_UPDATE: { verb: 'updated data model template', noun: '' },
  MODEL_TEMPLATE_DELETE: { verb: 'deleted data model template', noun: '', tone: 'warning' },
  MODEL_TEMPLATE_APPLY: { verb: 'created data models from template', noun: '' },
  FORMULA_DRAFT: { verb: 'saved a calculated signal draft', noun: '' },
  FORMULA_PUBLISH: { verb: 'published a calculated signal', noun: '' },
  RETENTION_CREATE: { verb: 'created a retention policy', noun: '' },
  RETENTION_ENABLE: { verb: 'enabled a retention policy', noun: '' },
  RETENTION_EXECUTE: { verb: 'ran a retention policy', noun: '' },
  DASHBOARD_CREATE: { verb: 'created dashboard', noun: '' },
  DASHBOARD_DRAFT: { verb: 'saved dashboard', noun: '' },
  DASHBOARD_PUBLISH: { verb: 'published dashboard', noun: '' },
  INGEST_REJECTED: { verb: 'rejected incoming data from collector', noun: '', system: true, tone: 'warning' },
  AUTH_LOGIN: { verb: 'signed in', noun: '' },
  ADMIN_BOOTSTRAP: { verb: 'created the administrator account', noun: '' },
  AUTH_RESET_REQUESTED: { verb: 'requested a password reset', noun: '' },
  AUTH_RESET_COMPLETED: { verb: 'reset the password', noun: '', tone: 'success' },
  REVERT_TO_ZERO: { verb: 'reset the installation', noun: '', tone: 'warning' },
  MAIL_FAILED: { verb: 'could not send an email', noun: '', system: true, tone: 'error' },
};

/** Events whose sentence never names a target (the entity is the account, a job or an unnamed record). */
const NO_TARGET = new Set([
  'AUTH_LOGIN',
  'ADMIN_BOOTSTRAP',
  'AUTH_RESET_REQUESTED',
  'AUTH_RESET_COMPLETED',
  'REVERT_TO_ZERO',
  'MAIL_FAILED',
  'COMMISSION_FAILED',
  'FORMULA_DRAFT',
  'FORMULA_PUBLISH',
  'RETENTION_CREATE',
  'RETENTION_ENABLE',
  'RETENTION_EXECUTE',
]);

/** Events about the session or the account; they are noise in an asset change log. */
export const ACCOUNT_EVENTS = new Set([
  'AUTH_LOGIN',
  'ADMIN_BOOTSTRAP',
  'AUTH_RESET_REQUESTED',
  'AUTH_RESET_COMPLETED',
]);

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function humanize(code: string): string {
  return code.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function protocolLabel(value: string): string {
  const key = value.toLowerCase();
  if (key.includes('modbus')) return 'Modbus TCP';
  if (key.includes('opc')) return 'OPC UA';
  if (key.includes('mqtt')) return 'MQTT';
  if (key.includes('websocket') || key === 'ws') return 'WebSocket';
  if (key.includes('http')) return 'HTTP';
  return value;
}

/** A count stored as a number or as a list of ids. */
function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Bookkeeping keys that never describe a user-visible change. */
const IGNORED_CHANGE_KEYS = new Set(['version', 'path_code', 'at', 'id', 'updated_at', 'source']);
const FIELD_LABEL: Record<string, string> = {
  description: 'description',
  properties: 'properties',
  attributes: 'properties',
  type_key: 'type',
  unit: 'unit',
  expected_interval_ms: 'expected interval',
  emit_policy: 're-publish interval',
  address: 'source address',
  address_json: 'source address',
  timestamp_node_id: 'source time node',
  timestamp_path: 'source time path',
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 'renamed from "A" · code X → Y · description changed' for every field present in both payloads. */
function changeSummary(before: Record<string, unknown>, after: Record<string, unknown>, nameKey = 'name'): string | undefined {
  const parts: string[] = [];
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  for (const key of keys) {
    if (IGNORED_CHANGE_KEYS.has(key) || !(key in before) || !(key in after) || same(before[key], after[key])) continue;
    if (key === nameKey) parts.unshift(`renamed from "${str(before[key])}"`);
    else if (key === 'code') parts.push(`code ${str(before.code)} → ${str(after.code)}`);
    else parts.push(`${FIELD_LABEL[key] || humanize(key)} changed`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

function without(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/** Verb per SIGNAL_BULK_<ACTION>; unknown actions fall back to a generic sentence. */
const BULK_VERB: Record<string, string> = {
  enable: 'resumed collection of',
  disable: 'paused collection of',
  delete: 'deleted',
  address: 'changed the source address of',
  edit_address: 'changed the source address of',
  update_address: 'changed the source address of',
  set_address: 'changed the source address of',
};

export function describeAudit(row: AuditRow, lookups: AuditLookups): AuditText {
  const eventType = str(row.event_type).toUpperCase();
  const spec = EVENTS[eventType];
  const before = (row.before_json || {}) as Record<string, unknown>;
  const after = (row.after_json || {}) as Record<string, unknown>;
  const entityId = str(row.entity_id);

  let actor: string;
  if (spec?.system || !row.actor_id) actor = 'System';
  else if (lookups.currentActorId && row.actor_id === lookups.currentActorId) actor = lookups.currentActorName || 'You';
  else actor = 'Administrator';

  // Best available display name for the target entity.
  const knownName = entityId ? lookups.names.get(entityId) : undefined;
  const payloadName = str(after.name) || str(after.display_name) || str(before.name) || str(before.display_name);
  let target = knownName || payloadName;
  if (!target && entityId) {
    const code = str(after.code) || str(before.code) || str(after.key) || str(before.key);
    target = code || '';
  }

  const tone = spec?.tone || (row.severity === 'ERROR' ? 'error' : row.severity === 'WARN' ? 'warning' : 'info');

  // Bulk signal actions: SIGNAL_BULK_ENABLE / _DISABLE / _DELETE and source address edits.
  if (!spec && eventType.startsWith('SIGNAL_BULK_')) {
    const action = str(after.action || eventType.slice('SIGNAL_BULK_'.length)).toLowerCase();
    const count = countOf(after.count ?? after.updated ?? after.ids ?? after.signal_ids);
    const verb = BULK_VERB[action] || `applied "${humanize(action)}" to`;
    return {
      actor,
      action: `${verb} ${count > 0 ? plural(count, 'signal', 'signals') : 'several signals'}`,
      tone: action === 'delete' || action === 'disable' ? 'warning' : 'info',
    };
  }

  if (!spec) {
    // Unknown event type: still a sentence, e.g. 'You performed "calibrate sensor" on Line 1'.
    const what = humanize(eventType) || 'an action';
    return { actor, action: `performed "${what}"${target ? ` on ${target}` : ''}`, tone };
  }

  if (eventType === 'MODEL_TEMPLATE_APPLY') {
    const created = countOf(after.created);
    const resources = countOf(after.resources);
    const fromTemplate = knownName ? `from template ${knownName}` : 'from a template';
    const published = Boolean(after.publish) && created > 0;
    const action =
      created > 0
        ? `created ${plural(created, 'data model', 'data models')} ${fromTemplate}${published ? ' and published them' : ''}`
        : `applied ${knownName ? `template ${knownName}` : 'a template'}; no data model was created`;
    const skipped = resources > created ? resources - created : 0;
    return {
      actor,
      action,
      detail: skipped > 0 ? `${plural(skipped, 'resource was', 'resources were')} skipped (model exists or signals are missing)` : undefined,
      tone: created > 0 ? 'success' : 'info',
    };
  }

  const noun = spec.noun === undefined ? '' : spec.noun;
  const targetText = NO_TARGET.has(eventType) ? '' : target || (noun ? `a ${noun}` : '');
  let action = targetText ? `${spec.verb} ${targetText}` : spec.verb;

  let detail: string | undefined;
  switch (eventType) {
    case 'RESOURCE_UPDATE':
      detail = changeSummary(before, after);
      break;
    case 'RESOURCE_MOVE': {
      const parentName = lookups.names.get(str(after.parent_id));
      detail = parentName ? `now under ${parentName}` : undefined;
      break;
    }
    case 'RESOURCE_ARCHIVE': {
      const affected = Number(after.affected_signals || 0);
      detail = affected > 0 ? `${plural(affected, 'signal', 'signals')} stopped collecting` : undefined;
      break;
    }
    case 'RESOURCE_RESTORE': {
      const restored = Number(after.restored_signals || 0);
      detail = restored > 0 ? `${plural(restored, 'signal', 'signals')} collecting again` : undefined;
      break;
    }
    case 'SIGNAL_BULK': {
      const created = countOf(after.created);
      if (created > 0) action = `added ${plural(created, 'signal', 'signals')} to ${target || 'a resource'}`;
      break;
    }
    case 'SIGNAL_UPDATE': {
      const parts: string[] = [];
      if (before.display_name && after.display_name && before.display_name !== after.display_name) {
        parts.push(`renamed from "${str(before.display_name)}"`);
      }
      if (after.enabled === false) parts.push('collection paused');
      if (after.enabled === true) parts.push('collection resumed');
      if (after.connection_id) {
        const connName = lookups.names.get(str(after.connection_id));
        parts.push(connName ? `now read from ${connName}` : 'moved to another connection');
      }
      const handled = ['display_name', 'enabled', 'connection_id'];
      const rest = changeSummary(without(before, handled), without(after, handled));
      if (rest) parts.push(rest);
      detail = parts.length ? parts.join(' · ') : undefined;
      break;
    }
    case 'CONNECTION_UPDATE':
      detail = changeSummary(before, after);
      break;
    case 'OUTPUT_GROUP_UPDATE':
    case 'MODEL_TEMPLATE_UPDATE':
      detail = changeSummary(without(before, ['resource_id']), without(after, ['resource_id', 'members']), 'display_name');
      break;
    case 'CONNECTION_CREATE':
    case 'CAPTURE_REQUEST':
    case 'COMMISSION_REQUEST':
      if (after.protocol) detail = protocolLabel(str(after.protocol));
      break;
    case 'CONNECTION_DEGRADED':
      detail = str(after.last_error) || undefined;
      break;
    case 'COMMISSION_FAILED':
      detail = str(after.error_code) === 'TIMEOUT' ? 'The collector did not answer in time.' : str(after.error_code) || undefined;
      break;
    case 'OUTPUT_GROUP_DUPLICATE': {
      const resourceName = lookups.names.get(str(after.resource_id));
      if (!knownName && after.key) action = `${spec.verb} "${str(after.key)}"`;
      detail = resourceName ? `on ${resourceName}` : undefined;
      break;
    }
    case 'OUTPUT_GROUP_DRAFT': {
      const members = countOf(after.members);
      detail = members > 0 ? plural(members, 'field', 'fields') : undefined;
      break;
    }
    case 'EDGE_RENAME':
      if (before.name) detail = `previously "${str(before.name)}"`;
      break;
    case 'CONFIG_PUBLISH':
      if (after.desired) detail = `revision ${str(after.desired)}`;
      break;
    default:
      break;
  }
  return { actor, action, detail, tone };
}
