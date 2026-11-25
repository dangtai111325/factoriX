/**
 * Source picker of the Studio and the template role mapping: Data Collector signals and Data Model
 * fields from `GET /dashboards/sources`, organised by the Factory Model tree (same layout as the
 * Historian SeriesPicker), with search, value-kind filter, live value + quality/freshness preview and the
 * backend capability badge ("Recorded history", "Recent snapshots only", "No history").
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Database, Layers, RefreshCw } from 'lucide-react';
import { buildResourceTree, resourceTypeGlyph, type ResourceTreeNode } from '../../../components/tree/resourceTree';
import { subscribeSignals, type LatestMsg } from '../../../lib/liveStream';
import { qualityDot } from '../../../pages/historian/SeriesPicker';
import { SearchInput, Segmented } from '../../../pages/historian/hsUi';
import { getModelLatest } from '../api';
import { formatAge, formatValue } from '../format';
import { capabilityBadge, kindAccepted, preferredKind, useSourceCatalog, valueKindOf, type ValueKindFilter } from '../sources';
import { extractField } from '../runtime/modelPath';
import type { SourceItem, SourceResource } from '../types';

type Tab = 'signal' | 'model_field';

const BADGE_CLS: Record<string, string> = {
  good: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  info: 'bg-blue-50 text-blue-800 border-blue-200',
  warning: 'bg-amber-50 text-amber-900 border-amber-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
};

/**
 * Value kind of a catalog item; an `auto` Data Model field (kind unknown) takes the kind of its live value,
 * so the Numeric / Text filters do not hide every such field (a server older than this rule says unknown).
 */
function itemKind(i: SourceItem): ReturnType<typeof valueKindOf> {
  const k = valueKindOf(i.value_type, i.value_kind);
  if (k !== 'unknown' || !i.has_last_value) return k;
  const v = i.last_value;
  return typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'string' ? 'string' : k;
}
const itemKind_ = itemKind;

export const CapabilityChip: React.FC<{ item: Pick<SourceItem, 'capabilities'> | null; className?: string }> = ({ item, className = '' }) => {
  const b = capabilityBadge(item?.capabilities);
  return (
    <span title={b.title} className={`inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] font-semibold whitespace-nowrap ${BADGE_CLS[b.tone]} ${className}`}>
      {b.label}
    </span>
  );
};

export interface SourcePickerProps {
  /** Value kinds the target accepts (registry `value_kinds`); other items are shown but disabled. */
  acceptKinds?: string[];
  selectedToken: string | null;
  onSelect: (item: SourceItem | null) => void;
  /** Double-click / Enter on an item. */
  onPick?: (item: SourceItem) => void;
  /** Actions shown in the preview of the selected item. */
  actions?: (item: SourceItem) => React.ReactNode;
  /** Tokens already used (marked in the list). */
  usedTokens?: Set<string>;
  className?: string;
  compact?: boolean;
}

