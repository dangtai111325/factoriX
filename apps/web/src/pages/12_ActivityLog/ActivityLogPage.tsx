import React, { useMemo, useState } from 'react';
import { Download, Search, Copy, Check } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { absoluteUtc7, relativeAge } from '../../utils/relativeTime';

const PAGE_SIZE = 25;

export const ActivityLogPage: React.FC = () => {
  const { activities } = useApp();
  const [selectedEvtId, setSelectedEvtId] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState('all');
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState(0);

  const entityTypes = useMemo(() => {
    return Array.from(new Set(activities.map((a) => a.entityType).filter(Boolean))) as string[];
  }, [activities]);

  const filteredEvents = useMemo(() => {
    const fromMs = fromTime ? Date.parse(fromTime) : NaN;
    const toMs = toTime ? Date.parse(toTime) : NaN;
    return activities.filter((a) => {
      const matchesSev = severityFilter === 'all' || a.severity === severityFilter;
      const matchesEntity = entityFilter === 'all' || a.entityType === entityFilter;
      const ts = Date.parse(a.timestamp);
      const matchesFrom = !Number.isFinite(fromMs) || (Number.isFinite(ts) && ts >= fromMs);
      const matchesTo = !Number.isFinite(toMs) || (Number.isFinite(ts) && ts <= toMs);
      const actor = a.actorName || String(a.details?.actor || '');
      const matchesSearch =
        !searchTerm ||
        a.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
        a.source.toLowerCase().includes(searchTerm.toLowerCase()) ||
        a.eventType.toLowerCase().includes(searchTerm.toLowerCase()) ||
        actor.toLowerCase().includes(searchTerm.toLowerCase());
      return matchesSev && matchesEntity && matchesFrom && matchesTo && matchesSearch;
    });
  }, [activities, severityFilter, entityFilter, fromTime, toTime, searchTerm]);

  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE));
  const pageItems = filteredEvents.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const selectedEvent =
    filteredEvents.find((a) => a.id === selectedEvtId) || pageItems[0] || null;

  const exportCsv = () => {
    const headers = ['Time', 'Severity', 'User', 'Source', 'Event', 'Message'];
    const rows = filteredEvents.map((a) =>
      [
        a.timestamp,
        a.severity,
        a.actorName || String(a.details?.actor || ''),
        a.source,
        a.eventType,
        a.message,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `factorix_activity_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const getSeverityBadge = (sev: string) => {
    switch (sev) {
      case 'success':
        return <Badge variant="good">Success</Badge>;
      case 'warning':
        return <Badge variant="warning">Warning</Badge>;
      case 'error':
        return <Badge variant="error">Error</Badge>;
      default:
        return <Badge variant="info">Info</Badge>;
    }
  };

  if (!activities.length) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Activity log</h1>
        <p className="fx-page-subtitle">
          No audit events yet. Creating the factory model and connections writes them here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Activity log</h1>
          <p className="fx-page-subtitle">Audit trail of operator and system actions.</p>
        </div>
        <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2 flex-wrap">
          {['all', 'info', 'success', 'warning', 'error'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSeverityFilter(s);
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold capitalize transition-all ${
                severityFilter === s
                  ? 'bg-[#FFF0F1] text-[#EF1B24] border border-[#FAC6C9]'
                  : 'bg-white text-[#657794] border border-[#D4DFEC] hover:text-[#111B37]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={entityFilter}
            onChange={(e) => {
              setEntityFilter(e.target.value);
              setPage(0);
            }}
            className="fx-input !w-auto h-9 text-[13px]"
            aria-label="Filter by object"
          >
            <option value="all">All objects</option>
            {entityTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <input
            type="datetime-local"
            value={fromTime}
            onChange={(e) => {
              setFromTime(e.target.value);
              setPage(0);
            }}
            className="fx-input !w-auto h-9 text-[12px]"
            aria-label="From"
          />
          <input
            type="datetime-local"
            value={toTime}
            onChange={(e) => {
              setToTime(e.target.value);
              setPage(0);
            }}
            className="fx-input !w-auto h-9 text-[12px]"
            aria-label="To"
          />
          <div className="relative w-56">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8] pointer-events-none" />
            <input
              type="text"
              placeholder="Filter events…"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(0);
              }}
              className="fx-input !pl-8 h-9 text-[13px]"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-7">
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Severity</th>
                    <th>User</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((evt) => (
                    <tr
                      key={evt.id}
                      data-selected={selectedEvent?.id === evt.id ? 'true' : undefined}
                      className="cursor-pointer"
                      onClick={() => setSelectedEvtId(evt.id)}
                    >
                      <td
                        className="font-mono text-[11px] text-[#94A3B8] whitespace-nowrap"
                        title={absoluteUtc7(evt.timestamp)}
                      >
                        {relativeAge(evt.timestamp)}
                      </td>
                      <td>{getSeverityBadge(evt.severity)}</td>
                      <td className="text-[12px] text-[#657794]">
                        {evt.actorName || String(evt.details?.actor || '—')}
                      </td>
                      <td className="text-[12px] text-[#111B37] font-medium">{evt.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-3 py-2 border-t border-[#E3EAF3] text-[12px]">
              <span className="text-[#657794]">
                {filteredEvents.length} events · page {page + 1}/{pageCount}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <Card title="Event">
            {!selectedEvent ? (
              <p className="text-[12px] text-[#657794]">Select an event.</p>
            ) : (
              <div className="space-y-3">
                <div>
                  <p className="text-[13px] font-bold text-[#111B37]">{selectedEvent.message}</p>
                  <p className="text-[11px] text-[#657794]" title={absoluteUtc7(selectedEvent.timestamp)}>
                    {relativeAge(selectedEvent.timestamp)} · {selectedEvent.actorName || 'System'}
                  </p>
                </div>
                <details key={selectedEvent.id}>
                  <summary className="text-[12px] font-semibold text-[#334568] cursor-pointer">
                    Technical details
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            JSON.stringify(selectedEvent.details || {}, null, 2),
                          );
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                      >
                        {copied ? 'Copied' : 'Copy JSON'}
                      </Button>
                    </div>
                    <pre className="text-[11px] font-mono bg-[#F9FAFD] border border-[#E3EAF3] rounded-lg p-3 overflow-auto max-h-[420px] text-[#334568]">
                      {JSON.stringify(
                        {
                          event_type: selectedEvent.eventType,
                          entity_type: selectedEvent.entityType,
                          entity_id: selectedEvent.entityId,
                          ...selectedEvent.details,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                </details>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
