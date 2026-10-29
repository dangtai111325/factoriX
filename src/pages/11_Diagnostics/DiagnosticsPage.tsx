import React, { useState } from 'react';
import {
  AlertTriangle,
  RotateCcw,
  Download,
  Trash2,
  CheckCircle2,
  Cpu,
  HardDrive,
  Activity,
  Layers,
  Terminal,
  Play,
  Filter,
  Search,
  ExternalLink,
  ChevronRight,
  X,
  HelpCircle,
  Clock,
  ShieldAlert,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';

interface DiagnosticIssue {
  id: string;
  time: string;
  level: 'ERROR' | 'WARN' | 'INFO';
  source: string;
  protocol: string;
  asset: string;
  register?: string;
  message: string;
  impact: string;
  details: string;
  recommendations: string[];
}

export const DiagnosticsPage: React.FC = () => {
  const { diagnostics } = useApp();

  const [activeProtocolFilter, setActiveProtocolFilter] = useState<string>('all');
  const [activeSeverityFilter, setActiveSeverityFilter] = useState<string>('all');
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [testProgress, setTestProgress] = useState(0);

  // Selected Issue for Drawer
  const [selectedIssue, setSelectedIssue] = useState<DiagnosticIssue | null>({
    id: 'err-1',
    time: '14:28:12',
    level: 'ERROR',
    source: 'Paint_Line_PLC',
    protocol: 'Modbus TCP',
    asset: 'Paint Line - PLC',
    register: '40021',
    message: 'Read timeout on register 40021 (timeout 3000ms)',
    impact: '1 signal unavailable (Paint_Viscosity_Raw)',
    details: 'The data collector sent a read request for register 40021 but did not receive a response within the configured timeout period (3000 ms).',
    recommendations: [
      'Check that the PLC is online and reachable at 192.168.1.100',
      'Verify register address 40021 exists and is permitted in PLC security table',
      'Check network latency and firewall packet drops on port 502',
      'Increase driver timeout from 3000ms to 5000ms in Connection Profile',
    ],
  });

  const [testPingStatus, setTestPingStatus] = useState<string | null>(null);

  const issuesList: DiagnosticIssue[] = [
    {
      id: 'err-1',
      time: '14:28:12',
      level: 'ERROR',
      source: 'Paint_Line_PLC',
      protocol: 'Modbus TCP',
      asset: 'Paint Line - PLC',
      register: '40021',
      message: 'Read timeout on register 40021 (timeout 3000ms)',
      impact: '1 signal unavailable (Paint_Viscosity_Raw)',
      details: 'The data collector sent a read request for register 40021 but did not receive a response within the configured timeout period (3000 ms).',
      recommendations: [
        'Check that the PLC is online and reachable at 192.168.1.100',
        'Verify register address 40021 exists in PLC memory map',
        'Check network latency and firewall on port 502',
        'Increase driver timeout to 5000ms',
      ],
    },
    {
      id: 'warn-2',
      time: '14:27:05',
      level: 'WARN',
      source: 'Energy_Meter',
      protocol: 'Modbus RTU',
      asset: 'Packaging Line 2',
      register: '30014',
      message: 'Invalid value received: -1.0 (out of range 0-500)',
      impact: 'Data quality marked Uncertain for Line2_KW_Total',
      details: 'Ingested raw value was out of engineering bounding rules. Ingestion clamped value to NaN and flagged Uncertain.',
      recommendations: [
        'Verify CT clamp polarity on physical energy meter',
        'Calibrate CT ratio settings in driver scale parameter (factor 0.1)',
      ],
    },
    {
      id: 'info-3',
      time: '14:26:44',
      level: 'INFO',
      source: 'Packaging_MQTT',
      protocol: 'MQTT',
      asset: 'Line B Packaging',
      message: 'Reconnected successfully (192.168.1.45:1883)',
      impact: 'Channel restored to healthy',
      details: 'Client session re-established with CleanSession=true. Subscribed topics resumed at QoS 1.',
      recommendations: ['No action required. Telemetry flowing normally.'],
    },
    {
      id: 'err-4',
      time: '14:25:31',
      level: 'ERROR',
      source: 'Cooling_Tower',
      protocol: 'OPC UA',
      asset: 'Facilities Cooling',
      message: 'Session keep-alive timeout: server unresponsive',
      impact: '4 temperature sensors offline',
      details: 'OPC UA TCP channel lost response to publish requests after 3 retry attempts.',
      recommendations: [
        'Verify OPC UA server service on host 192.168.10.88 is running',
        'Renew self-signed server security certificate if expired',
      ],
    },
    {
      id: 'warn-5',
      time: '14:21:08',
      level: 'WARN',
      source: 'Utilities_Modbus',
      protocol: 'Modbus TCP',
      asset: 'Plant Utilities',
      message: 'Slow response time (420 ms, threshold 200 ms)',
      impact: 'Sampling jitter observed on steam flow meter',
      details: 'Network latency spikes or PLC CPU bottleneck causing scan cycle delay.',
      recommendations: [
        'Reduce polling frequency from 250ms to 1000ms',
        'Prioritize industrial VLAN traffic with QoS 802.1p',
      ],
    },
  ];

  const handleRunAllTests = () => {
    setIsRunningTests(true);
    setTestProgress(10);
    const interval = setInterval(() => {
      setTestProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsRunningTests(false);
          return 100;
        }
        return prev + 30;
      });
    }, 300);
  };

  const handleTestPing = () => {
    setTestPingStatus('testing');
    setTimeout(() => {
      setTestPingStatus('Passed (42ms)');
    }, 700);
  };

  const filteredIssues = issuesList.filter((item) => {
    const protoMatch =
      activeProtocolFilter === 'all' ||
      item.protocol.toLowerCase().includes(activeProtocolFilter.toLowerCase());
    const levelMatch =
      activeSeverityFilter === 'all' || item.level === activeSeverityFilter;
    return protoMatch && levelMatch;
  });

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Heading & Action Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Diagnostics & Root-Cause Troubleshooting</h1>
          <p className="fx-page-subtitle">
            Automated test suites, protocol diagnostics stream, and interactive root-cause fix assistant.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            icon={<Play className="w-4 h-4" />}
            onClick={handleRunAllTests}
            loading={isRunningTests}
          >
            {isRunningTests ? `Running (${testProgress}%)` : 'Run All Test Suites'}
          </Button>
          <Button variant="secondary" icon={<Download className="w-4 h-4" />}>
            Export Dump
          </Button>
          <Button variant="danger" icon={<RotateCcw className="w-4 h-4" />}>
            Restart Collector
          </Button>
        </div>
      </div>

      {/* Region 2: 4 Top KPI Sparkline Cards (From Images 39 & 49) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">Failed Tests</span>
            <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              -2 vs prev hr
            </span>
          </div>
          <div className="text-2xl font-black text-red-600 mt-2">3</div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-red-500 w-[20%]" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">Invalid Signals</span>
            <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
              +6 vs prev hr
            </span>
          </div>
          <div className="text-2xl font-black text-amber-600 mt-2">12</div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-amber-500 w-[35%]" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">Offline Connections</span>
            <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              -1 vs prev hr
            </span>
          </div>
          <div className="text-2xl font-black text-slate-900 mt-2">2</div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-slate-700 w-[12%]" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase">System Warnings</span>
            <span className="text-xs font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
              +5 vs prev hr
            </span>
          </div>
          <div className="text-2xl font-black text-slate-900 mt-2">46</div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-blue-500 w-[55%]" />
          </div>
        </div>
      </div>

      {/* Region 3: 4 Automated Test Suites Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {[
          { title: '1. Connection Tests', sub: 'Connectivity, socket, TCP auth', status: 'Passed (18/20)', good: true },
          { title: '2. Protocol Tests', sub: 'Modbus CRC, OPC session, MQTT', status: '1 Timeout', good: false },
          { title: '3. Signal Integrity', sub: 'Out-of-range & data format', status: '12 Clamped', good: false },
          { title: '4. Storage & Buffer', sub: 'Circular buffer & Timescale sync', status: 'Healthy (0 drop)', good: true },
        ].map((suite, idx) => (
          <div key={idx} className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-slate-900 block">{suite.title}</span>
              <span className="text-[11px] text-slate-500 block">{suite.sub}</span>
            </div>
            <span
              className={`text-[11px] font-bold px-2 py-1 rounded-lg ${
                suite.good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
              }`}
            >
              {suite.status}
            </span>
          </div>
        ))}
      </div>

      {/* Main Split: Protocol Diagnostics Stream (Left 65%) + Issue Details & Fix Assistant (Right 35%) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Left: Protocol Diagnostics Stream */}
        <div className="col-span-12 lg:col-span-7 space-y-3">
          <Card className="p-0 overflow-hidden">
            {/* Filter Toolbar */}
            <div className="p-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {['all', 'Modbus', 'OPC UA', 'MQTT'].map((p) => (
                  <button
                    key={p}
                    onClick={() => setActiveProtocolFilter(p)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-all ${
                      activeProtocolFilter === p
                        ? 'bg-[#EF1B24] text-white'
                        : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {p === 'all' ? 'All Protocols' : p}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                {['all', 'ERROR', 'WARN', 'INFO'].map((l) => (
                  <button
                    key={l}
                    onClick={() => setActiveSeverityFilter(l)}
                    className={`px-2 py-1 text-[11px] font-bold rounded-lg uppercase ${
                      activeSeverityFilter === l
                        ? 'bg-slate-900 text-white'
                        : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Log Stream Table */}
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Level</th>
                    <th>Source / Asset</th>
                    <th>Diagnostic Message</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((issue) => {
                    const isSelected = selectedIssue?.id === issue.id;
                    return (
                      <tr
                        key={issue.id}
                        onClick={() => setSelectedIssue(issue)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-red-50/50 border-l-4 border-l-[#EF1B24]' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="font-mono text-xs text-slate-500">{issue.time}</td>
                        <td>
                          <Badge
                            variant={
                              issue.level === 'ERROR'
                                ? 'error'
                                : issue.level === 'WARN'
                                ? 'warning'
                                : 'good'
                            }
                          >
                            {issue.level}
                          </Badge>
                        </td>
                        <td>
                          <div className="text-xs font-bold text-slate-800">{issue.source}</div>
                          <span className="text-[10px] text-slate-400 font-mono">{issue.protocol}</span>
                        </td>
                        <td className="text-xs text-slate-700 max-w-xs truncate font-mono">
                          {issue.message}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="p-1 text-slate-400 hover:text-[#EF1B24] rounded"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Data Quality Analysis Table (From Image 39 & 49) */}
          <Card title="Signal Quality & Packet Integrity Analysis" className="p-0 overflow-hidden">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Signal Name</th>
                  <th>Asset Source</th>
                  <th>Valid %</th>
                  <th>Invalid Samples</th>
                  <th>Gaps</th>
                  <th>Quality Status</th>
                </tr>
              </thead>
              <tbody className="text-xs font-mono">
                <tr>
                  <td className="font-bold text-slate-800">temperature_1</td>
                  <td className="text-slate-600">Reactor 1</td>
                  <td className="text-amber-600 font-bold">96.8%</td>
                  <td>15</td>
                  <td>3</td>
                  <td>
                    <Badge variant="warning">UNCERTAIN</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="font-bold text-slate-800">pressure_line_a</td>
                  <td className="text-slate-600">Line A_PLC</td>
                  <td className="text-emerald-600 font-bold">99.8%</td>
                  <td>2</td>
                  <td>0</td>
                  <td>
                    <Badge variant="good">GOOD</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="font-bold text-slate-800">line_speed</td>
                  <td className="text-slate-600">Packaging PLC</td>
                  <td className="text-red-600 font-bold">0.0%</td>
                  <td>3,600</td>
                  <td>12</td>
                  <td>
                    <Badge variant="error">OFFLINE</Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>

        {/* Right: Slide-Out Issue Details & Fix Assistant Drawer */}
        <div className="col-span-12 lg:col-span-5">
          {selectedIssue ? (
            <Card className="h-full flex flex-col justify-between p-5 space-y-4 bg-white border border-slate-200 shadow-md">
              <div className="space-y-4">
                <div className="flex items-start justify-between border-b border-slate-100 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-slate-400">{selectedIssue.time}</span>
                      <Badge
                        variant={
                          selectedIssue.level === 'ERROR'
                            ? 'error'
                            : selectedIssue.level === 'WARN'
                            ? 'warning'
                            : 'good'
                        }
                      >
                        {selectedIssue.level}
                      </Badge>
                    </div>
                    <h3 className="text-base font-bold text-slate-900 mt-1">{selectedIssue.source}</h3>
                  </div>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                    {selectedIssue.protocol}
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-slate-500 uppercase font-semibold text-[10px] block">Error Summary</span>
                    <p className="font-mono text-red-600 font-bold bg-red-50 p-2.5 rounded-lg border border-red-200 mt-1">
                      {selectedIssue.message}
                    </p>
                  </div>

                  <div>
                    <span className="text-slate-500 uppercase font-semibold text-[10px] block">Impact Assessment</span>
                    <p className="text-slate-800 font-medium bg-slate-50 p-2.5 rounded-lg border border-slate-200 mt-1">
                      {selectedIssue.impact}
                    </p>
                  </div>

                  <div>
                    <span className="text-slate-500 uppercase font-semibold text-[10px] block">Technical Details</span>
                    <p className="text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-200 mt-1">
                      {selectedIssue.details}
                    </p>
                  </div>
                </div>

                {/* Recommended Fixes Checklist */}
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 mb-2">
                    <Sparkles className="w-4 h-4 text-[#EF1B24]" />
                    <span>Recommended Resolution Checklist</span>
                  </div>
                  <div className="space-y-2">
                    {selectedIssue.recommendations.map((rec, idx) => (
                      <label
                        key={idx}
                        className="flex items-start gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-white text-xs cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          defaultChecked={idx === 0}
                          className="mt-0.5 text-[#EF1B24] rounded focus:ring-[#EF1B24]"
                        />
                        <span className="text-slate-700 leading-tight">{rec}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  className="w-full text-xs"
                  icon={<Activity className="w-3.5 h-3.5" />}
                  onClick={handleTestPing}
                >
                  {testPingStatus ? `Test: ${testPingStatus}` : 'Test Connection Now'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs"
                  onClick={() => alert('Applied auto-reconnect backoff parameters.')}
                >
                  Auto-Fix
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="h-full flex items-center justify-center p-8 text-center text-slate-400 text-xs">
              Select an issue from the diagnostics stream to view root-cause analysis and recommended fixes.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
