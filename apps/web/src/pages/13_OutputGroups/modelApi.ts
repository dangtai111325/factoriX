// Thin typed wrappers over the shared api client for the Data Model screens.
import { api, ApiError } from '../../api/client';
import {
  ApiMember,
  ApplyResult,
  EmitPolicy,
  LatestResult,
  LatestValue,
  ModelDetail,
  ModelEventItem,
  ModelKind,
  ModelListItem,
  ModelTemplate,
  PreviewResult,
  ResourceSignal,
  normDetail,
  normEvent,
  normListItem,
  normPreview,
  normTemplate,
} from './types';

type Raw = Record<string, unknown>;
const BASE = '/api/v1/output-groups';

function items(res: unknown): Raw[] {
  if (Array.isArray(res)) return res as Raw[];
  if (res && typeof res === 'object' && Array.isArray((res as Raw).items)) return (res as Raw).items as Raw[];
  return [];
}

/** Human readable message from any thrown value. */
export function errorText(err: unknown, fallback = 'Request failed.'): string {
  if (err instanceof ApiError) return err.message || `${fallback} (HTTP ${err.status})`;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

/** 422 MEMBERS_UNRESOLVED: a signal key of the model has no ACTIVE signal on the resource. */
export function isMembersUnresolved(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'MEMBERS_UNRESOLVED';
}

export function isVersionConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && /VERSION/i.test(err.code || err.message);
}

export async function listModels(): Promise<ModelListItem[]> {
  return items(await api<unknown>(BASE)).map(normListItem);
}

export async function getModel(id: string): Promise<ModelDetail> {
  return normDetail(await api<Raw>(`${BASE}/${id}`));
}

export interface ModelWrite {
  resource_id?: string;
  key?: string;
  display_name: string;
  topic_template: string;
  kind: ModelKind;
  emit_policy: EmitPolicy;
  members: ApiMember[];
  version?: number;
}

export async function createModel(body: ModelWrite): Promise<{ id: string }> {
  const res = await api<Raw>(BASE, {
    method: 'POST',
    body: JSON.stringify({ ...body, projection_policy: { mode: 'compact', missing: 'null' } }),
  });
  return { id: String(res.id) };
}

export async function updateModel(id: string, body: ModelWrite): Promise<ModelDetail | null> {
  const res = await api<Raw | undefined>(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  return res && typeof res === 'object' && 'id' in res ? normDetail(res) : null;
}

export async function archiveModel(id: string): Promise<void> {
  await api(`${BASE}/${id}`, { method: 'DELETE' });
}

export async function publishModel(id: string, version: number): Promise<void> {
  await api(`${BASE}/${id}/publish`, { method: 'POST', body: JSON.stringify({ version }) });
}

export async function unpublishModel(id: string, version: number): Promise<void> {
  await api(`${BASE}/${id}/unpublish`, { method: 'POST', body: JSON.stringify({ version }) });
}

/** Only the emit policy changes; the server keeps members, topic and kind (OutputGroupPatch). */
export async function setRepublishInterval(id: string, version: number, republishMs: number | null): Promise<void> {
  await api(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify({ version, emit_policy: { republish_ms: republishMs } }) });
}

export async function duplicateModel(
  id: string,
  resourceId: string,
  opts: { displayName?: string; key?: string } = {},
): Promise<{ id: string | null; missingKeys: string[] }> {
  const res = await api<Raw>(`${BASE}/${id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ resource_id: resourceId, display_name: opts.displayName || undefined, key: opts.key || undefined }),
  });
  const created = (res.created || {}) as Raw;
  const missing = Array.isArray(res.missing_keys) ? (res.missing_keys as unknown[]).map(String) : [];
  return { id: created.id ? String(created.id) : null, missingKeys: missing };
}

export async function getPreview(id: string): Promise<PreviewResult> {
  return normPreview(await api<Raw>(`${BASE}/${id}/preview`));
}

export async function getLatest(id: string): Promise<LatestResult> {
  const r = (await api<Raw | null>(`${BASE}/${id}/latest`)) || {};
  return {
    body: typeof r.body === 'string' ? r.body : null,
    source_ts: r.source_ts ? String(r.source_ts) : null,
    published_at: r.published_at ? String(r.published_at) : null,
  };
}

export async function getEvents(id: string, limit = 50): Promise<ModelEventItem[]> {
  return items(await api<unknown>(`${BASE}/${id}/events?limit=${limit}`)).map(normEvent);
}

// ---------------------------------------------------------------- templates

export async function listTemplates(): Promise<ModelTemplate[]> {
  return items(await api<unknown>('/api/v1/model-templates')).map(normTemplate);
}

export interface TemplateWrite {
  key: string;
  display_name: string;
  kind: ModelKind;
  topic_template: string;
  emit_policy: EmitPolicy;
  members: ApiMember[];
}

export async function createTemplate(body: TemplateWrite): Promise<void> {
  const { members, ...rest } = body;
  // Templates are resource independent: signal fields carry signal_key only.
  const fields = members.map(({ signal_id: _sid, ...m }) => m);
  await api('/api/v1/model-templates', { method: 'POST', body: JSON.stringify({ ...rest, fields }) });
}

export async function deleteTemplate(id: string): Promise<void> {
  await api(`/api/v1/model-templates/${id}`, { method: 'DELETE' });
}

export async function applyTemplate(
  id: string,
  resourceIds: string[],
  opts: { publish: boolean; dryRun: boolean },
): Promise<ApplyResult[]> {
  const res = await api<Raw>(`/api/v1/model-templates/${id}/apply`, {
    method: 'POST',
    body: JSON.stringify({ resource_ids: resourceIds, publish: opts.publish, dry_run: opts.dryRun }),
  });
  return items(res.results ?? res).map((r) => ({
    resource_id: String(r.resource_id ?? ''),
    resource_name: String(r.resource_name ?? ''),
    group_id: r.group_id ? String(r.group_id) : null,
    missing_keys: Array.isArray(r.missing_keys) ? (r.missing_keys as unknown[]).map(String) : [],
    status: (['created', 'exists', 'missing', 'dry_run'].includes(String(r.status)) ? r.status : 'dry_run') as ApplyResult['status'],
    published: Boolean(r.published),
  }));
}

// ---------------------------------------------------------------- signals

export async function listResourceSignals(resourceId: string): Promise<ResourceSignal[]> {
  const res = await api<unknown>(`/api/v1/signals?resource_id=${encodeURIComponent(resourceId)}&limit=1000`);
  return items(res).map((r) => ({
    id: String(r.id),
    key: String(r.key ?? ''),
    displayName: String(r.display_name || r.key || ''),
    dataType: String(r.data_type ?? ''),
    unit: String(r.unit ?? ''),
    resourceId: String(r.resource_id ?? resourceId),
  }));
}

/** Latest values for many signals (the endpoint accepts at most 200 ids per call). */
export async function getLatestValues(ids: string[]): Promise<Map<string, LatestValue>> {
  const out = new Map<string, LatestValue>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = await api<unknown>(`/api/v1/observations/latest?signal_ids=${chunk.join(',')}`);
    for (const r of items(res)) {
      const vj = r.value_json as Raw | null | undefined;
      out.set(String(r.signal_id), {
        value: r.value !== undefined ? r.value : vj && typeof vj === 'object' ? vj.v : null,
        quality: r.effective_status ? String(r.effective_status) : r.quality ? String(r.quality) : null,
        receivedTime: r.received_time ? String(r.received_time) : null,
        sourceTime: r.source_time ? String(r.source_time) : null,
      });
    }
  }
  return out;
}
