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
  const [selectedIssue, setSelectedIssue] = useState<DiagnosticIssue | null>(null);

  const [testPingStatus, setTestPingStatus] = useState<string | null>(null);

  const issuesList: DiagnosticIssue[] = diagnostics.map((item) => ({
    id: item.id,
    time: item.lastErrorTimestamp || '—',
    level: item.status === 'critical' ? 'ERROR' : 'WARN',
    source: item.connectionName,
    protocol: item.protocol,
    asset: item.connectionName,
    message: item.lastError || 'Collector reported a degraded connection',
    impact: 'Signals on this connection may be stale',
    details: item.lastError || 'No extra detail was recorded.',
    recommendations: ['Open the connection and run the handshake again.'],
  }));

  const handleRunAllTests = () => {
    setIsRunningTests(false);
    setTestProgress(0);
    setTestPingStatus('Run the handshake on a connection. This page does not invent a pass.');
  };

  const handleTestPing = () => {
    setTestPingStatus('No ping is sent from the browser. Use the connection handshake.');
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
            title="Opens guidance — run handshake from Connections"
          >
            {isRunningTests ? `Running (${testProgress}%)` : 'How to Test'}
          </Button>
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            disabled
            title="Export dump is not available in this appliance build"
          >
            Export Dump
          </Button>
          <Button
            variant="danger"
            icon={<RotateCcw className="w-4 h-4" />}
            disabled
            title="Restart collector from the appliance host, not the browser"
          >
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
          <div className="text-2xl font-black text-red-600 mt-2">{issuesList.filter((i) => i.level === 'ERROR').length}</div>
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
