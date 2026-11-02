import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  XCircle,
  Cpu,
  Database,
  Activity,
  ArrowUpRight,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { KPICard } from '../../components/common/KPICard';
import { Badge } from '../../components/common/Badge';
import type { BadgeVariant } from '../../components/common/Badge';
import { DonutChart } from '../../components/charts/DonutChart';
import { LineChart } from '../../components/charts/LineChart';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import type { ActivityEvent, ResourceNode } from '../../types';
import { absoluteUtc7, relativeAge } from '../../utils/relativeTime';

function eventSentence(evt: ActivityEvent, resources: ResourceNode[]): string {
  if (evt.eventType === 'SIGNAL_BULK') {
    const created = Number(evt.details?.created);
    const host = resources.find((item) => item.id === evt.entityId);
    const count =
      Number.isFinite(created) && created > 0
        ? `${created} signal${created === 1 ? '' : 's'}`
        : 'Signals';
    return `${count} created${host ? ` on ${host.code || host.name}` : ''}`;
  }
  return evt.message;
}

export const OverviewPage: React.FC = () => {
  const {
    currentPlant,
    resources,
    connections,
    signals,
    activities,
    edges,
    refresh,
  } = useApp();
  const navigate = useNavigate();
  const connected = connections.filter((item) => item.status === 'connected').length;
  const degraded = connections.filter((item) => item.status === 'warning').length;
  const offline = Math.max(0, connections.length - connected - degraded);
  const good = signals.filter((item) => item.quality === 'GOOD').length;
  const stale = signals.filter((item) => item.quality === 'STALE' || item.quality === 'UNCERTAIN').length;
  const bad = signals.filter((item) => item.quality === 'BAD').length;
  const machines = resources.filter((item) => item.type === 'machine').length;
  const enrolledOnline = edges.filter(
    (e) =>
      e.enrollmentStatus === 'ENROLLED' &&
      !['OFFLINE', 'DEGRADED'].includes(String(e.health || '').toUpperCase()),
  ).length;
  const lastSignalAge = useMemo(() => {
    const times = signals
      .map((s) => Date.parse(s.lastUpdated || ''))
      .filter((n) => Number.isFinite(n));
    if (!times.length) return null;
    return Math.max(...times);
  }, [signals]);

  let collectionBadge: string = 'Not set up';
  let collectionVariant: BadgeVariant = 'neutral';
  let collectionTone: 'healthy' | 'offline' | 'degraded' | 'unknown' = 'unknown';
  let collectionSummary = 'No edges enrolled yet';
  let collectionDetail = 'Create a site and enroll an edge before collecting data';
  if (edges.some((e) => e.enrollmentStatus === 'ENROLLED' && String(e.health).toUpperCase() === 'OFFLINE')) {
    collectionBadge = 'Offline';
    collectionVariant = 'error';
    collectionTone = 'offline';
    collectionSummary = 'An enrolled edge is offline';
    collectionDetail = 'Open Edges to check heartbeat and network';
  } else if (enrolledOnline > 0) {
    collectionBadge = 'Online';
    collectionVariant = 'good';
    collectionTone = 'healthy';
    collectionSummary = `${enrolledOnline} edge online · ${connected} connections healthy`;
    collectionDetail = lastSignalAge
      ? `Last data ${relativeAge(new Date(lastSignalAge).toISOString())}`
      : 'Waiting for first values';
  } else if (edges.length) {
    collectionBadge = 'Not enrolled';
    collectionVariant = 'warning';
    collectionTone = 'degraded';
    collectionSummary = 'Edge exists but is not enrolled';
    collectionDetail = 'Issue a token or queue appliance enroll from Edges';
  }

  const stepModel = resources.length > 0;
  const stepEdge = edges.some((edge) => edge.enrollmentStatus === 'ENROLLED');
  const stepConnection = connections.length > 0;
  const stepValues = signals.some(
    (signal) => signal.currentValue !== '—' && String(signal.currentValue) !== '',
  );
  const showOnboarding = !(stepModel && stepEdge && stepConnection && stepValues);
  const [throughput, setThroughput] = useState<{ time: string; value: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const overview = await api<{ ingest_per_minute?: number }>('/api/v1/overview');
        if (cancelled) return;
        const perMinute = Number(overview.ingest_per_minute || 0);
        if (!Number.isFinite(perMinute) || perMinute <= 0) return;
        const label = new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        setThroughput((prev) =>
          [...prev, { time: label, value: Math.round((perMinute / 60) * 100) / 100 }].slice(-16),
        );
      } catch {
        /* empty chart stays */
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 20000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Operations Overview</h1>
          <p className="fx-page-subtitle">
            {currentPlant.name} at a glance
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            icon={<Plus className="w-4 h-4 text-[#EF1B24]" />}
            onClick={() => navigate('/acquisition/add-data')}
          >
            Add connection
          </Button>
          <Button
            variant="secondary"
            icon={<RefreshCw className="w-4 h-4 text-[#657794]" />}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {showOnboarding && (
        <Card className="p-4 border-[#BED7F7] bg-[#EEF5FF]/40">
          <p className="text-[13px] font-bold text-[#111B37] mb-2">Get started</p>
          <ol className="text-[12px] text-[#334568] space-y-1 list-decimal list-inside">
            <li className={stepModel ? 'line-through text-[#94A3B8]' : ''}>Model your factory</li>
            <li className={stepEdge ? 'line-through text-[#94A3B8]' : ''}>Check edge status</li>
            <li className={stepConnection ? 'line-through text-[#94A3B8]' : ''}>Add a data connection</li>
            <li className={stepValues ? 'line-through text-[#94A3B8]' : ''}>Verify first values</li>
          </ol>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <button type="button" className="text-left" onClick={() => navigate('/factory/structure')}>
          <KPICard
            title="Resources"
            value={resources.length}
            change={`${resources.length} in the model`}
            changeType="positive"
            icon={<Database className="w-5 h-5 text-[#EF1B24]" />}
            iconBg="bg-[#FFF0F1]"
          />
        </button>
        <button type="button" className="text-left" onClick={() => navigate('/signals')}>
          <KPICard
            title="Signals"
            value={signals.length}
            change={signals.length ? `${good} of ${signals.length} good` : '0 good'}
            changeType={good > 0 ? 'positive' : 'neutral'}
            icon={<Activity className="w-5 h-5 text-[#0DBA67]" />}
            iconBg="bg-[#E9FBF1]"
          />
        </button>
        <button type="button" className="text-left" onClick={() => navigate('/acquisition/connections')}>
          <KPICard
            title="Connections"
            value={connections.length}
            change={`${connected} healthy`}
            icon={<ArrowUpRight className="w-5 h-5 text-[#2A82E7]" />}
            iconBg="bg-[#EEF5FF]"
          />
        </button>
        <button type="button" className="text-left" onClick={() => navigate('/factory/structure')}>
          <KPICard
            title="Machines"
            value={machines}
            change={`${machines} machines`}
            icon={<Cpu className="w-5 h-5 text-[#8858EA]" />}
            iconBg="bg-[#F5F0FF]"
          />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        <Card className="h-[230px]">
          <div className="flex flex-col h-full justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[13px] font-bold text-[#111B37]">Data collection</span>
                <Badge variant={collectionVariant}>{collectionBadge}</Badge>
              </div>
              <div
                className={`flex items-center gap-3 p-3 rounded-lg mb-3 border ${
                  collectionTone === 'healthy'
                    ? 'bg-[#E9FBF1]/60 border-[#B6F0D1]'
                    : collectionTone === 'offline'
                      ? 'bg-[#FFF5F5] border-[#FAC6C9]'
                      : collectionTone === 'degraded'
                        ? 'bg-[#FFF8E7] border-[#FFE2A4]'
                        : 'bg-[#F1F5FA] border-[#D4DFEC]'
                }`}
              >
                {collectionTone === 'healthy' ? (
                  <CheckCircle2 className="w-7 h-7 text-[#0DBA67] flex-shrink-0" />
                ) : collectionTone === 'offline' ? (
                  <XCircle className="w-7 h-7 text-[#F2343B] flex-shrink-0" />
                ) : collectionTone === 'degraded' ? (
                  <AlertTriangle className="w-7 h-7 text-[#B96B00] flex-shrink-0" />
                ) : (
                  <HelpCircle className="w-7 h-7 text-[#94A3B8] flex-shrink-0" />
                )}
                <div>
                  <div className="text-[13px] font-bold text-[#111B37]">{collectionSummary}</div>
                  <div className="text-[11px] text-[#657794]">{collectionDetail}</div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[12px] pt-2 border-t border-[#E3EAF3]">
              <div className="flex items-center gap-2">
                <span className="text-[#657794]">Machines:</span>
                <span className="font-bold text-[#111B37]">{machines}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#657794]">Signals:</span>
                <span className="font-bold text-[#111B37]">{signals.length}</span>
              </div>
            </div>
          </div>
        </Card>

        <Card className="h-[230px]">
          <DonutChart
            title="Connection status"
            total={connections.length}
            centerLabel="Connections"
            segments={[
              { label: 'Connected', value: connected, color: '#0DBA67' },
              { label: 'Degraded', value: degraded, color: '#FFAA23' },
              { label: 'Offline', value: offline, color: '#F2343B' },
            ]}
          />
        </Card>

        <Card className="h-[230px]">
          <DonutChart
            title="Data quality"
            total={signals.length}
            centerLabel="Signals"
            segments={[
              { label: 'Good', value: good, color: '#0DBA67' },
              { label: 'Stale', value: stale, color: '#FFAA23' },
              { label: 'Bad', value: bad, color: '#F2343B' },
            ]}
          />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        <Card title="Acquisition throughput (msg/sec)" className="lg:col-span-2">
          {throughput.length ? (
            <LineChart data={throughput} height={170} />
          ) : (
            <div className="h-[170px] flex items-center justify-center text-[13px] text-[#657794]">
              No data in the last 15 minutes
            </div>
          )}
        </Card>

        <Card
          title="Recent events"
          action={
            <button
              type="button"
              onClick={() => navigate('/live/activity')}
              className="text-[12px] font-semibold text-[#EF1B24] hover:underline"
            >
              View all
            </button>
          }
        >
          <div className="space-y-2.5">
            {!activities.length && (
              <p className="text-[12px] text-[#657794]">No events yet.</p>
            )}
            {activities.slice(0, 5).map((evt) => (
              <div
                key={evt.id}
                className="flex items-start gap-2.5 text-[12px] pb-2 border-b border-[#F1F5FA] last:border-0 last:pb-0"
              >
                <span className="font-mono text-[#94A3B8] text-[11px] pt-0.5" title={absoluteUtc7(evt.timestamp)}>
                  {relativeAge(evt.timestamp)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[#111B37] truncate">
                    {eventSentence(evt, resources)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Latest values"
        action={
          <button
            type="button"
            onClick={() => navigate('/live/monitor')}
            className="text-[12px] font-semibold text-[#EF1B24] hover:underline"
          >
            Open live monitor →
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="fx-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Name</th>
                <th>Resource</th>
                <th>Value</th>
                <th>Quality</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {!signals.length && (
                <tr>
                  <td colSpan={6} className="text-[12px] text-[#657794]">
                    No signals yet.
                  </td>
                </tr>
              )}
              {signals.slice(0, 8).map((row) => (
                <tr key={row.id}>
                  <td className="font-mono font-semibold text-[#111B37] text-[12px]">{row.tag}</td>
                  <td className="font-medium text-[#334568]">{row.name}</td>
                  <td className="text-[#657794] text-[12px]">{row.resourcePath}</td>
                  <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">
                    {String(row.currentValue)}{' '}
                    <span className="font-normal text-[#657794] text-[11px]">{row.unit}</span>
                  </td>
                  <td>
                    <Badge variant={row.quality === 'GOOD' ? 'good' : row.quality === 'BAD' ? 'error' : 'warning'}>
                      {row.quality}
                    </Badge>
                  </td>
                  <td className="text-[#94A3B8] text-[11px] font-mono" title={absoluteUtc7(row.lastUpdated)}>
                    {relativeAge(row.lastUpdated)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
