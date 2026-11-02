import React, { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { LineChart } from '../../components/charts/LineChart';
import { useApp } from '../../store/AppContext';
import { api } from '../../api/client';
import { absoluteUtc7, relativeAge } from '../../utils/relativeTime';

export const LiveOperationsPage: React.FC = () => {
  const { signals, connections } = useApp();
  const [filter, setFilter] = useState('');
  const [qualityFilter, setQualityFilter] = useState<'all' | 'GOOD' | 'BAD' | 'STALE'>('all');
  const [selectedId, setSelectedId] = useState('');
  const [stats, setStats] = useState<{ min?: number; max?: number; avg?: number }>({});
  const [history, setHistory] = useState<Array<{ time: string; value: number }>>([]);

  const good = signals.filter((s) => s.quality === 'GOOD').length;
  const bad = signals.filter((s) => s.quality === 'BAD').length;
  const stale = signals.filter((s) => s.quality === 'STALE' || s.quality === 'UNCERTAIN').length;
  const connected = connections.filter((c) => c.status === 'connected').length;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return signals.filter((s) => {
      if (qualityFilter === 'STALE') {
        if (!(s.quality === 'STALE' || s.quality === 'UNCERTAIN')) return false;
      } else if (qualityFilter !== 'all' && s.quality !== qualityFilter) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.tag.toLowerCase().includes(q) ||
        s.resourcePath.toLowerCase().includes(q) ||
        s.sourceConnectionName.toLowerCase().includes(q)
      );
    });
  }, [signals, filter, qualityFilter]);

  const selected = filtered.find((s) => s.id === selectedId) || filtered[0] || null;

  useEffect(() => {
    if (!selected) {
      setStats({});
      setHistory([]);
      return;
    }
    let cancelled = false;
    const end = new Date();
    const start = new Date(end.getTime() - 15 * 60 * 1000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    void (async () => {
      try {
        const hist = await api<{
          items?: Array<{
            value_json?: { v?: number };
            value?: number;
            event_time?: string;
            source_time?: string;
          }>;
        }>(
          `/api/v1/observations/history?signal_id=${selected.id}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=60`,
        ).catch(() => ({ items: [] }));
        if (cancelled) return;
        const points = (hist.items || []).flatMap((row) => {
          const raw = row.value_json?.v ?? row.value;
          const value = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(value)) return [];
          const stamp = row.source_time || row.event_time || '';
          const time = stamp
            ? new Date(stamp).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })
            : '';
          return [{ time, value }];
        });
        setHistory(points);
        if (points.length) {
          const values = points.map((point) => point.value);
          setStats({
            min: Math.min(...values),
            max: Math.max(...values),
            avg: values.reduce((sum, value) => sum + value, 0) / values.length,
          });
        } else {
          setStats({});
        }
      } catch {
        if (!cancelled) {
          setStats({});
          setHistory([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const exportCsv = () => {
    const headers = ['Signal', 'Name', 'Resource', 'Source', 'Value', 'Unit', 'Quality', 'Updated'];
    const rows = filtered.map((s) =>
      [
        s.tag,
        s.name,
        s.resourcePath,
        s.sourceConnectionName || '',
        String(s.currentValue),
        s.unit || '',
        s.quality,
        s.lastUpdated || '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `factorix_live_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!signals.length) {
    return (
      <div className="space-y-3 animate-in fade-in duration-200">
        <h1 className="fx-page-title">Live monitor</h1>
        <p className="fx-page-subtitle">No signals yet. They appear here after a connection is activated.</p>
        <Card className="p-8 text-center text-[13px] text-[#657794]">
          Add a data connection and start collecting to see live values.
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Live monitor</h1>
          <p className="fx-page-subtitle">
            {signals.length} signals · {good} good · {stale} stale · {bad} bad · {connected}/{connections.length}{' '}
            connections healthy
          </p>
        </div>
        <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'GOOD', 'BAD', 'STALE'] as const).map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setQualityFilter(q)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold border ${
              qualityFilter === q
                ? 'bg-[#FFF0F1] border-[#FAC6C9] text-[#EF1B24]'
                : 'bg-white border-[#D4DFEC] text-[#657794]'
            }`}
          >
            {q === 'all' ? 'All qualities' : q}
          </button>
        ))}
        <div className="relative w-56 ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[#94A3B8]" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter signals…"
            className="w-full pl-8 pr-2 py-1.5 text-xs bg-white border border-[#D4DFEC] rounded-lg text-[#334568]"
          />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-7">
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th>Resource</th>
                    <th>Source</th>
                    <th>Source time</th>
                    <th className="!text-right">Value</th>
                    <th>Quality</th>
                    <th className="!text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((sig) => {
                    const isSelected = selected?.id === sig.id;
                    const conn = connections.find((c) => c.name === sig.sourceConnectionName);
                    return (
                      <tr
                        key={sig.id}
                        onClick={() => setSelectedId(sig.id)}
                        className={`cursor-pointer ${
                          isSelected ? 'bg-[#FFF0F1]/50 border-l-4 border-l-[#EF1B24]' : 'hover:bg-[#F9FAFD]'
                        }`}
                      >
                        <td className="font-bold text-xs text-[#111B37] font-mono whitespace-nowrap">
                          {sig.name}
                        </td>
                        <td className="text-xs text-[#657794] whitespace-nowrap">{sig.resourcePath}</td>
                        <td className="text-[11px] font-mono text-[#94A3B8] whitespace-nowrap">
                          {sig.sourceConnectionName || '—'}
                          {conn ? ` · ${conn.protocol.toUpperCase()}` : ''}
                        </td>
                        <td
                          className="font-mono text-[11px] text-[#657794] whitespace-nowrap"
                          title={absoluteUtc7(sig.sourceTime || sig.lastUpdated)}
                        >
                          {sig.sourceTime ? relativeAge(sig.sourceTime) : '—'}
                        </td>
                        <td className="!text-right text-xs font-extrabold text-[#111B37] font-mono tabular-nums whitespace-nowrap">
                          {String(sig.currentValue)} {sig.unit}
                        </td>
                        <td>
                          <Badge
                            variant={
                              sig.quality === 'GOOD' ? 'good' : sig.quality === 'BAD' ? 'error' : 'warning'
                            }
                          >
                            {sig.quality}
                          </Badge>
                        </td>
                        <td
                          className="!text-right font-mono text-xs text-[#94A3B8] whitespace-nowrap"
                          title={absoluteUtc7(sig.lastUpdated)}
                        >
                          {relativeAge(sig.lastUpdated)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-5 space-y-3">
          <Card className="p-4 space-y-3">
            <div>
              <h3 className="font-bold text-[#111B37] text-sm">
                {selected ? selected.name : 'Select a signal'}
              </h3>
              <p className="text-xs text-[#657794]">
                {selected ? `${selected.tag} · ${selected.resourcePath}` : 'Trend when history is available'}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs bg-[#F9FAFD] p-2.5 rounded-xl border border-[#E3EAF3]">
              <div>
                <span className="text-[10px] text-[#94A3B8] block font-semibold uppercase">Min</span>
                <span className="font-mono font-bold text-[#111B37]">
                  {stats.min != null ? stats.min.toFixed(2) : '—'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-[#94A3B8] block font-semibold uppercase">Avg</span>
                <span className="font-mono font-bold text-[#111B37]">
                  {stats.avg != null ? stats.avg.toFixed(2) : '—'}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-[#94A3B8] block font-semibold uppercase">Max</span>
                <span className="font-mono font-bold text-[#111B37]">
                  {stats.max != null ? stats.max.toFixed(2) : '—'}
                </span>
              </div>
            </div>
            <div className="h-48 pt-2 flex items-center justify-center text-[12px] text-[#657794]">
              {history.length ? (
                <LineChart data={history} height={160} />
              ) : (
                <p className="text-center">No history in the last 15 minutes</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
