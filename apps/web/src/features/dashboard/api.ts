/**
 * Dashboard Studio API layer: every endpoint of docs/architecture/contracts/dashboard.md §5, plus the two
 * read endpoints the runtime uses (`GET /api/v1/data-models/{id}/latest`, `POST /api/v1/historian/query`)
 * and the latest-values fallback (`GET /api/v1/observations/latest`) used only while push is unavailable.
 *
 * Errors are the shared `ApiError` (status, code, message, details) from api/client.ts; `errorInfo()` turns
 * any thrown value into `{code, message, status, issues}` for the UI.
 */
import { api, ApiError } from '../../api/client';
import type {
  DashboardDetail,
  DashboardDocument,
  DashboardExport,
  DashboardImportResult,
  DashboardListResponse,
  DashboardTemplate,
  HistorianQueryRequest,
  HistorianQueryResponseRaw,
  ModelLatest,
  PublishedDashboard,
  ResolveResponse,
  RevisionDetail,
  RevisionSummary,
  SourceCapabilities,
  SourceCatalog,
  SourceItem,
  SourceRef,
  SourceResource,
  ThemePreset,
  ValidationIssue,
  ValidationResult,
  WidgetRegistry,
} from './types';

const BASE = '/api/v1/dashboards';
const enc = encodeURIComponent;

function json(body: unknown): string {
  return JSON.stringify(body);
}

// ------------------------------------------------------------------ errors

export interface ErrorInfo {
  status: number | null;
  code: string;
  message: string;
  /** `details.issues[]` of VALIDATION / PUBLISH_BLOCKED answers. */
  issues: ValidationIssue[];
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function errorInfo(error: unknown, fallback = 'The request failed.'): ErrorInfo {
  if (error instanceof ApiError) {
    const raw = (error.details?.details as Record<string, unknown> | undefined)?.issues ?? error.details?.issues;
    const issues = Array.isArray(raw) ? (raw as ValidationIssue[]).filter((i) => i && typeof i.message === 'string') : [];
    return { status: error.status, code: error.code || `HTTP_${error.status}`, message: error.message || fallback, issues };
  }
  if (error instanceof Error) return { status: null, code: 'NETWORK', message: error.message || fallback, issues: [] };
  return { status: null, code: 'UNKNOWN', message: fallback, issues: [] };
}

/** One line for toasts: "message (CODE)". */
export function errorLine(error: unknown, fallback?: string): string {
  const info = errorInfo(error, fallback);
  return info.code && info.code !== 'NETWORK' && info.code !== 'UNKNOWN' ? `${info.message} (${info.code})` : info.message;
}

// ------------------------------------------------------------------ dashboards

export function listDashboards(params: { includeArchived?: boolean; q?: string } = {}, signal?: AbortSignal): Promise<DashboardListResponse> {
  const qs = new URLSearchParams({ include_archived: params.includeArchived ? 'true' : 'false' });
  if (params.q) qs.set('q', params.q);
  return api<DashboardListResponse>(`${BASE}?${qs}`, { signal });
}

export interface CreateDashboardBody {
  name: string;
  description?: string;
  template_id?: string;
  role_map?: Record<string, SourceRef>;
  source_dashboard_id?: string;
}

export function createDashboard(body: CreateDashboardBody): Promise<DashboardDetail & { warnings?: DashboardImportResult['warnings'] }> {
  return api(`${BASE}`, { method: 'POST', body: json(body) });
}

export function getDashboard(id: string, signal?: AbortSignal): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}`, { signal });
}

export function patchDashboard(
  id: string,
  body: { version: number; name?: string; description?: string; document?: DashboardDocument },
): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}`, { method: 'PATCH', body: json(body) });
}

export function validateDashboard(id: string, document?: DashboardDocument, signal?: AbortSignal): Promise<ValidationResult> {
  return api<ValidationResult>(`${BASE}/${enc(id)}/validate`, { method: 'POST', body: json(document ? { document } : {}), signal });
}

export function publishDashboard(id: string, body: { version: number; note?: string }): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}/publish`, { method: 'POST', body: json(body) });
}

export function getPublished(id: string, signal?: AbortSignal): Promise<PublishedDashboard> {
  return api<PublishedDashboard>(`${BASE}/${enc(id)}/published`, { signal });
}

export function listRevisions(id: string, signal?: AbortSignal): Promise<{ items: RevisionSummary[] }> {
  return api<{ items: RevisionSummary[] }>(`${BASE}/${enc(id)}/revisions`, { signal });
}

export function getRevision(id: string, revision: number, signal?: AbortSignal): Promise<RevisionDetail> {
  return api<RevisionDetail>(`${BASE}/${enc(id)}/revisions/${revision}`, { signal });
}

export function restoreRevision(id: string, body: { revision: number; version: number }): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}/restore`, { method: 'POST', body: json(body) });
}

