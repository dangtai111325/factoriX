import React, { useState } from 'react';
import {
  X,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Cpu,
  Radio,
  Server,
  Globe,
  Code2,
  Database,
  ArrowRight,
  Activity,
  Zap,
  Play,
  RotateCcw,
  Sparkles,
  HelpCircle,
  FolderTree,
} from 'lucide-react';

export interface AddDataWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialResource?: string;
  onComplete?: (result: any) => void;
}

export const AddDataWizardModal: React.FC<AddDataWizardModalProps> = ({
  isOpen,
  onClose,
  initialResource = 'Riverside Plant > Production > Line 1 — Assembly > Machine AA10-01',
  onComplete,
}) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [protocol, setProtocol] = useState<'modbus' | 'opcua' | 'mqtt' | 'http' | 'custom'>('modbus');

  // Modbus State
  const [modbusHost, setModbusHost] = useState('192.168.1.45');
  const [modbusPort, setModbusPort] = useState('502');
  const [modbusUnitId, setModbusUnitId] = useState('1');
  const [modbusFunc, setModbusFunc] = useState('03');
  const [modbusInterval, setModbusInterval] = useState('1000');

  // OPC UA State
  const [opcEndpoint, setOpcEndpoint] = useState('opc.tcp://192.168.1.100:4840');
  const [opcSecurity, setOpcSecurity] = useState('Sign & Encrypt');
  const [selectedNode, setSelectedNode] = useState('ns=2;s=Line1.Motor.01.Speed');

  // Signals Mapping State
  const [signals, setSignals] = useState([
    { id: 1, address: '40001', name: 'AA10-01_SpindleSpeed', type: 'UINT16', scale: '1.0', unit: 'rpm', value: '1,482 rpm' },
    { id: 2, address: '40002', name: 'AA10-01_SpindleLoad', type: 'UINT16', scale: '0.1', unit: '%', value: '62.3 %' },
    { id: 3, address: '40003', name: 'AA10-01_CoolantTemp', type: 'INT16', scale: '0.1', unit: '°C', value: '68.7 °C' },
    { id: 4, address: '40004', name: 'AA10-01_AxisVibration', type: 'FLOAT32', scale: '1.0', unit: 'mm/s', value: '2.8 mm/s' },
  ]);

  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success'>('idle');

  if (!isOpen) return null;

  const handleNext = () => {
    if (currentStep < 5) setCurrentStep(currentStep + 1);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleRunTest = () => {
    setTestStatus('testing');
    setTimeout(() => {
      setTestStatus('success');
    }, 700);
  };

  const handleFinish = () => {
    onComplete?.({
      protocol,
      resource: initialResource,
      signalsCount: signals.length,
    });
    onClose();
  };

  const stepLabels = [
    { num: 1, title: 'Context', desc: 'Resource scope' },
    { num: 2, title: 'Source Method', desc: 'Protocol selection' },
    { num: 3, title: 'Configure', desc: 'Driver & discovery' },
    { num: 4, title: 'Map Signals', desc: 'Define tags' },
    { num: 5, title: 'Test & Preview', desc: 'Live validation' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Wizard Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Add Data Source Wizard</h2>
              <p className="text-xs text-slate-500">Connect, discover registers, map signals, and activate collection</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator Bar */}
        <div className="px-6 py-3 border-b border-slate-100 bg-white grid grid-cols-5 gap-2">
          {stepLabels.map((s) => (
            <div
              key={s.num}
              onClick={() => setCurrentStep(s.num)}
              className={`flex items-center gap-2 p-1.5 rounded-lg cursor-pointer transition-all ${
                currentStep === s.num
                  ? 'bg-red-50 text-[#EF1B24] border border-[#EF1B24]/30'
                  : currentStep > s.num
                  ? 'text-emerald-700 bg-emerald-50/50'
                  : 'text-slate-400 hover:bg-slate-50'
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  currentStep === s.num
                    ? 'bg-[#EF1B24] text-white'
                    : currentStep > s.num
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {currentStep > s.num ? '✓' : s.num}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold truncate leading-tight">{s.title}</div>
                <div className="text-[10px] text-slate-400 truncate">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Wizard Step Body */}
        <div className="p-6 overflow-y-auto flex-1 text-sm bg-[#F6F8FC]/50">
          {/* STEP 1: CONTEXT */}
          {currentStep === 1 && (
            <div className="space-y-4 animate-fadeIn">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Target Factory Resource
                </span>
                <div className="mt-2 flex items-center gap-2 text-sm font-mono text-slate-800 bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <FolderTree className="w-4 h-4 text-[#EF1B24] flex-shrink-0" />
                  <span>{initialResource}</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <span className="text-xs text-slate-500 block">Asset Classification</span>
                  <span className="text-sm font-bold text-slate-800 mt-1 block">CNC Milling Machine</span>
                </div>
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <span className="text-xs text-slate-500 block">Physical Location</span>
                  <span className="text-sm font-bold text-slate-800 mt-1 block">Plant 01 / Bay 3</span>
                </div>
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <span className="text-xs text-slate-500 block">Connected Signals</span>
                  <span className="text-sm font-bold text-slate-800 mt-1 block">4 Active</span>
                </div>
              </div>

              <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 flex items-start gap-2.5">
                <HelpCircle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                <div>
                  Select the communication driver in the next step to establish telemetry collection from this industrial asset.
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: SOURCE / METHOD */}
          {currentStep === 2 && (
            <div className="space-y-4 animate-fadeIn">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                Select Industrial Communication Protocol
              </label>
              <div className="grid grid-cols-2 gap-4">
                {[
                  {
                    id: 'modbus',
                    name: 'Modbus TCP',
                    desc: 'Standard industrial PLC protocol over TCP/IP port 502 with holding registers & coils',
                    badge: 'Field Devices & PLCs',
                    icon: Cpu,
                  },
                  {
                    id: 'opcua',
                    name: 'OPC UA',
                    desc: 'IEC 62541 Secure architecture with address space browsing and event subscriptions',
                    badge: 'SCADA & Controllers',
                    icon: Radio,
                  },
                  {
                    id: 'mqtt',
                    name: 'MQTT / Sparkplug B',
                    desc: 'Lightweight pub/sub messaging with JSON or binary payloads from IoT edge gateways',
                    badge: 'IoT & Telemetry',
                    icon: Server,
                  },
                  {
                    id: 'http',
                    name: 'HTTP REST / Webhook',
                    desc: 'Scheduled polling or inbound webhooks receiving JSON telemetry payloads',
                    badge: 'Web & API Services',
                    icon: Globe,
                  },
                ].map((item) => (
                  <div
                    key={item.id}
                    onClick={() => setProtocol(item.id as any)}
                    className={`p-4 rounded-xl border cursor-pointer transition-all bg-white shadow-sm flex flex-col justify-between ${
                      protocol === item.id
                        ? 'border-[#EF1B24] ring-2 ring-[#EF1B24]/20 shadow-md'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <item.icon className={`w-5 h-5 ${protocol === item.id ? 'text-[#EF1B24]' : 'text-slate-500'}`} />
                          <span className="font-bold text-slate-900 text-sm">{item.name}</span>
                        </div>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                          {item.badge}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 leading-relaxed">{item.desc}</p>
                    </div>
                    {protocol === item.id && (
                      <div className="mt-3 text-xs font-bold text-[#EF1B24] flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Selected
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 3: DISCOVER / CONFIGURE */}
          {currentStep === 3 && (
            <div className="space-y-4 animate-fadeIn">
              {protocol === 'modbus' && (
                <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <span className="font-bold text-slate-900 text-sm">Modbus TCP Driver Parameters</span>
                    <button
                      type="button"
                      onClick={handleRunTest}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors"
                    >
                      <Activity className="w-3.5 h-3.5 text-blue-600" />
                      {testStatus === 'testing' ? 'Testing...' : testStatus === 'success' ? 'Connected (42ms)' : 'Ping PLC'}
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Host / IP Address</label>
                      <input
                        type="text"
                        value={modbusHost}
                        onChange={(e) => setModbusHost(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Port</label>
                      <input
                        type="text"
                        value={modbusPort}
                        onChange={(e) => setModbusPort(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Unit ID / Slave</label>
                      <input
                        type="text"
                        value={modbusUnitId}
                        onChange={(e) => setModbusUnitId(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Function Code</label>
                      <select
                        value={modbusFunc}
                        onChange={(e) => setModbusFunc(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium"
                      >
                        <option value="03">03 - Read Holding Registers (4xxxx)</option>
                        <option value="04">04 - Read Input Registers (3xxxx)</option>
                        <option value="01">01 - Read Coils (0xxxx)</option>
                        <option value="02">02 - Read Discrete Inputs (1xxxx)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Polling Interval (ms)</label>
                      <input
                        type="text"
                        value={modbusInterval}
                        onChange={(e) => setModbusInterval(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono"
                      />
                    </div>
                  </div>

                  {/* Hex Raw Response Table Preview */}
                  <div className="mt-3">
                    <span className="text-[11px] font-semibold text-slate-500 uppercase block mb-1">
                      Live Register Hex Stream (Preview)
                    </span>
                    <div className="bg-slate-900 text-emerald-400 p-2.5 rounded-lg font-mono text-xs overflow-x-auto">
                      <div>40001: 0x05CA (1482) | 40002: 0x026F (623) | 40003: 0x02AF (687)</div>
                      <div className="text-slate-400 text-[10px] mt-1">Status: OK | Response Time: 42ms | CRC: 0xB4F2 (Valid)</div>
                    </div>
                  </div>
                </div>
              )}

              {protocol === 'opcua' && (
                <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <span className="font-bold text-slate-900 text-sm">OPC UA Client Configuration</span>
                    <button
                      type="button"
                      onClick={handleRunTest}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5"
                    >
                      <Radio className="w-3.5 h-3.5 text-purple-600" />
                      {testStatus === 'success' ? 'Session Active (4840)' : 'Connect & Browse'}
                    </button>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">Endpoint URL</label>
                    <input
                      type="text"
                      value={opcEndpoint}
                      onChange={(e) => setOpcEndpoint(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono"
                    />
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <span className="text-xs font-semibold text-slate-700 block mb-2">Address Space Browser</span>
                    <div className="space-y-1 font-mono text-xs text-slate-700">
                      <div className="text-slate-900 font-bold">📁 Objects &gt; Plant &gt; Line1_Assembly</div>
                      <div className="pl-4 text-emerald-700">🔘 MotorSpeed (ns=2;s=Line1.Motor.01.Speed) - Double</div>
                      <div className="pl-4 text-emerald-700">🔘 Vibration (ns=2;s=Line1.Motor.01.Vibration) - Double</div>
                      <div className="pl-4 text-emerald-700">🔘 Running (ns=2;s=Line1.Motor.01.Running) - Boolean</div>
                    </div>
                  </div>
                </div>
              )}

              {protocol === 'mqtt' && (
                <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                  <span className="font-bold text-slate-900 text-sm block">MQTT Broker Connection</span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Broker URI</label>
                      <input
                        type="text"
                        defaultValue="mqtt://192.168.1.45:1883"
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono text-slate-800"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-600 block mb-1">Topic Subscription</label>
                      <input
                        type="text"
                        defaultValue="factory/line1/machines/#"
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg font-mono text-slate-800"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 4: MAP SIGNALS */}
          {currentStep === 4 && (
            <div className="space-y-4 animate-fadeIn">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm">Discovered Tag Mapping</h3>
                    <p className="text-xs text-slate-500">Assign standardized names, scale factors, and engineering units</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSignals([
                        ...signals,
                        {
                          id: signals.length + 1,
                          address: `4000${signals.length + 1}`,
                          name: `AA10-01_Sensor_${signals.length + 1}`,
                          type: 'UINT16',
                          scale: '1.0',
                          unit: 'units',
                          value: '100',
                        },
                      ]);
                    }}
                    className="px-3 py-1.5 bg-red-50 text-[#EF1B24] hover:bg-red-100 rounded-lg text-xs font-semibold transition-colors"
                  >
                    + Add Row
                  </button>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500 border-b border-slate-200 font-semibold">
                      <tr>
                        <th className="p-2.5">Address</th>
                        <th className="p-2.5">Signal Name</th>
                        <th className="p-2.5">Data Type</th>
                        <th className="p-2.5">Scale</th>
                        <th className="p-2.5">Unit</th>
                        <th className="p-2.5">Live Preview</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-slate-700">
                      {signals.map((sig) => (
                        <tr key={sig.id} className="hover:bg-slate-50/50">
                          <td className="p-2.5 text-slate-900 font-bold">{sig.address}</td>
                          <td className="p-2.5 text-[#EF1B24]">{sig.name}</td>
                          <td className="p-2.5 text-slate-600">{sig.type}</td>
                          <td className="p-2.5 text-slate-600">{sig.scale}</td>
                          <td className="p-2.5 text-slate-600">{sig.unit}</td>
                          <td className="p-2.5 text-emerald-600 font-bold">{sig.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: TEST & PREVIEW */}
          {currentStep === 5 && (
            <div className="space-y-4 animate-fadeIn">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
                <div className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <span className="font-bold text-sm block">Driver Handshake Successful!</span>
                    Connected to device on {modbusHost}:{modbusPort}. Ready to stream {signals.length} configured signals.
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <span className="text-xs font-semibold text-slate-600 block mb-1">Acquisition Summary</span>
                    <ul className="text-xs space-y-1 text-slate-700">
                      <li><strong>Protocol:</strong> {protocol.toUpperCase()}</li>
                      <li><strong>Target:</strong> {initialResource}</li>
                      <li><strong>Scan Rate:</strong> {modbusInterval} ms</li>
                      <li><strong>Signals:</strong> {signals.length} ready</li>
                    </ul>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <span className="text-xs font-semibold text-slate-600 block mb-1">Quality & Storage</span>
                    <ul className="text-xs space-y-1 text-slate-700">
                      <li><strong>Buffering:</strong> Memory Circular (Healthy)</li>
                      <li><strong>Historian:</strong> Enabled (TimescaleDB)</li>
                      <li><strong>Publish:</strong> UNSP factory/line1/data</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Wizard Footer Controls */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between bg-slate-50">
          <button
            type="button"
            disabled={currentStep === 1}
            onClick={handleBack}
            className={`px-4 py-2 text-xs font-semibold rounded-lg flex items-center gap-1 transition-colors ${
              currentStep === 1
                ? 'text-slate-300 cursor-not-allowed'
                : 'text-slate-600 hover:bg-slate-200'
            }`}
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
            >
              Cancel
            </button>

            {currentStep < 5 ? (
              <button
                type="button"
                onClick={handleNext}
                className="px-5 py-2 text-xs font-semibold text-white bg-[#EF1B24] hover:bg-[#d0171f] rounded-lg shadow-sm transition-all flex items-center gap-1.5"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFinish}
                className="px-6 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-all flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" /> Activate Collection
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
