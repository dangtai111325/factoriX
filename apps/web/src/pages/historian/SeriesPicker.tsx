/**
 * Historian source picker = the Factory Model tree (site → … → machine), and under each machine its
 * signals, its Data Model fields (grouped by model) and the recorded tables bound to it.
 *
 * Signals come from the app store (already loaded, live quality); Data Model fields from
 * `GET /storage/sources?view=models` (one ~1 s call, cached for the session); recorded tables from
 * `GET /storage/td/subtables` (system op_* / ms_* tables are hidden: they are the raw store itself).
 * Search switches to a flat result list grouped by machine.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Layers, RefreshCw, Table2 } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { buildResourceTree, ResourceTreeNode, resourceTypeGlyph } from '../../components/tree/resourceTree';
import { getSources, isSystemStorageName, listSubtables, ModelSourceGroup, SourceRef, TDSubtable } from '../../lib/storagePhysicalApi';
import { MAX_SERIES, SeriesKind } from './historianModel';
import { SearchInput, Segmented } from './hsUi';

export interface PickItem {
  token: string;
  kind: SeriesKind;
  /** Full label, e.g. "AA10-01 · speed_1". */
  label: string;
  name: string;
  sub: string;
  unit: string;
  valueType: string;
  resourceId: string | null;
  quality?: string | null;
  freshness?: string | null;
  group?: string;
  recorded?: boolean;
}

interface ModelGroup {
  id: string;
  name: string;
  machineId: string | null;
  fields: PickItem[];
}

// ---------------------------------------------------------------- session cache of the slow lists
let modelsCache: { at: number; promise: Promise<ModelSourceGroup[]> } | null = null;
function loadModels(force = false): Promise<ModelSourceGroup[]> {
  if (!force && modelsCache && Date.now() - modelsCache.at < 120_000) return modelsCache.promise;
  const promise = getSources({ view: 'models' }).then((res) => ((res as unknown as { items?: ModelSourceGroup[] }).items || []) as ModelSourceGroup[]);
  modelsCache = { at: Date.now(), promise };
  promise.catch(() => {
    modelsCache = null;
  });
  return promise;
}
let tablesCache: { at: number; promise: Promise<TDSubtable[]> } | null = null;
function loadTables(force = false): Promise<TDSubtable[]> {
  if (!force && tablesCache && Date.now() - tablesCache.at < 120_000) return tablesCache.promise;
  const promise = listSubtables().then((res) => (res?.items || []).filter((t) => !isSystemStorageName(t.physical_name) && !isSystemStorageName(t.stable_name)));
  tablesCache = { at: Date.now(), promise };
  promise.catch(() => {
    tablesCache = null;
  });
  return promise;
}

/** Quality dot: quality AND freshness; unknown (grey) when offline or not reported (R1-15). */
export function qualityDot(quality?: string | null, freshness?: string | null): { cls: string; title: string } {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { cls: 'bg-[#CBD5E1]', title: 'Unknown (browser offline)' };
  const q = (quality || '').toUpperCase();
  const f = (freshness || '').toUpperCase();
  if (q.includes('BAD')) return { cls: 'bg-[#EF4444]', title: 'Bad quality' };
  if (q === 'PAUSED') return { cls: 'bg-[#64748B]', title: 'Paused' };
  if (f === 'STALE' || q === 'STALE') return { cls: 'bg-[#F59E0B]', title: 'Stale — no fresh value' };
  if (f === 'DELAYED') return { cls: 'bg-[#FCD34D]', title: 'Good, delivery delayed' };
  if (q === 'GOOD' && (f === 'FRESH' || !f)) return { cls: 'bg-[#0DBA67]', title: 'Good · fresh' };
  if (q === 'NO_DATA' || f === 'NO_DATA') return { cls: 'bg-[#E2E8F0]', title: 'No data yet' };
  return { cls: 'bg-[#CBD5E1]', title: q ? `Quality ${q}` : 'Unknown' };
}

type KindFilter = 'all' | 'signal' | 'model_field' | 'subtable';

