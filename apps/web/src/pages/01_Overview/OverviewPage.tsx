import React, { useEffect, useState, useMemo } from 'react';
import {
  Layers,
  Radio,
  Network,
  Cpu,
  Database,
  CheckCircle2,
  Circle,
  ArrowRight,
  Plus,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { Card } from '../../components/common/Card';
import { Button } from '../../components/common/Button';
import { DonutChart } from '../../components/charts/DonutChart';
import { StatusBadge } from '../../components/common/StatusBadge';
import { api } from '../../api/client';

interface OverviewStats {
  resources: number;
  machines: number;
  active_connections: number;
  connections_online: number;
  connections_total: number;
  healthy_edges: number;
  edges_online: number;
  edges_total: number;
  last_data_at: string | null;
  ingest_per_minute: number;
  messages_per_min: number;
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

export const OverviewPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    resources,
    connections,
    edges,
    signals,
    outputGroups,
    activities,
    currentPlant,
    refresh,
  } = useApp();

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [checklistDismissed, setChecklistDismissed] = useState<boolean>(() => {
    return localStorage.getItem('fx.getStarted.hidden') === 'true';
  });

  const loadOverview = async () => {
    try {
      const data = await api<OverviewStats>('/api/v1/overview');
      setStats(data);
    } catch {
      // stats fallback to store counts
    }
  };

  useEffect(() => {
    void loadOverview();
    const timer = setInterval(() => {
      void loadOverview();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // Checklist completion flags
  const step1Complete = useMemo(
    () => resources.some((r) => r.type === 'machine' || r.type === 'line'),
    [resources]
  );
  const step2Complete = useMemo(
    () => edges.some((e) => (e.health || '').toUpperCase() === 'ONLINE' || (e.health || '').toUpperCase() === 'HEALTHY' || (e.health || '').toUpperCase() === 'ACTIVE'),
    [edges]
  );
  const step3Complete = useMemo(
    () => connections.length > 0,
    [connections]
  );
  const step4Complete = useMemo(
    () => signals.some((s) => s.quality === 'GOOD'),
    [signals]
  );
  const allStepsComplete = step1Complete && step2Complete && step3Complete && step4Complete;

  // Signal quality counts
  const qualityCounts = useMemo(() => {
    let good = 0;
    let uncertain = 0;
    let bad = 0;
    let stale = 0;
    let nodata = 0;
    for (const s of signals) {
      const q = (s.quality || 'NO_DATA').toUpperCase();
      if (q === 'GOOD') good++;
      else if (q === 'UNCERTAIN') uncertain++;
      else if (q === 'BAD') bad++;
      else if (q === 'STALE') stale++;
      else nodata++;
    }
    return { good, uncertain, bad, stale, nodata, total: signals.length };
  }, [signals]);

  const onlineEdgesCount = stats ? stats.edges_online : edges.filter((e) => (e.health || '').toUpperCase() === 'ONLINE' || (e.health || '').toUpperCase() === 'HEALTHY').length;
  const totalEdgesCount = stats ? stats.edges_total : edges.length;
  const onlineConnectionsCount = stats ? stats.connections_online : connections.filter((c) => (c.status || '').toUpperCase() === 'ACTIVE' && (c.health || '').toUpperCase() === 'ONLINE').length;
  const totalConnectionsCount = stats ? stats.connections_total : connections.filter((c) => (c.status || '').toUpperCase() !== 'ARCHIVED').length;

  const lastDataText = stats?.last_data_at ? timeAgo(stats.last_data_at) : (signals[0]?.lastUpdated ? timeAgo(signals[0].lastUpdated) : '—');
  const messagesPerMin = stats?.messages_per_min || 0;

  // Latest 6 signals
  const latestSignals = useMemo(() => {
    return [...signals]
      .sort((a, b) => new Date(b.lastUpdated || 0).getTime() - new Date(a.lastUpdated || 0).getTime())
      .slice(0, 6);
  }, [signals]);

  // Formatted recent activity (up to 5 items)
  const recentActivities = useMemo(() => {
    return activities.slice(0, 5);
  }, [activities]);

  return (
    <div className="space-y-6">
      {/* Top Header / Scope */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Overview</h1>
          <p className="text-[13px] text-[#657794]">
            {currentPlant?.name && currentPlant.id ? `Showing ${currentPlant.name}` : 'Showing all sites'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
              void loadOverview();
            }}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate('/collector/add-data')}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add data
          </Button>
        </div>
      </div>

      {/* Get Started Checklist (TC-UI-OV-01..03) */}
      {!checklistDismissed && !allStepsComplete && (
        <Card className="border border-[#CBD5E1] bg-gradient-to-r from-blue-50/50 to-indigo-50/30 p-5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[14px] font-bold text-[#111B37] flex items-center gap-2">
                Get started with FactoriX
              </h2>
              <p className="text-[12px] text-[#657794] mt-0.5">
                Complete these 4 steps to connect your factory and start capturing live operations data.
              </p>
            </div>
            <button
              onClick={() => {
                setChecklistDismissed(true);
                localStorage.setItem('fx.getStarted.hidden', 'true');
              }}
              className="text-[12px] text-[#657794] hover:text-[#111B37] underline"
            >
              Hide
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
            {/* Step 1 */}
            <div className={`p-3 rounded-lg border ${step1Complete ? 'bg-white/80 border-emerald-200' : 'bg-white border-slate-200'} flex flex-col justify-between`}>
              <div className="flex items-start gap-2.5">
                {step1Complete ? (
                  <CheckCircle2 className="w-4 h-4 text-[#0DBA67] flex-shrink-0 mt-0.5" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-300 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-[12px] font-semibold text-[#111B37]">1. Build factory model</div>
                  <div className="text-[11px] text-[#657794] mt-0.5">Define your sites, areas, lines & machines.</div>
                </div>
              </div>
              {!step1Complete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 text-[11px] h-7 w-full justify-between"
                  onClick={() => navigate('/factory/structure')}
                >
                  Build your factory model
                  <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              )}
            </div>

            {/* Step 2 */}
            <div className={`p-3 rounded-lg border ${step2Complete ? 'bg-white/80 border-emerald-200' : 'bg-white border-slate-200'} flex flex-col justify-between`}>
              <div className="flex items-start gap-2.5">
                {step2Complete ? (
                  <CheckCircle2 className="w-4 h-4 text-[#0DBA67] flex-shrink-0 mt-0.5" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-300 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-[12px] font-semibold text-[#111B37]">2. Add data connection</div>
                  <div className="text-[11px] text-[#657794] mt-0.5">Connect MQTT, Modbus, OPC UA or HTTP.</div>
                </div>
              </div>
              {!step2Complete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 text-[11px] h-7 w-full justify-between"
                  onClick={() => navigate('/collector/connections')}
                >
                  View Connections
                  <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              )}
            </div>

            {/* Step 3 */}
            <div className={`p-3 rounded-lg border ${step3Complete ? 'bg-white/80 border-emerald-200' : 'bg-white border-slate-200'} flex flex-col justify-between`}>
              <div className="flex items-start gap-2.5">
                {step3Complete ? (
                  <CheckCircle2 className="w-4 h-4 text-[#0DBA67] flex-shrink-0 mt-0.5" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-300 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-[12px] font-semibold text-[#111B37]">3. Add data connection</div>
                  <div className="text-[11px] text-[#657794] mt-0.5">Connect MQTT, Modbus, or OPC UA.</div>
                </div>
              </div>
              {!step3Complete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 text-[11px] h-7 w-full justify-between"
                  onClick={() => navigate('/collector/add-data')}
                >
                  Add a data connection
                  <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              )}
            </div>

            {/* Step 4 */}
            <div className={`p-3 rounded-lg border ${step4Complete ? 'bg-white/80 border-emerald-200' : 'bg-white border-slate-200'} flex flex-col justify-between`}>
              <div className="flex items-start gap-2.5">
                {step4Complete ? (
                  <CheckCircle2 className="w-4 h-4 text-[#0DBA67] flex-shrink-0 mt-0.5" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-300 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-[12px] font-semibold text-[#111B37]">4. Receive first values</div>
                  <div className="text-[11px] text-[#657794] mt-0.5">Verify signals report Good quality.</div>
                </div>
              </div>
              {!step4Complete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 text-[11px] h-7 w-full justify-between"
                  onClick={() => navigate('/collector/signals')}
                >
                  Check signals
                  <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* 4 Clickable KPI Cards (TC-UI-OV-03..04) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Resources */}
        <div
          onClick={() => navigate('/factory/structure')}
          className="bg-white border border-[#CBD5E1] rounded-xl p-4 hover:border-blue-400 hover:shadow-sm cursor-pointer transition"
        >
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Resources</span>
            <Layers className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2">
            {resources.length}
          </div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>Hierarchy nodes</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              View hierarchy <ArrowRight className="w-3 h-3 ml-0.5" />
            </span>
          </div>
        </div>

        {/* Signals */}
        <div
          onClick={() => navigate('/collector/signals')}
          className="bg-white border border-[#CBD5E1] rounded-xl p-4 hover:border-blue-400 hover:shadow-sm cursor-pointer transition"
        >
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Signals</span>
            <Radio className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2">
            {qualityCounts.good} of {qualityCounts.total} good
          </div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>{qualityCounts.total > 0 ? `${Math.round((qualityCounts.good / qualityCounts.total) * 100)}% healthy` : 'No signals'}</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              View catalog <ArrowRight className="w-3 h-3 ml-0.5" />
            </span>
          </div>
        </div>

        {/* Connections */}
        <div
          onClick={() => navigate('/collector/connections')}
          className="bg-white border border-[#CBD5E1] rounded-xl p-4 hover:border-blue-400 hover:shadow-sm cursor-pointer transition"
        >
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Connections</span>
            <Network className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2">
            {onlineConnectionsCount} online
          </div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>{totalConnectionsCount} configured</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              Manage connections <ArrowRight className="w-3 h-3 ml-0.5" />
            </span>
          </div>
        </div>

        {/* Data Models */}
        <div
          onClick={() => navigate('/models')}
          className="bg-white border border-[#CBD5E1] rounded-xl p-4 hover:border-blue-400 hover:shadow-sm cursor-pointer transition"
        >
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Data Models</span>
            <Database className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2">
            {outputGroups.length} models
          </div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>Model Catalog</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              View catalog <ArrowRight className="w-3 h-3 ml-0.5" />
            </span>
          </div>
        </div>
      </div>

      {/* Middle Row: Data Collection Summary & Donut Data Quality */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Data Collection Card (TC-UI-OV-05) */}
        <Card className="lg:col-span-2 p-5 border border-[#CBD5E1] bg-white">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Data collection</h3>
              <p className="text-[12px] text-[#657794]">Real-time ingestion across edges and active connections</p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  onlineEdgesCount > 0 && onlineConnectionsCount > 0
                    ? 'bg-[#0DBA67]'
                    : onlineEdgesCount === 0 && totalEdgesCount > 0
                    ? 'bg-[#EF4444]'
                    : 'bg-[#F59E0B]'
                }`}
              />
              <span className="text-[12px] font-medium text-[#111B37]">
                {onlineEdgesCount > 0 && onlineConnectionsCount > 0
                  ? 'Collecting normally'
                  : onlineEdgesCount === 0 && totalEdgesCount > 0
                  ? 'Edge offline'
                  : 'Degraded or idle'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Edges online</div>
              <div className="text-[20px] font-bold text-[#111B37] mt-1 tabular-nums">
                {onlineEdgesCount}/{totalEdgesCount}
              </div>
            </div>
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Connections online</div>
              <div className="text-[20px] font-bold text-[#111B37] mt-1 tabular-nums">
                {onlineConnectionsCount}/{totalConnectionsCount}
              </div>
            </div>
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Last data received</div>
              <div className="text-[18px] font-bold text-[#111B37] mt-1">
                {lastDataText}
              </div>
            </div>
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Ingestion rate</div>
              <div className="text-[18px] font-bold text-[#111B37] mt-1 tabular-nums">
                {messagesPerMin > 0 ? `~${messagesPerMin} msg/min` : '—'}
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[12px]">
            <span className="text-[#657794]">
              Data collector runtime runs internally and synchronizes automatically.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => navigate('/collector/connections')}
            >
              View Connections
            </Button>
          </div>
        </Card>

        {/* Data Quality Donut Card (TC-UI-OV-06, TC-UI-OV-10) */}
        <Card className="p-5 border border-[#CBD5E1] bg-white flex flex-col justify-between">
          <div>
            <h3 className="text-[14px] font-bold text-[#111B37] mb-1">Data quality</h3>
            <p className="text-[12px] text-[#657794] mb-3">Overall health distribution across all active signals</p>
          </div>

          {qualityCounts.total === 0 ? (
            <div className="py-8 text-center my-auto">
              <p className="text-[13px] font-medium text-[#111B37]">No values yet</p>
              <p className="text-[12px] text-[#657794] mt-1 mb-4">
                Connect your machines and protocols to monitor signal quality.
              </p>
              <Button size="sm" variant="primary" onClick={() => navigate('/collector/add-data')}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add data
              </Button>
            </div>
          ) : (
            <DonutChart
              title=""
              total={qualityCounts.total}
              centerLabel="signals"
              segments={[
                { label: 'Good', value: qualityCounts.good, color: '#0DBA67' },
                { label: 'Uncertain', value: qualityCounts.uncertain, color: '#F59E0B' },
                { label: 'Bad', value: qualityCounts.bad, color: '#EF4444' },
                { label: 'Stale', value: qualityCounts.stale, color: '#64748B' },
                { label: 'No data', value: qualityCounts.nodata, color: '#94A3B8' },
              ].filter((s) => s.value > 0 || qualityCounts.total === 0)}
            />
          )}

          <div className="pt-3 border-t border-slate-100 text-[11px] text-[#657794] flex justify-between">
            <span>Evaluated via live quality metrics</span>
            <button
              onClick={() => navigate('/collector/signals')}
              className="text-blue-600 font-medium hover:underline"
            >
              View signals
            </button>
          </div>
        </Card>
      </div>

      {/* Bottom Row: Latest Values Table & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Latest Values (TC-UI-OV-07) */}
        <Card className="lg:col-span-2 p-5 border border-[#CBD5E1] bg-white">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Latest values</h3>
              <p className="text-[12px] text-[#657794]">Recent signal updates across the factory</p>
            </div>
            <button
              onClick={() => navigate('/collector/signals')}
              className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center"
            >
              View all signals <ArrowRight className="w-3 h-3 ml-1" />
            </button>
          </div>

          {latestSignals.length === 0 ? (
            <div className="py-8 text-center text-[#657794] text-[13px]">
              No signal data available yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px] mt-2">
                <thead>
                  <tr className="border-b border-slate-100 text-[#657794] font-semibold">
                    <th className="py-2.5 px-3">Signal</th>
                    <th className="py-2.5 px-3">Resource</th>
                    <th className="py-2.5 px-3">Value</th>
                    <th className="py-2.5 px-3">Quality</th>
                    <th className="py-2.5 px-3 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {latestSignals.map((sig) => {
                    const res = resources.find((r) => r.id === sig.resourceId);
                    const formattedVal =
                      sig.value === null || sig.value === undefined
                        ? '—'
                        : typeof sig.value === 'number'
                        ? Number.isInteger(sig.value)
                          ? String(sig.value)
                          : sig.value.toFixed(2)
                        : String(sig.value);

                    return (
                      <tr
                        key={sig.id}
                        onClick={() => navigate(`/collector/signals?signalId=${sig.id}`)}
                        className="hover:bg-slate-50 cursor-pointer transition"
                      >
                        <td className="py-2.5 px-3 font-medium text-[#111B37]">
                          {sig.displayName || sig.name || sig.key}
                        </td>
                        <td className="py-2.5 px-3 text-[#657794] font-mono text-[11px]">
                          {res?.name || sig.resourcePath || '—'}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-[#111B37] tabular-nums">
                          {formattedVal} {sig.unit ? <span className="font-normal text-[#657794] text-[11px]">{sig.unit}</span> : null}
                        </td>
                        <td className="py-2.5 px-3">
                          <StatusBadge status={sig.quality || 'NO_DATA'} />
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#657794]" title={sig.lastUpdated ? new Date(sig.lastUpdated).toLocaleString() : ''}>
                          {timeAgo(sig.lastUpdated)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Recent Activity (TC-UI-OV-09) */}
        <Card className="p-5 border border-[#CBD5E1] bg-white flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-[14px] font-bold text-[#111B37]">Recent activity</h3>
            </div>

            {recentActivities.length === 0 ? (
              <div className="py-8 text-center text-[#657794] text-[12px]">
                No recent activity recorded yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 mt-2">
                {recentActivities.map((act) => (
                  <div key={act.id} className="py-2.5">
                    <div className="text-[12px] font-medium text-[#111B37]">
                      {act.title}
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-[#657794] mt-0.5">
                      <span>{act.description}</span>
                      <span>{timeAgo(act.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-slate-100 text-[11px] text-[#657794] flex justify-between items-center">
            <span>Audit events logged securely</span>
          </div>
        </Card>
      </div>
    </div>
  );
};
