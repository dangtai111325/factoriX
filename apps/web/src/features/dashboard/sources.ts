/**
 * Source catalog (`GET /dashboards/sources`): signals and Data Model fields with their capabilities, and
 * the Factory Model resources used by variables and the equipment widget. Loaded once per page load and
 * shared (module cache); `reload()` fetches it again.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSourceCatalog } from './api';
import type { SourceCapabilities, SourceCatalog, SourceItem, SourceResource } from './types';

let catalogPromise: Promise<SourceCatalog> | null = null;
let catalogValue: SourceCatalog | null = null;
const listeners = new Set<() => void>();

function load(force = false): Promise<SourceCatalog> {
  if (!force && catalogPromise) return catalogPromise;
  const p = getSourceCatalog();
  catalogPromise = p;
  p.then((v) => {
    catalogValue = v;
    listeners.forEach((l) => l());
  }).catch(() => {
    if (catalogPromise === p) catalogPromise = null;
  });
  return p;
}

export interface CatalogState {
  catalog: SourceCatalog | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  byToken: Map<string, SourceItem>;
  resourcesById: Map<string, SourceResource>;
}

export function useSourceCatalog(enabled = true): CatalogState {
  const [catalog, setCatalog] = useState<SourceCatalog | null>(() => catalogValue);
  const [loading, setLoading] = useState(!catalogValue && enabled);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const onChange = () => setCatalog(catalogValue);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    load(nonce > 0)
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        setError(null);
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);

  const byToken = useMemo(() => new Map((catalog?.items || []).map((i) => [i.token, i])), [catalog]);
  const resourcesById = useMemo(() => new Map((catalog?.resources || []).map((r) => [r.id, r])), [catalog]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { catalog, loading, error, reload, byToken, resourcesById };
}

/** Ancestor names of a resource (from `path` when the server sends it, else from the parent chain). */
export function resourcePath(r: SourceResource | undefined, byId: Map<string, SourceResource>): string[] {
  if (!r) return [];
  if (Array.isArray(r.path) && r.path.length) return r.path;
  if (typeof r.path === 'string' && r.path) return r.path.split(/\s*[/>›]\s*/).filter(Boolean);
  const out: string[] = [];
  let cur = r.parent_id ? byId.get(r.parent_id) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id) && out.length < 12) {
    seen.add(cur.id);
    out.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export type CapabilityBadge = { label: string; tone: 'good' | 'info' | 'warning' | 'neutral'; title: string };

/** Short user-facing description of what history a source has (computed by the backend, §6). */
export function capabilityBadge(c: SourceCapabilities | null | undefined): CapabilityBadge {
  if (!c) return { label: 'Capabilities unknown', tone: 'neutral', title: 'The server did not report what this source supports.' };
  const notes = c.notes.join(' ');
  if (!c.historical || c.fidelity === 'unavailable') return { label: 'No history', tone: 'warning', title: notes || 'Only the latest value is available.' };
  if (c.fidelity === 'model_snapshots') return { label: 'Recent snapshots only', tone: 'warning', title: notes || 'Only recent model snapshots are kept.' };
  if (c.fidelity === 'managed_recorded') return { label: 'Recorded history', tone: 'good', title: notes || 'Recorded by a storage binding.' };
  if (c.fidelity === 'postgres_fallback') return { label: 'Limited history', tone: 'info', title: notes || 'History from the PostgreSQL fallback.' };
  return { label: c.history_modes.includes('recorded') ? 'Full + recorded history' : 'Full history', tone: 'good', title: notes || 'Every reading is kept for the raw retention period.' };
}

export type ValueKindFilter = 'all' | 'number' | 'boolean' | 'string';

export type ValueKindName = 'number' | 'boolean' | 'string' | 'json' | 'unknown';

/**
 * Value kind of a source: the server's `value_kind` when present (contract §5), else derived from the
 * value type with the same rules (signal int/float → number, bool → boolean, string/enum/timestamp →
 * string, json → json, anything else → unknown).
 */
export function valueKindOf(valueType: string | null | undefined, serverKind?: string | null): ValueKindName {
  const k = (serverKind || '').toLowerCase();
  if (k === 'number' || k === 'boolean' || k === 'string' || k === 'json' || k === 'unknown') return k;
  const t = (valueType || '').toLowerCase();
  if (!t || t === 'auto') return 'unknown';
  if (t === 'bool' || t === 'boolean') return 'boolean';
  if (/(int|float|double|real|numeric|decimal|number|analog|long|short|byte|word)/.test(t) && !/point/.test(t)) return 'number';
  if (t === 'json' || t === 'object' || t === 'array') return 'json';
  if (/(string|text|char|enum|timestamp|date|time)/.test(t)) return 'string';
  return 'unknown';
}

/**
 * Does a source of this kind fit a widget accepting `kinds`? `any` takes everything; an `unknown` kind is
 * allowed (the server reports it as a warning); any other kind must be listed.
 */
export function kindAccepted(kind: ValueKindName, kinds: string[]): boolean {
  if (!kinds.length || kinds.includes('any')) return true;
  if (kind === 'unknown') return true;
  return kinds.includes(kind);
}

/** First accepted kind = the picker's preferred filter (contract §4); `any` → no filter. */
export function preferredKind(kinds: string[] | undefined): ValueKindFilter {
  const first = kinds?.[0];
  return first === 'number' || first === 'boolean' || first === 'string' ? first : 'all';
}
