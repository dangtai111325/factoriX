import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { useApp } from '../../store/AppContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { mappingRowIssues, validMqttFilter } from '../../features/acquisition/contracts';
import { MqttFieldCapture } from '../../features/acquisition/MqttFieldCapture';
import { appendDiscoveredFields } from '../../features/acquisition/mqttDiscovery';

type ProtocolId = 'modbus' | 'opcua' | 'mqtt' | 'http' | 'formula';

type MappingRow = {
  topic?: string;
  address: string;
  name: string;
  type: string;
  dataType: string;
  unit: string;
};

const PORT_DEFAULTS: Record<Exclude<ProtocolId, 'formula'>, string> = {
  modbus: '502',
  opcua: '4840',
  mqtt: '1883',
  http: '80',
};

function isValidPort(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

function isValidModbusUnit(value: string): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number(value);
  return n >= 0 && n <= 247;
}

function isValidMqttTopic(topic: string): boolean {
  return validMqttFilter(topic);
}

export const AddDataWizardPage: React.FC = () => {
  const {
    resources,
    prepareAcquisition,
    commissionAcquisition,
    activateAcquisition,
    deleteConnection,
  } = useApp() as ReturnType<typeof useApp> & {
    deleteConnection?: (id: string) => Promise<void>;
  };
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const machines = resources.filter((item) => item.type === 'machine' || item.type === 'line');

  const [step, setStep] = useState(1);
  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolId | null>(() => {
    const protocol = searchParams.get('protocol');
    return ['modbus', 'opcua', 'mqtt', 'http', 'formula'].includes(protocol || '') ? protocol as ProtocolId : null;
  });
  const [resourceId, setResourceId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('502');
  const [unitId, setUnitId] = useState('1');
  const [mqttTopic, setMqttTopic] = useState('');
  const [mqttQos, setMqttQos] = useState('1');
  const [mqttClientId, setMqttClientId] = useState(() => `fx-${Math.random().toString(36).slice(2, 10)}`);
  const [mqttVersion, setMqttVersion] = useState('3.1.1');
  const [mqttKeepalive, setMqttKeepalive] = useState('60');
  const [mqttTls, setMqttTls] = useState(false);
  const [mqttAnonymous, setMqttAnonymous] = useState(true);
  const [opcEndpoint, setOpcEndpoint] = useState('');
  const [opcSecurity, setOpcSecurity] = useState('None');
  const [httpBaseUrl, setHttpBaseUrl] = useState('');
  const [httpPath, setHttpPath] = useState('/');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [interval, setIntervalMs] = useState('1000');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showMappingErrors, setShowMappingErrors] = useState(false);
  const [prepared, setPrepared] = useState<{ connectionId: string; jobId: string; edgeId: string } | null>(null);
  const [wizardError, setWizardError] = useState('');
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);

  const [registers, setRegisters] = useState<MappingRow[]>([
    { address: '', name: '', type: 'Holding Register', dataType: 'Float32', unit: '' },
  ]);

  const [isTesting, setIsTesting] = useState(false);
  const [testStages, setTestStages] = useState<
    Array<{ name: string; status: 'pending' | 'testing' | 'pass' | 'fail'; latency?: number }>
  >([]);
  const [testSuccess, setTestSuccess] = useState(false);

  const targetResource = useMemo(
    () => resources.find((item) => item.id === resourceId),
    [resourceId, resources],
  );

  const targetPath = useMemo(() => {
    if (!targetResource) return '';
    const parts: string[] = [];
    let current: typeof targetResource | undefined = targetResource;
    const byId = new Map(resources.map((r) => [r.id, r]));
    while (current) {
      parts.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return parts.join(' / ');
  }, [resources, targetResource]);

  useEffect(() => {
    const fromQuery = searchParams.get('resourceId');
    if (fromQuery && machines.some((item) => item.id === fromQuery)) {
      setResourceId(fromQuery);
    } else if (!resourceId && machines[0]) {
      setResourceId(machines[0].id);
    }
  }, [machines, resourceId, searchParams]);

  useEffect(() => {
    if (!selectedProtocol || selectedProtocol === 'formula') return;
    setPort(PORT_DEFAULTS[selectedProtocol]);
    setPrepared(null);
    setTestSuccess(false);
    setRegisters([
      selectedProtocol === 'mqtt'
        ? { address: '$.', name: '', type: 'JSONPath', dataType: 'Float32', unit: '' }
        : selectedProtocol === 'opcua'
          ? { address: 'ns=2;s=', name: '', type: 'NodeId', dataType: 'Float32', unit: '' }
          : selectedProtocol === 'http'
            ? { address: '$.', name: '', type: 'JSONPath', dataType: 'Float32', unit: '' }
            : { address: '', name: '', type: 'Holding Register', dataType: 'Float32', unit: '' },
    ]);
  }, [selectedProtocol]);

  const mappingColumns = useMemo(() => {
    if (selectedProtocol === 'mqtt' || selectedProtocol === 'http') {
      return { address: 'JSONPath', type: 'Source', hint: 'e.g. $.status or $.machine_temp_1' };
    }
    if (selectedProtocol === 'opcua') {
      return { address: 'NodeId', type: 'Node', hint: 'e.g. ns=2;s=Temperature' };
    }
    return { address: 'Address', type: 'Register Type', hint: 'Holding register offset' };
  }, [selectedProtocol]);

  const draftExtra = () => {
    if (selectedProtocol === 'mqtt') return mqttTopic;
    if (selectedProtocol === 'http') return httpPath.trim() || '/';
    if (selectedProtocol === 'opcua') return opcSecurity;
    return unitId.trim();
  };

  const draftHost = () => {
    if (selectedProtocol === 'opcua') {
      if (opcEndpoint.trim()) return opcEndpoint.trim();
      return host.trim();
    }
    if (selectedProtocol === 'http') {
      if (httpBaseUrl.trim()) return httpBaseUrl.trim();
      return host.trim();
    }
    return host.trim();
  };

  const draft = () => ({
    protocol: (selectedProtocol === 'formula' ? 'modbus' : selectedProtocol || 'modbus') as
      | 'modbus'
      | 'opcua'
      | 'mqtt'
      | 'http',
    name: connectionName || `${selectedProtocol} ${draftHost()}`,
    host: draftHost(),
    port,
    extra: draftExtra(),
    intervalMs: Number(interval) || 1000,
    resourceId,
    fields: registers
      .filter((row) => row.name.trim() && row.address.trim())
      .map((row) => ({
        name: row.name.trim(),
        address: row.address.trim(),
        dataType: row.dataType,
        unit: row.unit,
        ...(selectedProtocol === 'mqtt' ? {topic:row.topic || ''} : {}),
      })),
    mqttQos: Number(mqttQos),
    mqttClientId,
    mqttVersion,
    mqttKeepalive: Number(mqttKeepalive),
    mqttTls,
    mqttAnonymous,
    httpMethod,
  });

  const { fields: currentFields, ...currentConfig } = draft();
  const configFingerprint = JSON.stringify(currentConfig);
  const latestConfigFingerprint = useRef(configFingerprint);
  latestConfigFingerprint.current = configFingerprint;
  const mappingFingerprint = JSON.stringify(currentFields);
  const draftFingerprint = configFingerprint + mappingFingerprint;
  const latestDraftFingerprint = useRef(draftFingerprint);
  latestDraftFingerprint.current = draftFingerprint;
  useEffect(() => { setPrepared(null); }, [configFingerprint]);
  useEffect(() => {
    setTestSuccess(false);
    setTestStages([]);
  }, [draftFingerprint]);

  const validateStep2 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!resourceId) errors.resourceId = 'Select a machine or line.';
    if (!selectedProtocol || selectedProtocol === 'formula') {
      errors.protocol = 'Select a protocol.';
    }

    if (selectedProtocol === 'mqtt') {
      if (!host.trim()) errors.host = 'Broker host is required.';
      if (!isValidPort(port)) errors.port = 'Port must be an integer from 1 to 65535.';
      if (!isValidMqttTopic(mqttTopic)) {
        errors.mqttTopic = 'Enter a valid MQTT topic filter (wildcards # and + allowed).';
      }
      if (!['0', '1', '2'].includes(mqttQos)) errors.mqttQos = 'QoS must be 0, 1, or 2.';
      if (!/^\d+$/.test(mqttKeepalive) || Number(mqttKeepalive) > 65535) errors.mqttKeepalive = 'Keepalive must be 0–65535 seconds.';
    } else if (selectedProtocol === 'opcua') {
      const ep = opcEndpoint.trim() || (host.trim() ? `opc.tcp://${host.trim()}:${port}` : '');
      if (!ep) errors.opcEndpoint = 'OPC UA endpoint URL is required.';
      else if (!ep.startsWith('opc.tcp://')) errors.opcEndpoint = 'Endpoint must start with opc.tcp://';
      if (host.trim() && !opcEndpoint.trim() && !isValidPort(port)) {
        errors.port = 'Port must be an integer from 1 to 65535.';
      }
    } else if (selectedProtocol === 'http') {
      const url = httpBaseUrl.trim() || host.trim();
      if (!url) errors.httpBaseUrl = 'Base URL or host is required.';
      if (!httpBaseUrl.trim() && host.trim() && !isValidPort(port)) {
        errors.port = 'Port must be an integer from 1 to 65535.';
      }
      if (!httpPath.trim().startsWith('/')) errors.httpPath = 'Path must start with /.';
    } else if (selectedProtocol === 'modbus') {
      if (!host.trim()) errors.host = 'PLC host / IP is required.';
      if (!isValidPort(port)) errors.port = 'Port must be an integer from 1 to 65535.';
      if (!isValidModbusUnit(unitId)) errors.unitId = 'Unit / Slave ID must be 0–247.';
    }

    if (!/^\d+$/.test(interval.trim()) || Number(interval) < 100) {
      errors.interval = 'Poll / keep-alive interval must be at least 100 ms.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setWizardError('Fix the highlighted fields before continuing.');
      return false;
    }
    setWizardError('');
    return true;
  };

  const validateStep3 = (): boolean => {
    setShowMappingErrors(true);
    const issues = mappingRowIssues(selectedProtocol === 'formula' || !selectedProtocol ? 'modbus' : selectedProtocol, registers);
    if (issues.length) {
      setWizardError('Correct the highlighted mapping rows before continuing.');
      return false;
    }
    const valid = registers.filter((row) => row.name.trim() && row.address.trim());
    if (!valid.length) {
      setWizardError('Add at least one complete mapping row (name + address/JSONPath/NodeId).');
      return false;
    }
    setWizardError('');
    return true;
  };
  const mappingErrors = useMemo(() => {
    const issues = showMappingErrors ? mappingRowIssues(selectedProtocol === 'formula' || !selectedProtocol ? 'modbus' : selectedProtocol, registers) : [];
    return new Map(issues.map(issue=>[`${issue.row}.${issue.field}`,issue.message]));
  }, [showMappingErrors, selectedProtocol, registers]);

  const handleRunTest = async () => {
    if (!validateStep2() || !validateStep3()) return;
    const testedFingerprint = draftFingerprint;
    setIsTesting(true);
    setTestSuccess(false);
    setWizardError('');
    try {
      const body = draft();
      const next = prepared ?? (await prepareAcquisition(body));
      setPrepared(next);
      const result = await commissionAcquisition(next.connectionId, body);
      if (latestDraftFingerprint.current !== testedFingerprint) {
        setWizardError('The configuration changed during the test. Run the test again.');
        return;
      }
      setTestStages(
        result.stages.map((stage) => ({
          name: stage.name,
          status:
            ['PASSED', 'COMPLETED', 'NOT_APPLICABLE'].includes(stage.status)
              ? 'pass'
              : stage.status === 'FAILED'
                ? 'fail'
                : 'pending',
          latency: stage.latency,
        })),
      );
      setTestSuccess(result.passed);
      if (!result.passed) {
        const failed = result.stages.find((s) => s.status === 'FAILED');
        const hint =
          failed?.name?.toUpperCase().includes('EDGE') ||
          result.stages.some((s) => String(s.status).includes('EDGE_NOT_ENROLLED'))
            ? ' Edge is not enrolled — open Data Collector › Edge Collectors to enroll the collector.'
            : '';
        setWizardError(
          (failed ? `Acquisition test failed at ${failed.name}. ${failed.detail || ''}` : 'Acquisition test did not pass.') + hint,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Test failed';
      setWizardError(message);
      if (/EDGE_NOT_ENROLLED|not enrolled/i.test(message)) {
        setTestStages([{ name: 'EDGE_ENROLLMENT', status: 'fail' }]);
      }
    } finally {
      setIsTesting(false);
    }
  };

  const handleFinish = async () => {
    setWizardError('');
    try {
      const body = draft();
      if (!prepared) throw new Error('Run the handshake before activation.');
      if (!testSuccess) throw new Error('Run a successful acquisition and mapping test before activation.');
      if (!body.fields.length) throw new Error('Add at least one named field before activation.');
      await activateAcquisition(prepared, body);
      navigate('/collector/signals');
    } catch (error) {
      setWizardError(error instanceof Error ? error.message : 'Activation failed');
    }
  };

  const handleCancel = async () => {
    if (prepared?.connectionId) {
      setDiscardPrompt(true);
      return;
    }
    navigate(-1);
  };

  const confirmDiscard = async (discard: boolean) => {
    setDiscardPrompt(false);
    if (discard && prepared?.connectionId && deleteConnection) {
      try {
        await deleteConnection(prepared.connectionId);
      } catch {
        /* best effort */
      }
    }
    navigate('/collector/connections');
  };

  const stepLabels = [
    { num: 1, label: 'Protocol Choice' },
    { num: 2, label: 'Endpoint Settings' },
    {
      num: 3,
      label:
        selectedProtocol === 'mqtt' || selectedProtocol === 'http'
          ? 'Topic / Field Mapping'
          : selectedProtocol === 'opcua'
            ? 'Node Mapping'
            : 'Register Mapping',
    },
    { num: 4, label: 'Test & Activate' },
  ];

  const endpointSubtitle = () => {
    switch (selectedProtocol) {
      case 'mqtt':
        return 'Broker host, topic filter, QoS and session options:';
      case 'opcua':
        return 'OPC UA endpoint URL and security mode:';
      case 'http':
        return 'REST base URL, path and polling interval:';
      default:
        return 'PLC host, port, unit id and polling interval:';
    }
  };

  return (
    <div className="space-y-4 max-w-5xl mx-auto animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Add Data Acquisition Wizard</h1>
          <p className="fx-page-subtitle">
            {targetResource
              ? `Target: ${targetPath || targetResource.name} (${targetResource.type})`
              : 'Choose a machine you already created, then the collector tests the endpoint before any signal is saved.'}
          </p>
          {wizardError && <p className="text-[12px] text-[#F2343B] mt-2">{wizardError}</p>}
        </div>
        <Button variant="secondary" onClick={() => void handleCancel()}>
          Cancel Wizard
        </Button>
      </div>

      {discardPrompt && (
        <Card className="p-4 border-[#FAC6C9] bg-[#FFF8F8]">
          <p className="text-[13px] text-[#111B37] font-semibold mb-2">
            Discard draft connection created by the handshake test?
          </p>
          <p className="text-[12px] text-[#657794] mb-3">
            Cancel normally leaves a DRAFT connection in the list. Discard removes it.
          </p>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" onClick={() => void confirmDiscard(true)}>
              Discard draft
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void confirmDiscard(false)}>
              Keep draft & leave
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          {stepLabels.map((s) => {
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

      {step === 1 && (
        <Card title="Select Protocol Source" subtitle="Choose industrial connection protocol to acquire data from:">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5 mt-2">
            {[
              {
                id: 'modbus' as const,
                name: 'Modbus TCP / RTU',
                desc: 'Standard PLC registers (Holding, Input, Coil) over TCP port 502',
                icon: Network,
                badge: 'PLC Standard',
                enabled: true,
              },
              {
                id: 'opcua' as const,
                name: 'OPC UA Client',
                desc: 'Industrial IoT address space browse, subscriptions and certificates',
                icon: Cable,
                badge: 'Rich Model',
                enabled: true,
              },
              {
                id: 'mqtt' as const,
                name: 'MQTT Client',
                desc: 'Subscribe to broker topics and map JSON fields with JSONPath',
                icon: RadioTower,
                badge: 'Edge / Cloud',
                enabled: true,
              },
              {
                id: 'http' as const,
                name: 'REST / HTTP API',
                desc: 'Polling external webhooks, MES endpoints or SCADA web services',
                icon: Cloud,
                badge: 'Web Standard',
                enabled: true,
              },
              {
                id: 'formula' as const,
                name: 'Custom Calculated Rule',
                desc: 'Declare calculated signals from the Signals page after source signals exist.',
                icon: Sigma,
                badge: 'Later',
                enabled: false,
              },
            ].map((p) => {
              const Icon = p.icon;
              const isSelected = selectedProtocol === p.id;
              return (
                <button
                  type="button"
                  key={p.id}
                  disabled={!p.enabled}
                  onClick={() => {
                    if (!p.enabled) {
                      setWizardError(
                        'Calculated signals are declared from the Signals page after source signals exist.',
                      );
                      return;
                    }
                    setSelectedProtocol(p.id);
                    setWizardError('');
                  }}
                  className={`p-4 rounded-xl border-2 text-left transition-all bg-white shadow-sm flex flex-col justify-between ${
                    !p.enabled
                      ? 'opacity-60 cursor-not-allowed border-[#E3EAF3]'
                      : isSelected
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
                      {!p.enabled ? 'Unavailable' : isSelected ? 'Selected ✓' : 'Select'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {step === 2 && selectedProtocol && selectedProtocol !== 'formula' && (
        <Card title="Configure Connection Parameters" subtitle={endpointSubtitle()}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl py-2">
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">Machine / Line</label>
              <select
                className="fx-input"
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
              >
                <option value="">Select a machine or line</option>
                {machines.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.type})
                  </option>
                ))}
              </select>
              {fieldErrors.resourceId && (
                <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.resourceId}</p>
              )}
            </div>
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">Connection name</label>
              <input
                className="fx-input"
                value={connectionName}
                onChange={(event) => setConnectionName(event.target.value)}
                placeholder={`${selectedProtocol}-connection`}
              />
            </div>

            {selectedProtocol === 'modbus' && (
              <>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    PLC Host / IP Address <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={host}
                    onChange={(e) => {
                      setHost(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                    }}
                  />
                  {fieldErrors.host && <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.host}</p>}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    TCP Port <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                  {fieldErrors.port && <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.port}</p>}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    Unit / Slave ID <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={unitId}
                    onChange={(e) => setUnitId(e.target.value)}
                  />
                  {fieldErrors.unitId && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.unitId}</p>
                  )}
                </div>
              </>
            )}

            {selectedProtocol === 'mqtt' && (
              <>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    Broker Host <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={host}
                    placeholder="192.168.2.108"
                    onChange={(e) => {
                      setHost(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                    }}
                  />
                  {fieldErrors.host && <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.host}</p>}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    Broker Port <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                  {fieldErrors.port && <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.port}</p>}
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    Topic filter <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={mqttTopic}
                    placeholder="uns/TIPA/DongNai/Factory-1/ASSY/#"
                    onChange={(e) => {
                      setMqttTopic(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                    }}
                  />
                  {fieldErrors.mqttTopic && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.mqttTopic}</p>
                  )}
                  <p className="text-[11px] text-[#657794] mt-1">Supports wildcards # and +</p>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">QoS</label>
                  <select className="fx-input" value={mqttQos} onChange={(e) => setMqttQos(e.target.value)}>
                    <option value="0">0 — At most once</option>
                    <option value="1">1 — At least once</option>
                    <option value="2">2 — Exactly once</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">MQTT version</label>
                  <select
                    className="fx-input"
                    value={mqttVersion}
                    onChange={(e) => setMqttVersion(e.target.value)}
                  >
                    <option value="3.1.1">3.1.1</option>
                    <option value="5.0">5.0</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Client ID</label>
                  <input
                    className="fx-input font-mono"
                    value={mqttClientId}
                    onChange={(e) => setMqttClientId(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Keepalive (s)</label>
                  <input
                    className="fx-input font-mono"
                    value={mqttKeepalive}
                    onChange={(e) => setMqttKeepalive(e.target.value)}
                  />
                  {fieldErrors.mqttKeepalive && <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.mqttKeepalive}</p>}
                </div>
                <div className="flex items-center gap-4 md:col-span-2">
                  <label className="flex items-center gap-2 text-[12px] text-[#111B37]">
                    <input
                      type="checkbox"
                      checked={mqttAnonymous}
                      onChange={(e) => setMqttAnonymous(e.target.checked)}
                    />
                    Anonymous (no username)
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-[#111B37]">
                    <input type="checkbox" checked={mqttTls} onChange={(e) => setMqttTls(e.target.checked)} />
                    TLS
                  </label>
                </div>
              </>
            )}

            {selectedProtocol === 'opcua' && (
              <>
                <div className="md:col-span-2">
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    Endpoint URL <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={opcEndpoint}
                    placeholder="opc.tcp://192.168.2.108:14840/UA/Server"
                    onChange={(e) => {
                      setOpcEndpoint(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                    }}
                  />
                  {fieldErrors.opcEndpoint && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.opcEndpoint}</p>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Security mode</label>
                  <select
                    className="fx-input"
                    value={opcSecurity}
                    onChange={(e) => setOpcSecurity(e.target.value)}
                  >
                    <option value="None">None</option>
                    <option value="Sign">Sign</option>
                    <option value="SignAndEncrypt">SignAndEncrypt</option>
                  </select>
                </div>
              </>
            )}

            {selectedProtocol === 'http' && (
              <>
                <div className="md:col-span-2">
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                    Base URL <span className="text-[#EF1B24]">*</span>
                  </label>
                  <input
                    className="fx-input font-mono"
                    value={httpBaseUrl}
                    placeholder="http://192.168.2.50:8080"
                    onChange={(e) => {
                      setHttpBaseUrl(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                    }}
                  />
                  {fieldErrors.httpBaseUrl && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.httpBaseUrl}</p>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Path</label>
                  <input
                    className="fx-input font-mono"
                    value={httpPath}
                    onChange={(e) => setHttpPath(e.target.value)}
                  />
                  {fieldErrors.httpPath && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.httpPath}</p>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Method</label>
                  <select className="fx-input" value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)}>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>
              </>
            )}

            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                {selectedProtocol === 'mqtt' ? 'Keep-alive / sample interval (ms)' : 'Poll Interval (ms)'}{' '}
                <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                className="fx-input font-mono"
                value={interval}
                onChange={(e) => setIntervalMs(e.target.value)}
              />
              {fieldErrors.interval && (
                <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.interval}</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card
          title={
            selectedProtocol === 'mqtt'
              ? 'MQTT Topic → JSONPath Mapping'
              : selectedProtocol === 'http'
                ? 'HTTP Response → JSONPath Mapping'
                : selectedProtocol === 'opcua'
                  ? 'OPC UA Node Mapping'
                  : 'Register Range & Tag Mapping'
          }
          subtitle={
            selectedProtocol === 'mqtt'
              ? 'Map JSON fields from subscribed payloads to signal keys:'
              : 'Define fields to collect from the endpoint:'
          }
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => {
                setRegisters((prev) => [
                  ...prev,
                  {
                    address: selectedProtocol === 'modbus' ? '' : '$.',
                    name: '',
                    type: mappingColumns.type,
                    dataType: 'Float32',
                    unit: '',
                    ...(selectedProtocol === 'mqtt' ? {topic:!/[+#]/.test(mqttTopic)?mqttTopic:''}:{}),
                  },
                ]);
              }}
            >
              Add Row
            </Button>
          }
        >
          {selectedProtocol === 'mqtt' ? <MqttFieldCapture
            key={configFingerprint}
            filter={mqttTopic}
            onBusy={setCaptureBusy}
            prepare={async () => {
              if (!validateStep2()) throw new Error('Correct the connection settings before capture.');
              const next = prepared ?? await prepareAcquisition(draft());
              if (latestConfigFingerprint.current !== configFingerprint) throw new Error('Connection settings changed. Capture again with the current settings.');
              setPrepared(next);
              return next.connectionId;
            }}
            onAdd={(topic, fields) => setRegisters(previous => appendDiscoveredFields(previous, topic, fields))}
          /> : null}
          <div className="overflow-x-auto">
            <table className="fx-table">
              <thead>
                <tr>
                  {selectedProtocol === 'mqtt' ? <th>Topic</th> : null}
                  <th>{mappingColumns.address}</th>
                  <th>Tag Name</th>
                  <th>{mappingColumns.type}</th>
                  <th>Data Type</th>
                  <th>Unit</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {registers.map((reg, idx) => (
                  <tr key={idx}>
                    {selectedProtocol === 'mqtt' ? <td className="min-w-64"><input aria-label={`Row ${idx+1} topic`} aria-invalid={mappingErrors.has(`${idx}.topic`)} aria-describedby={mappingErrors.has(`${idx}.topic`)?`mapping-topic-${idx}`:undefined} className="fx-input h-8 font-mono text-xs" value={reg.topic || ''} maxLength={2048} placeholder="Exact topic or explicit field filter" onChange={event=>setRegisters(previous=>previous.map((row,at)=>at===idx?{...row,topic:event.target.value}:row))}/>{mappingErrors.has(`${idx}.topic`)?<p id={`mapping-topic-${idx}`} className="mt-1 text-xs text-[var(--fx-error)]">{mappingErrors.get(`${idx}.topic`)}</p>:null}</td>:null}
                    <td>
                      <input
                        type="text"
                        value={reg.address}
                        aria-label={`Row ${idx+1} address`}
                        aria-invalid={mappingErrors.has(`${idx}.address`)}
                        placeholder={mappingColumns.hint}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRegisters((prev) => prev.map((r, i) => (i === idx ? { ...r, address: val } : r)));
                        }}
                        className="fx-input h-8 font-mono text-[12px]"
                      />
                      {mappingErrors.has(`${idx}.address`)?<p className="mt-1 text-xs text-[var(--fx-error)]">{mappingErrors.get(`${idx}.address`)}</p>:null}
                    </td>
                    <td>
                      <input
                        type="text"
                        value={reg.name}
                        aria-label={`Row ${idx+1} name`}
                        aria-invalid={mappingErrors.has(`${idx}.name`)}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRegisters((prev) => prev.map((r, i) => (i === idx ? { ...r, name: val } : r)));
                        }}
                        className="fx-input h-8 font-semibold text-[12px]"
                      />
                      {mappingErrors.has(`${idx}.name`)?<p className="mt-1 text-xs text-[var(--fx-error)]">{mappingErrors.get(`${idx}.name`)}</p>:null}
                    </td>
                    <td>
                      <span className="text-[12px] text-[#657794]">{reg.type}</span>
                    </td>
                    <td>
                      <select
                        className="fx-input h-8 text-[12px]"
                        value={reg.dataType}
                        aria-label={`Row ${idx+1} data type`}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRegisters((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, dataType: val } : r)),
                          );
                        }}
                      >
                        <option value="Float32">Float32</option>
                        <option value="Float64">Float64</option>
                        <option value="Int32">Int32</option>
                        <option value="Int64">Int64</option>
                        <option value="Bool">Bool</option>
                        <option value="String">String</option>
                        <option value="JSON">JSON</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={reg.unit}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRegisters((prev) => prev.map((r, i) => (i === idx ? { ...r, unit: val } : r)));
                        }}
                        className="fx-input h-8 text-[12px]"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setRegisters((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-[#F2343B] p-1 hover:bg-[#FFF0F1] rounded"
                        aria-label="Remove row"
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
          <Card title="Live Handshake & Ping Verification">
            <p className="text-[12px] text-[#657794] mb-4">
              Test connection to{' '}
              <span className="font-mono font-bold text-[#111B37]">
                {selectedProtocol === 'mqtt'
                  ? `${host}:${port} topic ${mqttTopic || '—'}`
                  : selectedProtocol === 'opcua'
                    ? opcEndpoint || `${host}:${port}`
                    : selectedProtocol === 'http'
                      ? httpBaseUrl || `${host}:${port}`
                      : `${host}:${port}`}
              </span>{' '}
              before activating.
            </p>
            <div className="p-4 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3] space-y-3 mb-4">
              <div className="flex justify-between text-[13px]">
                <span className="text-[#657794]">Protocol:</span>
                <span className="font-mono font-bold text-[#111B37] uppercase">{selectedProtocol}</span>
              </div>
              {selectedProtocol === 'mqtt' && (
                <div className="flex justify-between text-[13px]">
                  <span className="text-[#657794]">Topic:</span>
                  <span className="font-mono font-bold text-[#111B37] text-right max-w-[60%] break-all">
                    {mqttTopic || '—'}
                  </span>
                </div>
              )}
              {selectedProtocol === 'modbus' && (
                <div className="flex justify-between text-[13px]">
                  <span className="text-[#657794]">Unit ID:</span>
                  <span className="font-mono font-bold text-[#111B37]">{unitId}</span>
                </div>
              )}
              <div className="space-y-1.5 pt-2 border-t border-[#E3EAF3]">
                {testStages.length === 0 && (
                  <p className="text-[12px] text-slate-400">Run the handshake to evaluate collector stages.</p>
                )}
                {testStages.map((stg, idx) => (
                  <div key={idx} className="flex justify-between items-center text-[12px]">
                    <span className="text-slate-600">{stg.name}</span>
                    {stg.status === 'pass' ? (
                      <span className="text-[#0DBA67] font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Pass
                        {stg.latency != null ? ` (${stg.latency}ms)` : ''}
                      </span>
                    ) : stg.status === 'fail' ? (
                      <span className="text-[#F2343B] font-bold">Failed</span>
                    ) : stg.status === 'testing' ? (
                      <span className="text-[#2A82E7] font-semibold animate-pulse">Testing...</span>
                    ) : (
                      <span className="text-slate-400">Waiting</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <Button
              variant="secondary"
              className="w-full"
              icon={<Play className="w-4 h-4 text-[#EF1B24]" />}
              onClick={() => void handleRunTest()}
              loading={isTesting}
            >
              Run Handshake Test
            </Button>
            {!testSuccess && (
              <p className="text-[11px] text-[#657794] mt-2">
                Activate stays locked until the handshake passes. If the Edge is not enrolled, open{' '}
                <button
                  type="button"
                  className="text-[#EF1B24] font-semibold underline"
                  onClick={() => navigate('/collector/edges')}
                >
                  Edges
                </button>
                .
              </p>
            )}
          </Card>

          <Card title="Mapped Fields Preview">
            <p className="text-[12px] text-[#657794] mb-3">
              {selectedProtocol === 'mqtt'
                ? 'Fields that will be extracted from MQTT JSON payloads:'
                : 'Fields queued for activation after a successful handshake:'}
            </p>
            <div className="space-y-2">
              {registers
                .filter((r) => r.name && r.address)
                .map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]"
                  >
                    <div>
                      <span className="text-[12px] font-bold text-[#111B37]">{r.name}</span>
                      <span className="text-[10px] text-[#657794] font-mono block">{r.address}</span>
                      {selectedProtocol==='mqtt'?<span className="block break-all font-mono text-[10px] text-[#657794]">{r.topic}</span>:null}
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

      <div className="flex items-center justify-between pt-4 border-t border-[#E3EAF3]">
        <Button
          variant="secondary"
          icon={<ArrowLeft className="w-4 h-4" />}
          disabled={step === 1 || captureBusy || isTesting}
          onClick={() => setStep((s) => s - 1)}
        >
          Back
        </Button>

        {step < 4 ? (
          <Button
            variant="primary"
            icon={<ArrowRight className="w-4 h-4" />}
            disabled={captureBusy}
            onClick={() => {
              if (step === 1) {
                if (!selectedProtocol) {
                  setWizardError('Select a protocol to continue.');
                  return;
                }
                if (selectedProtocol === 'formula') {
                  setWizardError(
                    'Calculated signals are declared from the Signals page after source signals exist.',
                  );
                  return;
                }
                if (!machines.length) {
                  setWizardError('Create a machine in Factory Structure before adding a connection.');
                  return;
                }
                setWizardError('');
                setStep(2);
                return;
              }
              if (step === 2) {
                if (!validateStep2()) return;
                if (selectedProtocol==='mqtt' && !/[+#]/.test(mqttTopic)) setRegisters(previous=>previous.map(row=>row.topic?row:{...row,topic:mqttTopic}));
                setStep(3);
                return;
              }
              if (step === 3) {
                if (!validateStep3()) return;
                setStep(4);
              }
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
            title={!testSuccess ? 'Handshake must pass before activation' : undefined}
          >
            Activate & Finish
          </Button>
        )}
      </div>
    </div>
  );
};
