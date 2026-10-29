import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Box, Activity, Database, ArrowRight } from 'lucide-react';
import { useApp } from '../../store/AppContext';

export const SearchModal: React.FC = () => {
  const { searchOpen, setSearchOpen, searchQuery, setSearchQuery, resources, signals, connections } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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
    } else {
      setSearchQuery('');
    }
  }, [searchOpen, setSearchQuery]);

  if (!searchOpen) return null;

  const filteredResources = searchQuery
    ? resources.filter((r) => r.name.toLowerCase().includes(searchQuery.toLowerCase()) || r.code.toLowerCase().includes(searchQuery.toLowerCase()))
    : resources.slice(0, 3);

  const filteredSignals = searchQuery
    ? signals.filter((s) => s.name.toLowerCase().includes(searchQuery.toLowerCase()) || s.tag.toLowerCase().includes(searchQuery.toLowerCase()))
    : signals.slice(0, 3);

  const filteredConnections = searchQuery
    ? connections.filter((c) => c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.endpoint.toLowerCase().includes(searchQuery.toLowerCase()))
    : connections.slice(0, 2);

  const handleSelect = (path: string) => {
    navigate(path);
    setSearchOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-[620px] bg-white rounded-xl shadow-2xl border border-[#D4DFEC] overflow-hidden">
        {/* Input bar */}
        <div className="flex items-center px-4 py-3.5 border-b border-[#E3EAF3] gap-3">
          <Search className="w-5 h-5 text-[#657794]" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search resources, tags, signals, connections..."
            className="flex-1 text-[15px] text-[#111B37] placeholder-[#94A3B8] outline-none"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')} className="p-1 text-[#94A3B8] hover:text-[#111B37]">
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="px-2 py-0.5 text-[11px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794]">
            ESC to close
          </kbd>
        </div>

        {/* Results Body */}
        <div className="max-h-[380px] overflow-y-auto p-3 space-y-4">
          {/* Resources */}
          {filteredResources.length > 0 && (
            <div>
              <div className="text-[11px] font-bold uppercase text-[#94A3B8] px-2 mb-1.5 flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5 text-[#2A82E7]" />
                <span>Factory Resources</span>
              </div>
              <div className="space-y-1">
                {filteredResources.map((res) => (
                  <button
                    key={res.id}
                    type="button"
                    onClick={() => handleSelect(`/factory/structure?resourceId=${res.id}`)}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-[#FFF0F1]/60 group transition-colors"
                  >
                    <div>
                      <div className="text-[13px] font-semibold text-[#111B37] group-hover:text-[#EF1B24]">{res.name}</div>
                      <div className="text-[11px] text-[#657794] font-mono">{res.code} · {res.type}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#94A3B8] group-hover:text-[#EF1B24]" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Signals */}
          {filteredSignals.length > 0 && (
            <div>
              <div className="text-[11px] font-bold uppercase text-[#94A3B8] px-2 mb-1.5 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-[#0DBA67]" />
                <span>Signals & Tags</span>
              </div>
              <div className="space-y-1">
                {filteredSignals.map((sig) => (
                  <button
                    key={sig.id}
                    type="button"
                    onClick={() => handleSelect(`/signals?signalId=${sig.id}`)}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-[#FFF0F1]/60 group transition-colors"
                  >
                    <div>
                      <div className="text-[13px] font-semibold text-[#111B37] group-hover:text-[#EF1B24]">{sig.name}</div>
                      <div className="text-[11px] text-[#657794] font-mono">{sig.tag} · {sig.currentValue} {sig.unit}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#94A3B8] group-hover:text-[#EF1B24]" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Connections */}
          {filteredConnections.length > 0 && (
            <div>
              <div className="text-[11px] font-bold uppercase text-[#94A3B8] px-2 mb-1.5 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-[#8858EA]" />
                <span>Connections</span>
              </div>
              <div className="space-y-1">
                {filteredConnections.map((conn) => (
                  <button
                    key={conn.id}
                    type="button"
                    onClick={() => handleSelect(`/acquisition/connections?connectionId=${conn.id}`)}
                    className="w-full flex items-center justify-between p-2 rounded-lg text-left hover:bg-[#FFF0F1]/60 group transition-colors"
                  >
                    <div>
                      <div className="text-[13px] font-semibold text-[#111B37] group-hover:text-[#EF1B24]">{conn.name}</div>
                      <div className="text-[11px] text-[#657794] font-mono">{conn.endpoint} · {conn.protocol.toUpperCase()}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#94A3B8] group-hover:text-[#EF1B24]" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
