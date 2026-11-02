import React, { useEffect, useMemo, useState } from 'react';
import {
  Network,
  Cable,
  RadioTower,
  Cloud,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { ApiError } from '../../api/client';
import { useApp } from '../../store/AppContext';
import { useNavigate, useSearchParams } from 'react-router-dom';

type ProtocolId = 'modbus' | 'opcua' | 'mqtt' | 'http';

type MappingRow = {
  address: string;
  name: string;
  type: string;
  dataType: string;
  unit: string;
  topic?: string;
  sampleValue?: string;
  registerArea?: string;
  wordOrder?: 'big' | 'little';
  scale?: string;
  offset?: string;
};

type SampleTopic = { topic: string; payload: unknown };

const PORT_DEFAULTS: Record<ProtocolId, string> = {
  modbus: '502',
  opcua: '4840',
  mqtt: '1883',
  http: '80',
};

const UNIT_SUGGESTIONS = ['pcs', 'rpm', '°C', 'Cel', '%', '%RH', 'kW', 'W', 'kWh', 'V', 'A', 'bar', 'Hz', 's', 'm', 'kg'];

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
  const t = topic.trim();
  if (!t) return false;
  if (t.includes('#') && !t.endsWith('/#') && t !== '#') return false;
  if (t.split('/').some((seg) => seg.includes('#') && seg !== '#')) return false;
  return true;
}

function guessDataType(value: unknown): string {
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'Timestamp';
    return 'String';
  }
  if (value && typeof value === 'object') return 'JSON';
  return 'Number';
}

