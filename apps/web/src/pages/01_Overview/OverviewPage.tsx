import React, { useState } from 'react';
import {
  Play,
  Pause,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  XCircle,
  Cpu,
  HardDrive,
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

function deriveCollectorHealth(collectorLabel: string): {
  badge: string;
  variant: BadgeVariant;
  tone: 'healthy' | 'offline' | 'degraded' | 'unknown';
  summary: string;
  detail: string;
} {
  const lower = collectorLabel.toLowerCase();
  if (
    lower.includes('waiting') ||
    lower.includes('not enrolled') ||
    lower.includes('no edge') ||
    lower.includes('no site')
  ) {
    return {
      badge: 'NOT ENROLLED',
      variant: 'neutral',
      tone: 'unknown',
      summary: 'No collector enrolled yet',
      detail: 'Enroll an edge appliance for a site before treating health as normal',
    };
  }
  if (lower.includes('offline') || lower.includes('unreachable') || lower.includes('down')) {
    return {
      badge: 'OFFLINE',
      variant: 'error',
      tone: 'offline',
      summary: 'Collector is offline',
      detail: collectorLabel,
    };
  }
  if (lower.includes('degraded') || lower.includes('warning')) {
    return {
      badge: 'DEGRADED',
      variant: 'warning',
      tone: 'degraded',
      summary: 'Collector reporting degraded health',
      detail: collectorLabel,
    };
  }
  if (lower.includes('healthy') || lower.includes('normal')) {
    return {
      badge: 'HEALTHY',
      variant: 'good',
      tone: 'healthy',
      summary: 'Collector engine healthy',
      detail: collectorLabel,
    };
  }
  return {
    badge: 'UNKNOWN',
    variant: 'warning',
    tone: 'unknown',
    summary: 'Collector state unknown',
    detail: collectorLabel || 'Waiting for edge health',
  };
}

export const OverviewPage: React.FC = () => {
  const {
    isStreaming,
    setIsStreaming,
    currentPlant,
    resources,
    connections,
    signals,
    activities,
    refresh,
    collectorLabel,
  } = useApp();
  const navigate = useNavigate();
  const connected = connections.filter((item) => item.status === 'connected').length;
  const degraded = connections.filter((item) => item.status === 'warning').length;
  const offline = connections.length - connected - degraded;
  const good = signals.filter((item) => item.quality === 'GOOD').length;
  const stale = signals.filter((item) => item.quality === 'STALE' || item.quality === 'UNCERTAIN').length;
  const bad = signals.filter((item) => item.quality === 'BAD').length;
  const machines = resources.filter((item) => item.type === 'machine').length;
  const collectorHealth = deriveCollectorHealth(collectorLabel);

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      {/* Region 1 & 2: Page Heading & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="fx-page-title">Operations Overview</h1>
            <span className="px-2 py-0.5 rounded-full bg-[#E9FBF1] text-[#0A9855] text-[10px] font-bold border border-[#B6F0D1]">
              LIVE MODEL
            </span>
          </div>
          <p className="fx-page-subtitle">
            Telemetry acquisition for <strong className="text-slate-800">{currentPlant.name}</strong>, connection health, and real-time ingestion.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant={isStreaming ? 'danger' : 'primary'}
            icon={isStreaming ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            onClick={() => setIsStreaming(!isStreaming)}
            title={isStreaming ? 'Pause live visualization telemetry rendering' : 'Resume live visualization'}
          >
            {isStreaming ? 'Pause Visualization' : 'Resume Visualization'}
          </Button>
          <Button
            variant="secondary"
            icon={<Plus className="w-4 h-4 text-[#EF1B24]" />}
            onClick={() => navigate('/collector/add-data')}
          >
            Add Connection
          </Button>
          <Button variant="secondary" icon={<RefreshCw className="w-4 h-4 text-[#657794]" />} onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Region 3: KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KPICard
          title="Resources"
          value={resources.length}
          change="From the factory model"
          changeType="positive"
          icon={<Database className="w-5 h-5 text-[#EF1B24]" />}
          iconBg="bg-[#FFF0F1]"
        />
        <KPICard
          title="Signals"
          value={signals.length}
          change={`${good} good`}
          changeType="positive"
          icon={<Activity className="w-5 h-5 text-[#0DBA67]" />}
          iconBg="bg-[#E9FBF1]"
        />
        <KPICard
          title="Connections"
          value={connections.length}
          change={`${connected} healthy`}
          icon={<ArrowUpRight className="w-5 h-5 text-[#2A82E7]" />}
          iconBg="bg-[#EEF5FF]"
        />
        <KPICard
          title="Machines"
          value={machines}
          change="Declared assets"
          icon={<HardDrive className="w-5 h-5 text-[#8858EA]" />}
          iconBg="bg-[#F5F0FF]"
        />
      </div>

      {/* Middle Row: Region 4, 5, 6 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        {/* Region 4: System Health Panel */}
        <Card className="h-[230px]">
          <div className="flex flex-col h-full justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[13px] font-bold text-[#111B37]">Collector Engine Health</span>
                <Badge variant={collectorHealth.variant}>{collectorHealth.badge}</Badge>
              </div>
              <div
                className={`flex items-center gap-3 p-3 rounded-lg mb-3 border ${
                  collectorHealth.tone === 'healthy'
                    ? 'bg-[#E9FBF1]/60 border-[#B6F0D1]'
                    : collectorHealth.tone === 'offline'
                    ? 'bg-[#FFF5F5] border-[#FAC6C9]'
                    : collectorHealth.tone === 'degraded'
                    ? 'bg-[#FFF8E7] border-[#FFE2A4]'
                    : 'bg-[#F1F5FA] border-[#D4DFEC]'
                }`}
              >
                {collectorHealth.tone === 'healthy' ? (
                  <CheckCircle2 className="w-7 h-7 text-[#0DBA67] flex-shrink-0" />
                ) : collectorHealth.tone === 'offline' ? (
                  <XCircle className="w-7 h-7 text-[#F2343B] flex-shrink-0" />
                ) : collectorHealth.tone === 'degraded' ? (
                  <AlertTriangle className="w-7 h-7 text-[#B96B00] flex-shrink-0" />
                ) : (
                  <HelpCircle className="w-7 h-7 text-[#94A3B8] flex-shrink-0" />
                )}
                <div>
                  <div className="text-[13px] font-bold text-[#111B37]">
                    {connections.length
                      ? `${connected} connections reporting`
                      : collectorHealth.summary}
                  </div>
                  <div
                    className={`text-[11px] ${
                      collectorHealth.tone === 'healthy'
                        ? 'text-[#0A9855]'
                        : collectorHealth.tone === 'offline'
                        ? 'text-[#DB2028]'
                        : collectorHealth.tone === 'degraded'
                        ? 'text-[#B96B00]'
                        : 'text-[#657794]'
                    }`}
                  >
                    {collectorHealth.detail}
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[12px] pt-2 border-t border-[#E3EAF3]">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#657794]" />
                <span className="text-[#657794]">Machines:</span>
                <span className="font-bold text-[#111B37]">{machines}</span>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-[#657794]" />
                <span className="text-[#657794]">Signals:</span>
                <span className="font-bold text-[#111B37]">{signals.length}</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Region 5: Connection Health Donut */}
        <Card className="h-[230px]">
          <DonutChart
            title="Connection Status"
            total={connections.length}
            centerLabel="Total Conns"
            segments={[
              { label: 'Connected', value: connected, color: '#0DBA67' },
              { label: 'Degraded', value: degraded, color: '#FFAA23' },
              { label: 'Offline', value: offline, color: '#F2343B' },
            ]}
          />
        </Card>

        {/* Region 6: Signal Status Donut */}
        <Card className="h-[230px]">
          <DonutChart
            title="Signal Quality Index"
            total={signals.length}
            centerLabel="Signals"
            segments={[
              { label: 'Good Quality', value: good, color: '#0DBA67' },
              { label: 'Stale (>10s)', value: stale, color: '#FFAA23' },
              { label: 'Bad / Error', value: bad, color: '#F2343B' },
            ]}
          />
        </Card>
      </div>

      {/* Row 3: Region 7 & 8 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        {/* Region 7: Data Throughput Line Chart */}
        <Card title="Acquisition Throughput (msg/sec)" className="lg:col-span-2">
          <div className="h-[170px] flex items-center">
            <LineChart data={[]} height={150} />
          </div>
        </Card>

        {/* Region 8: Recent System Events */}
        <Card
          title="Recent Operational Events"
          action={
            <button
              type="button"
              onClick={() => navigate('/collector/diagnostics/activity')}
              className="text-[12px] font-semibold text-[#EF1B24] hover:underline"
            >
              View all
            </button>
          }
        >
          <div className="space-y-2.5">
            {activities.slice(0, 5).map((evt) => (
              <div key={evt.id} className="flex items-start gap-2.5 text-[12px] pb-2 border-b border-[#F1F5FA] last:border-0 last:pb-0">
                <span className="font-mono text-[#94A3B8] text-[11px] pt-0.5">{evt.timestamp}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[#111B37] truncate">{evt.source}</div>
                  <div className="text-[#657794] text-[11px] truncate">{evt.message}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Region 9: Live Recent Data Table */}
      <Card
        title="Live Signal Telemetry Samples"
        action={
          <button
            type="button"
            onClick={() => navigate('/collector/signals/live')}
            className="text-[12px] font-semibold text-[#EF1B24] hover:underline"
          >
            Open Live Monitor →
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="fx-table">
            <thead>
              <tr>
                <th>Signal Tag</th>
                <th>Parameter Name</th>
                <th>Factory Resource</th>
                <th>Live Value</th>
                <th>Quality</th>
                <th>Freshness</th>
              </tr>
            </thead>
            <tbody>
              {signals.slice(0, 8).map((row) => (
                <tr key={row.id}>
                  <td className="font-mono font-semibold text-[#111B37] text-[12px]">{row.tag}</td>
                  <td className="font-medium text-[#334568]">{row.name}</td>
                  <td className="text-[#657794] text-[12px]">{row.resourcePath}</td>
                  <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">
                    {String(row.currentValue)} <span className="font-normal text-[#657794] text-[11px]">{row.unit}</span>
                  </td>
                  <td>
                    <Badge variant={row.quality === 'GOOD' ? 'good' : 'warning'}>{row.quality}</Badge>
                  </td>
                  <td className="text-[#94A3B8] text-[11px] font-mono">{row.lastUpdated || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
