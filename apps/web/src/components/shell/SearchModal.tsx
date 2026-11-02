import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Box, Activity, Database, ArrowRight } from 'lucide-react';
import { useApp } from '../../store/AppContext';

type Result = { id: string; title: string; subtitle: string; path: string; group: string };

export const SearchModal: React.FC = () => {
  const { searchOpen, setSearchOpen, searchQuery, setSearchQuery, resources, signals, connections } =
    useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const items: Result[] = [];
    const resList = q
      ? resources.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.code.toLowerCase().includes(q),
        )
      : resources.slice(0, 3);
    resList.forEach((res) =>
      items.push({
        id: `r-${res.id}`,
        title: res.name,
        subtitle: `${res.code} · ${res.type}`,
        path: `/factory/structure?resourceId=${res.id}`,
        group: 'Resources',
      }),
    );
    const sigList = q
      ? signals.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.tag.toLowerCase().includes(q),
        )
      : signals.slice(0, 3);
    sigList.forEach((sig) =>
      items.push({
        id: `s-${sig.id}`,
        title: sig.name,
        subtitle: `${sig.tag} · ${sig.currentValue} ${sig.unit || ''}`.trim(),
        path: `/signals?signalId=${sig.id}`,
        group: 'Signals',
      }),
    );
    const connList = q
      ? connections.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.endpoint.toLowerCase().includes(q),
        )
      : connections.slice(0, 2);
    connList.forEach((conn) =>
      items.push({
        id: `c-${conn.id}`,
        title: conn.name,
        subtitle: `${conn.endpoint} · ${conn.protocol.toUpperCase()}`,
        path: `/acquisition/connections?connectionId=${conn.id}`,
        group: 'Connections',
      }),
    );
    return items;
  }, [searchQuery, resources, signals, connections]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen, setSearchOpen]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setActiveIndex(0);
    } else {
      setSearchQuery('');
    }
  }, [searchOpen, setSearchQuery]);

  useEffect(() => {
    setActiveIndex(0);
  }, [searchQuery]);

  if (!searchOpen) return null;

  const openResult = (path: string) => {
    navigate(path);
    setSearchOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      openResult(results[activeIndex].path);
    }
  };

  const groupIcon = (group: string) => {
    if (group === 'Signals') return <Activity className="w-3.5 h-3.5 text-[#0DBA67]" />;
    if (group === 'Connections') return <Database className="w-3.5 h-3.5 text-[#8858EA]" />;
    return <Box className="w-3.5 h-3.5 text-[#2A82E7]" />;
  };

  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-[620px] max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-2xl border border-[#D4DFEC] overflow-hidden">
        <div className="flex items-center px-4 py-3.5 border-b border-[#E3EAF3] gap-3">
          <Search className="w-5 h-5 text-[#657794]" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search…"
            className="flex-1 text-[15px] text-[#111B37] placeholder-[#94A3B8] outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="p-1 text-[#94A3B8] hover:text-[#111B37]"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="px-2 py-0.5 text-[11px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794]">
            Esc
          </kbd>
        </div>

        <div className="max-h-[380px] overflow-y-auto p-3 space-y-1">
          {!results.length && (
            <p className="text-[12px] text-[#657794] px-2 py-4">No matches.</p>
          )}
          {results.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <React.Fragment key={item.id}>
                {showGroup && (
                  <div className="text-[11px] font-bold uppercase text-[#94A3B8] px-2 mb-1 mt-2 flex items-center gap-1.5">
                    {groupIcon(item.group)}
                    <span>{item.group}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => openResult(item.path)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors ${
                    index === activeIndex
                      ? 'bg-[#FFF0F1]/80 ring-1 ring-[#FAC6C9]'
                      : 'hover:bg-[#FFF0F1]/60'
                  }`}
                >
                  <div>
                    <div className="text-[13px] font-semibold text-[#111B37]">{item.title}</div>
                    <div className="text-[11px] text-[#657794] font-mono">{item.subtitle}</div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[#94A3B8]" />
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};
