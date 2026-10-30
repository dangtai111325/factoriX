import React, { useEffect, useState } from 'react';
import {
  Network,
  Cable,
  RadioTower,
  Cloud,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Play,
  Sigma,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { useNavigate, useSearchParams } from 'react-router-dom';

export const AddDataWizardPage: React.FC = () => {
  const { resources, prepareAcquisition, commissionAcquisition, activateAcquisition } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const machines = resources.filter((item) => item.type === 'machine' || item.type === 'line');

  const [step, setStep] = useState<number>(1);
  const [selectedProtocol, setSelectedProtocol] = useState<'modbus' | 'opcua' | 'mqtt' | 'http' | 'formula'>('modbus');
  const [resourceId, setResourceId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('502');
  const [unitId, setUnitId] = useState('1');
  const [interval, setInterval] = useState('1000');
  const [prepared, setPrepared] = useState<{ connectionId: string; jobId: string; edgeId: string } | null>(null);
  const [wizardError, setWizardError] = useState('');

  const [registers, setRegisters] = useState([
    { address: '', name: '', type: 'Holding Register', dataType: 'Float32', unit: '', defaultVal: 0 },
  ]);

  const [isTesting, setIsTesting] = useState(false);
  const [testStages, setTestStages] = useState<Array<{ name: string; status: 'pending' | 'testing' | 'pass' | 'fail'; latency?: number }>>([]);
  const [testSuccess, setTestSuccess] = useState(false);

  useEffect(() => {
    const fromQuery = searchParams.get('resourceId');
    if (fromQuery && machines.some((item) => item.id === fromQuery)) {
      setResourceId(fromQuery);
    } else if (!resourceId && machines[0]) {
      setResourceId(machines[0].id);
    }
  }, [machines, resourceId, searchParams]);

  const draft = () => ({
    protocol: selectedProtocol === 'formula' ? 'modbus' as const : selectedProtocol,
    name: connectionName || `${selectedProtocol} ${host}`,
    host,
    port,
    extra: unitId,
    intervalMs: Number(interval) || 1000,
    resourceId,
    fields: registers.filter((row) => row.name && row.address).map((row) => ({
      name: row.name,
      address: row.address,
      dataType: row.dataType,
      unit: row.unit,
    })),
  });

  const handleRunTest = async () => {
    setIsTesting(true);
    setTestSuccess(false);
    setWizardError('');
    try {
      const next = prepared ?? await prepareAcquisition(draft());
      setPrepared(next);
      const result = await commissionAcquisition(next.connectionId);
      setTestStages(result.stages.map((stage) => ({
        name: stage.name,
        status: stage.status === 'PASSED' || stage.status === 'COMPLETED' ? 'pass' : stage.status === 'FAILED' ? 'fail' : 'pending',
        latency: stage.latency,
      })));
      setTestSuccess(result.passed);
      if (!result.passed) setWizardError('The collector did not pass the network stage. Nothing was marked healthy.');
    } catch (error) {
      setWizardError(error instanceof Error ? error.message : 'Test failed');
    } finally {
      setIsTesting(false);
    }
  };

  const handleFinish = async () => {
    setWizardError('');
    try {
      const body = draft();
      if (!prepared) throw new Error('Run the handshake before activation.');
      if (!testSuccess) throw new Error('Activation stays locked until the collector passes the network stage.');
      if (!body.fields.length) throw new Error('Add at least one named field before activation.');
      await activateAcquisition(prepared, body);
      navigate('/signals');
    } catch (error) {
      setWizardError(error instanceof Error ? error.message : 'Activation failed');
    }
  };

  return (
    <div className="space-y-4 max-w-5xl mx-auto animate-in fade-in duration-200">
      {/* Region 1: Wizard Heading */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Add Data Acquisition Wizard</h1>
          <p className="fx-page-subtitle">
            Choose a machine you already created, then the collector tests the endpoint before any signal is saved.
          </p>
          {wizardError && <p className="text-[12px] text-[#F2343B] mt-2">{wizardError}</p>}
        </div>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          Cancel Wizard
        </Button>
      </div>

      {/* Region 2: Step Progress Indicator */}
      <Card className="p-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { num: 1, label: 'Protocol Choice' },
            { num: 2, label: 'Endpoint Settings' },
            { num: 3, label: 'Register Mapping' },
            { num: 4, label: 'Test & Activate' },
          ].map((s) => {
            const isCompleted = step > s.num;
            const isCurrent = step === s.num;
            return (
              <div key={s.num} className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-[13px] mb-1.5 transition-all ${
                    isCurrent
                      ? 'bg-[#EF1B24] text-white shadow-md ring-4 ring-[#FFF0F1]'
                      : isCompleted
                      ? 'bg-[#0DBA67] text-white'
                      : 'bg-[#F1F5FA] text-[#94A3B8]'
                  }`}
                >
                  {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : s.num}
                </div>
                <span
                  className={`text-[12px] font-semibold ${
                    isCurrent ? 'text-[#111B37]' : isCompleted ? 'text-[#0DBA67]' : 'text-[#94A3B8]'
                  }`}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Wizard Step Content */}
      {step === 1 && (
        <Card title="Select Protocol Source" subtitle="Choose industrial connection protocol to acquire data from:">
          {/* Region 3: Source Choice Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5 mt-2">
            {[
              {
                id: 'modbus',
                name: 'Modbus TCP / RTU',
                desc: 'Standard PLC registers (Holding, Input, Coil) over TCP port 502',
                icon: Network,
                badge: 'PLC Standard',
              },
              {
                id: 'opcua',
                name: 'OPC UA Client',
                desc: 'Industrial IoT address space browse, subscriptions and certificates',
                icon: Cable,
                badge: 'Rich Model',
              },
              {
                id: 'mqtt',
                name: 'MQTT Broker',
                desc: 'Subscribe to JSON payloads, Sparkplug B, or raw telemetry topics',
                icon: RadioTower,
                badge: 'Edge / Cloud',
              },
              {
                id: 'http',
                name: 'REST / HTTP API',
                desc: 'Polling external webhooks, MES endpoints or SCADA web services',
                icon: Cloud,
                badge: 'Web Standard',
              },
              {
                id: 'formula',
                name: 'Custom Calculated Rule',
                desc: 'Derive calculated metrics using restricted Python-like AST formula',
                icon: Sigma,
                badge: 'Formula Engine',
              },
            ].map((p) => {
              const Icon = p.icon;
              const isSelected = selectedProtocol === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedProtocol(p.id as any)}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all bg-white shadow-sm flex flex-col justify-between ${
                    isSelected
                      ? 'border-[#EF1B24] ring-4 ring-[#FFF0F1]'
                      : 'border-[#E3EAF3] hover:border-[#94A3B8]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="w-10 h-10 rounded-lg bg-[#F9FAFD] flex items-center justify-center text-[#EF1B24]">
                        <Icon className="w-5 h-5" />
                      </div>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-[#F1F5FA] text-[#657794]">
                        {p.badge}
                      </span>
                    </div>
                    <h3 className="text-[14px] font-bold text-[#111B37]">{p.name}</h3>
                    <p className="text-[12px] text-[#657794] mt-1 leading-relaxed">{p.desc}</p>
                  </div>
                  <div className="mt-4 pt-2 border-t border-[#F1F5FA] flex items-center justify-end">
                    <span className={`text-[12px] font-bold ${isSelected ? 'text-[#EF1B24]' : 'text-[#94A3B8]'}`}>
                      {isSelected ? 'Selected ✓' : 'Select'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="Configure Connection Parameters" subtitle="Specify IP host, port and polling intervals:">
          {/* Region 4: Connection Inputs */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl py-2">
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">Machine</label>
              <select className="fx-input" value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
                <option value="">Select a machine</option>
                {machines.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">Connection name</label>
              <input className="fx-input" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                PLC Host / IP Address <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => { setHost(e.target.value); setPrepared(null); setTestSuccess(false); }}
                className="fx-input font-mono"
              />
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                TCP Port <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="fx-input font-mono"
              />
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                Unit / Slave ID <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className="fx-input font-mono"
              />
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                Poll Interval (ms) <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="fx-input font-mono"
              />
            </div>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card
          title="Register Range & Tag Mapping"
          subtitle="Define registers to poll from device:"
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => {
                setRegisters((prev) => [
                  ...prev,
                  { address: '', name: '', type: 'Holding Register', dataType: 'Float32', unit: '', defaultVal: 0 },
                ]);
              }}
            >
              Add Row
            </Button>
          }
        >
          {/* Region 5: Register Range Editor */}
          <div className="overflow-x-auto">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Tag Name</th>
                  <th>Register Type</th>
                  <th>Data Type</th>
                  <th>Engineering Unit</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {registers.map((reg, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        type="text"
                        value={reg.address}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRegisters((prev) => prev.map((r, i) => (i === idx ? { ...r, address: val } : r)));
                        }}
                        className="fx-input h-8 font-mono text-[12px]"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={reg.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRegisters((prev) => prev.map((r, i) => (i === idx ? { ...r, name: val } : r)));
                        }}
                        className="fx-input h-8 font-semibold text-[12px]"
                      />
                    </td>
                    <td>
                      <span className="text-[12px] text-[#657794]">{reg.type}</span>
                    </td>
                    <td>
                      <span className="font-mono text-[11px] font-bold text-[#2A82E7]">{reg.dataType}</span>
                    </td>
                    <td>
                      <span className="text-[12px] font-bold text-[#111B37]">{reg.unit}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setRegisters((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-[#F2343B] p-1 hover:bg-[#FFF0F1] rounded"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {step === 4 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Region 6: Test Connection Panel */}
          <Card title="Live Handshake & Ping Verification">
            <p className="text-[12px] text-[#657794] mb-4">
              Test connection to <span className="font-mono font-bold text-[#111B37]">{host}:{port}</span> before activating.
            </p>
            <div className="p-4 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3] space-y-3 mb-4">
              <div className="flex justify-between text-[13px]">
                <span className="text-[#657794]">Target IP:</span>
                <span className="font-mono font-bold text-[#111B37]">{host}:{port}</span>
              </div>
              <div className="flex justify-between text-[13px]">
                <span className="text-[#657794]">Unit ID:</span>
                <span className="font-mono font-bold text-[#111B37]">{unitId}</span>
              </div>
              <div className="space-y-1.5 pt-2 border-t border-[#E3EAF3]">
                {testStages.map((stg, idx) => (
                  <div key={idx} className="flex justify-between items-center text-[12px]">
                    <span className="text-slate-600">{stg.name}</span>
                    {stg.status === 'pass' ? (
                      <span className="text-[#0DBA67] font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Pass ({stg.latency}ms)
                      </span>
                    ) : stg.status === 'fail' ? (
                      <span className="text-[#F2343B] font-bold">Failed</span>
                    ) : stg.status === 'testing' ? (
                      <span className="text-[#2A82E7] font-semibold animate-pulse">Testing...</span>
                    ) : (
                      <span className="text-slate-400">{stg.status === 'pending' ? 'Waiting' : stg.status}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <Button
              variant="secondary"
              className="w-full"
              icon={<Play className="w-4 h-4 text-[#EF1B24]" />}
              onClick={handleRunTest}
              loading={isTesting}
            >
              Run Handshake Test
            </Button>
          </Card>

          {/* Region 7: Read Test & Decoded Values */}
          <Card title="Decoded Telemetry Preview">
            <p className="text-[12px] text-[#657794] mb-3">
              Values read and decoded from live registers:
            </p>
            <div className="space-y-2">
              {registers.map((r, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <div>
                    <span className="text-[12px] font-bold text-[#111B37]">{r.name}</span>
                    <span className="text-[10px] text-[#657794] font-mono block">Reg {r.address}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[14px] font-extrabold text-[#111B37] tabular-nums">
                      {testSuccess ? 'queued' : '--'}
                    </span>{' '}
                    <span className="text-[11px] text-[#657794]">{r.unit}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Navigation Buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-[#E3EAF3]">
        <Button
          variant="secondary"
          icon={<ArrowLeft className="w-4 h-4" />}
          disabled={step === 1}
          onClick={() => setStep((s) => s - 1)}
        >
          Back
        </Button>

        {step < 4 ? (
          <Button
            variant="primary"
            icon={<ArrowRight className="w-4 h-4" />}
            onClick={() => {
              if (step === 1 && selectedProtocol === 'formula') {
                setWizardError('Calculated signals are declared from the Signals page after source signals exist.');
                return;
              }
              if (step === 1 && !machines.length) {
                setWizardError('Create a machine in Factory Structure before adding a connection.');
                return;
              }
              if (!resourceId && machines[0]) setResourceId(machines[0].id);
              if (step === 2 && !host.trim()) {
                setWizardError('Enter the endpoint. The browser does not invent one.');
                return;
              }
              setWizardError('');
              setStep((s) => s + 1);
            }}
          >
            Next Step
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<CheckCircle2 className="w-4 h-4" />}
            onClick={() => void handleFinish()}
            disabled={!testSuccess}
          >
            Activate & Finish
          </Button>
        )}
      </div>
    </div>
  );
};
