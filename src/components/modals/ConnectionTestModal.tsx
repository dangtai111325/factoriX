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
  Sparkles,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { DemoScenario, TestStepResult } from '../../types';

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
  connectionId = 'conn-opcua-01',
  connectionName = 'Riverside_PLC_01',
  protocol = 'Modbus TCP',
  endpoint = '192.168.10.25:502',
}) => {
  const { runDeterministicConnectionTest, demoScenario } = useApp();
  const [testScenario, setTestScenario] = useState<DemoScenario>(demoScenario);
  const [testState, setTestState] = useState<'idle' | 'running' | 'completed'>('idle');
  const [testSteps, setTestSteps] = useState<TestStepResult[]>([]);
  const [overallStatus, setOverallStatus] = useState<string>('NOT_TESTED');

  if (!isOpen) return null;

  const handleStartTest = async () => {
    setTestState('running');
    const result = await runDeterministicConnectionTest(connectionId, testScenario);
    setTestSteps(result.steps);
    setOverallStatus(result.overallStatus);
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
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">Connection Diagnostics & Test</h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" /> Demo Simulator
                </span>
              </div>
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

          {/* Test Scenario Switcher (Review FX-06) */}
          <div className="p-3 bg-slate-50/80 border border-slate-200 rounded-lg">
            <label className="block text-[11px] font-bold text-slate-600 uppercase mb-1">
              Select Test Diagnostic Scenario
            </label>
            <select
              value={testScenario}
              onChange={(e) => setTestScenario(e.target.value as DemoScenario)}
              className="w-full text-xs p-2 rounded border border-slate-300 bg-white text-slate-800 font-semibold focus:outline-none"
            >
              <option value="healthy">🟢 Normal Baseline (All Stages PASS · 18ms)</option>
              <option value="degraded_modbus">🟡 Modbus Exception (Illegal Address 0x02)</option>
              <option value="timeout_opcua">🔴 OPC-UA Browse Timeout (5000ms)</option>
              <option value="auth_fail_mqtt">🔴 Authentication Failure (CONNACK 0x05)</option>
              <option value="offline">⚫ Network Unreachable (ECONNREFUSED)</option>
            </select>
          </div>

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
                  Click "Run Diagnostics" to execute simulated multi-stage handshake
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
                    <p className="text-[11px] text-slate-600">{s.details}</p>
                    {s.errorCode && (
                      <span className="font-mono text-[10px] text-red-600 font-bold">
                        Code: {s.errorCode}
                      </span>
                    )}
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
              : 'Diagnostics ready (Simulated)'}
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
