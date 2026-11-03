import React, { useState } from 'react';
import {
  Activity,
  ChevronRight,
  Download,
  Play,
  RotateCcw,
  Sparkles,
  ArrowRight,
  HelpCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
  const { diagnostics, connections, signals, collectorLabel } = useApp();
  const navigate = useNavigate();

  const [activeProtocolFilter, setActiveProtocolFilter] = useState<string>('all');
  const [activeSeverityFilter, setActiveSeverityFilter] = useState<string>('all');
  const [selectedIssue, setSelectedIssue] = useState<DiagnosticIssue | null>(null);
  const [testPingStatus, setTestPingStatus] = useState<string | null>(null);
  const [showHowToTest, setShowHowToTest] = useState(false);

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

  const failedTests = issuesList.filter((i) => i.level === 'ERROR').length;
  const systemWarnings = issuesList.filter((i) => i.level === 'WARN').length;
  const invalidSignals = signals.filter((s) => s.quality === 'BAD').length;
  const offlineConnections = connections.filter((c) => {
    const status = (c.status || '').toLowerCase();
    return status === 'disconnected' || status === 'offline' || status === 'unknown' || !c.status;
  }).length;

  const connectedCount = connections.filter((c) => c.status === 'connected').length;
  const degradedCount = connections.filter((c) => c.status === 'warning').length;

  const testSuites = [
    {
      title: '1. Connection Tests',
      sub: 'Connectivity, socket, TCP auth',
      status:
        connections.length === 0
          ? 'Not run — use connection handshake'
          : `${connectedCount} healthy / ${offlineConnections} offline`,
      tone: connections.length === 0 ? 'neutral' : offlineConnections > 0 ? 'bad' : 'good',
    },
    {
      title: '2. Protocol Tests',
      sub: 'Modbus CRC, OPC session, MQTT',
      status:
        diagnostics.length === 0
          ? 'Not run — use connection handshake'
          : failedTests > 0
          ? `${failedTests} error${failedTests === 1 ? '' : 's'}`
          : `${systemWarnings} warning${systemWarnings === 1 ? '' : 's'}`,
      tone: diagnostics.length === 0 ? 'neutral' : failedTests > 0 ? 'bad' : systemWarnings > 0 ? 'warn' : 'good',
    },
    {
      title: '3. Signal Integrity',
      sub: 'Out-of-range & data format',
      status:
        signals.length === 0
          ? 'Not run — use connection handshake'
          : invalidSignals > 0
          ? `${invalidSignals} invalid`
          : `${signals.length} reported`,
      tone: signals.length === 0 ? 'neutral' : invalidSignals > 0 ? 'bad' : 'good',
    },
    {
      title: '4. Storage & Buffer',
      sub: 'Circular buffer & Timescale sync',
      status: 'Not run — use connection handshake',
      tone: 'neutral' as const,
    },
  ];

  const handleHowToTest = () => {
    setShowHowToTest(true);
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

  const qualityBadge = (quality: string) => {
    if (quality === 'GOOD') return <Badge variant="good">GOOD</Badge>;
    if (quality === 'BAD') return <Badge variant="error">BAD</Badge>;
    if (quality === 'STALE' || quality === 'UNCERTAIN') return <Badge variant="warning">{quality}</Badge>;
    return <Badge variant="neutral">{quality || 'UNKNOWN'}</Badge>;
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Diagnostics & Root-Cause Troubleshooting</h1>
          <p className="fx-page-subtitle">
            Protocol diagnostics stream and connection health from the enrolled collector.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="primary"
            icon={<Play className="w-4 h-4" />}
            onClick={handleHowToTest}
            title="Opens guidance — run handshake from Connections"
          >
            How to Test
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

      {showHowToTest && (
        <Card className="p-4 border border-[#BED7F7] bg-[#EEF5FF]/60">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <HelpCircle className="w-5 h-5 text-[#2A82E7] flex-shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <h3 className="text-sm font-bold text-[#111B37]">How to run connection tests</h3>
                <p className="text-xs text-[#334568] leading-relaxed">
                  This page does not invent pass/fail results. Open a connection, run the handshake
                  there, then return here to review real diagnostics from the collector
                  ({collectorLabel}).
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/collector/connections')}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1D63BD] hover:underline mt-1"
                >
                  Go to Connections
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowHowToTest(false)}
              className="text-xs font-semibold text-[#657794] hover:text-[#111B37]"
            >
              Dismiss
            </button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase">Failed Tests</span>
          <div className={`text-2xl font-black mt-2 ${failedTests > 0 ? 'text-red-600' : 'text-slate-900'}`}>
            {failedTests}
          </div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-red-500"
              style={{ width: `${Math.min(100, failedTests * 10)}%` }}
            />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase">Invalid Signals</span>
          <div className={`text-2xl font-black mt-2 ${invalidSignals > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
            {invalidSignals}
          </div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-amber-500"
              style={{
                width: `${signals.length ? Math.min(100, (invalidSignals / signals.length) * 100) : 0}%`,
              }}
            />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase">Offline Connections</span>
          <div className="text-2xl font-black text-slate-900 mt-2">{offlineConnections}</div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-slate-700"
              style={{
                width: `${connections.length ? Math.min(100, (offlineConnections / connections.length) * 100) : 0}%`,
              }}
            />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase">System Warnings</span>
          <div className="text-2xl font-black text-slate-900 mt-2">{systemWarnings}</div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-blue-500"
              style={{ width: `${Math.min(100, systemWarnings * 10)}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {testSuites.map((suite) => (
          <div
            key={suite.title}
            className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between gap-2"
          >
            <div>
              <span className="text-xs font-bold text-slate-900 block">{suite.title}</span>
              <span className="text-[11px] text-slate-500 block">{suite.sub}</span>
            </div>
            <span
              className={`text-[11px] font-bold px-2 py-1 rounded-lg text-right leading-tight ${
                suite.tone === 'good'
                  ? 'bg-emerald-50 text-emerald-700'
                  : suite.tone === 'bad'
                  ? 'bg-red-50 text-red-600'
                  : suite.tone === 'warn'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {suite.status}
            </span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-7 space-y-3">
          <Card className="p-0 overflow-hidden">
            <div className="p-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {['all', 'Modbus', 'OPC UA', 'MQTT'].map((p) => (
                  <button
                    key={p}
                    type="button"
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
                    type="button"
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
                  {filteredIssues.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center text-xs text-slate-400 py-8">
                        {issuesList.length === 0
                          ? 'No diagnostic issues reported. Degraded connections appear here after handshake.'
                          : 'No issues match the current filters.'}
                      </td>
                    </tr>
                  ) : (
                    filteredIssues.map((issue) => {
                      const isSelected = selectedIssue?.id === issue.id;
                      return (
                        <tr
                          key={issue.id}
                          onClick={() => setSelectedIssue(issue)}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-red-50/50 border-l-4 border-l-[#EF1B24]'
                              : 'hover:bg-slate-50'
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
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Signal Quality & Packet Integrity Analysis" className="p-0 overflow-hidden">
            {signals.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-slate-400">
                No signal quality data yet. Activate a connection first.
              </div>
            ) : (
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Signal Name</th>
                    <th>Asset Source</th>
                    <th>Quality</th>
                    <th>Last Value</th>
                    <th>Updated</th>
                    <th>Quality Status</th>
                  </tr>
                </thead>
                <tbody className="text-xs font-mono">
                  {signals.slice(0, 20).map((sig) => (
                    <tr key={sig.id}>
                      <td className="font-bold text-slate-800">{sig.tag || sig.name}</td>
                      <td className="text-slate-600">{sig.resourcePath || sig.sourceConnectionName || '—'}</td>
                      <td
                        className={
                          sig.quality === 'GOOD'
                            ? 'text-emerald-600 font-bold'
                            : sig.quality === 'BAD'
                            ? 'text-red-600 font-bold'
                            : 'text-amber-600 font-bold'
                        }
                      >
                        {sig.quality || 'UNKNOWN'}
                      </td>
                      <td>{String(sig.currentValue ?? '—')}</td>
                      <td className="text-slate-500">{sig.lastUpdated || '—'}</td>
                      <td>{qualityBadge(sig.quality)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

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
                    <span className="text-slate-500 uppercase font-semibold text-[10px] block">
                      Error Summary
                    </span>
                    <p className="font-mono text-red-600 font-bold bg-red-50 p-2.5 rounded-lg border border-red-200 mt-1">
                      {selectedIssue.message}
                    </p>
                  </div>

                  <div>
                    <span className="text-slate-500 uppercase font-semibold text-[10px] block">
                      Impact Assessment
                    </span>
                    <p className="text-slate-800 font-medium bg-slate-50 p-2.5 rounded-lg border border-slate-200 mt-1">
                      {selectedIssue.impact}
                    </p>
                  </div>

                  <div>
                    <span className="text-slate-500 uppercase font-semibold text-[10px] block">
                      Technical Details
                    </span>
                    <p className="text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-200 mt-1">
                      {selectedIssue.details}
                    </p>
                  </div>
                </div>

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
                  onClick={() => navigate('/collector/connections')}
                >
                  Open Connection
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="h-full flex items-center justify-center p-8 text-center text-slate-400 text-xs">
              Select an issue from the diagnostics stream to view root-cause analysis and recommended
              fixes.
              {degradedCount > 0 && (
                <span className="block mt-2 text-amber-600">
                  {degradedCount} degraded connection{degradedCount === 1 ? '' : 's'} currently
                  reported.
                </span>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
