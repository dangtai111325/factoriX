import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Box, Activity, Database, ArrowRight, Layers } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import { formatValue, normalizeQuality, QUALITY_LABEL } from '../../lib/format';
import type { ResourceNode } from '../../types';
import { ModalPortal } from '../modals/ModalPortal';

/** Results shown per section; the count of the rest is shown under it. */
const SECTION_LIMIT = 8;

interface ResultItem {
  id: string;
  title: string;
  sub: string;
  path: string;
}

interface Section {
  key: 'resources' | 'signals' | 'connections' | 'models';
  label: string;
  icon: React.ReactNode;
  items: ResultItem[];
  total: number;
}

/** Every whitespace-separated term must appear (case-insensitive) somewhere in the haystack. */
function matches(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

/** Machine (the signal's resource) and the line above it, for telling identical signal keys apart (R3-SR-01). */
function resourceContext(byId: Map<string, ResourceNode>, resourceId: string): { machine: string; line: string } {
  const own = byId.get(resourceId);
  let line = '';
  let cursor = own?.parentId ? byId.get(own.parentId) : undefined;
  const parentName = cursor?.name || '';
  for (let guard = 0; cursor && guard < 12; guard += 1) {
    if (String(cursor.type).toLowerCase() === 'line') {
      line = cursor.name;
      break;
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return { machine: own?.name || '', line: line || parentName };
}

export const SearchModal: React.FC = () => {
  const { searchOpen, setSearchOpen, searchQuery, setSearchQuery, resources, signals, connections, dataModels, loadState } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const byId = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);
  const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hasQuery = terms.length > 0;

  const sections = useMemo<Section[]>(() => {
    const resourceItems = resources
      .filter((r) => !hasQuery || matches(`${r.name} ${r.code} ${r.type}`.toLowerCase(), terms))
      .map((r) => ({ id: r.id, title: r.name, sub: `${r.code} · ${r.type}`, path: `/factory/structure?resourceId=${r.id}` }));

    // Signals: show machine and line so identical keys on different machines can be told apart.
    const signalItems = signals
      .map((s) => ({ s, ctx: resourceContext(byId, s.resourceId) }))
      .filter(
        ({ s, ctx }) =>
          !hasQuery ||
          matches(`${s.name} ${s.tag} ${s.displayName || ''} ${ctx.machine || s.resourcePath} ${ctx.line}`.toLowerCase(), terms),
      )
      .map(({ s, ctx }) => {
        const quality = normalizeQuality(s.quality);
        const value = quality === 'GOOD' || quality === 'UNCERTAIN' ? formatValue(s.value ?? null) : QUALITY_LABEL[quality];
        const where = [ctx.machine || s.resourcePath, ctx.line].filter(Boolean).join(' · ');
        return {
          id: s.id,
          title: s.displayName && s.displayName !== s.name ? `${s.name} (${s.displayName})` : s.name,
          sub: [where, value].filter(Boolean).join(' · '),
          path: `/collector/signals?signalId=${s.id}`,
        };
      });

    const connectionItems = connections
      .filter((c) => !hasQuery || matches(`${c.name} ${c.endpoint} ${PROTOCOL_LABEL[c.protocol]}`.toLowerCase(), terms))
      .map((c) => ({ id: c.id, title: c.name, sub: `${c.endpoint} · ${PROTOCOL_LABEL[c.protocol]}`, path: `/collector/connections?connectionId=${c.id}` }));

    // Data models: name, machines and state (Running / Paused).
    const modelItems = dataModels
      .filter((m) => !hasQuery || matches(`${m.name} ${m.description} ${m.machines.join(' ')} ${m.state}`.toLowerCase(), terms))
      .map((m) => ({
        id: m.id,
        title: m.name,
        sub: [m.machines.slice(0, 3).join(', ') + (m.machines.length > 3 ? ` +${m.machines.length - 3}` : ''), m.state === 'RUNNING' ? 'Running' : 'Paused']
          .filter(Boolean)
          .join(' · '),
        path: `/models?model=${encodeURIComponent(m.id)}`,
      }));

    const limit = (items: ResultItem[], idle: number) => items.slice(0, hasQuery ? SECTION_LIMIT : idle);
    const all: Section[] = [
      { key: 'resources', label: 'Factory Resources', icon: <Box className="w-3.5 h-3.5 text-[#2A82E7]" />, items: limit(resourceItems, 3), total: resourceItems.length },
      { key: 'signals', label: 'Signals', icon: <Activity className="w-3.5 h-3.5 text-[#0DBA67]" />, items: limit(signalItems, 3), total: signalItems.length },
      { key: 'connections', label: 'Connections', icon: <Database className="w-3.5 h-3.5 text-[#8858EA]" />, items: limit(connectionItems, 2), total: connectionItems.length },
      { key: 'models', label: 'Data Models', icon: <Layers className="w-3.5 h-3.5 text-[#7C3AED]" />, items: limit(modelItems, 2), total: modelItems.length },
    ];
    return all.filter((section) => section.items.length > 0);
    // `terms` is derived from searchQuery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, resources, signals, connections, dataModels, byId]);

  const allResults = sections.flatMap((section) => section.items);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  const handleSelect = (path: string) => {
    navigate(path);
    setSearchOpen(false);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
      if (searchOpen && allResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % allResults.length);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + allResults.length) % allResults.length);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (allResults[selectedIndex]) {
            handleSelect(allResults[selectedIndex].path);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setSearchQuery('');
    }
  }, [searchOpen, setSearchQuery]);

  if (!searchOpen) return null;

  let currentIndexTracker = 0;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center px-2 pt-4 sm:pt-24 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSearchOpen(false);
        }}
      >
        <div className="w-full max-w-[620px] bg-white rounded-xl shadow-2xl border border-[#D4DFEC] overflow-hidden">
          {/* Input bar */}
          <div className="flex items-center px-4 py-3.5 border-b border-[#E3EAF3] gap-3">
            <Search className="w-5 h-5 text-[#657794] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search resources, signals, connections, data models…"
              aria-label="Search resources, signals, connections and data models"
              className="flex-1 min-w-0 text-[15px] text-[#111B37] placeholder-[#94A3B8] outline-none"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} className="p-1 text-[#94A3B8] hover:text-[#111B37]" aria-label="Clear search">
                <X className="w-4 h-4" />
              </button>
            )}
            <kbd className="hidden sm:inline px-2 py-0.5 text-[11px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794]">
              ESC to close
            </kbd>
          </div>

          {/* Results Body */}
          <div className="max-h-[min(380px,calc(100vh-8rem))] overflow-y-auto p-3 space-y-4">
            {hasQuery && allResults.length === 0 && (
              <div className="py-8 text-center text-[14px] text-[#657794]">
                {loadState === 'loading' ? 'Loading search index…' : `No results for "${searchQuery}"`}
              </div>
            )}

            {sections.map((section) => (
              <div key={section.key}>
                <div className="text-[11px] font-bold uppercase text-[#94A3B8] px-2 mb-1.5 flex items-center gap-1.5">
                  {section.icon}
                  <span>{section.label}</span>
                  {hasQuery && section.total > section.items.length && (
                    <span className="ml-auto normal-case font-medium text-[#94A3B8]">
                      {section.items.length} of {section.total} — refine the search
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {section.items.map((item) => {
                    const itemIndex = currentIndexTracker++;
                    const isSelected = itemIndex === selectedIndex;
                    return (
                      <button
                        key={`${section.key}-${item.id}`}
                        type="button"
                        onClick={() => handleSelect(item.path)}
                        onMouseEnter={() => setSelectedIndex(itemIndex)}
                        className={`w-full flex items-center justify-between gap-2 p-2 rounded-lg text-left transition-colors group ${
                          isSelected ? 'bg-[#EEF5FF] text-[#0B2545]' : 'hover:bg-[#FFF0F1]/60'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className={`text-[13px] font-semibold truncate ${isSelected ? 'text-[#0B2545]' : 'text-[#111B37] group-hover:text-[#EF1B24]'}`}>
                            {item.title}
                          </div>
                          <div className="text-[11px] text-[#657794] font-mono truncate">{item.sub}</div>
                        </div>
                        <ArrowRight className={`w-4 h-4 shrink-0 ${isSelected ? 'text-[#0B2545]' : 'text-[#94A3B8] group-hover:text-[#EF1B24]'}`} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
