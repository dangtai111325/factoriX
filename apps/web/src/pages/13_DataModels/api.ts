// Typed wrappers over the shared api client for /api/v1/data-models (Data Model v2).
// Contract: scratchpad dm2_api.md (backend). Normalisers stay tolerant so small shape drifts do not
// break the screens.
import { api, ApiError } from '../../api/client';
import type {
  ApiContainerNode,
  ApiSpec,
  Catalog,
  CatalogResource,
  CatalogSignal,
  DuplicateOutcome,
  FieldError,
  FieldQuality,
  FieldQualityRow,
  LatestBody,
  ModelDetail,
  ModelListItem,
  ModelState,
  PreviewResult,
  QualitySummary,
  RuleFunctionInfo,
  Snapshot,
  UnmatchedRef,
  ValidateResult,
} from './types';

type Raw = Record<string, unknown>;
export const BASE = '/api/v1/data-models';

function items(res: unknown, ...keys: string[]): Raw[] {
  if (Array.isArray(res)) return res as Raw[];
  if (res && typeof res === 'object') {
    for (const key of ['items', ...keys]) {
      const v = (res as Raw)[key];
      if (Array.isArray(v)) return v as Raw[];
    }
  }
  return [];
}

const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const numOrUndef = (v: unknown): number | undefined => (v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Body text from the server: a string (exact ordered JSON) or, defensively, an object. */
function bodyText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** The request never reached FactoriX (browser offline, appliance unreachable, gateway down). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 502 || err.status === 503 || err.status === 504;
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  // fetch() rejects with a TypeError: "Failed to fetch" (Chrome), "NetworkError when attempting…" (Firefox), "Load failed" (Safari).
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return true;
  return typeof navigator !== 'undefined' && navigator.onLine === false && !(err instanceof ApiError);
}

export const NETWORK_MESSAGE = "Can't reach FactoriX. Your changes are kept on this page — check the connection and retry.";

/** Human readable message from any thrown value. */
export function errorText(err: unknown, fallback = 'Request failed.'): string {
  // R4-DM-13: "Failed to fetch" / gateway errors become one friendly message.
  if (isNetworkError(err)) return NETWORK_MESSAGE;
  if (err instanceof ApiError) {
    if (err.code === 'DUPLICATE_NAME') return err.message || 'A data model with this name already exists.';
    if (err.code === 'VERSION_CONFLICT') return 'Someone else changed this model meanwhile. Reload it to see the latest version.';
    return err.message || `${fallback} (HTTP ${err.status})`;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export function isVersionConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code !== 'DUPLICATE_NAME';
}

export function isDuplicateName(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'DUPLICATE_NAME';
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405);
}

/** Spec errors carried by a 422 INVALID_SPEC response. */
export function specErrorsOf(err: unknown): FieldError[] {
  return err instanceof ApiError ? normErrors(err.details.field_errors) : [];
}