export function duplicateDashboard(id: string, name: string): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}/duplicate`, { method: 'POST', body: json({ name }) });
}

export function archiveDashboard(id: string, version: number): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}/archive`, { method: 'POST', body: json({ version }) });
}

export function unarchiveDashboard(id: string, version: number): Promise<DashboardDetail> {
  return api<DashboardDetail>(`${BASE}/${enc(id)}/unarchive`, { method: 'POST', body: json({ version }) });
}

/** Permanently delete an archived dashboard and all its revisions (409 NOT_ARCHIVED for an active one). */
export function deleteDashboard(id: string): Promise<void> {
  return api<void>(`${BASE}/${enc(id)}`, { method: 'DELETE' });
}

export function exportDashboard(id: string): Promise<DashboardExport> {
  return api<DashboardExport>(`${BASE}/${enc(id)}/export`);
}

export function importDashboard(body: { name?: string; payload: unknown }): Promise<DashboardImportResult> {
  return api<DashboardImportResult>(`${BASE}/import`, { method: 'POST', body: json(body) });
}

// ------------------------------------------------------------------ registry, themes, templates

export function getWidgetTypes(signal?: AbortSignal): Promise<WidgetRegistry> {
  return api<WidgetRegistry>(`${BASE}/widget-types`, { signal });
}

export function getThemes(signal?: AbortSignal): Promise<{ items: ThemePreset[] }> {
  return api<{ items: ThemePreset[] }>(`${BASE}/themes`, { signal });
}

export function listTemplates(signal?: AbortSignal): Promise<{ items: DashboardTemplate[] }> {
  return api<{ items: DashboardTemplate[] }>(`${BASE}/templates`, { signal });
}

export function createTemplate(body: { dashboard_id: string; name: string; description?: string; category?: string }): Promise<DashboardTemplate> {
  return api<DashboardTemplate>(`${BASE}/templates`, { method: 'POST', body: json(body) });
}

