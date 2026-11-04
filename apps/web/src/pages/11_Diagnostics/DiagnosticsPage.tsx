import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  RefreshCw,
  Search,
  Server,
  Radio,
  Network,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { api } from '../../api/client';

interface AuditItem {
  id: string;
  occurred_at: string;
  event_type: string;
  actor_id?: string;
  entity_type?: string;
  entity_id?: string;
  severity: 'INFO' | 'WARN' | 'ERROR';
  details?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

function timeAgo(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 0 || isNaN(diffSec)) return 'just now';
  if (diffSec < 60) return `${diffSec} s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;
  return `${Math.floor(diffHour / 24)} d ago`;
}

function formatAuditWhat(event: AuditItem): string {
  const type = (event.event_type || '').toUpperCase();
  const details = event.details || event.after || {};

  switch (type) {
    case 'EDGE_OFFLINE':
      return 'Edge went offline';
    case 'EDGE_ONLINE':
      return 'Edge is back online';
    case 'EDGE_ENROLL_TOKEN':
      return 'Issued edge enrollment token';
    case 'CONNECTION_CREATED':
      return `Created connection "${details.name || 'unnamed'}"`;
    case 'CONNECTION_UPDATED':
      return `Updated connection "${details.name || ''}"`;
    case 'CONNECTION_PAUSED':
      return `Paused connection "${details.name || ''}"`;
    case 'CONNECTION_RESUMED':
      return `Resumed connection "${details.name || ''}"`;
    case 'CONNECTION_DEGRADED':
      return `Connection degraded: ${details.error || 'No data received'}`;
    case 'SIGNALS_CREATED':
    case 'SIGNALS_BULK_CREATED':
      return `Added signals to resource`;
    case 'SIGNAL_UPDATED':
      return `Updated signal "${details.name || details.display_name || ''}"`;
    case 'SIGNAL_ARCHIVED':
      return `Archived signal "${details.name || ''}"`;
    case 'SIGNALS_BULK_ACTION':
      return `${details.action || 'Updated'} ${details.count || ''} signals`;
    case 'RESOURCE_CREATED':
      return `Created resource "${details.name || ''}"`;
    case 'RESOURCE_MOVED':
      return `Moved resource "${details.name || ''}"`;
    case 'COMMISSION_TEST':
      return `Ran commissioning test`;
    default:
      return type.replace(/_/g, ' ').toLowerCase();
  }
}

export const DiagnosticsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { edges, connections, signals, resources, refresh } = useApp();

  const activeTab = searchParams.get('tab') === 'activity' ? 'activity' : 'health';
  const setActiveTab = (tab: 'health' | 'activity') => {
    setSearchParams({ tab });
  };

  // Health Filter State
  const [healthFilter, setHealthFilter] = useState<'all' | 'edges' | 'connections' | 'bad' | 'stale'>('all');

  // Activity State
  const [auditEvents, setAuditEvents] = useState<AuditItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [activitySeverityFilter, setActivitySeverityFilter] = useState<string>('all');
  const [activitySearch, setActivitySearch] = useState<string>('');
  const [selectedAuditItem, setSelectedAuditItem] = useState<AuditItem | null>(null);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  // Load Audit Events
  const loadAuditEvents = async (cursor?: string | null) => {
    setAuditLoading(true);
    try {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50';
      const data = await api<{
        items: AuditItem[];
        next_cursor?: string | null;
        has_more?: boolean;
      }>(`/api/v1/audit-events${q}`);

      if (cursor) {
        setAuditEvents((prev) => [...prev, ...data.items]);
      } else {
        setAuditEvents(data.items || []);
      }
      setAuditCursor(data.next_cursor || null);
      setAuditHasMore(Boolean(data.has_more));
    } catch {
      // fallback or keep existing
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'activity') {
      void loadAuditEvents(null);
    }
  }, [activeTab]);

  // Derived Issues for Health Tab
  const healthIssues = useMemo(() => {
    const list: Array<{
      id: string;
      category: 'edges' | 'connections' | 'bad' | 'stale';
      object: string;
      issue: string;
      since: string;
      severity: 'ERROR' | 'WARN';
      recommendation: string;
      actionLink?: string;
    }> = [];

    // 1. Edges Offline (Highest severity)
    for (const e of edges) {
      const isEnrolled = e.enrollment_status === 'ENROLLED' || (!e.enrollment_status && e.health);
      if (isEnrolled && (e.health || '').toUpperCase() === 'OFFLINE') {
        const timeStr = e.last_heartbeat ? new Date(e.last_heartbeat).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently';
        list.push({
          id: `edge-${e.id}`,
          category: 'edges',
          object: e.name,
          issue: `Edge ${e.name} offline since ${timeStr}`,
          since: e.last_heartbeat || '',
          severity: 'ERROR',
          recommendation: 'Check that the edge is powered on and can reach the appliance.',
          actionLink: '/collector/edges',
        });
      }
    }

    // 2. Connections with errors or degraded
    for (const c of connections) {
      if ((c.status || '').toUpperCase() === 'ACTIVE') {
        const isDegraded = (c.health || '').toUpperCase() === 'DEGRADED';
        const isOffline = (c.health || '').toUpperCase() === 'OFFLINE';
        if (isDegraded || isOffline || c.lastError) {
          list.push({
            id: `conn-${c.id}`,
            category: 'connections',
            object: c.name,
            issue: `${c.name}: ${c.lastError || 'No data received for 30 s'}`,
            since: c.lastErrorTimestamp || c.updatedAt || '',
            severity: isOffline ? 'ERROR' : 'WARN',
            recommendation: 'Open the connection and test connectivity to verify endpoint credentials.',
            actionLink: `/collector/connections`,
          });
        }
      }
    }

    // 3. Bad Signals
    for (const s of signals) {
      if ((s.quality || '').toUpperCase() === 'BAD') {
        const res = resources.find((r) => r.id === s.resourceId);
        const name = s.displayName || s.name || s.key;
        list.push({
          id: `sig-bad-${s.id}`,
          category: 'bad',
          object: `${name} on ${res?.name || 'resource'}`,
          issue: `${name} reports BAD quality (${s.qualityReason || 'Value outside range or parse error'})`,
          since: s.lastUpdated || '',
          severity: 'ERROR',
          recommendation: 'Check field type mapping and jsonpath address in signal settings.',
          actionLink: `/collector/signals?signalId=${s.id}`,
        });
      }
    }

    // 4. Stale Signals
    for (const s of signals) {
      if ((s.quality || '').toUpperCase() === 'STALE') {
        const res = resources.find((r) => r.id === s.resourceId);
        const name = s.displayName || s.name || s.key;
        list.push({
          id: `sig-stale-${s.id}`,
          category: 'stale',
          object: `${name} on ${res?.name || 'resource'}`,
          issue: `${name} on ${res?.name || 'resource'} has no update for 10 s`,
          since: s.lastUpdated || '',
          severity: 'WARN',
          recommendation: `Check that the source publishes data for this signal.`,
          actionLink: `/collector/signals?signalId=${s.id}`,
        });
      }
    }

    return list;
  }, [edges, connections, signals, resources]);

  // Counts for 4 KPIs
  const edgeOfflineCount = useMemo(() => healthIssues.filter((i) => i.category === 'edges').length, [healthIssues]);
  const connectionErrorCount = useMemo(() => healthIssues.filter((i) => i.category === 'connections').length, [healthIssues]);
  const signalBadCount = useMemo(() => healthIssues.filter((i) => i.category === 'bad').length, [healthIssues]);
  const signalStaleCount = useMemo(() => healthIssues.filter((i) => i.category === 'stale').length, [healthIssues]);

  // Filtered health issues
  const filteredHealthIssues = useMemo(() => {
    if (healthFilter === 'all') return healthIssues;
    return healthIssues.filter((i) => i.category === healthFilter);
  }, [healthIssues, healthFilter]);

  // Filtered Activity Events
  const filteredActivities = useMemo(() => {
    return auditEvents.filter((item) => {
      if (activitySeverityFilter !== 'all' && item.severity !== activitySeverityFilter) return false;
      if (activitySearch) {
        const term = activitySearch.toLowerCase();
        const what = formatAuditWhat(item).toLowerCase();
        const entity = (item.entity_type || '').toLowerCase();
        return what.includes(term) || entity.includes(term);
      }
      return true;
    });
  }, [auditEvents, activitySeverityFilter, activitySearch]);

  // Export Activity CSV (TC-UI-DG-10)
  const handleExportCsv = () => {
    const rows = [
      ['When', 'What', 'Severity', 'Object'],
      ...filteredActivities.map((a) => [
        a.occurred_at,
        `"${formatAuditWhat(a).replace(/"/g, '""')}"`,
        a.severity,
        `"${(a.entity_type || 'system').replace(/"/g, '""')}"`,
      ]),
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `activity_log_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Diagnostics</h1>
          <p className="text-[13px] text-[#657794]">
            Monitor operational health, collector status, and audit events
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'activity' && (
            <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={filteredActivities.length === 0}>
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export CSV
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
              if (activeTab === 'activity') void loadAuditEvents(null);
            }}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Tabs Switcher */}
      <div className="flex items-center gap-2 border-b border-slate-200" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'health'}
          onClick={() => setActiveTab('health')}
          className={`px-4 py-2 text-[13px] font-semibold border-b-2 transition ${
            activeTab === 'health'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-[#657794] hover:text-[#111B37]'
          }`}
        >
          Health {healthIssues.length > 0 && <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-red-100 text-red-700 font-bold">{healthIssues.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'activity'}
          onClick={() => setActiveTab('activity')}
          className={`px-4 py-2 text-[13px] font-semibold border-b-2 transition ${
            activeTab === 'activity'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-[#657794] hover:text-[#111B37]'
          }`}
        >
          Activity Log
        </button>
      </div>

      {/* TAB 1: HEALTH */}
      {activeTab === 'health' && (
        <div className="space-y-6">
          {/* 4 Clickable KPI Cards (TC-UI-DG-01..05) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Edges Offline */}
            <div
              onClick={() => setHealthFilter(healthFilter === 'edges' ? 'all' : 'edges')}
              className={`p-4 rounded-xl border cursor-pointer transition ${
                healthFilter === 'edges'
                  ? 'border-red-500 bg-red-50/50 ring-2 ring-red-200'
                  : 'border-[#CBD5E1] bg-white hover:border-slate-400'
              }`}
            >
              <div className="flex items-center justify-between text-[#657794]">
                <span className="text-[12px] font-semibold uppercase tracking-wider">Edges offline</span>
                <Server className={`w-4 h-4 ${edgeOfflineCount > 0 ? 'text-red-500' : 'text-slate-400'}`} />
              </div>
              <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">
                {edgeOfflineCount}
              </div>
              <div className="text-[11px] text-[#657794] mt-1">
                {edgeOfflineCount === 0 ? 'All nodes reporting' : 'Collector node unreachable'}
              </div>
            </div>

            {/* Connections with errors */}
            <div
              onClick={() => setHealthFilter(healthFilter === 'connections' ? 'all' : 'connections')}
              className={`p-4 rounded-xl border cursor-pointer transition ${
                healthFilter === 'connections'
                  ? 'border-amber-500 bg-amber-50/50 ring-2 ring-amber-200'
                  : 'border-[#CBD5E1] bg-white hover:border-slate-400'
              }`}
            >
              <div className="flex items-center justify-between text-[#657794]">
                <span className="text-[12px] font-semibold uppercase tracking-wider">Connections with errors</span>
                <Network className={`w-4 h-4 ${connectionErrorCount > 0 ? 'text-amber-500' : 'text-slate-400'}`} />
              </div>
              <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">
                {connectionErrorCount}
              </div>
              <div className="text-[11px] text-[#657794] mt-1">
                {connectionErrorCount === 0 ? 'All protocols active' : 'Degraded or timed out'}
              </div>
            </div>

            {/* Signals Bad */}
            <div
              onClick={() => setHealthFilter(healthFilter === 'bad' ? 'all' : 'bad')}
              className={`p-4 rounded-xl border cursor-pointer transition ${
                healthFilter === 'bad'
                  ? 'border-red-500 bg-red-50/50 ring-2 ring-red-200'
                  : 'border-[#CBD5E1] bg-white hover:border-slate-400'
              }`}
            >
              <div className="flex items-center justify-between text-[#657794]">
                <span className="text-[12px] font-semibold uppercase tracking-wider">Signals bad</span>
                <Radio className={`w-4 h-4 ${signalBadCount > 0 ? 'text-red-500' : 'text-slate-400'}`} />
              </div>
              <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">
                {signalBadCount}
              </div>
              <div className="text-[11px] text-[#657794] mt-1">
                {signalBadCount === 0 ? 'No parsing errors' : 'Value outside valid domain'}
              </div>
            </div>

            {/* Signals Stale */}
            <div
              onClick={() => setHealthFilter(healthFilter === 'stale' ? 'all' : 'stale')}
              className={`p-4 rounded-xl border cursor-pointer transition ${
                healthFilter === 'stale'
                  ? 'border-slate-700 bg-slate-100 ring-2 ring-slate-300'
                  : 'border-[#CBD5E1] bg-white hover:border-slate-400'
              }`}
            >
              <div className="flex items-center justify-between text-[#657794]">
                <span className="text-[12px] font-semibold uppercase tracking-wider">Signals stale</span>
                <Clock className={`w-4 h-4 ${signalStaleCount > 0 ? 'text-slate-600' : 'text-slate-400'}`} />
              </div>
              <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">
                {signalStaleCount}
              </div>
              <div className="text-[11px] text-[#657794] mt-1">
                {signalStaleCount === 0 ? 'Fresh continuous streams' : 'No update in expected window'}
              </div>
            </div>
          </div>

          {/* Issues List Card */}
          <Card className="border border-[#CBD5E1] bg-white overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-[14px] font-bold text-[#111B37]">Detected issues</h3>
                <p className="text-[12px] text-[#657794]">
                  {healthFilter === 'all'
                    ? 'All active warnings and diagnostic failures'
                    : `Filtered by ${healthFilter.toUpperCase()}`}
                </p>
              </div>
              {healthFilter !== 'all' && (
                <button
                  onClick={() => setHealthFilter('all')}
                  className="text-[12px] text-blue-600 hover:underline font-medium"
                >
                  Clear filter
                </button>
              )}
            </div>

            {filteredHealthIssues.length === 0 ? (
              <div className="p-12 text-center text-[#657794]">
                <CheckCircle2 className="w-10 h-10 text-[#0DBA67] mx-auto mb-3" />
                <h3 className="text-[14px] font-bold text-[#111B37]">Everything is collecting normally.</h3>
                <p className="text-[12px] text-[#657794] mt-1">
                  All edge nodes, connections, and signals are operating within expected parameters.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredHealthIssues.map((issue) => (
                  <div
                    key={issue.id}
                    className="p-4 hover:bg-slate-50 transition flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                            issue.severity === 'ERROR'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {issue.severity}
                        </span>
                        <span className="text-[13px] font-bold text-[#111B37]">{issue.object}</span>
                      </div>
                      <p className="text-[12px] text-[#111B37] font-medium">{issue.issue}</p>
                      <p className="text-[11px] text-[#657794]">
                        <span className="font-semibold text-slate-700">Remediation:</span> {issue.recommendation}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-[11px] text-[#657794] whitespace-nowrap">
                        {timeAgo(issue.since)}
                      </span>
                      {issue.actionLink && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px] whitespace-nowrap"
                          onClick={() => navigate(issue.actionLink!)}
                        >
                          View object
                          <ExternalLink className="w-3 h-3 ml-1" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 2: ACTIVITY */}
      {activeTab === 'activity' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <Card className="p-4 border border-[#CBD5E1] bg-white flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-64">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search events…"
                  value={activitySearch}
                  onChange={(e) => setActivitySearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Severity Pills */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-[12px]">
                {['all', 'INFO', 'WARN', 'ERROR'].map((sev) => (
                  <button
                    key={sev}
                    onClick={() => setActivitySeverityFilter(sev)}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                      activitySeverityFilter === sev
                        ? 'bg-white text-[#111B37] shadow-xs'
                        : 'text-[#657794] hover:text-[#111B37]'
                    }`}
                  >
                    {sev === 'all' ? 'All' : sev === 'WARN' ? 'Warning' : sev === 'ERROR' ? 'Error' : 'Info'}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {/* Activity Table */}
          <Card className="border border-[#CBD5E1] bg-white overflow-hidden">
            {filteredActivities.length === 0 ? (
              <div className="p-12 text-center text-[#657794]">
                <Activity className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                <h3 className="text-[14px] font-semibold text-[#111B37]">No events recorded</h3>
                <p className="text-[12px] text-[#657794] mt-1">
                  Events will appear here as operations and deployments take place.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50 text-[#657794] font-semibold">
                      <th className="py-2.5 px-4">When</th>
                      <th className="py-2.5 px-4">What</th>
                      <th className="py-2.5 px-4">Severity</th>
                      <th className="py-2.5 px-4">Object</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredActivities.map((event) => (
                      <tr
                        key={event.id}
                        onClick={() => {
                          setSelectedAuditItem(event);
                          setShowTechnicalDetails(false);
                        }}
                        className="hover:bg-slate-50 cursor-pointer transition"
                      >
                        <td className="py-3 px-4 text-[#657794] whitespace-nowrap" title={new Date(event.occurred_at).toLocaleString()}>
                          {timeAgo(event.occurred_at)}
                        </td>
                        <td className="py-3 px-4 font-medium text-[#111B37]">
                          {formatAuditWhat(event)}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                              event.severity === 'ERROR'
                                ? 'bg-red-100 text-red-800'
                                : event.severity === 'WARN'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {event.severity}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-[#657794] font-mono text-[11px]">
                          {event.entity_type || 'system'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Load more cursor pagination (TC-UI-DG-08) */}
            {auditHasMore && (
              <div className="p-4 border-t border-slate-100 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadAuditEvents(auditCursor)}
                  disabled={auditLoading}
                >
                  {auditLoading ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Audit Item Details Modal (TC-UI-DG-09) */}
      {selectedAuditItem && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-lg p-5 bg-white border border-slate-300 shadow-xl space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                    selectedAuditItem.severity === 'ERROR'
                      ? 'bg-red-100 text-red-800'
                      : selectedAuditItem.severity === 'WARN'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {selectedAuditItem.severity}
                </span>
                <h3 className="text-[14px] font-bold text-[#111B37] mt-1">
                  {formatAuditWhat(selectedAuditItem)}
                </h3>
              </div>
              <span className="text-[11px] text-[#657794]">
                {new Date(selectedAuditItem.occurred_at).toLocaleString()}
              </span>
            </div>

            <div className="space-y-2 text-[12px]">
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-[#657794]">Event type:</span>
                <span className="font-mono text-[#111B37]">{selectedAuditItem.event_type}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span className="text-[#657794]">Entity:</span>
                <span className="font-mono text-[#111B37]">
                  {selectedAuditItem.entity_type} {selectedAuditItem.entity_id ? `(${selectedAuditItem.entity_id.slice(0, 8)}…)` : ''}
                </span>
              </div>
            </div>

            {/* Expandable Technical Details */}
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              <button
                onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
                className="flex items-center justify-between w-full text-[12px] font-semibold text-slate-700"
              >
                <span>Technical details</span>
                {showTechnicalDetails ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              {showTechnicalDetails && (
                <pre className="mt-2 text-[11px] font-mono text-slate-800 bg-white p-2 border border-slate-200 rounded overflow-x-auto max-h-48">
                  {JSON.stringify(selectedAuditItem, null, 2)}
                </pre>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <Button variant="primary" size="sm" onClick={() => setSelectedAuditItem(null)}>
                Close
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