function flattenJson(value: unknown, prefix = '$'): Array<{ path: string; value: unknown }> {
  if (value === null || value === undefined) return [{ path: prefix, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenJson(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenJson(child, `${prefix}.${key}`),
    );
  }
  return [{ path: prefix, value }];
}

function stageLabel(name: string): string {
  const key = name.toUpperCase();
  if (key === 'NETWORK') return 'Reach broker';
  if (key === 'AUTH') return 'Authenticate';
  if (key === 'PROTOCOL' || key === 'READ_OR_SUBSCRIBE') return 'Subscribe';
  if (key === 'DECODE') return 'Receive sample';
  if (key === 'MAPPING' || key === 'VALIDATION' || key === 'MAP_FIELDS') return 'Map fields';
  return name;
}

function stageUiStatus(
  status: string,
): 'pending' | 'testing' | 'pass' | 'fail' {
  const s = status.toUpperCase();
  if (s === 'PASSED' || s === 'COMPLETED' || s === 'NOT_APPLICABLE') return 'pass';
  if (s === 'FAILED' || s === 'ERROR') return 'fail';
  // NOT_TESTED and unknowns stay pending — never show fake Pass.
  return 'pending';
}

export const AddDataWizardPage: React.FC = () => {
  const {
    resources,
    connections,
    prepareAcquisition,
    commissionAcquisition,
    activateAcquisition,
    deleteConnection,
  } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('from') || '/acquisition/connections';
  const machines = resources.filter((item) => item.type === 'machine' || item.type === 'line');
  const editConnectionId = searchParams.get('connectionId') || '';

  const [step, setStep] = useState(1);
  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolId | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('502');
  const [unitId, setUnitId] = useState('1');
  const [modbusTimeoutMs, setModbusTimeoutMs] = useState('3000');
  const [modbusRetries, setModbusRetries] = useState('1');
  const [mqttTopic, setMqttTopic] = useState('');
  const [mqttQos, setMqttQos] = useState('1');
  const [mqttClientId, setMqttClientId] = useState(() => `fx-${Math.random().toString(36).slice(2, 10)}`);
  const [mqttVersion, setMqttVersion] = useState('3.1.1');
  const [mqttKeepalive, setMqttKeepalive] = useState('60');
  const [mqttTls, setMqttTls] = useState(false);
  const [mqttTlsVerify, setMqttTlsVerify] = useState(true);
  const [mqttTlsCa, setMqttTlsCa] = useState('');
  const [mqttTlsClientCert, setMqttTlsClientCert] = useState('');
  const [mqttAnonymous, setMqttAnonymous] = useState(true);
  const [mqttUsername, setMqttUsername] = useState('');
  const [mqttPassword, setMqttPassword] = useState('');
  const [timestampJsonpath, setTimestampJsonpath] = useState('$.source_timestamp');
  const [applyToSimilar, setApplyToSimilar] = useState(false);
  const [opcEndpoint, setOpcEndpoint] = useState('');
  const [opcSecurity, setOpcSecurity] = useState('None');
  const [opcSecurityPolicy, setOpcSecurityPolicy] = useState('None');
  const [opcUsername, setOpcUsername] = useState('');
  const [opcPassword, setOpcPassword] = useState('');
  const [opcTrustAll, setOpcTrustAll] = useState(false);
  const [httpBaseUrl, setHttpBaseUrl] = useState('');
  const [httpPath, setHttpPath] = useState('/');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [httpAuth, setHttpAuth] = useState('none');
  const [httpHeaders, setHttpHeaders] = useState('{}');
  const [httpTimeoutMs, setHttpTimeoutMs] = useState('5000');
  const [httpUsername, setHttpUsername] = useState('');
  const [httpPassword, setHttpPassword] = useState('');
  const [httpPreview, setHttpPreview] = useState('');
  const [interval, setIntervalMs] = useState('1000');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<{ connectionId: string; jobId: string; edgeId: string } | null>(null);
  const [wizardError, setWizardError] = useState('');
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [allowLeave, setAllowLeave] = useState(false);

  const [registers, setRegisters] = useState<MappingRow[]>([
    { address: '', name: '', type: 'Holding Register', dataType: 'Float32', unit: '' },
  ]);

  const [isTesting, setIsTesting] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [sampleTopics, setSampleTopics] = useState<SampleTopic[]>([]);
  const [selectedSampleTopic, setSelectedSampleTopic] = useState('');
  const [testStages, setTestStages] = useState<
    Array<{ name: string; status: 'pending' | 'testing' | 'pass' | 'fail'; latency?: number }>
  >([]);
  const [testSuccess, setTestSuccess] = useState(false);

  // BrowserRouter does not support useBlocker; guard tab close/refresh instead.
  useEffect(() => {
    if (!dirty || allowLeave) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, allowLeave]);

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

  const markDirty = () => setDirty(true);

  // CR-Q17: only preselect from query; never auto-pick the first machine.
  // CR-C01: never treat site_id as machine — resourceId must be a machine/line.
  useEffect(() => {
    const fromQuery = searchParams.get('resourceId');
    if (fromQuery && machines.some((item) => item.id === fromQuery)) {
      setResourceId(fromQuery);
    }
  }, [machines, searchParams]);

  // CR-C01: Edit wizard loads existing connection config (not site_id as machine).
  useEffect(() => {
    if (!editConnectionId) return;
    const conn = connections.find((item) => item.id === editConnectionId);
    if (!conn) return;
    setSelectedProtocol(conn.protocol as ProtocolId);
    setConnectionName(conn.name);
    setStep(2);
    const cfg = conn.config || {};
    if (conn.protocol === 'modbus') {
      setHost(String(cfg.host || ''));
      setPort(String(cfg.port || '502'));
      setUnitId(String(cfg.unit_id || '1'));
      setIntervalMs(String(cfg.interval_ms || '1000'));
    } else if (conn.protocol === 'opcua') {
      setOpcEndpoint(String(cfg.endpoint || conn.endpoint || ''));
      setIntervalMs(String(cfg.interval_ms || '1000'));
    } else if (conn.protocol === 'mqtt') {
      setHost(String(cfg.host || ''));
      setPort(String(cfg.port || '1883'));
      const topics = Array.isArray(cfg.topics) ? cfg.topics : [];
      setMqttTopic(String(topics[0] || ''));
      setMqttQos(String(cfg.qos ?? '1'));
      setIntervalMs(String(cfg.interval_ms || '1000'));
    } else if (conn.protocol === 'http') {
      setHttpBaseUrl(String(cfg.base_url || ''));
      setHttpPath(String(cfg.path || '/'));
      setIntervalMs(String(cfg.interval_ms || '1000'));
    }
    // Only set resourceId when query explicitly provided a machine — never site_id.
  }, [editConnectionId, connections]);

  useEffect(() => {
    if (!selectedProtocol) return;
    setPort(PORT_DEFAULTS[selectedProtocol]);
    setPrepared(null);
    setTestSuccess(false);
    setSampleTopics([]);
    setSelectedSampleTopic('');
    setRegisters([
      selectedProtocol === 'mqtt'
        ? { address: '$.', name: '', type: 'JSONPath', dataType: 'Number', unit: '', topic: mqttTopic }
        : selectedProtocol === 'opcua'
          ? { address: 'ns=2;s=', name: '', type: 'NodeId', dataType: 'Float32', unit: '' }
          : selectedProtocol === 'http'
            ? { address: '$.', name: '', type: 'JSONPath', dataType: 'Number', unit: '' }
            : {
                address: '',
                name: '',
                type: 'Holding Register',
                dataType: 'Float32',
                unit: '',
                registerArea: 'holding',
                wordOrder: 'big',
                scale: '1',
                offset: '0',
              },
    ]);
    markDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProtocol]);

  const mappingColumns = useMemo(() => {
    if (selectedProtocol === 'mqtt' || selectedProtocol === 'http') {
      return { address: 'JSONPath', hint: 'e.g. $.status or $.temperature' };
    }
    if (selectedProtocol === 'opcua') {
      return { address: 'NodeId', hint: 'e.g. ns=2;s=Temperature' };
    }
    return { address: 'Address', hint: 'Register offset' };
  }, [selectedProtocol]);

  const draftExtra = () => {
    if (selectedProtocol === 'mqtt') return mqttTopic.trim();
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

  const qosNumber = () => (['0', '1', '2'].includes(mqttQos) ? Number(mqttQos) : 1);

  const draft = () => ({
    protocol: (selectedProtocol || 'modbus') as 'modbus' | 'opcua' | 'mqtt' | 'http',
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
        topic: (row.topic || mqttTopic).trim() || undefined,
        qos: qosNumber(),
        registerArea: row.registerArea,
        wordOrder: row.wordOrder,
        scale: row.scale != null && row.scale !== '' ? Number(row.scale) : undefined,
        offset: row.offset != null && row.offset !== '' ? Number(row.offset) : undefined,
      })),
    mqttQos: qosNumber(),
    mqttClientId,
    mqttVersion,
    mqttKeepalive: Number(mqttKeepalive) || 60,
    mqttTls,
    mqttTlsVerify,
    mqttTlsCa: mqttTlsCa || undefined,
    mqttTlsClientCert: mqttTlsClientCert || undefined,
    mqttAnonymous: mqttAnonymous && !mqttUsername.trim(),
    mqttUsername: mqttUsername.trim() || undefined,
    mqttPassword: mqttPassword || undefined,
    timestampJsonpath: timestampJsonpath.trim() || '$.source_timestamp',
    modbusTimeoutMs: Number(modbusTimeoutMs) || 3000,
    modbusRetries: Number(modbusRetries) || 0,
    opcSecurityMode: opcSecurity,
    opcSecurityPolicy,
    opcUsername: opcUsername.trim() || undefined,
    opcPassword: opcPassword || undefined,
    opcTrustAll,
    httpMethod,
    httpAuth,
    httpHeaders,
    httpTimeoutMs: Number(httpTimeoutMs) || 5000,
    httpUsername: httpUsername.trim() || undefined,
    httpPassword: httpPassword || undefined,
  });

  const showApiErrors = (error: unknown) => {
    if (error instanceof ApiError) {
      const lines = [error.message];
      const mapped: Record<string, string> = {};
      for (const item of error.fieldErrors || []) {
        const path = item.path || '';
        const msg = item.message || item.code || 'Invalid';
        lines.push(`${path}: ${msg}`);
        const bulk = path.match(/^items\[(\d+)\]\.(key|name|data_type|unit)/);
        if (bulk) {
          const idx = Number(bulk[1]);
          mapped[`row-${idx}`] = msg;
          if (bulk[2] === 'key' || bulk[2] === 'name') mapped[`name-${idx}`] = msg;
        } else if (path) {
          mapped[path] = msg;
        }
      }
      setFieldErrors((prev) => ({ ...prev, ...mapped }));
      setFormErrors(lines);
      setWizardError(lines[0]);
      return;
    }
    const message = error instanceof Error ? error.message : 'Request failed';
    setWizardError(message);
    setFormErrors([message]);
  };

  const validateStep2 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!resourceId) errors.resourceId = 'Select a machine or line.';
    if (!selectedProtocol) errors.protocol = 'Select a protocol.';

    if (selectedProtocol === 'mqtt') {
      if (!host.trim()) errors.host = 'Broker host is required.';
      if (!isValidPort(port)) errors.port = 'Port must be an integer from 1 to 65535.';
      if (!isValidMqttTopic(mqttTopic)) {
        errors.mqttTopic = 'Enter a valid MQTT topic filter (wildcards # and + allowed).';
      }
      if (!['0', '1', '2'].includes(mqttQos)) errors.mqttQos = 'QoS must be 0, 1, or 2.';
      if (!mqttAnonymous && !mqttUsername.trim()) errors.mqttUsername = 'Username is required when not anonymous.';
    } else if (selectedProtocol === 'opcua') {
      const ep = opcEndpoint.trim() || (host.trim() ? `opc.tcp://${host.trim()}:${port}` : '');
      if (!ep) errors.opcEndpoint = 'OPC UA endpoint URL is required.';
      else if (!ep.startsWith('opc.tcp://')) errors.opcEndpoint = 'Endpoint must start with opc.tcp://';
    } else if (selectedProtocol === 'http') {
      const url = httpBaseUrl.trim() || host.trim();
      if (!url) errors.httpBaseUrl = 'Base URL or host is required.';
      if (!httpPath.trim().startsWith('/')) errors.httpPath = 'Path must start with /.';
    } else if (selectedProtocol === 'modbus') {
      if (!host.trim()) errors.host = 'PLC host / IP is required.';
      if (!isValidPort(port)) errors.port = 'Port must be an integer from 1 to 65535.';
      if (!isValidModbusUnit(unitId)) errors.unitId = 'Unit / Slave ID must be 0–247.';
    }

    if (selectedProtocol !== 'mqtt') {
      if (!/^\d+$/.test(interval.trim()) || Number(interval) < 100) {
        errors.interval = 'Poll interval must be at least 100 ms.';
      }
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      const msgs = Object.values(errors);
      setFormErrors(msgs);
      setWizardError('Fix the highlighted fields before continuing.');
      return false;
    }
    setWizardError('');
    setFormErrors([]);
    return true;
  };

  const validateStep3 = (): boolean => {
    const valid = registers.filter((row) => row.name.trim() && row.address.trim());
    if (!valid.length) {
      setWizardError('Add at least one complete mapping row (name + address/JSONPath/NodeId).');
      setFormErrors(['Add at least one complete mapping row.']);
      return false;
    }
    const names = valid.map((row) => row.name.trim());
    if (new Set(names).size !== names.length) {
      setWizardError('Duplicate signal names are not allowed.');
      setFormErrors(['Duplicate signal names are not allowed.']);
      return false;
    }
    setWizardError('');
    setFormErrors([]);
    return true;
  };

  const replacePrepared = async () => {
    if (prepared?.connectionId) {
      try {
        await deleteConnection(prepared.connectionId);
      } catch {
        /* best effort clear of old draft */
      }
    }
    setPrepared(null);
    setTestSuccess(false);
    const next = await prepareAcquisition(draft());
    setPrepared(next);
    return next;
  };

  const applyHandshakeResult = (result: Awaited<ReturnType<typeof commissionAcquisition>>) => {
    const preferred = ['NETWORK', 'AUTH', 'READ_OR_SUBSCRIBE', 'DECODE', 'MAPPING'];
    const byName = new Map(
      result.stages
        .filter((s) => !['transport', 'read_sample', 'decode_quality'].includes(s.name.toLowerCase()))
        .map((s) => [s.name.toUpperCase(), s]),
    );
    const ordered = preferred
      .map((n) => byName.get(n) || (n === 'READ_OR_SUBSCRIBE' ? byName.get('PROTOCOL') : undefined))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    const display = ordered.length ? ordered : result.stages.filter(
      (s) => !['transport', 'read_sample', 'decode_quality'].includes(s.name.toLowerCase()),
    );
    setTestStages(
      display.map((stage) => ({
        name: stageLabel(stage.name),
        status: stageUiStatus(stage.status),
        latency: stage.latency && stage.latency > 0 ? stage.latency : undefined,
      })),
    );
    setTestSuccess(result.passed);
    const samples: SampleTopic[] = [];
    for (const stage of result.stages) {
      if (stage.sample && typeof stage.sample === 'object') {
        const sample = stage.sample as { topic?: string; payload?: unknown };
        samples.push({
          topic: sample.topic || mqttTopic || 'sample',
          payload: sample.payload ?? stage.sample,
        });
      }
    }
    if (samples.length) {
      setSampleTopics(samples);
      setSelectedSampleTopic(samples[0].topic);
    }
    return result.passed;
  };

  const handleRunTest = async () => {
    if (!validateStep2() || !validateStep3()) return;
    setIsTesting(true);
    setTestSuccess(false);
    setWizardError('');
    setFormErrors([]);
    try {
      const next = await (prepared ? Promise.resolve(prepared) : replacePrepared());
      const result = await commissionAcquisition(next.connectionId);
      applyHandshakeResult(result);
      if (!result.passed) {
        const failed = result.stages.find((s) => s.status === 'FAILED');
        const hint =
          failed?.name?.toUpperCase().includes('EDGE') || result.errorCode === 'EDGE_NOT_ENROLLED'
            ? ' Edge is not enrolled — open Acquisition › Edges to enroll the collector.'
            : '';
        setWizardError(
          (failed ? `Handshake failed at ${stageLabel(failed.name)}.` : 'Handshake did not pass — Map fields must succeed.') +
            hint,
        );
      }
    } catch (error) {
      showApiErrors(error);
      if (error instanceof Error && /EDGE_NOT_ENROLLED|not enrolled/i.test(error.message)) {
        setTestStages([{ name: 'EDGE_ENROLLMENT', status: 'fail' }]);
      }
    } finally {
      setIsTesting(false);
    }
  };

  const handleCaptureSample = async () => {
    if (!validateStep2()) return;
    setIsCapturing(true);
    setWizardError('');
    setFormErrors([]);
    try {
      const next = await replacePrepared();
      const result = await commissionAcquisition(next.connectionId);
      applyHandshakeResult(result);
      const collected: SampleTopic[] = [];
      for (const stage of result.stages) {
        if (stage.sample && typeof stage.sample === 'object') {
          const sample = stage.sample as { topic?: string; payload?: unknown };
          collected.push({
            topic: sample.topic || mqttTopic || 'sample',
            payload: sample.payload ?? stage.sample,
          });
        }
        if (stage.detail?.startsWith('{') || stage.detail?.startsWith('[')) {
          try {
            collected.push({ topic: mqttTopic || 'sample', payload: JSON.parse(stage.detail) });
          } catch {
            /* ignore */
          }
        }
      }
      if (!collected.length) {
        setWizardError(
          'Capture finished but no sample payload was returned by the collector. Map fields from handshake samples when available, or enter JSONPath manually.',
        );
        setFormErrors([
          'No capture sample API payload yet — handshake Receive sample / Map fields stages did not include JSON.',
        ]);
      } else {
        setSampleTopics(collected);
        setSelectedSampleTopic(collected[0].topic);
      }
    } catch (error) {
      showApiErrors(error);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleSendHttpTest = async () => {
    if (!validateStep2()) return;
    setHttpPreview('');
    try {
      const next = await replacePrepared();
      const result = await commissionAcquisition(next.connectionId);
      applyHandshakeResult(result);
      const sample = result.stages.find((s) => s.sample)?.sample;
      setHttpPreview(
        sample
          ? JSON.stringify(sample, null, 2)
          : result.diagnostic ||
              (result.passed
                ? 'Test request succeeded (no JSON body returned to the console).'
                : 'Test request did not return a JSON preview.'),
      );
    } catch (error) {
      showApiErrors(error);
    }
  };

  const addMappingFromPath = (path: string, value: unknown, topic: string) => {
    setRegisters((prev) => {
      if (prev.some((row) => row.address === path && (row.topic || mqttTopic) === topic)) return prev;
      const leaf = path.split('.').pop()?.replace(/\[\d+\]/g, '') || 'field';
      return [
        ...prev.filter((row) => row.name.trim() || row.address.trim() !== '$.'),
        {
          address: path,
          name: leaf,
          type: 'JSONPath',
          dataType: guessDataType(value),
          unit: '',
          topic,
          sampleValue: value == null ? '' : String(value),
        },
      ];
    });
    markDirty();
  };

  const handleFinish = async () => {
    setWizardError('');
    setFormErrors([]);
    try {
      const body = draft();
      if (!prepared) throw new Error('Run the handshake before activation.');
      if (!testSuccess) throw new Error('Activation stays locked until Map fields passes in the handshake.');
      if (!body.fields.length) throw new Error('Add at least one named field before activation.');
      await activateAcquisition(prepared, body);
      if (applyToSimilar && selectedProtocol === 'mqtt' && targetResource?.parentId) {
        const siblings = machines.filter(
          (item) => item.parentId === targetResource.parentId && item.id !== targetResource.id,
        );
        for (const sibling of siblings) {
          try {
            const patternTopic = mqttTopic.replace(targetResource.code || targetResource.name, sibling.code || sibling.name);
            const siblingDraft = {
              ...body,
              resourceId: sibling.id,
              name: `${body.name} · ${sibling.name}`,
              extra: patternTopic,
              fields: body.fields.map((field) => ({
                ...field,
                topic: (field.topic || mqttTopic).replace(
                  targetResource.code || targetResource.name,
                  sibling.code || sibling.name,
                ),
              })),
            };
            const siblingPrepared = await prepareAcquisition(siblingDraft);
            await activateAcquisition(siblingPrepared, siblingDraft);
          } catch (siblingError) {
            showApiErrors(siblingError);
          }
        }
      }
      setAllowLeave(true);
      setDirty(false);
      navigate('/signals');
    } catch (error) {
      showApiErrors(error);
    }
  };

  const leaveWizard = (path: string) => {
    setAllowLeave(true);
    setDirty(false);
    navigate(path);
  };

  const handleCancel = async () => {
    if (prepared?.connectionId || dirty) {
      setDiscardPrompt(true);
      return;
    }
    leaveWizard(returnTo);
  };

  const confirmDiscard = async (discard: boolean) => {
    setDiscardPrompt(false);
    if (discard && prepared?.connectionId) {
      try {
        await deleteConnection(prepared.connectionId);
      } catch {
        /* best effort */
      }
    }
    leaveWizard(returnTo);
  };

  const stepLabels = [
    { num: 1, label: 'Add data connection' },
    { num: 2, label: 'Endpoint settings' },
    { num: 3, label: 'Map fields' },
    { num: 4, label: 'Test connection' },
  ];

  const endpointSubtitle = () => {
    switch (selectedProtocol) {
      case 'mqtt':
        return 'Broker host, topic filter, QoS, credentials and TLS:';
      case 'opcua':
        return 'OPC UA endpoint, security mode/policy and user token:';
      case 'http':
        return 'REST base URL, method, auth, headers and timeout:';
      default:
        return 'Modbus TCP host, unit id, timeout and retries:';
    }
  };

  const activeSample = sampleTopics.find((item) => item.topic === selectedSampleTopic) || sampleTopics[0];
  const sampleLeaves = activeSample ? flattenJson(activeSample.payload) : [];

  return (
    <div className="space-y-4 max-w-5xl mx-auto animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Add data connection</h1>
          <p className="fx-page-subtitle">
            {targetResource
              ? `Target: ${targetPath || targetResource.name} (${targetResource.type})`
              : 'Choose a machine, configure the endpoint, map fields, then test before collecting.'}
          </p>
          {wizardError && <p className="text-[12px] text-[#F2343B] mt-2">{wizardError}</p>}
          {formErrors.length > 1 && (
            <ul className="mt-2 space-y-1">
              {formErrors.map((err) => (
                <li key={err} className="text-[11px] text-[#F2343B]">
                  {err}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="secondary" onClick={() => void handleCancel()}>
          Cancel
        </Button>
      </div>

      {discardPrompt && (
        <Card className="p-4 border-[#FAC6C9] bg-[#FFF8F8]">
          <p className="text-[13px] text-[#111B37] font-semibold mb-2">
            Discard draft connection created by the handshake test?
          </p>
          <p className="text-[12px] text-[#657794] mb-3">
            Cancel returns to the previous page. Discard removes the DRAFT connection.
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
        <Card title="Select protocol" subtitle="Choose how FactoriX will collect data:">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5 mt-2">
            {[
              {
                id: 'modbus' as const,
                name: 'Modbus TCP',
                desc: 'Standard PLC registers (Holding, Input, Coil) over TCP port 502',
                icon: Network,
                badge: 'PLC Standard',
              },
              {
                id: 'opcua' as const,
                name: 'OPC UA Client',
                desc: 'Industrial IoT address space browse, subscriptions and certificates',
                icon: Cable,
                badge: 'Rich Model',
              },
              {
                id: 'mqtt' as const,
                name: 'MQTT Client',
                desc: 'Subscribe to broker topics and map JSON fields with JSONPath',
                icon: RadioTower,
                badge: 'Edge / Cloud',
              },
              {
                id: 'http' as const,
                name: 'REST / HTTP API',
                desc: 'Polling external webhooks, MES endpoints or SCADA web services',
                icon: Cloud,
                badge: 'Web Standard',
              },
            ].map((p) => {
              const Icon = p.icon;
              const isSelected = selectedProtocol === p.id;
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => {
                    setSelectedProtocol(p.id);
                    setWizardError('');
                    setFormErrors([]);
                  }}
                  className={`p-4 rounded-xl border-2 text-left transition-all bg-white shadow-sm flex flex-col justify-between ${
                    isSelected ? 'border-[#EF1B24] ring-4 ring-[#FFF0F1]' : 'border-[#E3EAF3] hover:border-[#94A3B8]'
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
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {step === 2 && selectedProtocol && (
        <Card title="Configure connection" subtitle={endpointSubtitle()}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl py-2">
            <div>
              <label className="block text-[12px] font-bold text-[#111B37] mb-1">Machine / Line</label>
              <select
                className="fx-input"
                value={resourceId}
                onChange={(event) => {
                  setResourceId(event.target.value);
                  markDirty();
                }}
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
                onChange={(event) => {
                  setConnectionName(event.target.value);
                  markDirty();
                }}
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
                    placeholder="plc.example.local"
                    onChange={(e) => {
                      setHost(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                      markDirty();
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
                    onChange={(e) => {
                      setPort(e.target.value);
                      markDirty();
                    }}
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
                    onChange={(e) => {
                      setUnitId(e.target.value);
                      markDirty();
                    }}
                  />
                  {fieldErrors.unitId && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.unitId}</p>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Timeout (ms)</label>
                  <input
                    className="fx-input font-mono"
                    value={modbusTimeoutMs}
                    onChange={(e) => {
                      setModbusTimeoutMs(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Retries</label>
                  <input
                    className="fx-input font-mono"
                    value={modbusRetries}
                    onChange={(e) => {
                      setModbusRetries(e.target.value);
                      markDirty();
                    }}
                  />
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
                    placeholder="mqtt.example.local"
                    onChange={(e) => {
                      setHost(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                      markDirty();
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
                    onChange={(e) => {
                      setPort(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                      markDirty();
                    }}
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
                    placeholder="enterprise/site/area/line/#"
                    onChange={(e) => {
                      setMqttTopic(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                      markDirty();
                    }}
                  />
                  {fieldErrors.mqttTopic && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.mqttTopic}</p>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">QoS</label>
                  <select
                    className="fx-input"
                    value={mqttQos}
                    onChange={(e) => {
                      setMqttQos(e.target.value);
                      markDirty();
                    }}
                  >
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
                    onChange={(e) => {
                      setMqttVersion(e.target.value);
                      markDirty();
                    }}
                  >
                    <option value="3.1.1">3.1.1</option>
                    <option value="5">5.0</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Client ID</label>
                  <input
                    className="fx-input font-mono"
                    value={mqttClientId}
                    onChange={(e) => {
                      setMqttClientId(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Keepalive (s)</label>
                  <input
                    className="fx-input font-mono"
                    value={mqttKeepalive}
                    onChange={(e) => {
                      setMqttKeepalive(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-4 md:col-span-2">
                  <label className="flex items-center gap-2 text-[12px] text-[#111B37]">
                    <input
                      type="checkbox"
                      checked={mqttAnonymous}
                      onChange={(e) => {
                        setMqttAnonymous(e.target.checked);
                        markDirty();
                      }}
                    />
                    Anonymous (no username)
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-[#111B37]">
                    <input
                      type="checkbox"
                      checked={mqttTls}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setMqttTls(on);
                        if (on && port === '1883') setPort('8883');
                        if (!on && port === '8883') setPort('1883');
                        markDirty();
                      }}
                    />
                    TLS
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-[#111B37]">
                    <input
                      type="checkbox"
                      checked={mqttTlsVerify}
                      onChange={(e) => {
                        setMqttTlsVerify(e.target.checked);
                        markDirty();
                      }}
                    />
                    Verify certificate
                  </label>
                </div>
                {!mqttAnonymous && (
                  <>
                    <div>
                      <label className="block text-[12px] font-bold text-[#111B37] mb-1">Username</label>
                      <input
                        className="fx-input"
                        value={mqttUsername}
                        onChange={(e) => {
                          setMqttUsername(e.target.value);
                          markDirty();
                        }}
                      />
                      {fieldErrors.mqttUsername && (
                        <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.mqttUsername}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-[12px] font-bold text-[#111B37] mb-1">Password</label>
                      <input
                        type="password"
                        className="fx-input"
                        value={mqttPassword}
                        autoComplete="new-password"
                        onChange={(e) => {
                          setMqttPassword(e.target.value);
                          markDirty();
                        }}
                      />
                    </div>
                  </>
                )}
                {mqttTls && (
                  <>
                    <div className="md:col-span-2">
                      <label className="block text-[12px] font-bold text-[#111B37] mb-1">CA certificate (PEM)</label>
                      <textarea
                        className="fx-input font-mono text-[11px] min-h-[72px]"
                        value={mqttTlsCa}
                        placeholder="-----BEGIN CERTIFICATE-----"
                        onChange={(e) => {
                          setMqttTlsCa(e.target.value);
                          markDirty();
                        }}
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-[12px] font-bold text-[#111B37] mb-1">Client certificate (PEM)</label>
                      <textarea
                        className="fx-input font-mono text-[11px] min-h-[72px]"
                        value={mqttTlsClientCert}
                        placeholder="-----BEGIN CERTIFICATE-----"
                        onChange={(e) => {
                          setMqttTlsClientCert(e.target.value);
                          markDirty();
                        }}
                      />
                    </div>
                  </>
                )}
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
                    placeholder="opc.tcp://plc.example.local:4840"
                    onChange={(e) => {
                      setOpcEndpoint(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                      markDirty();
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
                    onChange={(e) => {
                      setOpcSecurity(e.target.value);
                      if (e.target.value === 'None') setOpcSecurityPolicy('None');
                      markDirty();
                    }}
                  >
                    <option value="None">None</option>
                    <option value="Sign">Sign</option>
                    <option value="SignAndEncrypt">SignAndEncrypt</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Security policy</label>
                  <select
                    className="fx-input"
                    value={opcSecurityPolicy}
                    onChange={(e) => {
                      setOpcSecurityPolicy(e.target.value);
                      markDirty();
                    }}
                  >
                    <option value="None">None</option>
                    <option value="Basic256Sha256">Basic256Sha256</option>
                    <option value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">User token (username)</label>
                  <input
                    className="fx-input"
                    value={opcUsername}
                    placeholder="Anonymous when empty"
                    onChange={(e) => {
                      setOpcUsername(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Password</label>
                  <input
                    type="password"
                    className="fx-input"
                    value={opcPassword}
                    autoComplete="new-password"
                    onChange={(e) => {
                      setOpcPassword(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="flex items-center gap-2 text-[12px] text-[#111B37]">
                    <input
                      type="checkbox"
                      checked={opcTrustAll}
                      onChange={(e) => {
                        setOpcTrustAll(e.target.checked);
                        markDirty();
                      }}
                    />
                    Trust server certificate (lab only)
                  </label>
                  <p className="text-[11px] text-[#657794] mt-1">
                    Address-space browse runs after a successful handshake when the collector supports it.
                  </p>
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
                    placeholder="http://mes.example.local:8080"
                    onChange={(e) => {
                      setHttpBaseUrl(e.target.value);
                      setPrepared(null);
                      setTestSuccess(false);
                      markDirty();
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
                    onChange={(e) => {
                      setHttpPath(e.target.value);
                      markDirty();
                    }}
                  />
                  {fieldErrors.httpPath && (
                    <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.httpPath}</p>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Method</label>
                  <select
                    className="fx-input"
                    value={httpMethod}
                    onChange={(e) => {
                      setHttpMethod(e.target.value);
                      markDirty();
                    }}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Auth</label>
                  <select
                    className="fx-input"
                    value={httpAuth}
                    onChange={(e) => {
                      setHttpAuth(e.target.value);
                      markDirty();
                    }}
                  >
                    <option value="none">None</option>
                    <option value="basic">Basic</option>
                    <option value="bearer">Bearer</option>
                    <option value="api_key">API key</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Timeout (ms)</label>
                  <input
                    className="fx-input font-mono"
                    value={httpTimeoutMs}
                    onChange={(e) => {
                      setHttpTimeoutMs(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                {httpAuth !== 'none' && (
                  <>
                    <div>
                      <label className="block text-[12px] font-bold text-[#111B37] mb-1">Username / key id</label>
                      <input
                        className="fx-input"
                        value={httpUsername}
                        onChange={(e) => {
                          setHttpUsername(e.target.value);
                          markDirty();
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-[12px] font-bold text-[#111B37] mb-1">Secret</label>
                      <input
                        type="password"
                        className="fx-input"
                        value={httpPassword}
                        autoComplete="new-password"
                        onChange={(e) => {
                          setHttpPassword(e.target.value);
                          markDirty();
                        }}
                      />
                    </div>
                  </>
                )}
                <div className="md:col-span-2">
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Headers (JSON object)</label>
                  <textarea
                    className="fx-input font-mono text-[11px] min-h-[64px]"
                    value={httpHeaders}
                    onChange={(e) => {
                      setHttpHeaders(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <div className="md:col-span-2">
                  <Button size="sm" variant="secondary" onClick={() => void handleSendHttpTest()}>
                    Send test request
                  </Button>
                  {httpPreview && (
                    <pre className="mt-2 p-3 rounded-lg bg-[#0F172A] text-[#E2E8F0] text-[11px] overflow-auto max-h-48">
                      {httpPreview}
                    </pre>
                  )}
                </div>
              </>
            )}

            {selectedProtocol !== 'mqtt' && (
              <div>
                <label className="block text-[12px] font-bold text-[#111B37] mb-1">
                  Poll interval (ms) <span className="text-[#EF1B24]">*</span>
                </label>
                <input
                  className="fx-input font-mono"
                  value={interval}
                  onChange={(e) => {
                    setIntervalMs(e.target.value);
                    markDirty();
                  }}
                />
                {fieldErrors.interval && (
                  <p className="text-[11px] text-[#F2343B] mt-1">{fieldErrors.interval}</p>
                )}
              </div>
            )}
          </div>
          {formErrors.length > 0 && step === 2 && (
            <div className="mt-3 rounded-lg border border-[#FAC6C9] bg-[#FFF8F8] p-3 space-y-1">
              {formErrors.map((err) => (
                <p key={err} className="text-[12px] text-[#F2343B]">
                  {err}
                </p>
              ))}
            </div>
          )}
        </Card>
      )}

      {step === 3 && (
        <div className="space-y-4">
          {(selectedProtocol === 'mqtt' || selectedProtocol === 'http') && (
            <Card
              title="Capture sample"
              subtitle="Listen briefly, then click a JSON field to add a mapping row."
              action={
                <Button size="sm" variant="secondary" loading={isCapturing} onClick={() => void handleCaptureSample()}>
                  Capture sample (10 s)
                </Button>
              }
            >
              {sampleTopics.length === 0 ? (
                <p className="text-[12px] text-[#657794]">
                  No samples yet. Capture uses the collector handshake sample when the Edge returns payload JSON.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <p className="text-[11px] font-bold uppercase text-[#657794]">Topics</p>
                    {sampleTopics.map((item) => (
                      <button
                        key={item.topic}
                        type="button"
                        onClick={() => setSelectedSampleTopic(item.topic)}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-[12px] font-mono ${
                          selectedSampleTopic === item.topic
                            ? 'bg-[#FFF0F1] text-[#EF1B24]'
                            : 'bg-[#F9FAFD] text-[#334568]'
                        }`}
                      >
                        {item.topic}
                      </button>
                    ))}
                  </div>
                  <div className="md:col-span-2 max-h-56 overflow-auto border border-[#E3EAF3] rounded-lg">
                    <table className="fx-table">
                      <thead>
                        <tr>
                          <th>JSONPath</th>
                          <th>Sample value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sampleLeaves.map((leaf) => (
                          <tr
                            key={leaf.path}
                            className="cursor-pointer hover:bg-[#FFF0F1]"
                            onClick={() =>
                              addMappingFromPath(leaf.path, leaf.value, activeSample?.topic || mqttTopic)
                            }
                          >
                            <td className="font-mono text-[11px]">{leaf.path}</td>
                            <td className="font-mono text-[11px] text-[#657794]">
                              {leaf.value == null ? 'null' : String(leaf.value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          )}

          <Card
            title="Map fields"
            subtitle={
              selectedProtocol === 'mqtt'
                ? 'Topic + JSONPath per signal. Timestamp field defaults to $.source_timestamp.'
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
                      type: mappingColumns.address,
                      dataType:
                        selectedProtocol === 'mqtt' || selectedProtocol === 'http'
                          ? 'Number'
                          : selectedProtocol === 'modbus'
                            ? 'Float32'
                            : 'Float32',
                      unit: '',
                      topic: selectedProtocol === 'mqtt' ? mqttTopic : undefined,
                      registerArea: selectedProtocol === 'modbus' ? 'holding' : undefined,
                      wordOrder: selectedProtocol === 'modbus' ? 'big' : undefined,
                      scale: selectedProtocol === 'modbus' ? '1' : undefined,
                      offset: selectedProtocol === 'modbus' ? '0' : undefined,
                    },
                  ]);
                  markDirty();
                }}
              >
                Add row
              </Button>
            }
          >
            {selectedProtocol === 'mqtt' && (
              <div className="mb-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-bold text-[#111B37] mb-1">Timestamp field (Source time)</label>
                  <input
                    className="fx-input font-mono"
                    value={timestampJsonpath}
                    onChange={(e) => {
                      setTimestampJsonpath(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
                <label className="flex items-end gap-2 text-[12px] text-[#111B37] pb-2">
                  <input
                    type="checkbox"
                    checked={applyToSimilar}
                    onChange={(e) => {
                      setApplyToSimilar(e.target.checked);
                      markDirty();
                    }}
                  />
                  Apply this mapping to similar machines (by topic pattern)
                </label>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    {selectedProtocol === 'mqtt' ? <th>Topic</th> : null}
                    {selectedProtocol === 'modbus' ? <th>Area</th> : null}
                    <th>{mappingColumns.address}</th>
                    <th>Signal name</th>
                    <th>Data type</th>
                    {selectedProtocol === 'modbus' ? (
                      <>
                        <th>Word order</th>
                        <th>Scale</th>
                        <th>Offset</th>
                      </>
                    ) : null}
                    <th>Unit</th>
                    {(selectedProtocol === 'mqtt' || selectedProtocol === 'http') && <th>Sample value</th>}
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {registers.map((reg, idx) => {
                    const dup =
                      reg.name.trim() &&
                      registers.some((other, j) => j !== idx && other.name.trim() === reg.name.trim());
                    const rowError = fieldErrors[`row-${idx}`] || fieldErrors[`name-${idx}`];
                    return (
                      <tr
                        key={idx}
                        className={dup || rowError ? 'outline outline-2 outline-[#F2343B]' : undefined}
                      >
                        {selectedProtocol === 'mqtt' ? (
                          <td>
                            <input
                              type="text"
                              value={reg.topic ?? mqttTopic}
                              placeholder={mqttTopic || 'topic/filter'}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRegisters((prev) =>
                                  prev.map((r, i) => (i === idx ? { ...r, topic: val } : r)),
                                );
                                markDirty();
                              }}
                              className="fx-input h-8 font-mono text-[12px] min-w-[12rem]"
                            />
                          </td>
                        ) : null}
                        {selectedProtocol === 'modbus' ? (
                          <td>
                            <select
                              className="fx-input h-8 text-[12px]"
                              value={reg.registerArea || 'holding'}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRegisters((prev) =>
                                  prev.map((r, i) => (i === idx ? { ...r, registerArea: val } : r)),
                                );
                                markDirty();
                              }}
                            >
                              <option value="holding">Holding</option>
                              <option value="input">Input</option>
                              <option value="coil">Coil</option>
                              <option value="discrete">Discrete</option>
                            </select>
                          </td>
                        ) : null}
                        <td>
                          <input
                            type="text"
                            value={reg.address}
                            placeholder={mappingColumns.hint}
                            onChange={(e) => {
                              const val = e.target.value;
                              setRegisters((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, address: val } : r)),
                              );
                              markDirty();
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
                              setRegisters((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, name: val } : r)),
                              );
                              markDirty();
                            }}
                            className={`fx-input h-8 font-semibold text-[12px] ${
                              dup || rowError ? 'border-[#F2343B]' : ''
                            }`}
                          />
                          {dup ? <p className="text-[10px] text-[#F2343B] mt-0.5">Duplicate name</p> : null}
                          {rowError ? <p className="text-[10px] text-[#F2343B] mt-0.5">{rowError}</p> : null}
                        </td>
                        <td>
                          <select
                            className="fx-input h-8 text-[12px]"
                            value={reg.dataType}
                            onChange={(e) => {
                              const val = e.target.value;
                              setRegisters((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, dataType: val } : r)),
                              );
                              markDirty();
                            }}
                          >
                            {selectedProtocol === 'mqtt' || selectedProtocol === 'http' ? (
                              <>
                                <option value="Number">Number</option>
                                <option value="Integer">Integer</option>
                                <option value="Boolean">Boolean</option>
                                <option value="String">String</option>
                                <option value="Timestamp">Timestamp</option>
                                <option value="JSON">JSON</option>
                              </>
                            ) : selectedProtocol === 'modbus' ? (
                              <>
                                <option value="Int16">Int16</option>
                                <option value="UInt16">UInt16</option>
                                <option value="Int32">Int32</option>
                                <option value="UInt32">UInt32</option>
                                <option value="Float32">Float32</option>
                                <option value="Float64">Float64</option>
                                <option value="Bool">Bool</option>
                              </>
                            ) : (
                              <>
                                <option value="Float32">Float32</option>
                                <option value="Int32">Int32</option>
                                <option value="Bool">Bool</option>
                                <option value="String">String</option>
                              </>
                            )}
                          </select>
                        </td>
                        {selectedProtocol === 'modbus' ? (
                          <>
                            <td>
                              <select
                                className="fx-input h-8 text-[12px]"
                                value={reg.wordOrder || 'big'}
                                onChange={(e) => {
                                  const val = e.target.value as 'big' | 'little';
                                  setRegisters((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, wordOrder: val } : r)),
                                  );
                                  markDirty();
                                }}
                              >
                                <option value="big">Big</option>
                                <option value="little">Little</option>
                              </select>
                            </td>
                            <td>
                              <input
                                className="fx-input h-8 font-mono text-[12px] w-20"
                                value={reg.scale ?? '1'}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setRegisters((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, scale: val } : r)),
                                  );
                                  markDirty();
                                }}
                              />
                            </td>
                            <td>
                              <input
                                className="fx-input h-8 font-mono text-[12px] w-20"
                                value={reg.offset ?? '0'}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setRegisters((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, offset: val } : r)),
                                  );
                                  markDirty();
                                }}
                              />
                            </td>
                          </>
                        ) : null}
                        <td>
                          <input
                            type="text"
                            value={reg.unit}
                            list="fx-unit-suggestions"
                            onChange={(e) => {
                              const val = e.target.value;
                              setRegisters((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, unit: val } : r)),
                              );
                              markDirty();
                            }}
                            className="fx-input h-8 text-[12px]"
                          />
                        </td>
                        {(selectedProtocol === 'mqtt' || selectedProtocol === 'http') && (
                          <td className="font-mono text-[11px] text-[#657794] max-w-[8rem] truncate">
                            {reg.sampleValue || '—'}
                          </td>
                        )}
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setRegisters((prev) => prev.filter((_, i) => i !== idx));
                              markDirty();
                            }}
                            className="text-[#F2343B] p-1 hover:bg-[#FFF0F1] rounded"
                            aria-label="Remove row"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <datalist id="fx-unit-suggestions">
                {UNIT_SUGGESTIONS.map((unit) => (
                  <option key={unit} value={unit} />
                ))}
              </datalist>
            </div>
          </Card>
        </div>
      )}

      {step === 4 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card title="Test connection">
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
              before collecting.
            </p>
            <div className="p-4 rounded-xl bg-[#F9FAFD] border border-[#E3EAF3] space-y-3 mb-4">
              <div className="space-y-1.5">
                {testStages.length === 0 && (
                  <p className="text-[12px] text-slate-400">
                    Run the test to evaluate Reach broker → Authenticate → Subscribe → Receive sample → Map fields.
                  </p>
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
              Test connection
            </Button>
            {!testSuccess && (
              <p className="text-[11px] text-[#657794] mt-2">
                Start collecting stays locked until Map fields passes. If the Edge is not enrolled, open{' '}
                <button
                  type="button"
                  className="text-[#EF1B24] font-semibold underline"
                  onClick={() => navigate('/acquisition/edges')}
                >
                  Edges
                </button>
                .
              </p>
            )}
          </Card>

          <Card title="Mapped fields">
            <p className="text-[12px] text-[#657794] mb-3">
              Fields that will be created after a successful Map fields stage:
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
                      <span className="text-[10px] text-[#657794] font-mono block">
                        {r.topic ? `${r.topic} · ` : ''}
                        {r.address}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[12px] font-bold text-[#111B37] tabular-nums">{r.dataType}</span>{' '}
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
              if (step === 1) {
                if (!selectedProtocol) {
                  setWizardError('Select a protocol to continue.');
                  return;
                }
                if (!machines.length) {
                  setWizardError('Create a machine in Factory Structure before adding a connection.');
                  return;
                }
                setWizardError('');
                setFormErrors([]);
                setStep(2);
                return;
              }
              if (step === 2) {
                if (!validateStep2()) return;
                setStep(3);
                return;
              }
              if (step === 3) {
                if (!validateStep3()) return;
                setStep(4);
              }
            }}
          >
            Next
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<CheckCircle2 className="w-4 h-4" />}
            onClick={() => void handleFinish()}
            disabled={!testSuccess}
            title={!testSuccess ? 'Map fields must pass before collecting' : undefined}
          >
            Start collecting
          </Button>
        )}
      </div>
    </div>
  );
};