function pathText(v: unknown): string {
  if (Array.isArray(v)) return `/${v.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
  return str(v);
}

export function normErrors(v: unknown): FieldError[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((e): FieldError => {
        if (typeof e === 'string') return { path: '', message: e };
        const r = (e || {}) as Raw;
        return {
          path: pathText(r.path ?? ''),
          nodeId: strOrNull(r.node_id) ?? undefined,
          severity: r.severity === 'warning' ? 'warning' : 'error',
          message: str(r.message ?? r.error ?? r.code, 'Error'),
          code: strOrNull(r.code) ?? undefined,
          pos: numOrUndef(r.pos),
          end: numOrUndef(r.end),
          suggestions: Array.isArray(r.suggestions) ? (r.suggestions as unknown[]).map(String) : undefined,
        };
      })
      .filter((e) => e.message);
  }
  if (typeof v === 'object') return Object.entries(v as Raw).map(([path, message]) => ({ path, message: str(message, 'Error') }));
  return [];
}

function normState(v: unknown): ModelState {
  return String(v || '').toUpperCase() === 'PAUSED' ? 'PAUSED' : 'RUNNING';
}

const QUALITIES: FieldQuality[] = ['missing', 'bad', 'disabled', 'no_data', 'paused', 'stale', 'uncertain', 'good'];

function normQuality(v: unknown): FieldQuality | undefined {
  const q = String(v ?? '').toLowerCase() as FieldQuality;
  return QUALITIES.includes(q) ? q : undefined;
}

function normQualitySummary(v: unknown): QualitySummary | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Raw;
  const counts: Partial<Record<FieldQuality, number>> = {};
  if (r.counts && typeof r.counts === 'object') {
    Object.entries(r.counts as Raw).forEach(([k, n]) => {
      const q = normQuality(k);
      if (q) counts[q] = num(n);
    });
  }
  const list = (x: unknown) => (Array.isArray(x) ? x.map((i) => String(i)).filter(Boolean) : []);
  return {
    status: normQuality(r.status) || 'good',
    counts,
    affectedFields: num(r.affected_fields),
    pausedSources: list(r.paused_sources),
    staleSources: list(r.stale_sources),
  };
}

function normQualityRows(v: unknown): FieldQualityRow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return (v as Raw[]).map((f) => ({
    path: pathText(f.path ?? ''),
    nodeId: strOrNull(f.node_id) ?? undefined,
    quality: normQuality(f.quality) || 'good',
    reason: strOrNull(f.reason),
  }));
}

function normLatest(v: unknown): LatestBody | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Raw;
  return {
    body: bodyText(r.body),
    sampledAt: strOrNull(r.sampled_at),
    errors: normErrors(r.errors),
    fields: normQualityRows(r.fields),
    quality: normQualitySummary(r.quality),
  };
}

function normListItem(r: Raw): ModelListItem {
  const machines = Array.isArray(r.machines)
    ? (r.machines as unknown[]).map((m) => (m && typeof m === 'object' ? str((m as Raw).name ?? (m as Raw).code) : str(m))).filter(Boolean)
    : [];
  const latest = normLatest(r.latest);
  return {
    id: str(r.id),
    name: str(r.name, 'Untitled model'),
    description: str(r.description),
    sample_ms: num(r.sample_ms, 1000),
    state: normState(r.state),
    version: num(r.version, 1),
    field_count: num(r.field_count),
    ref_count: num(r.ref_count),
    machines,
    updated_at: strOrNull(r.updated_at),
    last_sampled_at: strOrNull(r.last_sampled_at) ?? latest?.sampledAt ?? null,
    error_count: num(r.error_count),
    latest_body: bodyText(r.body) ?? latest?.body ?? null,
  };
}

function normSpec(v: unknown): ApiSpec {
  let spec = v;
  if (typeof spec === 'string') {
    try {
      spec = JSON.parse(spec);
    } catch {
      spec = null;
    }
  }
  const s = (spec || {}) as Raw;
  const root = (s.root && typeof s.root === 'object' ? s.root : { type: 'object', children: [] }) as ApiContainerNode;
  if (!Array.isArray(root.children)) root.children = [];
  const labels = s.labels && typeof s.labels === 'object' ? (s.labels as Record<string, string>) : undefined;
  return { version: 2, root, labels };
}

function normDetail(r: Raw): ModelDetail {
  return { ...normListItem(r), spec: normSpec(r.spec), issues: normErrors(r.issues), latest: normLatest(r.latest) };
}

export async function listModels(): Promise<ModelListItem[]> {
  return items(await api<unknown>(BASE)).map(normListItem);
}

export async function getModel(id: string): Promise<ModelDetail> {
  return normDetail(await api<Raw>(`${BASE}/${encodeURIComponent(id)}`));
}

export interface ModelWrite {
  name: string;
  description: string;
  sample_ms: number;
  spec: ApiSpec;
}

export async function createModel(body: ModelWrite & { state?: ModelState }, signal?: AbortSignal): Promise<ModelDetail> {
  return normDetail(await api<Raw>(BASE, { method: 'POST', body: JSON.stringify(body), signal }));
}

export async function updateModel(id: string, version: number, body: ModelWrite, signal?: AbortSignal): Promise<ModelDetail> {
  return normDetail(await api<Raw>(`${BASE}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...body, version }), signal }));
}

export async function deleteModel(id: string, version?: number): Promise<void> {
  await api(`${BASE}/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`, { method: 'DELETE' });
}