export function deleteTemplate(id: string): Promise<void> {
  return api<void>(`${BASE}/templates/${enc(id)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ sources and resolution

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Raw[]) : []);

function capabilitiesOf(v: unknown): SourceCapabilities | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Raw;
  return {
    latest: c.latest === true,
    live: c.live === true,
    historical: c.historical === true,
    history_modes: Array.isArray(c.history_modes) ? (c.history_modes as SourceCapabilities['history_modes']) : [],
    fidelity: (str(c.fidelity) || 'unavailable') as SourceCapabilities['fidelity'],
    notes: Array.isArray(c.notes) ? (c.notes as unknown[]).map(str).filter(Boolean) : [],
  };
}

function sourceRefOf(v: unknown): SourceRef | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Raw;
  if (s.kind === 'signal' && s.signal_id) return { kind: 'signal', signal_id: str(s.signal_id) };
  if (s.kind === 'model_field' && s.model_id && s.field_path) return { kind: 'model_field', model_id: str(s.model_id), field_path: str(s.field_path) };
  return null;
}

function signalItem(r: Raw, resourceId: string | null): SourceItem {
  const token = str(r.token || r.signal_id || r.id);
  return {
    source: sourceRefOf(r.source) ?? (token ? { kind: 'signal', signal_id: token } : null),
    value_kind: strOrNull(r.value_kind),
    kind: 'signal',
    token,
    key: str(r.key),
    label: str(r.label || r.display_name || r.key || token),
    value_type: strOrNull(r.value_type ?? r.data_type),
    unit: strOrNull(r.unit),
    quality: strOrNull(r.quality),
    freshness: strOrNull(r.freshness),
    last_value: r.last_value === undefined ? null : r.last_value,
    has_last_value: r.has_last_value === undefined ? r.last_value !== undefined && r.last_value !== null : r.has_last_value === true,
    last_at: strOrNull(r.last_at),
    resource_id: strOrNull(r.resource_id) ?? resourceId,
    signal_id: str(r.signal_id || token),
    capabilities: capabilitiesOf(r.capabilities),
  };
}

function fieldItem(r: Raw, resourceId: string | null, model: { id: string; name: string } | null): SourceItem {
  const token = str(r.token);
  // token = mod:<model uuid>:<field path>
  const m = /^mod:([^:]+):(.*)$/.exec(token);
  const modelId = str(r.model_id) || model?.id || (m ? m[1] : '');
  const fieldPath = str(r.field_path) || (m ? m[2] : '');
  return {
    source: sourceRefOf(r.source) ?? (modelId && fieldPath ? { kind: 'model_field', model_id: modelId, field_path: fieldPath } : null),
    value_kind: strOrNull(r.value_kind),
    kind: 'model_field',
    token,
    key: str(r.key || fieldPath),
    label: str(r.label || `${model?.name ?? ''} · ${fieldPath}`),
    value_type: strOrNull(r.value_type ?? r.data_type),
    unit: strOrNull(r.unit),
    quality: strOrNull(r.quality),
    freshness: strOrNull(r.freshness),
    last_value: r.last_value === undefined ? null : r.last_value,
    has_last_value: r.has_last_value === true,
    last_at: strOrNull(r.last_at),
    resource_id: strOrNull(r.resource_id) ?? resourceId,
    model_id: modelId,
    model_name: str(r.model_name) || model?.name || '',
    field_path: fieldPath,
    capabilities: capabilitiesOf(r.capabilities),
  };
}

/**
 * `GET /dashboards/sources?q=` → normalised catalog. The response is the Historian picker read model
 * (`items[]` grouped by machine with `signals[]` and `models[].fields[]`), restricted to signals and model
 * fields, each with `capabilities`, plus `resources[]`. A flat `items[]` with `kind` is accepted as well.
 */
export async function getSourceCatalog(q?: string, signal?: AbortSignal): Promise<SourceCatalog> {
  const qs = q ? `?q=${enc(q)}` : '';
  const res = await api<Raw>(`${BASE}/sources${qs}`, { signal });
  const items: SourceItem[] = [];
  for (const g of arr(res?.items)) {
    if (g.kind === 'signal') {
      items.push(signalItem(g, null));
      continue;
    }
    if (g.kind === 'model_field') {
      items.push(fieldItem(g, null, null));
      continue;
    }
    const resource = g.resource && typeof g.resource === 'object' ? (g.resource as Raw) : null;
    const rid = resource && resource.id && resource.id !== 'unassigned' ? str(resource.id) : null;
    for (const s of arr(g.signals)) items.push(signalItem(s, rid));
    for (const m of arr(g.models)) {
      const model = { id: str(m.model_id || m.id), name: str(m.name || m.display_name) };
      for (const f of arr(m.fields)) items.push(fieldItem(f, rid, model));
    }
    for (const f of arr(g.fields)) items.push(fieldItem(f, rid, null));
  }
  const resources: SourceResource[] = arr(res?.resources).map((r) => ({
    id: str(r.id),
    name: str(r.name),
    code: str(r.code),
    type_key: str(r.type_key || r.type),
    path: Array.isArray(r.path) ? (r.path as unknown[]).map(str) : strOrNull(r.path),
    parent_id: strOrNull(r.parent_id),
  }));
  return { items: items.filter((i) => i.token), resources: resources.filter((r) => r.id) };
}

export function resolveSources(
  body: { variables: Record<string, string | null>; sources: SourceRef[] },
  signal?: AbortSignal,
): Promise<ResolveResponse> {
  return api<ResolveResponse>(`${BASE}/resolve`, { method: 'POST', body: json(body), signal });
}

// ------------------------------------------------------------------ live and history (shared endpoints)

export async function getModelLatest(modelId: string, signal?: AbortSignal): Promise<ModelLatest> {
  const r = await api<Raw | null>(`/api/v1/data-models/${enc(modelId)}/latest`, { signal });
  const body = r?.body;
  return {
    body: typeof body === 'string' ? body : body === null || body === undefined ? null : JSON.stringify(body),
    sampled_at: strOrNull(r?.sampled_at),
    errors: arr(r?.errors).map((e) => ({ path: strOrNull(e.path) ?? undefined, code: strOrNull(e.code) ?? undefined, message: strOrNull(e.message) ?? undefined })),
    fields: Array.isArray(r?.fields)
      ? arr(r?.fields).map((f) => ({ path: str(f.path), quality: str(f.quality), reason: strOrNull(f.reason) }))
      : undefined,
  };
}

export function queryHistorian(body: HistorianQueryRequest, signal?: AbortSignal): Promise<HistorianQueryResponseRaw> {
  return api<HistorianQueryResponseRaw>('/api/v1/historian/query', { method: 'POST', body: json(body), signal });
}

/** Latest rows of up to 200 signals (REST fallback while the live stream does not push them). */
export async function getLatestObservations(ids: string[], signal?: AbortSignal): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = await api<Raw | Raw[]>(`/api/v1/observations/latest?signal_ids=${chunk.map(enc).join(',')}`, { signal });
    out.push(...(Array.isArray(res) ? res : arr((res as Raw)?.items)));
  }
  return out;
}

// ------------------------------------------------------------------ download helper

/** Save a JSON value as a file (export). No server URL is opened. */
export function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string): string {
  return (name || 'dashboard').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'dashboard';
}
