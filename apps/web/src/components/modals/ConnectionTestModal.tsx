import React, { useState } from 'react';
import {
  X,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Download,
  RefreshCw,
  Server,
  ArrowRight,
  ShieldAlert,
  Clock,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';

interface HandshakeStage {
  stage: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  latencyMs: number;
  message: string;
}

export interface ConnectionTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionId?: string;
  connectionName?: string;
  protocol?: string;
  endpoint?: string;
}

export const ConnectionTestModal: React.FC<ConnectionTestModalProps> = ({
  isOpen,
  onClose,
  connectionId = '',
  connectionName = 'Selected connection',
  protocol = '—',
  endpoint = '—',
}) => {
  const { commissionAcquisition } = useApp();
  const [testState, setTestState] = useState<'idle' | 'running' | 'completed'>('idle');
  const [testSteps, setTestSteps] = useState<HandshakeStage[]>([]);
  const [overallStatus, setOverallStatus] = useState<string>('NOT_TESTED');
  const [testError, setTestError] = useState('');

  if (!isOpen) return null;

  const handleStartTest = async () => {
    if (!connectionId) {
      setTestError('Select a saved connection before running the handshake.');
      return;
    }
    setTestState('running');
    setTestError('');
    try {
      const result = await commissionAcquisition(connectionId);
      setTestSteps(result.stages.map((stage) => ({
        stage: stage.name,
        status: stage.status === 'FAILED' ? 'FAIL' : stage.status === 'PASSED' || stage.status === 'COMPLETED' ? 'PASS' : 'TIMEOUT',
        latencyMs: stage.latency || 0,
        message: stage.status,
      })));
      setOverallStatus(result.passed ? 'PASS' : 'FAIL');
    } catch (caught) {
      setTestError(caught instanceof Error ? caught.message : 'The handshake did not finish.');
      setOverallStatus('FAIL');
    }
    setTestState('completed');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Connection handshake</h2>
              <p className="text-xs text-slate-500">Multi-stage pipeline validation and latency diagnostics</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 text-sm">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Target Connection:</span>
              <span className="font-bold text-slate-900">{connectionName}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Protocol & Target:</span>
              <span className="font-mono text-slate-700">{protocol} ({endpoint})</span>
            </div>
          </div>

          {testError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{testError}</p>
          )}

          {/* Test Pipeline Steps */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Pipeline Stages ({testSteps.length}/4 evaluated)
              </span>
              <button
                type="button"
                onClick={handleStartTest}
                disabled={testState === 'running'}
                className="px-3 py-1.5 bg-[#EF1B24] text-white hover:bg-[#d0171f] disabled:opacity-50 rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testState === 'running' ? 'animate-spin' : ''}`} />
                {testState === 'running' ? 'Testing...' : 'Run Diagnostics'}
              </button>
            </div>

            <div className="space-y-2 text-xs">
              {testSteps.length === 0 ? (
                <div className="py-4 text-center text-slate-400 font-mono text-xs">
                  Run the handshake. The collector reports each stage. No result is invented.
                </div>
              ) : (
                testSteps.map((s, idx) => (
                  <div
                    key={idx}
                    className={`p-2.5 rounded-lg border flex flex-col gap-1 transition-all ${
                      s.status === 'PASS'
                        ? 'bg-emerald-50/50 border-emerald-200'
                        : s.status === 'TIMEOUT'
                        ? 'bg-amber-50 border-amber-200'
                        : 'bg-red-50 border-red-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-800">
                        {idx + 1}. {s.stage.replace('_', ' ')}
                      </span>
                      {s.status === 'PASS' ? (
                        <span className="text-emerald-700 font-bold flex items-center gap-1 text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> PASS ({s.latencyMs}ms)
                        </span>
                      ) : s.status === 'TIMEOUT' ? (
                        <span className="text-amber-700 font-bold flex items-center gap-1 text-[11px]">
                          <Clock className="w-3.5 h-3.5 text-amber-600" /> TIMEOUT
                        </span>
                      ) : (
                        <span className="text-red-700 font-bold flex items-center gap-1 text-[11px]">
                          <ShieldAlert className="w-3.5 h-3.5 text-red-600" /> {s.status}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-600">{s.message}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <span className="text-[11px] text-slate-500 font-mono">
            {testState === 'completed'
              ? `Diagnostic completed: ${overallStatus}`
              : 'Waiting for the collector'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-700 transition-colors"
          >
            Close Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
};
