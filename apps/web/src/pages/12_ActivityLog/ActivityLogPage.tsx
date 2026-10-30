import React, { useState } from 'react';
import {
  ListFilter,
  Download,
  Search,
  Copy,
  Check,
  RotateCcw,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { ActivityEvent } from '../../types';

export const ActivityLogPage: React.FC = () => {
  const { activities } = useApp();
  const [selectedEvtId, setSelectedEvtId] = useState<string>('act-evt-101');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const selectedEvent =
    activities.find((a) => a.id === selectedEvtId) || activities[0] || null;

  const filteredEvents = activities.filter((a) => {
    const matchesSev = severityFilter === 'all' || a.severity === severityFilter;
    const matchesSearch =
      a.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.source.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.eventType.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSev && matchesSearch;
  });

  const handleCopyJson = () => {
    if (selectedEvent.details) {
      navigator.clipboard.writeText(JSON.stringify(selectedEvent.details, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getSeverityBadge = (sev: string) => {
    switch (sev) {
      case 'success':
        return <Badge variant="good">SUCCESS</Badge>;
      case 'warning':
        return <Badge variant="warning">WARNING</Badge>;
      case 'error':
        return <Badge variant="error">ERROR</Badge>;
      default:
        return <Badge variant="info">INFO</Badge>;
    }
  };

  if (!selectedEvent) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Activity Log</h1>
        <p className="fx-page-subtitle">No audit events yet. Creating the factory model and connections writes them here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Heading */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Operational Activity Log</h1>
          <p className="fx-page-subtitle">
            Historical events audit trail, operator interventions, and system state transitions.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" icon={<Download className="w-4 h-4" />}>
            Export Audit Log
          </Button>
        </div>
      </div>

      {/* Region 2: Filter Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2">
          {['all', 'info', 'success', 'warning', 'error'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverityFilter(s)}
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

        <div className="relative w-72">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" />
          <input
            type="text"
            placeholder="Search events, sources, codes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="fx-input pl-9 h-9 text-[13px]"
          />
        </div>
      </div>

      {/* Main Split: Events Table (Reg 3) & JSON Detail Inspector (Reg 4, 5) */}
      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-7">
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Severity</th>
                    <th>Source Engine</th>
                    <th>Event Type</th>
                    <th>Summary Message</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((evt) => {
                    const isSelected = evt.id === selectedEvent.id;
                    return (
                      <tr
                        key={evt.id}
                        onClick={() => setSelectedEvtId(evt.id)}
                        data-selected={isSelected}
                        className="cursor-pointer"
                      >
                        <td className="font-mono text-[#94A3B8] text-[11px] whitespace-nowrap">
                          {evt.timestamp}
                        </td>
                        <td>{getSeverityBadge(evt.severity)}</td>
                        <td className="font-semibold text-[#111B37] text-[12px]">{evt.source}</td>
                        <td className="font-mono text-[11px] text-[#2A82E7]">{evt.eventType}</td>
                        <td className="text-[#334568] text-[12px] truncate max-w-[280px]">
                          {evt.message}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Region 4: Selected Event Detail Inspector */}
        <div className="col-span-12 lg:col-span-5 space-y-3.5">
          <Card
            title="Event Payload & Context"
            subtitle={`ID: ${selectedEvent.id}`}
            action={
              <Button
                size="sm"
                variant="secondary"
                icon={copied ? <Check className="w-3.5 h-3.5 text-[#0DBA67]" /> : <Copy className="w-3.5 h-3.5" />}
                onClick={handleCopyJson}
              >
                {copied ? 'Copied' : 'Copy JSON'}
              </Button>
            }
          >
            <div className="space-y-3 text-[12px]">
              <div>
                <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">Event Message</span>
                <p className="font-semibold text-[#111B37] mt-0.5">{selectedEvent.message}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#E3EAF3]">
                <div>
                  <span className="text-[#657794] block text-[11px]">Source Subsystem:</span>
                  <span className="font-bold text-[#111B37]">{selectedEvent.source}</span>
                </div>
                <div>
                  <span className="text-[#657794] block text-[11px]">Event Classification:</span>
                  <span className="font-mono text-[#2A82E7] font-semibold">{selectedEvent.eventType}</span>
                </div>
              </div>

              {/* JSON Payload Highlight */}
              <div className="pt-2 border-t border-[#E3EAF3]">
                <span className="text-[#94A3B8] block text-[11px] uppercase font-bold mb-1.5">
                  Structured Payload (JSON)
                </span>
                <pre className="p-3 rounded-xl bg-[#111B2E] text-[#0DBA67] font-mono text-[11px] leading-relaxed overflow-x-auto">
                  {JSON.stringify(selectedEvent.details || {}, null, 2)}
                </pre>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
