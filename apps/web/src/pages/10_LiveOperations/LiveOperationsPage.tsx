import React, { useState, useEffect } from 'react';
import {
  Radio,
  Play,
  Pause,
  Filter,
  Search,
  Maximize2,
  Download,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  Activity,
  Cpu,
  HardDrive,
  Wifi,
  Layers,
  ChevronRight,
  Sparkles,
  CheckCircle2,
  Info,
  X,
  Plus,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { LineChart } from '../../components/charts/LineChart';
import { useApp } from '../../store/AppContext';

export const LiveOperationsPage: React.FC = () => {
  const { signals, isStreaming, setIsStreaming } = useApp();

  const [selectedSignalTag, setSelectedSignalTag] = useState<string>('');
  const [activeSignalsInTrend, setActiveSignalsInTrend] = useState<string[]>([]);
  const [timeRange, setTimeRange] = useState<'15m' | '1h' | '6h' | '24h'>('1h');

  const liveSignalList = signals.map((item) => ({
    id: item.id,
    tag: item.tag,
    name: item.name,
    asset: item.resourcePath,
    source: item.sourceConnectionName || 'Collector',
    value: String(item.currentValue),
    unit: item.unit || '',
    quality: item.quality,
    time: item.lastUpdated || '—',
    min: '—',
    max: '—',
    avg: '—',
  }));


  const activeSelectedSignal =
    liveSignalList.find((s) => s.tag === selectedSignalTag) || liveSignalList[0];

  const trendPoints: Array<{ time: string; value: number }> = [];

  const toggleTrendSignal = (tag: string) => {
    if (activeSignalsInTrend.includes(tag)) {
      if (activeSignalsInTrend.length > 1) {
        setActiveSignalsInTrend(activeSignalsInTrend.filter((t) => t !== tag));
      }
    } else {
      setActiveSignalsInTrend([...activeSignalsInTrend, tag]);
    }
  };

  if (!activeSelectedSignal) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Live Operations</h1>
        <p className="fx-page-subtitle">No signals yet. They appear here after a connection is activated.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Top Command Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="fx-page-title">Live Acquisition Monitor</h1>
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              All Systems Operational
            </span>
          </div>
          <p className="fx-page-subtitle">
            Real-time multi-protocol data acquisition, high-frequency stream waveform, and collector telemetry.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant={isStreaming ? 'danger' : 'primary'}
            icon={isStreaming ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-[#0DBA67]" />}
            onClick={() => setIsStreaming(!isStreaming)}
            title={isStreaming ? 'Pause live visualization telemetry rendering' : 'Resume live visualization rendering'}
          >
            {isStreaming ? 'Pause Visualization' : 'Resume Visualization'}
          </Button>
          <Button variant="secondary" icon={<Download className="w-4 h-4" />}>
            Export CSV
          </Button>
        </div>
      </div>

      {/* Region 2: Telemetry KPI Summary Row (From Image 38 & 48) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase block">Connection Health</span>
            <div className="text-2xl font-black text-slate-900 mt-1">18/20 Online</div>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-slate-500 font-mono">
              <span className="text-emerald-600 font-bold">18 Online</span> ·{' '}
              <span className="text-amber-600 font-bold">2 Degraded</span>
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <Radio className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase block">Active Acquisition Jobs</span>
            <div className="text-2xl font-black text-slate-900 mt-1">5 Running</div>
            <span className="text-[11px] text-slate-500 block mt-1">1,242 messages/min</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
            <Activity className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase block">Buffer Utilization</span>
            <div className="text-2xl font-black text-emerald-600 mt-1">12.9%</div>
            <span className="text-[11px] text-emerald-700 font-semibold block mt-1">Healthy Ring Storage</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-xs">
            CIRC
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase block">Collector Engine Host</span>
            <div className="text-xs font-bold text-slate-800 mt-1 space-y-0.5 font-mono">
              <div>CPU: 32% · RAM: 64%</div>
              <div>Disk: 28% · Net: 48.7 kB/s</div>
            </div>
            <span className="text-[10px] text-slate-400 block mt-0.5">Uptime: 4d 12h 36m</span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-slate-50 text-slate-600 flex items-center justify-center">
            <Cpu className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Region 3: Main Operational Grid: Real-time Table (Left 55%) vs Waveform Trend with Chips (Right 45%) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Left: Real-time Signal Stream Table */}
        <div className="col-span-12 lg:col-span-7 space-y-3">
          <Card className="p-0 overflow-hidden">
            <div className="p-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Real-time Signal Stream ({liveSignalList.length})
                </span>
                <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded-full">
                  1000ms Refresh
                </span>
              </div>
              <div className="relative w-48">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Filter signals..."
                  className="w-full pl-8 pr-2 py-1 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Signal Name</th>
                    <th>Asset Scope</th>
                    <th>Protocol</th>
                    <th>Live Value</th>
                    <th>Quality</th>
                    <th>Last Update</th>
                  </tr>
                </thead>
                <tbody>
                  {liveSignalList.map((sig) => {
                    const isSelected = selectedSignalTag === sig.tag;
                    return (
                      <tr
                        key={sig.id}
                        onClick={() => setSelectedSignalTag(sig.tag)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-red-50/50 border-l-4 border-l-[#EF1B24]' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="font-bold text-xs text-slate-900 font-mono flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              activeSignalsInTrend.includes(sig.tag) ? 'bg-[#EF1B24]' : 'bg-slate-300'
                            }`}
                          />
                          {sig.name}
                        </td>
                        <td className="text-xs text-slate-600">{sig.asset}</td>
                        <td className="text-[11px] font-mono text-slate-500">{sig.source}</td>
                        <td className="text-xs font-extrabold text-[#EF1B24] font-mono tabular-nums">
                          {sig.value} {sig.unit}
                        </td>
                        <td>
                          <Badge variant={sig.quality === 'GOOD' ? 'good' : 'warning'}>
                            {sig.quality.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="font-mono text-xs text-slate-400">{sig.time}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Bottom Signal Inspector Panel (From Image 29 & 38) */}
          <Card title={`Signal Inspector: ${activeSelectedSignal.name}`}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span className="text-slate-500 block text-[10px] uppercase font-semibold">Asset Location</span>
                <span className="font-bold text-slate-900 mt-0.5 block">{activeSelectedSignal.asset}</span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span className="text-slate-500 block text-[10px] uppercase font-semibold">Min (1h Window)</span>
                <span className="font-mono font-bold text-slate-800 mt-0.5 block">
                  {activeSelectedSignal.min} {activeSelectedSignal.unit}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span className="text-slate-500 block text-[10px] uppercase font-semibold">Max (1h Window)</span>
                <span className="font-mono font-bold text-slate-800 mt-0.5 block">
                  {activeSelectedSignal.max} {activeSelectedSignal.unit}
                </span>
              </div>
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <span className="text-slate-500 block text-[10px] uppercase font-semibold">Average (1h)</span>
                <span className="font-mono font-bold text-emerald-600 mt-0.5 block">
                  {activeSelectedSignal.avg} {activeSelectedSignal.unit}
                </span>
              </div>
            </div>
          </Card>
        </div>

        {/* Right: Multi-Trend Canvas & Events Ticker */}
        <div className="col-span-12 lg:col-span-5 space-y-3">
          <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Real-time Multi-Trend</h3>
                <p className="text-xs text-slate-500">Live waveform comparison across selected industrial tags</p>
              </div>
              <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg text-xs font-semibold">
                {['15m', '1h', '6h'].map((r) => (
                  <button
                    key={r}
                    onClick={() => setTimeRange(r as any)}
                    className={`px-2 py-0.5 rounded ${
                      timeRange === r ? 'bg-white shadow text-[#EF1B24]' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Signal Pill Chips Selector */}
            <div className="flex flex-wrap gap-2">
              {['temp_reactor_01', 'pressure_linea', 'flow_rate_inlet'].map((tag) => {
                const isActive = activeSignalsInTrend.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTrendSignal(tag)}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-all ${
                      isActive
                        ? 'bg-[#EF1B24] text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    <span>{tag}</span>
                    {isActive && <CheckCircle2 className="w-3.5 h-3.5" />}
                  </button>
                );
              })}
            </div>

            {/* Min / Max / Avg Stats Summary Chips (From Image 38) */}
            <div className="grid grid-cols-3 gap-2 text-center text-xs bg-slate-50 p-2.5 rounded-xl border border-slate-200">
              <div>
                <span className="text-[10px] text-slate-400 block font-semibold uppercase">Min</span>
                <span className="font-mono font-bold text-slate-800">61.2 °C</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block font-semibold uppercase">Avg</span>
                <span className="font-mono font-bold text-emerald-600">76.3 °C</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block font-semibold uppercase">Max</span>
                <span className="font-mono font-bold text-slate-800">89.6 °C</span>
              </div>
            </div>

            {/* Waveform Chart */}
            <div className="h-64 pt-2">
              <LineChart data={trendPoints} />
            </div>
          </Card>

          {/* Diagnostics & Events Live Ticker (From Image 29, 38, 48) */}
          <Card title="Diagnostics & Live Event Feed">
            <div className="space-y-2 text-xs">
              <div className="p-2 rounded-lg bg-slate-50 border border-slate-200 flex items-start gap-2">
                <span className="font-mono text-slate-400 text-[10px] mt-0.5">14:32:15</span>
                <Badge variant="good">INFO</Badge>
                <span className="text-slate-700 flex-1 truncate">
                  LineA_PLC: Signal updated product_count = 8,532 pcs
                </span>
              </div>
              <div className="p-2 rounded-lg bg-amber-50/60 border border-amber-200 flex items-start gap-2">
                <span className="font-mono text-amber-700 text-[10px] mt-0.5">14:31:03</span>
                <Badge variant="warning">WARN</Badge>
                <span className="text-amber-900 flex-1 truncate">
                  Tank_03: Signal quality uncertain on level sensor 02
                </span>
              </div>
              <div className="p-2 rounded-lg bg-red-50/60 border border-red-200 flex items-start gap-2">
                <span className="font-mono text-red-600 text-[10px] mt-0.5">14:28:12</span>
                <Badge variant="error">ERROR</Badge>
                <span className="text-red-900 flex-1 truncate">
                  Packaging_MQTT: Connection lost (broker timeout)
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
