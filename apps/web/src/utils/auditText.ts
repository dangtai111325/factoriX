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
  /** id -> display name, for any entity kind (resources, connections, signals, edges, models). */
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
  CONNECTION_DEGRADED: { verb: 'lost data from connection', noun: '', system: true, tone: 'warning' },
  CAPTURE_REQUEST: { verb: 'captured a sample from', noun: '' },
  COMMISSION_REQUEST: { verb: 'tested connection', noun: '' },
  COMMISSION_FAILED: { verb: 'reported a failed test for', noun: '', system: true, tone: 'error' },
  CONFIG_PUBLISH: { verb: 'sent a new configuration to collector', noun: '' },
  EDGE_CREATE: { verb: 'registered collector', noun: '' },
  EDGE_RENAME: { verb: 'renamed collector', noun: '' },
  EDGE_DELETE: { verb: 'removed collector', noun: '', tone: 'warning' },
  EDGE_ENROLL_TOKEN: { verb: 'issued an enrollment token for collector', noun: '' },
  EDGE_OFFLINE: { verb: 'lost contact with collector', noun: '', system: true, tone: 'error' },
  OUTPUT_GROUP_DRAFT: { verb: 'saved data model', noun: '' },
  OUTPUT_GROUP_UPDATE: { verb: 'updated data model', noun: '' },
  OUTPUT_GROUP_DELETE: { verb: 'deleted data model', noun: '', tone: 'warning' },
  OUTPUT_GROUP_PUBLISH: { verb: 'published data model', noun: '', tone: 'success' },
  OUTPUT_GROUP_UNPUBLISH: { verb: 'unpublished data model', noun: '' },
  FORMULA_DRAFT: { verb: 'saved a calculated signal draft', noun: '' },
  FORMULA_PUBLISH: { verb: 'published a calculated signal', noun: '' },
  RETENTION_CREATE: { verb: 'created a retention policy', noun: '' },
  RETENTION_ENABLE: { verb: 'enabled a retention policy', noun: '' },
  RETENTION_EXECUTE: { verb: 'ran a retention policy', noun: '' },
  DASHBOARD_CREATE: { verb: 'created dashboard', noun: '' },
  DASHBOARD_DRAFT: { verb: 'saved dashboard', noun: '' },
  DASHBOARD_PUBLISH: { verb: 'published dashboard', noun: '' },
  INGEST_REJECTED: { verb: 'rejected incoming data', noun: '', system: true, tone: 'warning' },
  AUTH_LOGIN: { verb: 'signed in', noun: '' },
  ADMIN_BOOTSTRAP: { verb: 'created the administrator account', noun: '' },
  AUTH_RESET_REQUESTED: { verb: 'requested a password reset', noun: '' },
  AUTH_RESET_COMPLETED: { verb: 'reset the password', noun: '', tone: 'success' },
  REVERT_TO_ZERO: { verb: 'reset the installation', noun: '', tone: 'warning' },
  MAIL_FAILED: { verb: 'could not send an email', noun: '', system: true, tone: 'error' },
};

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
  const words = code.toLowerCase().replace(/_/g, ' ').trim();
  return words || 'changed something';
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

export function describeAudit(row: AuditRow, lookups: AuditLookups): AuditText {
  const spec = EVENTS[row.event_type];
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
    const code = str(after.code) || str(before.code) || str(after.key);
    target = code || '';
  }

  const tone = spec?.tone || (row.severity === 'ERROR' ? 'error' : row.severity === 'WARN' ? 'warning' : 'info');
  if (!spec) {
    return { actor, action: humanize(row.event_type) + (target ? ` ${target}` : ''), tone };
  }

  const noun = spec.noun === undefined ? '' : spec.noun;
  const targetText = target || (noun ? `a ${noun}` : '');
  const action = targetText ? `${spec.verb} ${targetText}` : spec.verb;

  let detail: string | undefined;
  switch (row.event_type) {
    case 'RESOURCE_UPDATE': {
      const parts: string[] = [];
      if (before.name && after.name && before.name !== after.name) parts.push(`renamed from "${str(before.name)}"`);
      if (before.code && after.code && before.code !== after.code) parts.push(`code ${str(before.code)} → ${str(after.code)}`);
      detail = parts.length ? parts.join(' · ') : undefined;
      break;
    }
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
    case 'SIGNAL_BULK': {
      const created = Number(after.created || 0);
      detail = created > 0 ? `${plural(created, 'signal', 'signals')} added` : undefined;
      break;
    }
    case 'SIGNAL_UPDATE':
      if (before.display_name && after.display_name && before.display_name !== after.display_name) {
        detail = `renamed from "${str(before.display_name)}"`;
      }
      break;
    case 'CONNECTION_CREATE':
    case 'CAPTURE_REQUEST':
    case 'COMMISSION_REQUEST':
      if (after.protocol) detail = protocolLabel(str(after.protocol));
      break;
    case 'CONNECTION_DEGRADED':
      detail = str(after.last_error) || undefined;
      break;
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
