import React, { useState } from 'react';
import {
  Play,
  Square,
  Plus,
  RefreshCw,
  CheckCircle2,
  Cpu,
  HardDrive,
  Database,
  Activity,
  ArrowUpRight,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { KPICard } from '../../components/common/KPICard';
import { Badge } from '../../components/common/Badge';
import { DonutChart } from '../../components/charts/DonutChart';
import { LineChart } from '../../components/charts/LineChart';
import {
  overviewKpis,
  connectionHealthStats,
  signalHealthStats,
  throughputTrend,
  recentSystemEvents,
  liveDataTable,
} from '../../fixtures/overviewData';
import { useNavigate } from 'react-router-dom';

export const OverviewPage: React.FC = () => {
  const [isRunning, setIsRunning] = useState(true);
  const navigate = useNavigate();

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      {/* Region 1 & 2: Page Heading & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Operations Overview</h1>
          <p className="fx-page-subtitle">
            Global factory telemetry acquisition, connection health, and real-time data ingestion.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant={isRunning ? 'danger' : 'primary'}
            icon={isRunning ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
            onClick={() => setIsRunning(!isRunning)}
          >
            {isRunning ? 'Stop Collector' : 'Start Collector'}
          </Button>
          <Button
            variant="secondary"
            icon={<Plus className="w-4 h-4 text-[#EF1B24]" />}
            onClick={() => navigate('/acquisition/add-data')}
          >
            Add Connection
          </Button>
          <Button variant="secondary" icon={<RefreshCw className="w-4 h-4 text-[#657794]" />}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Region 3: KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KPICard
          title={overviewKpis[0].title}
          value={overviewKpis[0].value}
          total={overviewKpis[0].total}
          change={overviewKpis[0].change}
          changeType="positive"
          icon={<Database className="w-5 h-5 text-[#EF1B24]" />}
          iconBg="bg-[#FFF0F1]"
        />
        <KPICard
          title={overviewKpis[1].title}
          value={overviewKpis[1].value}
          change={overviewKpis[1].change}
          changeType="positive"
          icon={<Activity className="w-5 h-5 text-[#0DBA67]" />}
          iconBg="bg-[#E9FBF1]"
        />
        <KPICard
          title={overviewKpis[2].title}
          value={overviewKpis[2].value}
          unit={overviewKpis[2].unit}
          change={overviewKpis[2].change}
          icon={<ArrowUpRight className="w-5 h-5 text-[#2A82E7]" />}
          iconBg="bg-[#EEF5FF]"
        />
        <KPICard
          title={overviewKpis[3].title}
          value={overviewKpis[3].value}
          total={overviewKpis[3].total}
          change={overviewKpis[3].change}
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
                <Badge variant="good">NORMAL</Badge>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-[#E9FBF1]/60 border border-[#B6F0D1] mb-3">
                <CheckCircle2 className="w-7 h-7 text-[#0DBA67] flex-shrink-0" />
                <div>
                  <div className="text-[13px] font-bold text-[#111B37]">99.98% High Availability</div>
                  <div className="text-[11px] text-[#0A9855]">All 4 collector workers active & responsive</div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[12px] pt-2 border-t border-[#E3EAF3]">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#657794]" />
                <span className="text-[#657794]">CPU Load:</span>
                <span className="font-bold text-[#111B37]">14.8%</span>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-[#657794]" />
                <span className="text-[#657794]">Uptime:</span>
                <span className="font-bold text-[#111B37]">3d 14h 22m</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Region 5: Connection Health Donut */}
        <Card className="h-[230px]">
          <DonutChart
            title="Connection Status"
            total={connectionHealthStats.total}
            centerLabel="Total Conns"
            segments={[
              { label: 'Connected', value: connectionHealthStats.connected, color: '#0DBA67' },
              { label: 'Degraded', value: connectionHealthStats.degraded, color: '#FFAA23' },
              { label: 'Offline', value: connectionHealthStats.offline, color: '#F2343B' },
            ]}
          />
        </Card>

        {/* Region 6: Signal Status Donut */}
        <Card className="h-[230px]">
          <DonutChart
            title="Signal Quality Index"
            total={signalHealthStats.total}
            centerLabel="Signals"
            segments={[
              { label: 'Good Quality', value: signalHealthStats.good, color: '#0DBA67' },
              { label: 'Stale (>10s)', value: signalHealthStats.stale, color: '#FFAA23' },
              { label: 'Bad / Error', value: signalHealthStats.bad, color: '#F2343B' },
            ]}
          />
        </Card>
      </div>

      {/* Row 3: Region 7 & 8 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
        {/* Region 7: Data Throughput Line Chart */}
        <Card title="Acquisition Throughput (msg/sec)" className="lg:col-span-2">
          <div className="h-[170px] flex items-center">
            <LineChart data={throughputTrend} height={150} />
          </div>
        </Card>

        {/* Region 8: Recent System Events */}
        <Card
          title="Recent Operational Events"
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
            {recentSystemEvents.map((evt) => (
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
            onClick={() => navigate('/live/monitor')}
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
              {liveDataTable.map((row) => (
                <tr key={row.id}>
                  <td className="font-mono font-semibold text-[#111B37] text-[12px]">{row.tag}</td>
                  <td className="font-medium text-[#334568]">{row.name}</td>
                  <td className="text-[#657794] text-[12px]">{row.resource}</td>
                  <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">
                    {row.value} <span className="font-normal text-[#657794] text-[11px]">{row.unit}</span>
                  </td>
                  <td>
                    <Badge variant={row.quality === 'GOOD' ? 'good' : 'warning'}>{row.quality}</Badge>
                  </td>
                  <td className="text-[#94A3B8] text-[11px] font-mono">{row.freshness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
