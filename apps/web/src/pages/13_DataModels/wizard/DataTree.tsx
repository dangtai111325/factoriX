// Left pane of the body builder: the hierarchy tree (same tree as the Add Data target step) with the
// signals of every resource, live values and search. Click / Enter on a signal adds a mapping field;
// "Map all" on a resource auto-maps everything below it; signals can be dragged onto body rows.
import React, { useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, RefreshCw, Search, Wand2 } from 'lucide-react';
import { buildResourceTree, resourceTreeMatches, resourceTypeGlyph, ResourceTreeNode } from '../../../components/tree/resourceTree';
import { formatValue, normalizeQuality } from '../../../lib/format';
import { useLiveValues } from '../hooks';
import { CatalogIndex, signalTooltip, signalsUnder } from '../rules';
import type { CatalogResource, CatalogSignal } from '../types';
import { Skeleton } from '../ui';

export const SIGNAL_DRAG_TYPE = 'application/x-factorix-signal';

interface Props {
  index: CatalogIndex;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  /** Where a click will add the field ("body root", "object electrical", "row status"). */
  targetLabel: string;
  onPickSignal: (signal: CatalogSignal) => void;
  onMapAll: (resource: CatalogResource) => void;
  /** Signals already used in the body (shown with a dot). */
  usedSignalIds: Set<string>;
}

const qualityDot = (q: string | null) => {
  const code = normalizeQuality(q);
  return code === 'GOOD' ? 'bg-[#0DBA67]' : code === 'UNCERTAIN' || code === 'STALE' ? 'bg-amber-400' : code === 'NO_DATA' || code === 'PAUSED' ? 'bg-slate-300' : 'bg-red-500';
};

