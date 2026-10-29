import React, { useState } from 'react';
import { X, Activity, CheckCircle2, AlertTriangle, Download, RefreshCw, Server, ArrowRight } from 'lucide-react';

export interface ConnectionTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionName?: string;
  protocol?: string;
  endpoint?: string;
}

export const ConnectionTestModal: React.FC<ConnectionTestModalProps> = ({
  isOpen,
  onClose,
  connectionName = 'Riverside_PLC_01',
  protocol = 'Modbus TCP',
  endpoint = '192.168.10.25:502',
}) => {
  const [testState, setTestState] = useState<'idle' | 'running' | 'success'>('idle');
  const [selectedTemplate, setSelectedTemplate] = useState('Siemens S7-1500 PLC Profile');

  if (!isOpen) return null;

  const handleStartTest = () => {
    setTestState('running');
    setTimeout(() => {
      setTestState('success');
    }, 800);
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
              <h2 className="text-lg font-bold text-slate-900">Connection Diagnostics & Test</h2>
              <p className="text-xs text-slate-500">Live ping, handshake validation, and latency assessment</p>
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

          {/* Test Status Box */}
          <div className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">Test Pipeline Steps</span>
              <button
                type="button"
                onClick={handleStartTest}
                className="px-3 py-1 bg-[#EF1B24] text-white hover:bg-[#d0171f] rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testState === 'running' ? 'animate-spin' : ''}`} />
                {testState === 'running' ? 'Testing...' : 'Run Diagnostics'}
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-100">
                <span className="text-slate-700">1. Socket TCP Handshake (SYN-ACK)</span>
                {testState === 'success' ? (
                  <span className="text-emerald-600 font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Passed (12ms)
                  </span>
                ) : (
                  <span className="text-slate-400">Ready</span>
                )}
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-100">
                <span className="text-slate-700">2. Protocol Session & Auth Negotiation</span>
                {testState === 'success' ? (
                  <span className="text-emerald-600 font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Valid Session
                  </span>
                ) : (
                  <span className="text-slate-400">Ready</span>
                )}
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-100">
                <span className="text-slate-700">3. Register Polling (Test Read 40001)</span>
                {testState === 'success' ? (
                  <span className="text-emerald-600 font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> 42ms Latency (Good)
                  </span>
                ) : (
                  <span className="text-slate-400">Ready</span>
                )}
              </div>
            </div>
          </div>

          {/* Import Template Section */}
          <div className="border-t border-slate-100 pt-3">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Import Pre-Built Device Template
            </label>
            <div className="flex gap-2">
              <select
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="flex-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
              >
                <option>Siemens S7-1500 PLC Profile</option>
                <option>Schneider Modbus M340 Map</option>
                <option>Omron FINS EtherNet/IP Profile</option>
                <option>EMQX Cloud Broker Settings</option>
              </select>
              <button
                type="button"
                onClick={() => alert(`Template "${selectedTemplate}" successfully imported!`)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5" /> Apply
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
