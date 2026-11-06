import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers,
  Radio,
  Network,
  Database,
  CheckCircle2,
  Circle,
  ArrowRight,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../features/auth';
import { Button } from '../../components/common/Button';
import { DonutChart } from '../../components/charts/DonutChart';
import { StatusBadge } from '../../components/common/StatusBadge';
import { refreshCollectorHealth, useCollectorHealth } from '../../components/shell/collectorHealth';
import { api } from '../../api/client';
import { ACCOUNT_EVENTS, AuditRow, describeAudit } from '../../utils/auditText';
import { formatTimestamp, formatValue, normalizeQuality, timeAgo } from '../../lib/format';

interface OverviewStats {
  resources: number;
  machines: number;
  active_connections: number;
  connections_online: number;
  connections_total: number;
  last_data_at: string | null;
  ingest_per_minute: number;
  messages_per_min: number;
}

const CHECKLIST_KEY = 'fx.getStarted.hidden';

function readChecklistHidden(): boolean {
  try {
    return localStorage.getItem(CHECKLIST_KEY) === 'true';
  } catch {
    return false;
  }
}

type Tone = 'good' | 'warning' | 'error' | 'neutral';

const TONE_DOT: Record<Tone, string> = {
  good: 'bg-[#0DBA67]',
  warning: 'bg-[#F59E0B]',
  error: 'bg-[#EF4444]',
  neutral: 'bg-[#94A3B8]',
};

interface ChecklistStep {
  key: string;
  title: string;
  description: string;
  done: boolean;
  action: { label: string; to: string };
}