export const DataTree: React.FC<Props> = ({ index, loading, error, onReload, targetLabel, onPickSignal, onMapAll, usedSignalIds }) => {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const forest = useMemo(() => buildResourceTree(index.catalog.resources), [index]);
  const totals = useMemo(() => new Map(index.catalog.resources.map((r) => [r.id, signalsUnder(index, r.id).length])), [index]);
  const q = query.trim().toLowerCase();

  const signalMatches = (s: CatalogSignal) => !q || s.key.toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
  const subtreeHasSignalMatch = (node: ResourceTreeNode<CatalogResource>): boolean =>
    (index.signalsOf.get(node.resource.id) || []).some(signalMatches) || node.children.some(subtreeHasSignalMatch);
  const visibleNode = (node: ResourceTreeNode<CatalogResource>) => !q || resourceTreeMatches(node, q) || subtreeHasSignalMatch(node);

  /** Leaf resources with signals start collapsed (except the first) so big plants stay readable. */
  const defaultCollapsed = useMemo(() => {
    const out: Record<string, boolean> = {};
    let first = true;
    index.catalog.resources.forEach((r) => {
      const hasChildren = (index.childrenOf.get(r.id) || []).length > 0;
      const hasSignals = (index.signalsOf.get(r.id) || []).length > 0;
      if (hasSignals && !hasChildren) {
        out[r.id] = !first;
        first = false;
      }
    });
    return out;
  }, [index]);
  const isCollapsed = (id: string) => (q ? false : collapsed[id] ?? defaultCollapsed[id] ?? false);

  // Live values only for the signal rows that are currently shown.
  const shownSignalIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (node: ResourceTreeNode<CatalogResource>) => {
      if (!visibleNode(node) || isCollapsed(node.resource.id)) return;
      (index.signalsOf.get(node.resource.id) || []).filter(signalMatches).forEach((s) => ids.push(s.id));
      node.children.forEach(walk);
    };
    forest.forEach(walk);
    return ids.slice(0, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forest, q, collapsed, defaultCollapsed, index]);
  const live = useLiveValues(shownSignalIds);

  const toggle = (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !isCollapsed(id) }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') || []);
    const current = document.activeElement as HTMLElement | null;
    const i = current ? items.indexOf(current) : -1;
    const focusAt = (n: number) => {
      const el = items[Math.max(0, Math.min(items.length - 1, n))];
      if (el) {
        el.focus();
        setFocusId(el.dataset.id || null);
      }
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && current?.dataset.kind === 'resource') {
      e.preventDefault();
      const id = current.dataset.id!;
      const open = !isCollapsed(id);
      if (e.key === 'ArrowRight' && !open) toggle(id);
      else if (e.key === 'ArrowLeft' && open) toggle(id);
      else if (e.key === 'ArrowRight') focusAt(i + 1);
    }
  };

  const renderSignal = (s: CatalogSignal, depth: number) => {
    const lv = live.get(s.id);
    const value = lv ? lv.value : s.value;
    const quality = lv ? lv.quality : s.quality;
    const used = usedSignalIds.has(s.id);
    return (
      <div
        key={s.id}
        role="treeitem"
        aria-level={depth + 1}
        aria-label={`Signal ${s.key}${s.name && s.name !== s.key ? ` (${s.name})` : ''}, value ${formatValue(value)}. Press Enter to add.`}
        data-id={s.id}
        data-kind="signal"
        tabIndex={focusId === s.id ? 0 : -1}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SIGNAL_DRAG_TYPE, s.id);
          e.dataTransfer.setData('text/plain', s.key);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onFocus={() => setFocusId(s.id)}
        onClick={() => onPickSignal(s)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPickSignal(s);
          }
        }}
        title={`${signalTooltip(index, s.id)}${used ? '\nAlready used in the body' : ''}\nClick to add · drag onto the body`}
        style={{ paddingLeft: depth * 12 + 8 }}
        className="group py-1 pr-2 flex items-center gap-1.5 cursor-pointer rounded-md hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-[12px]"
      >
        <GripVertical className="w-3 h-3 text-slate-300 group-hover:text-slate-400 shrink-0" aria-hidden="true" />
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${qualityDot(quality)}`} aria-hidden="true" />
        <span className={`flex-1 min-w-0 font-mono truncate ${used ? 'text-blue-800 font-semibold' : 'text-[#111B37]'}`}>{s.key}</span>
        {used && <span className="sr-only">(used in the body)</span>}
        <span className="font-mono text-[11px] text-[#657794] truncate max-w-[40%] shrink-0" title={formatValue(value)}>
          {formatValue(value)}
        </span>
      </div>
    );
  };

  const renderNode = (node: ResourceTreeNode<CatalogResource>, depth: number): React.ReactNode => {
    if (!visibleNode(node)) return null;
    const r = node.resource;
    const sigs = (index.signalsOf.get(r.id) || []).filter(signalMatches);
    const hasContent = node.children.length > 0 || sigs.length > 0;
    const open = !isCollapsed(r.id);
    const total = totals.get(r.id) || 0;
    return (
      <React.Fragment key={r.id}>
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasContent ? open : undefined}
          aria-label={`${r.name || r.code} (${index.catalog.typeNames[r.type] || r.type}), ${total} signal(s)`}
          data-id={r.id}
          data-kind="resource"
          tabIndex={focusId === r.id || (focusId === null && depth === 0 && node === forest[0]) ? 0 : -1}
          onFocus={() => setFocusId(r.id)}
          onClick={() => hasContent && toggle(r.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (hasContent) toggle(r.id);
            }
          }}
          style={{ paddingLeft: depth * 12 + 4 }}
          className="group py-1.5 pr-2 flex items-center gap-1.5 cursor-pointer rounded-lg hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {hasContent ? (
            open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          ) : (
            <span className="w-3.5" />
          )}
          {resourceTypeGlyph(r.type)}
          <span className="flex-1 min-w-0 text-[12px] font-semibold text-[#111B37] truncate" title={`${r.name || r.code} (${index.catalog.typeNames[r.type] || r.type})`}>
            {r.name || r.code}
          </span>
          <span className="hidden 2xl:inline text-[9px] uppercase font-bold px-1 py-0.5 bg-slate-100 text-slate-600 rounded shrink-0">{index.catalog.typeNames[r.type] || r.type}</span>
          {total > 0 && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onMapAll(r);
              }}
              title={`Map all ${total} signal(s) under ${r.name || r.code}`}
              aria-label={`Map all signals under ${r.name || r.code}`}
              className="inline-flex items-center justify-center w-6 h-6 rounded-md text-[#134074] border border-transparent hover:border-[#C9D9EE] hover:bg-[#EEF5FF] opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100 shrink-0"
            >
              <Wand2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {hasContent && open && (
          <div role="group">
            {sigs.map((s) => renderSignal(s, depth + 1))}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-[13px] font-bold text-[#111B37]">Data</h3>
        <button type="button" onClick={onReload} className="p-1 rounded text-slate-500 hover:bg-slate-100" aria-label="Reload the data tree" title="Reload">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="relative mb-2">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search resources or signals…"
          aria-label="Search the data tree"
          className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500"
        />
      </div>
      <p className="text-[11px] text-[#657794] mb-2">
        Click a signal to add it to <span className="font-semibold text-[#334568]">{targetLabel}</span>, or drag it onto a row. <Wand2 className="inline w-3 h-3 text-[#134074]" aria-hidden="true" /> maps everything under a resource.
      </p>
      {error && <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 mb-2">{error}</p>}
      <div
        ref={treeRef}
        role="tree"
        aria-label="Data tree"
        onKeyDown={onKeyDown}
        className="flex-1 min-h-[200px] overflow-y-auto border border-slate-200 rounded-xl p-1.5 bg-[#F8FAFC]"
      >
        {loading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className={`h-4 ${i % 3 === 0 ? 'w-2/3' : 'w-5/6 ml-4'}`} />
            ))}
          </div>
        ) : forest.length === 0 ? (
          <div className="text-center py-8 px-3 text-[12px] text-slate-500">No resources with signals yet. Add data in the Data Collector first.</div>
        ) : (
          forest.map((root) => renderNode(root, 0))
        )}
      </div>
    </div>
  );
};
