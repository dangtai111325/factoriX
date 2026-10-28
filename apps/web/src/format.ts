export type SignalValue = number | boolean | string | null | Record<string, unknown>;

const ERRORS: Record<string, string> = {
  ADMIN_EXISTS: "An administrator already exists.",
  ADJACENCY: "That type cannot be placed under the selected parent.",
  AGGREGATE: "That summary is not available.",
  ALIAS: "Each output name must be unique.",
  ARCHIVED: "This item is archived and cannot be changed.",
  ARCHIVED_PARENT: "Add children to an active resource.",
  AUTH: "Sign-in is required for this connection.",
  BATCH: "The batch is too large.",
  BINDING: "Choose a signal that belongs to this site.",
  BOOTSTRAP_DENIED: "The setup code is not correct.",
  BOOTSTRAP_DISABLED: "Administrator setup is not enabled.",
  BUCKET: "Choose a shorter time bucket.",
  BULK_REJECTED: "Nothing was saved because one or more rows are invalid.",
  CATEGORY: "Choose a valid type group.",
  CONFIG: "Check the connection settings.",
  CSRF: "The page expired. Refresh and try again.",
  DOMAIN: "That relationship is not allowed.",
  DUPLICATE: "That code is already in use.",
  EMPTY: "Add at least one item before publishing.",
  ENROLLMENT: "The enrollment code is invalid or already used.",
  HAS_CHILDREN: "Archive the child resources first.",
  HIERARCHY: "This hierarchy is not valid.",
  HTTP: "The request failed.",
  IMPORT_INVALID: "The import file has invalid rows.",
  INSECURE_PROFILE: "Confirm the insecure connection before continuing.",
  INVALID_CODE: "That code is not valid or it has expired.",
  INVALID_CREDENTIALS: "Sign-in failed. Check the name and password.",
  INVALID_EMAIL: "Enter a valid email address.",
  MAIL_UNAVAILABLE: "The reset code could not be sent. Try again later.",
  INVALID_ID: "That identifier is not valid.",
  INVALID_LOCALE: "Choose English or Vietnamese for the account locale.",
  JOB: "The collection job is not available.",
  LAYOUT_SCOPE: "A layout cannot change the factory structure.",
  LEGAL_HOLD: "Retention is on hold, so data cannot be removed.",
  LIMIT: "That request is larger than the allowed limit.",
  LOCKED: "Sign-in is temporarily locked.",
  MISSING_PARENT: "A parent in the import could not be found.",
  NOT_FOUND: "That item could not be found.",
  PROTOCOL: "This protocol is not available.",
  RANGE: "Choose a valid time range.",
  RELATION: "That relationship type is not available.",
  RESOURCE_VERSION_CONFLICT: "Someone else saved this item. Reload and try again.",
  RETENTION_BLOCKED: "Turn retention on before running it.",
  REVISION: "The release no longer matches the edge.",
  SCOPE: "The edge does not belong to the selected site.",
  SECRET: "The secret is too long.",
  SESSION_EXPIRED: "Your session expired. Sign in again.",
  SIGNAL: "A calculated signal needs a resource, key, and name.",
  SITE_REQUIRED: "Choose a site for this resource.",
  STATE: "That status is not valid.",
  TIMEZONE: "Enter a valid time zone.",
  TOPIC: "The topic is not valid.",
  UNAUTHENTICATED: "Sign in to continue.",
  UNIT: "The units in this calculation do not match.",
  UNKNOWN_TYPE: "That resource type does not exist.",
  UPLOAD: "The file could not be used.",
  WIDGET: "That dashboard item is not available.",
  SYNTAX: "The expression could not be read.",
  FORBIDDEN: "That expression uses something that is not allowed.",
  TOO_LARGE: "The expression is too long.",
  TOO_COMPLEX: "The expression is too complex.",
  WINDOW: "That time window is not available.",
  UNBOUND: "A name in the expression is not linked to a signal.",
  UNUSED_ALIAS: "A name is unused in the expression.",
  EVAL: "The sample could not be calculated.",
  NON_FINITE: "The result is not a finite number.",
  WEAK_PASSWORD: "Use a longer password with mixed character types.",
  INVALID_LOGIN: "That sign-in name is not valid.",
  CYCLE: "This calculation depends on itself.",
};

const LABELS: Record<string, string> = {
  modbus_tcp: "Modbus TCP",
  opcua: "OPC UA",
  mqtt: "MQTT",
  http: "HTTP",
  UNKNOWN: "Not reported",
  HEALTHY: "Healthy",
  ACTIVE: "Active",
  DEGRADED: "Degraded",
  DOWN: "Down",
  OFFLINE: "Offline",
  UNENROLLED: "Not enrolled",
  CONFIG_PENDING: "Waiting for the edge",
  DRAFT: "Draft",
  PENDING: "Waiting",
  RUNNING: "Running",
  PASSED: "Passed",
  FAILED: "Failed",
  PUBLISHED: "Published",
  SUPERSEDED: "Replaced",
  ARCHIVED: "Archived",
  GOOD: "Good",
  BAD: "Bad",
  UNCERTAIN: "Uncertain",
};

export function plainLabel(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (!text) return "—";
  if (LABELS[text]) return LABELS[text];
  if (ERRORS[text]) return ERRORS[text];
  if (/^[A-Za-z0-9_]+$/.test(text) && text.includes("_")) {
    const words = text.toLowerCase().replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (/^[A-Z0-9]+$/.test(text)) {
    const words = text.toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return text;
}

export function operatorMessage(code: string | undefined): string {
  if (code && ERRORS[code]) return ERRORS[code];
  return "Something went wrong. Try again.";
}

export function formatSignal(value: unknown): string {
  if (value === null || value === undefined) return "No value";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "Invalid value";
    return new Intl.NumberFormat("en", { maximumFractionDigits: 3 }).format(value);
  }
  return typeof value === "string" ? value : "Structured data";
}

export function formatTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(date);
}