export const OverviewPage: React.FC = () => {
  const navigate = useNavigate();
  const { resources, connections, signals, outputGroups, currentPlant, refresh } = useApp();
  const { state: authState } = useAuth();
  const collector = useCollectorHealth();

  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRow[] | null>(null);
  const [checklistDismissed, setChecklistDismissed] = useState<boolean>(readChecklistHidden);
  // Names of resources that are no longer in the live model (e.g. archived), resolved on demand.
  const [extraNames, setExtraNames] = useState<Record<string, string>>({});
  const requestedNames = useRef(new Set<string>());

  const loadOverview = useCallback(async () => {
    const [overview, audit] = await Promise.allSettled([
      api<OverviewStats>('/api/v1/overview'),
      api<{ items?: AuditRow[] }>('/api/v1/audit-events?limit=30'),
    ]);
    if (overview.status === 'fulfilled') setStats(overview.value);
    else console.warn('Overview statistics could not be loaded', overview.reason);
    if (audit.status === 'fulfilled') setAuditRows(audit.value.items || []);
    else console.warn('Recent activity could not be loaded', audit.reason);
  }, []);

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), 10000);
    return () => window.clearInterval(timer);
  }, [loadOverview]);

  // ---- quality ----
  const qualityCounts = useMemo(() => {
    const counts = { good: 0, uncertain: 0, bad: 0, stale: 0, nodata: 0, total: signals.length };
    for (const s of signals) {
      const q = normalizeQuality(s.quality);
      if (q === 'GOOD') counts.good++;
      else if (q === 'UNCERTAIN') counts.uncertain++;
      else if (q === 'BAD') counts.bad++;
      else if (q === 'STALE') counts.stale++;
      else counts.nodata++;
    }
    return counts;
  }, [signals]);

  // ---- connections ----
  const totalConnections = stats ? stats.connections_total : connections.length;
  const onlineConnections = stats
    ? stats.connections_online
    : connections.filter((c) => (c.status || '').toLowerCase() === 'connected').length;

  // ---- getting started (real progress, in the order the product works) ----
  const modelDone = resources.some((r) => r.type === 'machine' || r.type === 'line');
  const connectionDone = totalConnections > 0;
  const collectorDone = collector.state === 'online';
  const valuesDone = qualityCounts.good > 0;
  const steps: ChecklistStep[] = [
    {
      key: 'model',
      title: 'Model your factory',
      description: modelDone
        ? `${resources.length} ${resources.length === 1 ? 'resource' : 'resources'} in the model.`
        : 'Add your sites, areas, lines and machines.',
      done: modelDone,
      action: { label: 'Open hierarchy', to: '/factory/structure' },
    },
    {
      key: 'connection',
      title: 'Connect a data source',
      description: connectionDone
        ? `${totalConnections} ${totalConnections === 1 ? 'connection' : 'connections'} configured.`
        : 'MQTT, Modbus TCP, OPC UA, HTTP or WebSocket.',
      done: connectionDone,
      action: { label: 'Add data', to: '/collector/add-data' },
    },
    {
      key: 'collector',
      title: 'Bring the collector online',
      description: collectorDone ? 'The collector is connected and reporting.' : collector.detail,
      done: collectorDone,
      action: { label: 'View connections', to: '/collector/connections' },
    },
    {
      key: 'values',
      title: 'Receive good values',
      description: valuesDone
        ? `${qualityCounts.good} ${qualityCounts.good === 1 ? 'signal reports' : 'signals report'} good values.`
        : 'Check that your signals report Good quality.',
      done: valuesDone,
      action: { label: 'Check signals', to: '/collector/signals' },
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => !step.done);
  const allStepsComplete = doneCount === steps.length;

  // ---- data collection status ----
  const collection: { tone: Tone; label: string; hint: string } = (() => {
    if (totalConnections === 0 && collector.total === 0) {
      return { tone: 'neutral', label: 'Not configured', hint: 'Add a data connection to start collecting.' };
    }
    if (collector.state === 'loading') {
      return { tone: 'neutral', label: 'Checking…', hint: 'Reading collector status.' };
    }
    if (collector.state === 'not_configured' || collector.state === 'waiting') {
      return { tone: 'neutral', label: 'Waiting for collector', hint: collector.detail };
    }
    if (collector.state === 'offline') {
      return { tone: 'error', label: 'Collector offline', hint: collector.detail };
    }
    if (totalConnections === 0) {
      return { tone: 'neutral', label: 'No connections', hint: 'The collector is online. Add a data connection.' };
    }
    if (collector.state === 'online' && onlineConnections >= totalConnections) {
      return { tone: 'good', label: 'Collecting normally', hint: 'All connections are delivering data.' };
    }
    return {
      tone: 'warning',
      label: 'Attention needed',
      hint:
        collector.state === 'degraded'
          ? collector.detail
          : `${onlineConnections} of ${totalConnections} connections online.`,
    };
  })();

  const lastDataAt =
    stats?.last_data_at ||
    signals.reduce<string>((latest, s) => (s.lastUpdated && s.lastUpdated > latest ? s.lastUpdated : latest), '') ||
    null;
  const messagesPerMin = stats?.messages_per_min || 0;

  const latestSignals = useMemo(
    () =>
      [...signals]
        .filter((s) => Boolean(s.lastUpdated))
        .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
        .slice(0, 6),
    [signals],
  );

  // ---- recent activity ----
  const names = useMemo(() => {
    const map = new Map<string, string>();
    resources.forEach((r) => map.set(r.id, r.name));
    connections.forEach((c) => map.set(c.id, c.name));
    signals.forEach((s) => map.set(s.id, s.displayName || s.key || s.name));
    outputGroups.forEach((g) => map.set(g.id, g.name));
    collector.edges.forEach((e) => map.set(e.id, e.name));
    Object.entries(extraNames).forEach(([id, name]) => {
      if (!map.has(id)) map.set(id, name);
    });
    return map;
  }, [resources, connections, signals, outputGroups, collector.edges, extraNames]);
  const currentActorId = authState.status === 'authenticated' ? authState.user.admin_id : undefined;
  const recentActivities = useMemo(
    () =>
      (auditRows || [])
        .filter((row) => !ACCOUNT_EVENTS.has(row.event_type))
        .slice(0, 6)
        .map((row) => ({ row, text: describeAudit(row, { names, currentActorId, currentActorName: 'You' }) })),
    [auditRows, names, currentActorId],
  );

  useEffect(() => {
    const missing = recentActivities
      .map(({ row }) => row)
      .filter((row) => row.entity_type === 'resource' && row.entity_id && !names.has(String(row.entity_id)))
      .map((row) => String(row.entity_id))
      .filter((id) => !requestedNames.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => requestedNames.current.add(id));
    void Promise.allSettled(
      missing.map((id) => api<{ id: string; name: string }>(`/api/v1/resources/${encodeURIComponent(id)}`)),
    ).then((results) => {
      const found: Record<string, string> = {};
      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value?.id) found[String(result.value.id)] = result.value.name;
      });
      if (Object.keys(found).length) setExtraNames((prev) => ({ ...prev, ...found }));
    });
  }, [recentActivities, names]);

  const hideChecklist = () => {
    setChecklistDismissed(true);
    try {
      localStorage.setItem(CHECKLIST_KEY, 'true');
    } catch {
      // Storage unavailable: hidden for this session only.
    }
  };

  const kpiClass =
    'text-left bg-white border border-[#CBD5E1] rounded-xl p-4 hover:border-blue-400 hover:shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50';

  return (
    <div className="space-y-6">
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
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={() => {
              void refresh().catch((error) => console.warn('Refresh failed', error));
              void loadOverview();
              refreshCollectorHealth();
            }}
          >
            Refresh
          </Button>
          <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => navigate('/collector/add-data')}>
            Add data
          </Button>
        </div>
      </div>

      {!checklistDismissed && !allStepsComplete && (
        <section className="fx-card border border-[#CBD5E1] bg-gradient-to-r from-blue-50/50 to-indigo-50/30 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[14px] font-bold text-[#111B37]">Get started with FactoriX</h2>
              <p className="text-[12px] text-[#657794] mt-0.5">
                {doneCount} of {steps.length} steps done. {nextStep ? `Next: ${nextStep.title.toLowerCase()}.` : ''}
              </p>
              <div
                className="mt-2 h-1.5 w-56 max-w-full rounded-full bg-slate-200 overflow-hidden"
                role="progressbar"
                aria-label="Getting started progress"
                aria-valuemin={0}
                aria-valuemax={steps.length}
                aria-valuenow={doneCount}
              >
                <div className="h-full bg-[#0DBA67] transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
              </div>
            </div>
            <button type="button" onClick={hideChecklist} className="text-[12px] text-[#657794] hover:text-[#111B37] underline">
              Hide
            </button>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
            {steps.map((step, index) => {
              const isNext = nextStep?.key === step.key;
              return (
                <li
                  key={step.key}
                  className={`p-3 rounded-lg border flex flex-col justify-between ${
                    step.done
                      ? 'bg-white/80 border-emerald-200'
                      : isNext
                        ? 'bg-white border-blue-300 shadow-sm'
                        : 'bg-white/70 border-slate-200'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    {step.done ? (
                      <CheckCircle2 className="w-4 h-4 text-[#0DBA67] flex-shrink-0 mt-0.5" aria-label="Done" />
                    ) : (
                      <Circle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isNext ? 'text-blue-400' : 'text-slate-300'}`} aria-label="To do" />
                    )}
                    <div>
                      <div className={`text-[12px] font-semibold ${step.done || isNext ? 'text-[#111B37]' : 'text-[#657794]'}`}>
                        {index + 1}. {step.title}
                      </div>
                      <div className="text-[11px] text-[#657794] mt-0.5">{step.description}</div>
                    </div>
                  </div>
                  {isNext && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 text-[11px] h-7 w-full justify-between"
                      onClick={() => navigate(step.action.to)}
                    >
                      {step.action.label}
                      <ArrowRight className="w-3 h-3 ml-1" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button type="button" onClick={() => navigate('/factory/structure')} className={kpiClass}>
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Resources</span>
            <Layers className="w-4 h-4 text-blue-600" aria-hidden="true" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">{resources.length}</div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>{stats ? `${stats.machines} ${stats.machines === 1 ? 'machine' : 'machines'}` : 'Hierarchy nodes'}</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              View hierarchy <ArrowRight className="w-3 h-3 ml-0.5" aria-hidden="true" />
            </span>
          </div>
        </button>

        <button type="button" onClick={() => navigate('/collector/signals')} className={kpiClass}>
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Signals</span>
            <Radio className="w-4 h-4 text-emerald-600" aria-hidden="true" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">
            {qualityCounts.total === 0 ? '0' : `${qualityCounts.good} of ${qualityCounts.total} good`}
          </div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>
              {qualityCounts.total > 0
                ? `${Math.round((qualityCounts.good / qualityCounts.total) * 100)}% good quality`
                : 'No signals yet'}
            </span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              View signals <ArrowRight className="w-3 h-3 ml-0.5" aria-hidden="true" />
            </span>
          </div>
        </button>

        <button type="button" onClick={() => navigate('/collector/connections')} className={kpiClass}>
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Connections</span>
            <Network className="w-4 h-4 text-indigo-600" aria-hidden="true" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">
            {totalConnections === 0 ? '0' : `${onlineConnections} online`}
          </div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>{totalConnections} configured</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              Manage <ArrowRight className="w-3 h-3 ml-0.5" aria-hidden="true" />
            </span>
          </div>
        </button>

        <button type="button" onClick={() => navigate('/models')} className={kpiClass}>
          <div className="flex items-center justify-between text-[#657794]">
            <span className="text-[12px] font-semibold uppercase tracking-wider">Data models</span>
            <Database className="w-4 h-4 text-purple-600" aria-hidden="true" />
          </div>
          <div className="text-[26px] font-extrabold text-[#111B37] mt-2 tabular-nums">{outputGroups.length}</div>
          <div className="text-[12px] text-[#657794] mt-1 flex items-center justify-between">
            <span>{outputGroups.length === 1 ? 'Model defined' : 'Models defined'}</span>
            <span className="text-blue-600 text-[11px] font-medium flex items-center">
              Model catalog <ArrowRight className="w-3 h-3 ml-0.5" aria-hidden="true" />
            </span>
          </div>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="fx-card lg:col-span-2 p-5 border border-[#CBD5E1] bg-white">
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Data collection</h3>
              <p className="text-[12px] text-[#657794]">Collector and connection status</p>
            </div>
            <div className="flex items-center gap-2" title={collection.hint}>
              <span className={`w-2.5 h-2.5 rounded-full ${TONE_DOT[collection.tone]}`} aria-hidden="true" />
              <span className="text-[12px] font-medium text-[#111B37]">{collection.label}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Collectors online</div>
              <div className="text-[20px] font-bold text-[#111B37] mt-1 tabular-nums">
                {collector.total === 0 ? '—' : `${collector.online}/${collector.total}`}
              </div>
            </div>
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Connections online</div>
              <div className="text-[20px] font-bold text-[#111B37] mt-1 tabular-nums">
                {totalConnections === 0 ? '—' : `${onlineConnections}/${totalConnections}`}
              </div>
            </div>
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Last data received</div>
              <div className="text-[18px] font-bold text-[#111B37] mt-1" title={lastDataAt ? formatTimestamp(lastDataAt) : undefined}>
                {lastDataAt ? timeAgo(lastDataAt) : '—'}
              </div>
            </div>
            <div className="p-3 bg-slate-50/70 rounded-lg border border-slate-100">
              <div className="text-[11px] text-[#657794] uppercase font-semibold">Ingestion rate</div>
              <div className="text-[18px] font-bold text-[#111B37] mt-1 tabular-nums">
                {messagesPerMin > 0 ? `${messagesPerMin} values/min` : '—'}
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-3 text-[12px]">
            <span className="text-[#657794]">{collection.hint}</span>
            <Button size="sm" variant="outline" className="h-7 text-[11px] shrink-0" onClick={() => navigate('/collector/connections')}>
              View connections
            </Button>
          </div>
        </section>

        <section className="fx-card p-5 border border-[#CBD5E1] bg-white flex flex-col justify-between">
          <div>
            <h3 className="text-[14px] font-bold text-[#111B37] mb-1">Data quality</h3>
            <p className="text-[12px] text-[#657794] mb-3">Current quality of all signals</p>
          </div>

          {qualityCounts.total === 0 ? (
            <div className="py-8 text-center my-auto">
              <p className="text-[13px] font-medium text-[#111B37]">No signals yet</p>
              <p className="text-[12px] text-[#657794] mt-1">Quality appears here once signals are bound to the model.</p>
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
              ].filter((s) => s.value > 0)}
            />
          )}

          <div className="pt-3 border-t border-slate-100 text-[11px] text-[#657794] flex justify-end">
            <button type="button" onClick={() => navigate('/collector/signals')} className="text-blue-600 font-medium hover:underline">
              View signals
            </button>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="fx-card lg:col-span-2 p-5 border border-[#CBD5E1] bg-white">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Latest values</h3>
              <p className="text-[12px] text-[#657794]">Most recently updated signals</p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/collector/signals')}
              className="text-[12px] font-semibold text-blue-600 hover:text-blue-700 flex items-center"
            >
              View all signals <ArrowRight className="w-3 h-3 ml-1" aria-hidden="true" />
            </button>
          </div>

          {latestSignals.length === 0 ? (
            <div className="py-8 text-center text-[#657794] text-[13px]">No values received yet.</div>
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
                    const label = sig.displayName || sig.name || sig.key || '';
                    const resourceName = res?.name || sig.resourcePath || '—';
                    return (
                      <tr
                        key={sig.id}
                        tabIndex={0}
                        onClick={() => navigate(`/collector/signals?signalId=${encodeURIComponent(sig.id)}`)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') navigate(`/collector/signals?signalId=${encodeURIComponent(sig.id)}`);
                        }}
                        className="hover:bg-slate-50 cursor-pointer transition focus:outline-none focus-visible:bg-slate-50"
                      >
                        <td className="py-2.5 px-3 font-medium text-[#111B37] max-w-[220px] truncate" title={label}>
                          {label}
                        </td>
                        <td className="py-2.5 px-3 text-[#657794] max-w-[200px] truncate" title={resourceName}>
                          {resourceName}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-[#111B37] tabular-nums font-mono">
                          {formatValue(sig.value)}{' '}
                          {sig.unit ? <span className="font-normal font-sans text-[#657794] text-[11px]">{sig.unit}</span> : null}
                        </td>
                        <td className="py-2.5 px-3">
                          <StatusBadge status={normalizeQuality(sig.quality)} />
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#657794] whitespace-nowrap" title={formatTimestamp(sig.lastUpdated)}>
                          {timeAgo(sig.lastUpdated)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fx-card p-5 border border-[#CBD5E1] bg-white">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <h3 className="text-[14px] font-bold text-[#111B37]">Recent activity</h3>
          </div>

          {auditRows === null ? (
            <div className="py-8 text-center text-[#657794] text-[12px]">Loading…</div>
          ) : recentActivities.length === 0 ? (
            <div className="py-8 text-center text-[#657794] text-[12px]">No changes recorded yet.</div>
          ) : (
            <ol className="divide-y divide-slate-100 mt-1">
              {recentActivities.map(({ row, text: entry }) => (
                <li key={row.id} className="py-2.5 flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                      entry.tone === 'error'
                        ? 'bg-[#EF4444]'
                        : entry.tone === 'warning'
                          ? 'bg-[#F59E0B]'
                          : entry.tone === 'success'
                            ? 'bg-[#0DBA67]'
                            : 'bg-[#94A3B8]'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-[#111B37] break-words">
                      <span className="font-semibold">{entry.actor}</span> {entry.action}
                    </p>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#657794] mt-0.5">
                      <span className="truncate" title={entry.detail}>
                        {entry.detail || ''}
                      </span>
                      <time dateTime={row.occurred_at} title={formatTimestamp(row.occurred_at)} className="whitespace-nowrap shrink-0">
                        {timeAgo(row.occurred_at)}
                      </time>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
};