export async function setRunning(id: string, running: boolean): Promise<ModelDetail | null> {
  const r = await api<Raw | undefined>(`${BASE}/${encodeURIComponent(id)}/${running ? 'resume' : 'pause'}`, { method: 'POST', body: '{}' });
  return r && typeof r === 'object' && r.id ? normDetail(r) : null;
}

export async function validateSpec(spec: ApiSpec, modelId: string | null, signal?: AbortSignal): Promise<ValidateResult> {
  const r =
    (await api<Raw>(`${BASE}/validate`, { method: 'POST', body: JSON.stringify({ spec, model_id: modelId || undefined }), signal })) || {};
  const errors = normErrors(r.errors);
  const rendered = new Map<string, string>();
  const walk = (node: Raw) => {
    const children = Array.isArray(node.children) ? (node.children as Raw[]) : [];
    children.forEach((child) => {
      const id = strOrNull(child.id);
      if (id && child.type === 'field') {
        const display = child.mode === 'calculated' ? child.expr_display : child.ref_display;
        if (typeof display === 'string') rendered.set(id, display);
      }
      if (child.type === 'object' || child.type === 'array') walk(child);
    });
  };
  const renderedSpec = r.spec as Raw | undefined;
  if (renderedSpec && typeof renderedSpec === 'object' && renderedSpec.root) walk(renderedSpec.root as Raw);
  const valid = r.valid !== undefined ? Boolean(r.valid) : !errors.some((e) => e.severity !== 'warning');
  return { ok: valid, errors, rendered };
}

export async function previewSpec(spec: ApiSpec, opts: { sessionId: string; modelId: string | null }, signal?: AbortSignal): Promise<PreviewResult> {
  const r =
    (await api<Raw>(`${BASE}/preview`, {
      method: 'POST',
      body: JSON.stringify({ spec, session_id: opts.sessionId, model_id: opts.modelId || undefined }),
      signal,
    })) || {};
  return {
    body: bodyText(r.body),
    errors: normErrors(r.errors),
    sampledAt: strOrNull(r.sampled_at),
    fields: items(r.fields).map((f) => ({
      path: pathText(f.path ?? ''),
      nodeId: strOrNull(f.node_id) ?? undefined,
      value: f.value,
      error: strOrNull(f.error),
      quality: normQuality(f.quality),
      qualityReason: strOrNull(f.quality_reason),
    })),
    quality: normQualitySummary(r.quality),
  };
}

export async function getLatest(id: string): Promise<LatestBody> {
  return normLatest((await api<Raw | null>(`${BASE}/${encodeURIComponent(id)}/latest`)) || {}) || { body: null, sampledAt: null, errors: [] };
}

export async function getSnapshots(id: string, limit = 20): Promise<Snapshot[]> {
  const res = await api<unknown>(`${BASE}/${encodeURIComponent(id)}/snapshots?limit=${limit}`);
  return items(res, 'snapshots').map((r, index) => {
    const errs = normErrors(r.errors);
    return {
      id: str(r.id ?? r.sampled_at, `${index}`),
      sampledAt: strOrNull(r.sampled_at),
      body: bodyText(r.body) || '',
      errorCount: r.error_count !== undefined ? num(r.error_count) : errs.length,
    };
  });
}

function normOutcome(r: Raw): DuplicateOutcome {
  // One entry per reference (the server merges the fields using it); merged here too for older servers.
  const byRef = new Map<string, UnmatchedRef>();
  items(r.unmatched).forEach((u) => {
    const ref = str(u.ref ?? u.label);
    const paths = Array.isArray(u.paths) ? (u.paths as unknown[]).map(pathText) : [pathText(u.path ?? '')];
    const hit = byRef.get(ref);
    if (hit) {
      paths.forEach((p) => !hit.paths.includes(p) && hit.paths.push(p));
      hit.count = hit.paths.length;
    } else byRef.set(ref, { path: paths[0] || '', ref, reason: str(u.reason ?? u.message), paths, count: paths.length });
  });
  const unmatched = Array.from(byRef.values());
  return {
    targetId: strOrNull(r.target_resource_id),
    createdId: strOrNull(r.id),
    createdName: str(r.name),
    replaced: num(r.replaced),
    unmatched,
    unmatchedFields: r.unmatched_fields !== undefined ? num(r.unmatched_fields) : unmatched.reduce((n, u) => n + u.count, 0),
    skipped: Boolean(r.skipped),
  };
}