export const SeriesPicker: React.FC<{
  selected: string[];
  colorOf: (token: string) => string | undefined;
  onToggle: (item: PickItem) => void;
  onClear: () => void;
  /** Registers labels the page can show before the first query answers. */
  onCatalog?: (items: PickItem[]) => void;
  className?: string;
}> = ({ selected, colorOf, onToggle, onClear, onCatalog, className = '' }) => {
  const { resources, signals, dataModels, loadState } = useApp();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [models, setModels] = useState<ModelSourceGroup[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [tables, setTables] = useState<TDSubtable[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setModelsError(null);
    loadModels(reloadKey > 0)
      .then((m) => alive && setModels(m))
      .catch((e) => alive && setModelsError(e?.message || 'Could not load Data Model fields'));
    loadTables(reloadKey > 0)
      .then((t) => alive && setTables(t))
      .catch(() => alive && setTables([]));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const resById = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);

  const signalItems: PickItem[] = useMemo(
    () =>
      signals.map((s) => {
        const rid = s.resourceId || s.resource_id || null;
        const res = rid ? resById.get(rid) : undefined;
        const key = s.key || s.name || s.tag;
        const vt = String(s.data_type || s.dataType || '');
        return {
          token: s.id,
          kind: 'signal' as const,
          label: `${res?.code || res?.name || 'Signal'} · ${key}`,
          name: key,
          sub: [vt.toLowerCase(), s.unit].filter(Boolean).join(' · '),
          unit: s.unit || '',
          valueType: vt,
          resourceId: rid,
          quality: String(s.quality || ''),
          freshness: s.freshness || null,
        };
      }),
    [signals, resById],
  );

  const modelGroups: ModelGroup[] = useMemo(() => {
    if (!models) return [];
    return models.map((g) => {
      const dm = dataModels.find((m) => m.id === g.id);
      const machineId = g.resource?.id || dm?.machineIds?.find((id) => resById.has(id)) || null;
      return {
        id: g.id,
        name: g.display_name || g.name,
        machineId,
        fields: (g.fields || []).map((f: SourceRef) => ({
          token: f.id,
          kind: 'model_field' as const,
          label: `${g.display_name || g.name} · ${f.field_path || f.key || f.name}`,
          name: String(f.field_path || f.key || f.name || f.id),
          sub: [String(f.value_type || f.data_type || '').toLowerCase(), f.unit, f.bound_to ? 'recorded' : ''].filter(Boolean).join(' · '),
          unit: f.unit || '',
          valueType: String(f.value_type || f.data_type || ''),
          resourceId: machineId,
          quality: f.quality || null,
          freshness: f.freshness || null,
          group: g.display_name || g.name,
          recorded: Boolean(f.bound_to),
        })),
      };
    });
  }, [models, dataModels, resById]);

  const tableItems: PickItem[] = useMemo(
    () =>
      (tables || []).map((t) => {
        const ref = (t.tag_values || []).find((tv) => /machine/.test(tv.name) && tv.value && resById.has(String(tv.value)));
        return {
          token: `subtable:${t.database_name}.${t.physical_name}`,
          kind: 'subtable' as const,
          label: t.display_name || t.physical_name,
          name: t.display_name || t.physical_name,
          sub: [t.stable_name, t.recording_mode ? t.recording_mode.toLowerCase().replace(/_/g, ' ') : ''].filter(Boolean).join(' · '),
          unit: '',
          valueType: '',
          resourceId: ref ? String(ref.value) : null,
          quality: t.status === 'ACTIVE' ? 'GOOD' : t.status,
          freshness: null,
          recorded: true,
        };
      }),
    [tables, resById],
  );

  const allItems = useMemo(() => [...signalItems, ...modelGroups.flatMap((g) => g.fields), ...tableItems], [signalItems, modelGroups, tableItems]);
  useEffect(() => {
    onCatalog?.(allItems);
  }, [allItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const byResource = useMemo(() => {
    const m = new Map<string, { signals: PickItem[]; models: ModelGroup[]; tables: PickItem[] }>();
    const get = (id: string) => {
      let v = m.get(id);
      if (!v) m.set(id, (v = { signals: [], models: [], tables: [] }));
      return v;
    };
    signalItems.forEach((s) => s.resourceId && get(s.resourceId).signals.push(s));
    modelGroups.forEach((g) => g.machineId && get(g.machineId).models.push(g));
    tableItems.forEach((t) => t.resourceId && get(t.resourceId).tables.push(t));
    m.forEach((v) => v.signals.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
    return m;
  }, [signalItems, modelGroups, tableItems]);

  const tree = useMemo(
    () =>
      buildResourceTree(
        resources.map((r) => ({ id: r.id, parentId: r.parentId || r.parent_id || null, name: r.name, code: r.code, type: String(r.type || '') })),
      ),
    [resources],
  );

  const countUnder = useMemo(() => {
    const memo = new Map<string, number>();
    const walk = (n: ResourceTreeNode): number => {
      const own = byResource.get(n.resource.id);
      const c =
        (kind === 'all' || kind === 'signal' ? own?.signals.length || 0 : 0) +
        (kind === 'all' || kind === 'model_field' ? own?.models.reduce((a, g) => a + g.fields.length, 0) || 0 : 0) +
        (kind === 'all' || kind === 'subtable' ? own?.tables.length || 0 : 0) +
        n.children.reduce((a, ch) => a + walk(ch), 0);
      memo.set(n.resource.id, c);
      return c;
    };
    tree.forEach(walk);
    return memo;
  }, [tree, byResource, kind]);

  // Default expansion: every node above a node that owns sources, plus the machines of the selection.
  useEffect(() => {
    if (expanded || !tree.length || !signals.length) return;
    const open = new Set<string>();
    const selRes = new Set(allItems.filter((i) => selected.includes(i.token)).map((i) => i.resourceId).filter(Boolean) as string[]);
    const walk = (n: ResourceTreeNode, path: string[]) => {
      if (byResource.has(n.resource.id)) path.forEach((p) => open.add(p));
      if (selRes.has(n.resource.id)) {
        open.add(n.resource.id);
        path.forEach((p) => open.add(p));
      }
      n.children.forEach((c) => walk(c, [...path, n.resource.id]));
    };
    tree.forEach((n) => walk(n, []));
    setExpanded(open);
  }, [tree, signals.length, byResource, allItems, selected, expanded]);

  const toggleNode = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev || []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const kindOk = (k: SeriesKind) => kind === 'all' || kind === k;

  const leaf = (it: PickItem, depth: number) => {
    const on = selected.includes(it.token);
    const color = on ? colorOf(it.token) : undefined;
    const dot = qualityDot(it.quality, it.freshness);
    const full = selected.length >= MAX_SERIES && !on;
    return (
      <button
        key={it.token}
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={`${it.label}${it.sub ? ` (${it.sub})` : ''}`}
        title={full ? `At most ${MAX_SERIES} series. Remove one first.` : `${it.label}${it.sub ? ` · ${it.sub}` : ''} · ${dot.title}`}
        onClick={() => onToggle(it)}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={`w-full flex items-center gap-2 pr-2 py-1 rounded-md text-left text-[12px] transition-colors ${
          on ? 'bg-[#F1F5FA] text-[#111B37] font-semibold' : 'text-[#334568] hover:bg-[#F8FAFC]'
        } ${full ? 'opacity-60' : ''}`}
      >
        <span
          className={`w-3.5 h-3.5 rounded-[4px] border shrink-0 flex items-center justify-center ${on ? 'border-transparent' : 'border-[#CBD5E1] bg-white'}`}
          style={on ? { background: color } : undefined}
          aria-hidden="true"
        >
          {on && <svg viewBox="0 0 12 12" className="w-2.5 h-2.5"><path d="M2.5 6.2l2.3 2.3 4.7-4.9" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{it.name}</span>
          {it.sub && <span className="block truncate text-[10px] font-normal text-[#94A3B8] font-mono">{it.sub}</span>}
        </span>
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot.cls}`} aria-hidden="true" />
      </button>
    );
  };

  const subHeader = (id: string, icon: React.ReactNode, label: string, count: number, depth: number) => (
    <button
      type="button"
      aria-expanded={openGroups.has(id)}
      onClick={() => toggleGroup(id)}
      style={{ paddingLeft: 8 + depth * 14 }}
      className="w-full flex items-center gap-1.5 pr-2 py-1 rounded-md text-left text-[11px] font-semibold text-[#657794] hover:bg-[#F8FAFC]"
    >
      {openGroups.has(id) ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
      {icon}
      <span className="truncate flex-1">{label}</span>
      <span className="text-[10px] font-semibold text-[#94A3B8]">{count}</span>
    </button>
  );

  const renderOwn = (rid: string, depth: number) => {
    const own = byResource.get(rid);
    if (!own) return null;
    return (
      <>
        {kindOk('signal') && own.signals.map((s) => leaf(s, depth))}
        {kindOk('model_field') &&
          own.models.map((g) => (
            <div key={g.id}>
              {subHeader(`m:${g.id}`, <Layers className="w-3 h-3 shrink-0 text-[#8858EA]" />, g.name, g.fields.length, depth)}
              {openGroups.has(`m:${g.id}`) && g.fields.map((f) => leaf(f, depth + 1))}
            </div>
          ))}
        {kindOk('subtable') && own.tables.length > 0 && (
          <div>
            {subHeader(`t:${rid}`, <Table2 className="w-3 h-3 shrink-0 text-[#2A82E7]" />, 'Recorded tables', own.tables.length, depth)}
            {openGroups.has(`t:${rid}`) && own.tables.map((t) => leaf(t, depth + 1))}
          </div>
        )}
      </>
    );
  };

  const renderNode = (n: ResourceTreeNode, depth: number): React.ReactNode => {
    const count = countUnder.get(n.resource.id) || 0;
    if (!count) return null;
    const open = expanded?.has(n.resource.id);
    const selectedHere = allItems.filter((i) => i.resourceId === n.resource.id && selected.includes(i.token)).length;
    return (
      <div key={n.resource.id}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggleNode(n.resource.id)}
          style={{ paddingLeft: 4 + depth * 14 }}
          className="w-full flex items-center gap-1.5 pr-2 py-1.5 rounded-md text-left hover:bg-[#F8FAFC]"
          title={`${n.resource.name} (${n.resource.code})`}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 text-[#657794] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[#657794] shrink-0" />}
          {resourceTypeGlyph(n.resource.type)}
          <span className="text-[12px] font-semibold text-[#111B37] truncate flex-1">{n.resource.name}</span>
          {selectedHere > 0 && <span className="text-[10px] font-bold text-[#2A82E7]">{selectedHere}✓</span>}
          <span className="text-[10px] font-semibold text-[#657794] bg-[#F1F5FA] px-1.5 rounded">{count}</span>
        </button>
        {open && (
          <div>
            {renderOwn(n.resource.id, depth + 1)}
            {n.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const orphanModels = modelGroups.filter((g) => !g.machineId);
  const orphanTables = tableItems.filter((t) => !t.resourceId);

  // ---------------------------------------------------------------- search results (flat, grouped by machine)
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const words = q.split(/\s+/).filter(Boolean);
    const hits = allItems.filter((it) => kindOk(it.kind) && words.every((w) => `${it.label} ${it.sub} ${it.group || ''}`.toLowerCase().includes(w)));
    const groups = new Map<string, PickItem[]>();
    for (const h of hits) {
      const res = h.resourceId ? resById.get(h.resourceId) : undefined;
      const g = res ? res.name : h.kind === 'subtable' ? 'Recorded tables' : 'Data models';
      groups.set(g, [...(groups.get(g) || []), h]);
    }
    return { total: hits.length, groups: Array.from(groups.entries()) };
  }, [q, allItems, kind, resById]); // eslint-disable-line react-hooks/exhaustive-deps

  let shown = 0;
  const LIMIT = 300;

  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      <div className="p-3 space-y-2 border-b border-[#E3EAF3]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-bold text-[#111B37]">Series</h2>
          <div className="flex items-center gap-2 text-[11px] text-[#657794]">
            <span aria-live="polite">
              {selected.length}/{MAX_SERIES} selected
            </span>
            {selected.length > 0 && (
              <button type="button" onClick={onClear} className="font-semibold text-[#334568] hover:text-[#111B37] underline-offset-2 hover:underline">
                Clear
              </button>
            )}
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} title="Reload model fields and recorded tables" aria-label="Reload source list" className="p-1 rounded hover:bg-slate-100">
              <RefreshCw className={`w-3 h-3 ${models === null && !modelsError ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="Search machine, signal or field" ariaLabel="Search series" />
        <Segmented<KindFilter>
          ariaLabel="Source type"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: 'All' },
            { id: 'signal', label: 'Signals' },
            { id: 'model_field', label: 'Model fields' },
            { id: 'subtable', label: 'Recorded' },
          ]}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5" role="group" aria-label="Factory Model sources">
        {loadState !== 'ready' && !signals.length ? (
          <div className="py-10 text-center text-[12px] text-[#657794]">
            <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-[#94A3B8]" />
            Loading the Factory Model…
          </div>
        ) : results ? (
          results.total === 0 ? (
            <p className="py-8 text-center text-[12px] text-[#657794]">Nothing matches “{query}”.</p>
          ) : (
            <>
              {results.groups.map(([g, items]) => {
                if (shown >= LIMIT) return null;
                const take = items.slice(0, LIMIT - shown);
                shown += take.length;
                return (
                  <div key={g} className="mb-1">
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">{g}</div>
                    {take.map((it) => leaf(it, 0))}
                  </div>
                );
              })}
              {results.total > LIMIT && <p className="px-2 py-2 text-[11px] text-[#657794]">{results.total - LIMIT} more — refine the search.</p>}
            </>
          )
        ) : (
          <>
            {tree.map((n) => renderNode(n, 0))}
            {kindOk('model_field') && orphanModels.length > 0 && (
              <div className="mt-1">
                {subHeader('orphans-m', <Layers className="w-3 h-3 shrink-0 text-[#8858EA]" />, 'Data models (no machine)', orphanModels.reduce((a, g) => a + g.fields.length, 0), 0)}
                {openGroups.has('orphans-m') &&
                  orphanModels.map((g) => (
                    <div key={g.id}>
                      {subHeader(`m:${g.id}`, <Layers className="w-3 h-3 shrink-0 text-[#8858EA]" />, g.name, g.fields.length, 1)}
                      {openGroups.has(`m:${g.id}`) && g.fields.map((f) => leaf(f, 2))}
                    </div>
                  ))}
              </div>
            )}
            {kindOk('subtable') && orphanTables.length > 0 && (
              <div className="mt-1">
                {subHeader('orphans-t', <Database className="w-3 h-3 shrink-0 text-[#2A82E7]" />, 'Recorded tables', orphanTables.length, 0)}
                {openGroups.has('orphans-t') && orphanTables.map((t) => leaf(t, 1))}
              </div>
            )}
            {kind === 'subtable' && tables && tableItems.length === 0 && (
              <p className="px-3 py-6 text-center text-[12px] text-[#657794] leading-relaxed">
                No recorded tables yet. Create supertables and subtables in Storage Management to record Data Model fields; they appear here.
              </p>
            )}
            {kind === 'model_field' && modelsError && <p className="px-3 py-4 text-[12px] text-red-700">{modelsError}</p>}
            {kind === 'model_field' && models === null && !modelsError && <p className="px-3 py-4 text-[12px] text-[#657794]">Loading Data Model fields…</p>}
          </>
        )}
      </div>
    </div>
  );
};
