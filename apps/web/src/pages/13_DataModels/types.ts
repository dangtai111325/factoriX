// Data Model v2 types (custom JSON body builder). API contract: /api/v1/data-models (spec §5).

export type ModelState = 'RUNNING' | 'PAUSED';
export type ValueType = 'auto' | 'float' | 'int' | 'string' | 'bool' | 'timestamp' | 'json';
export const VALUE_TYPES: ValueType[] = ['auto', 'float', 'int', 'string', 'bool', 'timestamp', 'json'];

export const SAMPLE_MS_MIN = 200;
export const SAMPLE_MS_MAX = 3_600_000;
export const SAMPLE_MS_DEFAULT = 1000;
export const SAMPLE_PRESETS: Array<{ ms: number; label: string }> = [
  { ms: 1000, label: '1 s' },
  { ms: 3000, label: '3 s' },
  { ms: 5000, label: '5 s' },
  { ms: 10000, label: '10 s' },
  { ms: 60000, label: '1 min' },
];

/** Spec limits (§2 validation). */
export const KEY_MAX = 128;
export const DEPTH_MAX = 16;
export const FIELDS_MAX = 2000;

/** Row of GET /data-models. */
export interface ModelListItem {
  id: string;
  name: string;
  description: string;
  sample_ms: number;
  state: ModelState;
  version: number;
  field_count: number;
  ref_count: number;
  machines: string[];
  updated_at: string | null;
  last_sampled_at: string | null;
  error_count: number;
  /** Optional: latest body text when the list carries it (saves one request per card). */
  latest_body: string | null;
}

// ------------------------------------------------------------------ body spec (wire format)

export interface ApiRefInfo {
  signal_id?: string;
  signal_key?: string;
  signal_name?: string;
  data_type?: string;
  unit?: string;
  resource_id?: string;
  resource_name?: string;
  resource_type?: string;
  path?: string;
  protocol?: string;
  connection_name?: string;
}

export interface ApiFieldNode {
  /** Client row id (≤ 64 chars), stored and echoed; errors carry it as node_id. */
  id?: string;
  type: 'field';
  key?: string;
  mode: 'mapping' | 'calculated';
  value_type: ValueType;
  ref?: { signal_id: string } | null;
  /** Stored expression (canonical tokens {{sig:<uuid>}} / {{res:<uuid>}}) or typed text on write. */
  expr?: string | null;
  /** Expression with references rendered with the current names (read only, from the server). */
  expr_display?: string | null;
  /** Mapping reference rendered by the server (read only), e.g. $machine[M1].temp_1. */
  ref_display?: string | null;
  ref_info?: ApiRefInfo | null;
  /** A referenced signal / resource was deleted or archived (read only). */
  missing?: boolean;
}

export interface ApiContainerNode {
  id?: string;
  type: 'object' | 'array';
  key?: string;
  children: ApiNode[];
}

export type ApiNode = ApiFieldNode | ApiContainerNode;

export interface ApiSpec {
  version: 2;
  root: ApiContainerNode;
  /** Server-maintained token labels ({"sig:<uuid>": "$machine[M1].status"}); lets $⚠missing[…] round-trip. */
  labels?: Record<string, string>;
}

export interface ModelDetail extends ModelListItem {
  spec: ApiSpec;
  issues: FieldError[];
  latest: LatestBody | null;
}

// ------------------------------------------------------------------ editor tree (client state)

export interface FieldNode {
  uid: string;
  type: 'field';
  key: string;
  mode: 'mapping' | 'calculated';
  valueType: ValueType;
  signalId: string;
  /** Raw stored expression as loaded from the server (tokens); kept when the text is not edited. */
  exprRaw: string;
  /** Expression text shown and edited by the user (references rendered with names). */
  exprText: string;
  /** True once the user changed the expression text (then exprText is sent). */
  exprEdited: boolean;
  /** Server rendering of a mapping ref (fallback when the catalog does not know the signal). */
  refDisplay: string;
  /** Tooltip from the server's ref_info (full path + connection). */
  refTooltip: string;
  /** The server reported a deleted / archived reference. */
  missing: boolean;
}

export interface ContainerNode {
  uid: string;
  type: 'object' | 'array';
  key: string;
  children: BodyNode[];
}

export type BodyNode = FieldNode | ContainerNode;

export function isContainer(node: BodyNode): node is ContainerNode {
  return node.type === 'object' || node.type === 'array';
}

// ------------------------------------------------------------------ catalog (data picker)

export interface CatalogSignal {
  id: string;
  resourceId: string;
  key: string;
  name: string;
  dataType: string;
  unit: string;
  value: unknown;
  quality: string | null;
  receivedTime: string | null;
  sourceTime: string | null;
  protocol: string;
  connectionName: string;
  /** Raw source group (topic / JSON object / node folder / connection) used by the "grouped" auto-mapping layout. */
  group: string;
  /** Server-rendered reference, e.g. $machine[M1].status. */
  ref: string;
}

export interface CatalogResource {
  id: string;
  parentId: string | null;
  type: string;
  name: string;
  code: string;
  /** Server-rendered selector, e.g. $machine[M1] (already disambiguated). */
  ref?: string;
}

export interface Catalog {
  resources: CatalogResource[];
  signals: CatalogSignal[];
  /** Type key → display name. */
  typeNames: Record<string, string>;
}

// ------------------------------------------------------------------ evaluation results

export interface FieldError {
  /** JSON pointer of the node ("/electrical/voltage_1", array items by index). */
  path: string;
  /** Client row id echoed by the server. */
  nodeId?: string;
  severity?: 'error' | 'warning';
  /** Character range in the submitted expression. */
  pos?: number;
  end?: number;
  message: string;
  code?: string;
  suggestions?: string[];
}

export interface PreviewField {
  path: string;
  nodeId?: string;
  value: unknown;
  error: string | null;
}

export interface PreviewResult {
  body: string | null;
  errors: FieldError[];
  sampledAt: string | null;
  fields: PreviewField[];
}

export interface ValidateResult {
  ok: boolean;
  errors: FieldError[];
  /** expr_display / ref_display per node id, from the rendered spec. */
  rendered: Map<string, string>;
}

export interface RuleFunctionInfo {
  name: string;
  signature: string;
  group: string;
  description: string;
}

export interface Snapshot {
  id: string;
  sampledAt: string | null;
  body: string;
  errorCount: number;
}

export interface LatestBody {
  body: string | null;
  sampledAt: string | null;
  errors: FieldError[];
}

export interface UnmatchedRef {
  path: string;
  ref: string;
  reason: string;
}

export interface DuplicateOutcome {
  targetId: string | null;
  createdId: string | null;
  createdName: string;
  replaced: number;
  unmatched: UnmatchedRef[];
}