/** Plain copy with a new name ("Duplicate…"). */
export async function duplicateModel(id: string, name: string): Promise<DuplicateOutcome> {
  const r = (await api<Raw>(`${BASE}/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) })) || {};
  const list = items(r, 'created');
  return normOutcome(list[0] || r);
}

/** One copy per target resource ("Duplicate to machines…"); `dryRun` returns the plan without creating. */
export async function duplicateToTargets(
  id: string,
  sourceResourceId: string,
  targetIds: string[],
  opts: { dryRun: boolean; skipUnmatched?: boolean },
): Promise<DuplicateOutcome[]> {
  const r =
    (await api<Raw>(`${BASE}/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ source_resource_id: sourceResourceId, targets: targetIds, dry_run: opts.dryRun, skip_unmatched: Boolean(opts.skipUnmatched) }),
    })) || {};
  return items(r, 'created').map(normOutcome);
}

export async function getRuleFunctions(): Promise<{ functions: RuleFunctionInfo[]; examples: Array<{ label: string; expr: string }> }> {
  const r = (await api<Raw>(`${BASE}/rules/functions`)) || {};
  return {
    functions: items(r.functions).map((f) => ({ name: str(f.name), signature: str(f.signature, `${str(f.name)}()`), group: str(f.group), description: str(f.description) })),
    examples: items(r.examples).map((e) => ({ label: str(e.label), expr: str(e.expr) })),
  };
}

// ------------------------------------------------------------------ catalog

function normCatalogSignal(r: Raw, resourceId: string): CatalogSignal {
  return {
    id: str(r.id),
    resourceId: str(r.resource_id, resourceId),
    key: str(r.key),
    name: str(r.name ?? r.key),
    dataType: str(r.data_type),
    unit: str(r.unit),
    value: r.value !== undefined ? r.value : null,
    quality: strOrNull(r.effective_status ?? r.quality),
    receivedTime: strOrNull(r.received_time),
    sourceTime: strOrNull(r.source_time),
    protocol: str(r.protocol),
    connectionName: str(r.connection_name),
    group: str(r.group ?? r.connection_name),
    ref: str(r.ref),
  };
}

/** GET /data-models/catalog → flat resources (parent_id) each carrying its signals. */
export async function getCatalog(resourceId?: string): Promise<Catalog> {
  const res = await api<unknown>(`${BASE}/catalog${resourceId ? `?resource_id=${encodeURIComponent(resourceId)}` : ''}`);
  const resources: CatalogResource[] = [];
  const signals: CatalogSignal[] = [];
  const typeNames: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (r: Raw, parentId: string | null) => {
    const id = str(r.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const type = str(r.type_key ?? r.type).toLowerCase();
    if (type && r.type_name) typeNames[type] = str(r.type_name);
    resources.push({ id, parentId: strOrNull(r.parent_id) ?? parentId, type, name: str(r.name ?? r.code), code: str(r.code), ref: str(r.ref) || undefined });
    items(r.signals).forEach((s) => signals.push(normCatalogSignal(s, id)));
    items(r.children).forEach((c) => add(c, id));
  };
  items(res, 'resources').forEach((r) => add(r, null));
  if (res && typeof res === 'object' && !Array.isArray(res)) {
    items((res as Raw).types).forEach((t) => {
      if (t.key) typeNames[str(t.key).toLowerCase()] = str(t.name, str(t.key));
    });
  }
  return { resources, signals, typeNames };
}

/** Latest values for many signals (the endpoint accepts at most 200 ids per call). */
export async function getLatestValues(ids: string[]): Promise<Map<string, { value: unknown; quality: string | null; receivedTime: string | null }>> {
  const out = new Map<string, { value: unknown; quality: string | null; receivedTime: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = await api<unknown>(`/api/v1/observations/latest?signal_ids=${chunk.join(',')}`);
    for (const r of items(res)) {
      const vj = r.value_json as Raw | null | undefined;
      out.set(str(r.signal_id), {
        value: r.value !== undefined ? r.value : vj && typeof vj === 'object' ? vj.v : null,
        quality: strOrNull(r.effective_status ?? r.quality),
        receivedTime: strOrNull(r.received_time),
      });
    }
  }
  return out;
}