export const SourcePicker: React.FC<SourcePickerProps> = ({ acceptKinds = [], selectedToken, onSelect, onPick, actions, usedTokens, className = '', compact }) => {
  const { catalog, loading, error, reload, byToken } = useSourceCatalog();
  const [tab, setTab] = useState<Tab>('signal');
  const [query, setQuery] = useState('');
  // The first accepted kind of the target is the preferred filter (contract §4).
  const acceptKey = acceptKinds.join(',');
  const [kind, setKind] = useState<ValueKindFilter>(() => preferredKind(acceptKinds));
  useEffect(() => {
    setKind(preferredKind(acceptKey ? acceptKey.split(',') : []));
  }, [acceptKey]);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [openModels, setOpenModels] = useState<Set<string>>(new Set());

  const resources = catalog?.resources || [];
  const tree = useMemo(
    () => buildResourceTree(resources.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, code: r.code, type: r.type_key, raw: r }))),
    [resources],
  );
  const items = useMemo(
    () =>
      (catalog?.items || []).filter(
        (i) => i.kind === tab && (kind === 'all' || itemKind(i) === kind),
      ),
    [catalog, tab, kind],
  );
  const byResource = useMemo(() => {
    const m = new Map<string, SourceItem[]>();
    for (const it of items) {
      const k = it.resource_id || '__none__';
      const arr = m.get(k);
      if (arr) arr.push(it);
      else m.set(k, [it]);
    }
    m.forEach((arr) => arr.sort((a, b) => (a.model_name || '').localeCompare(b.model_name || '') || a.label.localeCompare(b.label, undefined, { numeric: true })));
    return m;
  }, [items]);
  const counts = useMemo(() => {
    const memo = new Map<string, number>();
    const walk = (n: ResourceTreeNode): number => {
      const c = (byResource.get(n.resource.id)?.length || 0) + n.children.reduce((a, ch) => a + walk(ch), 0);
      memo.set(n.resource.id, c);
      return c;
    };
    tree.forEach(walk);
    return memo;
  }, [tree, byResource]);

  // Default expansion: every branch that leads to sources, plus the branch of the selection.
  useEffect(() => {
    if (expanded || !tree.length || !catalog) return;
    const open = new Set<string>();
    const sel = selectedToken ? byToken.get(selectedToken) : undefined;
    // Small catalogs open down to the owners of the sources; large ones only the first levels.
    const small = items.length <= 60;
    const walk = (n: ResourceTreeNode, path: string[]) => {
      if (byResource.has(n.resource.id) && (small || path.length < 3)) {
        path.forEach((p) => open.add(p));
        if (small) open.add(n.resource.id);
      }
      if (sel && sel.resource_id === n.resource.id) [...path, n.resource.id].forEach((p) => open.add(p));
      n.children.forEach((c) => walk(c, [...path, n.resource.id]));
    };
    tree.forEach((n) => walk(n, []));
    setExpanded(open);
  }, [tree, catalog, byResource, expanded, selectedToken, byToken, items.length]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev || []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selected = selectedToken ? byToken.get(selectedToken) || null : null;

  const leaf = (it: SourceItem, depth: number) => {
    const itemKind = itemKind_(it);
    const ok = kindAccepted(itemKind, acceptKinds);
    const on = it.token === selectedToken;
    const dot = qualityDot(it.quality, it.freshness);
    const used = usedTokens?.has(it.token);
    const name = it.kind === 'model_field' ? it.field_path || it.key : it.key || it.label;
    const sub = [String(it.value_type || '').toLowerCase(), it.unit].filter(Boolean).join(' · ');
    return (
      <button
        key={it.token}
        type="button"
        role="option"
        aria-selected={on}
        aria-disabled={!ok}
        title={ok ? `${it.label}${sub ? ` · ${sub}` : ''} · ${dot.title}` : `Not accepted by this widget (${itemKind} value).`}
        onClick={() => onSelect(on ? null : it)}
        onDoubleClick={() => ok && onPick?.(it)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ok && onPick) {
            e.preventDefault();
            onPick(it);
          }
        }}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={`w-full flex items-center gap-2 pr-2 py-1 rounded-md text-left text-[12px] transition-colors ${
          on ? 'bg-[#EEF5FF] text-[#0B2545] font-semibold ring-1 ring-[#BED7F7]' : 'text-[#334568] hover:bg-[#F8FAFC]'
        } ${ok ? '' : 'opacity-45'}`}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot.cls}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{name}</span>
          {sub && <span className="block truncate text-[10px] font-normal text-[#94A3B8] font-mono">{sub}</span>}
        </span>
        {used && <span className="text-[9px] font-bold uppercase text-[#2A82E7] shrink-0">in use</span>}
        {it.has_last_value && <span className="text-[10px] font-mono text-[#657794] shrink-0 max-w-[70px] truncate">{formatValue(it.last_value, { unit: null })}</span>}
      </button>
    );
  };

  const renderOwn = (rid: string, depth: number) => {
    const own = byResource.get(rid);
    if (!own) return null;
    if (tab === 'signal') return own.map((s) => leaf(s, depth));
    const groups = new Map<string, SourceItem[]>();
    own.forEach((f) => {
      const k = f.model_id || 'model';
      groups.set(k, [...(groups.get(k) || []), f]);
    });
    return Array.from(groups.entries()).map(([mid, fields]) => {
      const open = openModels.has(mid) || fields.some((f) => f.token === selectedToken);
      return (
        <div key={mid}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() =>
              setOpenModels((prev) => {
                const n = new Set(prev);
                if (n.has(mid)) n.delete(mid);
                else n.add(mid);
                return n;
              })
            }
            style={{ paddingLeft: 8 + depth * 14 }}
            className="w-full flex items-center gap-1.5 pr-2 py-1 rounded-md text-left text-[11px] font-semibold text-[#657794] hover:bg-[#F8FAFC]"
          >
            {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
            <Layers className="w-3 h-3 shrink-0 text-[#8858EA]" aria-hidden="true" />
            <span className="truncate flex-1">{fields[0].model_name || 'Data model'}</span>
            <span className="text-[10px] text-[#94A3B8]">{fields.length}</span>
          </button>
          {open && fields.map((f) => leaf(f, depth + 1))}
        </div>
      );
    });
  };

  const renderNode = (n: ResourceTreeNode, depth: number): React.ReactNode => {
    const count = counts.get(n.resource.id) || 0;
    if (!count) return null;
    const open = expanded?.has(n.resource.id);
    return (
      <div key={n.resource.id}>
        <button
          type="button"
          aria-expanded={!!open}
          onClick={() => toggle(n.resource.id)}
          style={{ paddingLeft: 4 + depth * 14 }}
          className="w-full flex items-center gap-1.5 pr-2 py-1.5 rounded-md text-left hover:bg-[#F8FAFC]"
          title={`${n.resource.name} (${n.resource.code})`}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 text-[#657794] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[#657794] shrink-0" />}
          {resourceTypeGlyph(n.resource.type)}
          <span className="text-[12px] font-semibold text-[#111B37] truncate flex-1">{n.resource.name}</span>
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

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const words = q.split(/\s+/).filter(Boolean);
    const resById = new Map(resources.map((r) => [r.id, r]));
    const hits = items.filter((it) => {
      const res = it.resource_id ? resById.get(it.resource_id) : undefined;
      const hay = `${it.label} ${it.key} ${it.field_path || ''} ${it.model_name || ''} ${res?.name || ''} ${res?.code || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const groups = new Map<string, SourceItem[]>();
    for (const h of hits) {
      const res = h.resource_id ? resById.get(h.resource_id) : undefined;
      const g = res ? res.name : h.kind === 'model_field' ? h.model_name || 'Data models' : 'No resource';
      groups.set(g, [...(groups.get(g) || []), h]);
    }
    return { total: hits.length, groups: Array.from(groups.entries()) };
  }, [q, items, resources]);

  const orphans = byResource.get('__none__') || [];
  const LIMIT = 300;
  let shown = 0;

  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      <div className="p-2.5 space-y-2 border-b border-[#E3EAF3]">
        <div className="flex items-center justify-between gap-2">
          <Segmented<Tab>
            ariaLabel="Source type"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { id: 'signal', label: 'Data Collector', icon: <Database className="w-3 h-3" /> },
              { id: 'model_field', label: 'Data Models', icon: <Layers className="w-3 h-3" /> },
            ]}
          />
          <button type="button" onClick={reload} className="p-1 rounded text-[#657794] hover:bg-slate-100" aria-label="Reload sources" title="Reload sources">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder={tab === 'signal' ? 'Search machine or signal' : 'Search model or field'} ariaLabel="Search sources" />
        <Segmented<ValueKindFilter>
          ariaLabel="Value type"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: 'All' },
            { id: 'number', label: 'Numeric' },
            { id: 'boolean', label: 'Boolean' },
            { id: 'string', label: 'Text' },
          ]}
        />
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto p-1.5 ${compact ? 'max-h-[320px]' : ''}`} role="listbox" aria-label="Sources">
        {error && !catalog ? (
          <div className="p-3 text-[12px] text-red-700">
            Could not load the sources. <button type="button" className="underline font-semibold" onClick={reload}>Retry</button>
          </div>
        ) : !catalog ? (
          <div className="py-10 text-center text-[12px] text-[#657794]">
            <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-[#94A3B8]" aria-hidden="true" />
            Loading sources…
          </div>
        ) : results ? (
          results.total === 0 ? (
            <p className="py-8 text-center text-[12px] text-[#657794]">Nothing matches “{query}”.</p>
          ) : (
            <>
              {results.groups.map(([g, list]) => {
                if (shown >= LIMIT) return null;
                const take = list.slice(0, LIMIT - shown);
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
        ) : items.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-[#657794] leading-relaxed">
            {tab === 'signal'
              ? kind === 'all'
                ? 'No signals yet. Add data in the Data Collector first.'
                : 'No signal of this value type.'
              : kind === 'all'
                ? 'No Data Model fields yet. Create a model in Data Models first.'
                : 'No model field of this value type.'}
          </p>
        ) : (
          <>
            {tree.map((n) => renderNode(n, 0))}
            {orphans.length > 0 && (
              <div className="mt-1">
                <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">Not assigned to a resource</div>
                {renderOwn('__none__', 0)}
              </div>
            )}
          </>
        )}
      </div>
      {selected && <SourcePreview item={selected} resources={resources} actions={actions} />}
    </div>
  );
};

/** Preview of the selected source: live value + quality/freshness (signals live, model fields from /latest) and capabilities. */
const SourcePreview: React.FC<{ item: SourceItem; resources: SourceResource[]; actions?: (item: SourceItem) => React.ReactNode }> = ({ item, resources, actions }) => {
  const [live, setLive] = useState<{ value: unknown; has: boolean; quality: string | null; freshness: string | null; at: number | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    setLive(null);
    let alive = true;
    if (item.kind === 'signal') {
      return subscribeSignals([item.token], (msg: LatestMsg) => {
        const at = Date.parse(String(msg.last_acquired_at || msg.received_time || msg.source_time || ''));
        setLive({ value: msg.value, has: msg.value !== null && msg.value !== undefined, quality: msg.quality ?? null, freshness: msg.freshness ?? null, at: Number.isFinite(at) ? at : null });
      });
    }
    if (item.model_id && item.field_path) {
      getModelLatest(item.model_id)
        .then((res) => {
          if (!alive) return;
          let body: unknown = null;
          try {
            body = res.body ? JSON.parse(res.body) : null;
          } catch {
            body = null;
          }
          const f = extractField(body, item.field_path!);
          const fq = res.fields?.find((x) => x.path === item.field_path)?.quality ?? null;
          const at = res.sampled_at ? Date.parse(res.sampled_at) : NaN;
          setLive({ value: f.value, has: f.found, quality: fq ? fq.toUpperCase() : null, freshness: null, at: Number.isFinite(at) ? at : null });
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [item.token, item.kind, item.model_id, item.field_path]);

  const res = item.resource_id ? resources.find((r) => r.id === item.resource_id) : undefined;
  const value = live ? live.value : item.last_value;
  const has = live ? live.has : item.has_last_value;
  const at = live?.at ?? (item.last_at ? Date.parse(item.last_at) : null);
  const dot = qualityDot(live?.quality ?? item.quality, live?.freshness ?? item.freshness);
  const caps = item.capabilities;
  return (
    <div className="border-t border-[#E3EAF3] p-2.5 bg-[#F9FAFD] space-y-1.5" aria-live="polite">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold text-[#111B37] truncate" title={item.label}>
            {item.kind === 'model_field' ? item.field_path : item.key || item.label}
          </div>
          <div className="text-[10px] text-[#657794] truncate">
            {item.kind === 'model_field' ? `${item.model_name || 'Data model'}${res ? ` · ${res.name}` : ''}` : res ? res.name : 'Signal'}
          </div>
        </div>
        <CapabilityChip item={item} />
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot.cls}`} aria-hidden="true" />
        <span className="font-mono tabular-nums font-semibold text-[#111B37] truncate">{has ? formatValue(value, { unit: item.unit }) : 'No value yet'}</span>
        <span className="text-[10px] text-[#94A3B8] ml-auto whitespace-nowrap">
          {dot.title}
          {at ? ` · ${formatAge(at, now)}` : ''}
        </span>
      </div>
      {caps && caps.notes.length > 0 && <p className="text-[10px] text-[#657794] leading-snug">{caps.notes.join(' ')}</p>}
      {actions && <div className="flex flex-wrap gap-1.5 pt-0.5">{actions(item)}</div>}
    </div>
  );
};
