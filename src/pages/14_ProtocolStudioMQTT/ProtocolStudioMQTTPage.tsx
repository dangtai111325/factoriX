import React, { useState } from 'react';
import {
  RadioTower,
  Play,
  Pause,
  Braces,
  Plus,
  Trash2,
  Send,
  CheckCircle2,
  Copy,
  Layers,
  Sparkles,
  RefreshCw,
  FolderTree,
  ChevronDown,
  ChevronRight,
  Database,
  Code2,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';

interface MappingItem {
  id: string;
  jsonPath: string;
  signalName: string;
  type: string;
  unit: string;
  required: boolean;
  previewValue: string;
}

export const ProtocolStudioMQTTPage: React.FC = () => {
  const [topicSub, setTopicSub] = useState<string>('factory/line1/machines/+');
  const [isSubscribed, setIsSubscribed] = useState<boolean>(true);
  const [activeViewMode, setActiveViewMode] = useState<'tree' | 'raw'>('tree');
  const [simulateCount, setSimulateCount] = useState<number>(0);

  const [mappings, setMappings] = useState<MappingItem[]>([
    {
      id: 'm1',
      jsonPath: '$.machine_name',
      signalName: 'machine_name',
      type: 'String',
      unit: '',
      required: true,
      previewValue: 'AS-01',
    },
    {
      id: 'm2',
      jsonPath: '$.metrics.temperature',
      signalName: 'temperature',
      type: 'Double',
      unit: '°C',
      required: true,
      previewValue: '72.4',
    },
    {
      id: 'm3',
      jsonPath: '$.metrics.vibration',
      signalName: 'vibration',
      type: 'Double',
      unit: 'mm/s',
      required: true,
      previewValue: '0.12',
    },
    {
      id: 'm4',
      jsonPath: '$.metrics.running',
      signalName: 'running',
      type: 'Boolean',
      unit: '',
      required: true,
      previewValue: 'true',
    },
    {
      id: 'm5',
      jsonPath: '$.production.good_count',
      signalName: 'good_count',
      type: 'Integer',
      unit: 'pcs',
      required: false,
      previewValue: '1,254',
    },
  ]);

  const rawJsonSample = {
    machine_name: 'AS-01',
    timestamp: '2026-10-29T14:32:18Z',
    metrics: {
      temperature: 72.4,
      vibration: 0.12,
      running: true,
      speed_rpm: 1450,
    },
    production: {
      good_count: 1254,
      reject_count: 12,
      cycle_time: 3.4,
    },
    alarms: [
      {
        message: 'Temperature nominal',
        severity: 'info',
      },
    ],
  };

  const handleSimulate = () => {
    setSimulateCount((c) => c + 1);
    setMappings((prev) =>
      prev.map((m) => {
        if (m.signalName === 'temperature') {
          return { ...m, previewValue: (72.4 + Math.random() * 2).toFixed(1) };
        }
        if (m.signalName === 'good_count') {
          return { ...m, previewValue: String(1254 + simulateCount + 1) };
        }
        return m;
      })
    );
  };

  const handleAddRow = () => {
    setMappings([
      ...mappings,
      {
        id: `m-${Date.now()}`,
        jsonPath: '$.metrics.speed_rpm',
        signalName: 'speed_rpm',
        type: 'Integer',
        unit: 'rpm',
        required: false,
        previewValue: '1450',
      },
    ]);
  };

  const handleRemoveRow = (id: string) => {
    setMappings(mappings.filter((m) => m.id !== id));
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Header & Control Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="fx-page-title">JSON Mapping Studio — MQTT & HTTP API</h1>
            <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 font-bold text-xs">
              JSONPath Parser v2.4
            </span>
          </div>
          <p className="fx-page-subtitle">
            Map incoming JSON payloads to standardized industrial signals using JSONPath and declarative type inference.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="secondary"
            icon={<Sparkles className="w-4 h-4 text-amber-500" />}
            onClick={() => alert('Auto-detected 5 standardized tags from payload schema!')}
          >
            Auto Detect Fields
          </Button>
          <Button
            variant="primary"
            icon={<CheckCircle2 className="w-4 h-4" />}
            onClick={() => alert('Mappings validated and saved to Collector Engine.')}
          >
            Review & Save
          </Button>
        </div>
      </div>

      {/* Target Resource & Profile Bar (From Image 18) */}
      <Card className="p-3 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2">
            <FolderTree className="w-4 h-4 text-[#EF1B24]" />
            <span className="text-slate-500">Target Resource:</span>
            <span className="font-mono font-bold text-slate-800">
              Riverside Plant &gt; Production &gt; Line 1 - Assembly
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono">
            <Badge variant="mqtt">MQTT / EMQX_Broker</Badge>
            <span className="text-slate-500">Topic: {topicSub}</span>
          </div>
        </div>
      </Card>

      {/* 3-PANE ENTERPRISE MAPPING WORKSPACE (From Image 18 & 27) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* PANE 1 (Left 30%): Incoming Payload Inspector (JSON Tree / Raw) */}
        <div className="col-span-12 lg:col-span-4 space-y-3">
          <Card className="p-0 overflow-hidden flex flex-col h-[520px]">
            <div className="p-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Braces className="w-4 h-4 text-[#EF1B24]" /> Incoming Payload (Sample)
              </span>
              <div className="flex items-center gap-1 bg-white border border-slate-200 p-0.5 rounded-lg text-xs font-semibold">
                <button
                  onClick={() => setActiveViewMode('tree')}
                  className={`px-2 py-0.5 rounded ${
                    activeViewMode === 'tree' ? 'bg-slate-900 text-white' : 'text-slate-600'
                  }`}
                >
                  Tree View
                </button>
                <button
                  onClick={() => setActiveViewMode('raw')}
                  className={`px-2 py-0.5 rounded ${
                    activeViewMode === 'raw' ? 'bg-slate-900 text-white' : 'text-slate-600'
                  }`}
                >
                  Raw JSON
                </button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto flex-1 font-mono text-xs bg-slate-900 text-emerald-400">
              {activeViewMode === 'raw' ? (
                <pre className="leading-relaxed">{JSON.stringify(rawJsonSample, null, 2)}</pre>
              ) : (
                <div className="space-y-1.5 text-slate-300">
                  <div className="text-amber-400 font-bold">$ (root object)</div>
                  <div className="pl-3">
                    <span className="text-blue-400">machine_name:</span>{' '}
                    <span className="text-emerald-300">"AS-01"</span>{' '}
                    <span className="text-[10px] text-slate-500">(string)</span>
                  </div>
                  <div className="pl-3">
                    <span className="text-blue-400">timestamp:</span>{' '}
                    <span className="text-emerald-300">"2026-10-29T14:32:18Z"</span>
                  </div>
                  <div className="pl-3 text-amber-400">▾ metrics (object)</div>
                  <div className="pl-6 space-y-1">
                    <div>
                      <span className="text-blue-400">temperature:</span>{' '}
                      <span className="text-emerald-300">72.4</span>{' '}
                      <span className="text-[10px] text-slate-500">(number)</span>
                    </div>
                    <div>
                      <span className="text-blue-400">vibration:</span>{' '}
                      <span className="text-emerald-300">0.12</span>{' '}
                      <span className="text-[10px] text-slate-500">(number)</span>
                    </div>
                    <div>
                      <span className="text-blue-400">running:</span>{' '}
                      <span className="text-emerald-300">true</span>{' '}
                      <span className="text-[10px] text-slate-500">(boolean)</span>
                    </div>
                    <div>
                      <span className="text-blue-400">speed_rpm:</span>{' '}
                      <span className="text-emerald-300">1450</span>
                    </div>
                  </div>
                  <div className="pl-3 text-amber-400">▾ production (object)</div>
                  <div className="pl-6 space-y-1">
                    <div>
                      <span className="text-blue-400">good_count:</span>{' '}
                      <span className="text-emerald-300">1254</span>
                    </div>
                    <div>
                      <span className="text-blue-400">reject_count:</span>{' '}
                      <span className="text-emerald-300">12</span>
                    </div>
                    <div>
                      <span className="text-blue-400">cycle_time:</span>{' '}
                      <span className="text-emerald-300">3.4</span>
                    </div>
                  </div>
                  <div className="pl-3 text-amber-400">▸ alarms (array [1 item])</div>
                </div>
              )}
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-950 flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-mono">Simulate Message # {simulateCount}</span>
              <Button
                size="sm"
                variant="secondary"
                className="text-xs bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700"
                icon={<RefreshCw className="w-3.5 h-3.5" />}
                onClick={handleSimulate}
              >
                Simulate Inbound Event
              </Button>
            </div>
          </Card>
        </div>

        {/* PANE 2 (Center 50%): JSONPath Field Mapping Table */}
        <div className="col-span-12 lg:col-span-5 space-y-3">
          <Card className="p-0 overflow-hidden flex flex-col h-[520px]">
            <div className="p-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider block">
                  Field Mapping Definitions ({mappings.length})
                </span>
                <span className="text-[11px] text-slate-500">JSONPath selector to target canonical signal</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-[#EF1B24] font-bold hover:bg-red-50"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={handleAddRow}
              >
                Add Row
              </Button>
            </div>

            <div className="overflow-x-auto flex-1 p-2">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Source JSONPath</th>
                    <th>Signal Name</th>
                    <th>Data Type</th>
                    <th>Unit</th>
                    <th>Value</th>
                    <th className="text-right">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs font-mono">
                  {mappings.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="font-bold text-[#1D63BD]">{m.jsonPath}</td>
                      <td>
                        <input
                          type="text"
                          value={m.signalName}
                          onChange={(e) => {
                            const next = [...mappings];
                            const item = next.find((x) => x.id === m.id);
                            if (item) item.signalName = e.target.value;
                            setMappings(next);
                          }}
                          className="px-2 py-1 bg-white border border-slate-200 rounded text-slate-900 font-bold w-28 text-xs"
                        />
                      </td>
                      <td>
                        <select
                          value={m.type}
                          onChange={(e) => {
                            const next = [...mappings];
                            const item = next.find((x) => x.id === m.id);
                            if (item) item.type = e.target.value;
                            setMappings(next);
                          }}
                          className="px-1.5 py-1 bg-white border border-slate-200 rounded text-slate-700 text-xs"
                        >
                          <option>Double</option>
                          <option>Integer</option>
                          <option>Boolean</option>
                          <option>String</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={m.unit}
                          placeholder="--"
                          onChange={(e) => {
                            const next = [...mappings];
                            const item = next.find((x) => x.id === m.id);
                            if (item) item.unit = e.target.value;
                            setMappings(next);
                          }}
                          className="px-1.5 py-1 bg-white border border-slate-200 rounded text-slate-800 w-12 text-center text-xs"
                        />
                      </td>
                      <td className="text-emerald-600 font-bold">{m.previewValue}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveRow(m.id)}
                          className="p-1 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
              <span>All 5 JSONPath expressions valid</span>
              <span className="font-semibold text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Ready to compile
              </span>
            </div>
          </Card>
        </div>

        {/* PANE 3 (Right 20%): Canonical Output & Policies (From Image 18 & 27) */}
        <div className="col-span-12 lg:col-span-3 space-y-3">
          <Card title="Mapping Engine Policies" className="text-xs space-y-3">
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  defaultChecked
                  className="mt-0.5 text-[#EF1B24] rounded focus:ring-[#EF1B24]"
                />
                <span className="text-slate-700 leading-tight">Create new signals if not found in catalog</span>
              </label>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  defaultChecked
                  className="mt-0.5 text-[#EF1B24] rounded focus:ring-[#EF1B24]"
                />
                <span className="text-slate-700 leading-tight">Apply automatic data type inference</span>
              </label>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  defaultChecked
                  className="mt-0.5 text-[#EF1B24] rounded focus:ring-[#EF1B24]"
                />
                <span className="text-slate-700 leading-tight">Missing field policy: Set Null (Uncertain)</span>
              </label>
            </div>
          </Card>

          <Card title="Canonical Observation Preview" className="p-0 overflow-hidden text-xs">
            <div className="p-3 bg-slate-900 text-emerald-400 font-mono text-[11px] space-y-2 max-h-56 overflow-y-auto">
              <div>// Ingested observation stream:</div>
              {mappings.map((m) => (
                <div key={m.id} className="text-slate-300">
                  <span className="text-[#EF1B24] font-bold">{m.signalName}</span>: {m.previewValue}{' '}
                  {m.unit && <span className="text-slate-500">({m.unit})</span>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* BOTTOM SECTION: Payload Preview & History (From Image 18) */}
      <Card title="Recent Inbound Messages from Topic (factory/line1/machines/+)" className="p-0 overflow-hidden">
        <table className="fx-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Topic</th>
              <th>Payload Size</th>
              <th>Preview Snippet</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody className="text-xs font-mono">
            <tr>
              <td className="text-slate-500">2026-10-29 14:32:18.421</td>
              <td className="text-slate-900 font-bold">factory/line1/machines/AS-01</td>
              <td>512 B</td>
              <td className="text-slate-600 truncate max-w-md">
                {`{"machine_name": "AS-01", "metrics": {"temperature": 72.4, "running": true}}`}
              </td>
              <td className="text-right">
                <button
                  type="button"
                  onClick={handleSimulate}
                  className="text-xs text-[#EF1B24] font-semibold hover:underline"
                >
                  Load
                </button>
              </td>
            </tr>
            <tr>
              <td className="text-slate-500">2026-10-29 14:32:17.108</td>
              <td className="text-slate-900 font-bold">factory/line1/machines/AS-02</td>
              <td>498 B</td>
              <td className="text-slate-600 truncate max-w-md">
                {`{"machine_name": "AS-02", "metrics": {"temperature": 68.1, "running": true}}`}
              </td>
              <td className="text-right">
                <button
                  type="button"
                  onClick={handleSimulate}
                  className="text-xs text-[#EF1B24] font-semibold hover:underline"
                >
                  Load
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
};
