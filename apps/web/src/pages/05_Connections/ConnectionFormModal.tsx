import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X, RadioTower, Network, Cable, Cloud, AlertCircle, Eye, EyeOff, Activity, Plus, Trash2, Waypoints } from 'lucide-react';
import { ProtocolType, ConnectionItem, EdgeItem } from '../../types';
import { api, ApiError } from '../../api/client';
import { CommissionResult, runConnectionTest } from '../../lib/commissioning';
import { useApp } from '../../store/AppContext';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { TestResultPanel } from './TestResultPanel';
import { httpPathsOfConnection, rateBudget } from './httpRate';

export interface SavedConnection {
  id: string;
  name: string;
  protocol: ProtocolType;
}

interface ConnectionFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionToEdit?: ConnectionItem | null;
  /** Called after every successful save (create or update). */
  onSuccess: (saved?: SavedConnection) => void;
  /** Kept for compatibility; the form loads the real site list from the API. */
  sites?: Array<{ id: string; name: string; code?: string }>;
  edges: Array<Pick<EdgeItem, 'id' | 'name'> & { site_id?: string; siteId?: string }>;
  /** Site (sites.id) to preselect for a new connection. */
  defaultSiteId?: string;
  defaultProtocol?: ProtocolType;
  /** Restrict the protocol choice (e.g. the wizard). */
  allowedProtocols?: ProtocolType[];
}

type HeaderRow = { key: string; value: string };

const PROTOCOLS: Array<{ id: ProtocolType; name: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'mqtt', name: 'MQTT', icon: RadioTower },
  { id: 'modbus', name: 'Modbus TCP', icon: Network },
  { id: 'opcua', name: 'OPC UA', icon: Cable },
  { id: 'http', name: 'HTTP / REST', icon: Cloud },
  { id: 'websocket', name: 'WebSocket', icon: Waypoints },
];

const STORED_PROTOCOL: Record<ProtocolType, string> = {
  modbus: 'modbus_tcp',
  opcua: 'opcua',
  mqtt: 'mqtt',
  http: 'http',
  websocket: 'websocket',
};

/** Protocols whose acquisition job runs on a timer (interval_ms). WebSocket uses it as emit interval. */
const INTERVAL_PROTOCOLS: ProtocolType[] = ['modbus', 'opcua', 'http', 'websocket'];
const DEFAULT_INTERVAL: Record<ProtocolType, number> = { modbus: 1000, opcua: 1000, mqtt: 0, http: 5000, websocket: 1000 };

const inputCls = 'w-full px-3 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs font-mono text-[#0B2545] outline-none focus:border-[#134074]';
const labelCls = 'block text-xs font-bold text-[#475569] mb-1';

function headersToRows(value: unknown): HeaderRow[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).map(([key, v]) => ({ key, value: String(v ?? '') }));
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  rows.forEach((row) => {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  });
  return out;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface ConnectionDetail {
  id: string;
  name: string;
  protocol: string;
  site_id: string;
  edge_id: string;
  version: number;
  secret_configured?: boolean;
  config_json?: Record<string, unknown>;
  config?: Record<string, unknown>;
  jobs?: Array<{ id: string; mode?: string; interval_ms?: number | null }>;
}

function protocolFromApi(value: string): ProtocolType {
  const v = value.toLowerCase();
  if (v.includes('modbus')) return 'modbus';
  if (v.includes('opc')) return 'opcua';
  if (v.includes('mqtt')) return 'mqtt';
  if (v.includes('websocket') || v === 'ws') return 'websocket';
  return 'http';
}

export const ConnectionFormModal: React.FC<ConnectionFormModalProps> = ({
  isOpen,
  onClose,
  connectionToEdit,
  onSuccess,
  edges,
  defaultSiteId,
  defaultProtocol,
  allowedProtocols,
}) => {
  const titleId = useId();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Connection being edited: either passed in, or created by "Save & test" in this session.
  const [savedId, setSavedId] = useState<string | null>(null);
  const [version, setVersion] = useState<number>(1);
  const [baseConfig, setBaseConfig] = useState<Record<string, unknown>>({});
  const [job, setJob] = useState<{ id: string; mode: string; interval_ms: number | null } | null>(null);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [dirty, setDirty] = useState(false);
  const isEdit = Boolean(savedId);

  const [siteOptions, setSiteOptions] = useState<Array<{ id: string; name: string }>>([]);

  // Common
  const [protocol, setProtocol] = useState<ProtocolType>('mqtt');
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [intervalMs, setIntervalMs] = useState<number>(1000);
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);

  // Modbus
  const [modbusHost, setModbusHost] = useState('');
  const [modbusPort, setModbusPort] = useState(502);
  const [unitId, setUnitId] = useState(1);
  const [modbusTimeout, setModbusTimeout] = useState(3000);
  const [modbusRetries, setModbusRetries] = useState(1);

  // OPC UA
  const [opcEndpoint, setOpcEndpoint] = useState('');
  const [opcSecurityMode, setOpcSecurityMode] = useState<'None' | 'Sign' | 'SignAndEncrypt'>('None');
  const [opcSecurityPolicy, setOpcSecurityPolicy] = useState('Basic256Sha256');
  const [opcAuth, setOpcAuth] = useState<'anonymous' | 'userpass'>('anonymous');
  const [opcUsername, setOpcUsername] = useState('');

  // MQTT
  const [mqttHost, setMqttHost] = useState('');
  const [mqttPort, setMqttPort] = useState(1883);
  const [mqttVersion, setMqttVersion] = useState<'3.1.1' | '5'>('3.1.1');
  const [clientId, setClientId] = useState('');
  const [keepalive, setKeepalive] = useState(60);
  const [cleanSession, setCleanSession] = useState(true);
  const [mqttAuth, setMqttAuth] = useState<'none' | 'userpass'>('none');
  const [mqttUsername, setMqttUsername] = useState('');
  const [tls, setTls] = useState(false);
  const [tlsVerify, setTlsVerify] = useState(true);
  const [mqttQos, setMqttQos] = useState<0 | 1 | 2>(1);

  // HTTP
  const [httpBaseUrl, setHttpBaseUrl] = useState('');
  const [httpAuth, setHttpAuth] = useState<'none' | 'basic' | 'api_key' | 'bearer'>('none');
  const [httpHeaderName, setHttpHeaderName] = useState('X-API-Key');
  const [httpUsername, setHttpUsername] = useState('');
  const [httpHeaders, setHttpHeaders] = useState<HeaderRow[]>([]);
  const [httpTimeout, setHttpTimeout] = useState(5000);
  const [httpRateLimit, setHttpRateLimit] = useState(60);
  /** HTTP: optional relative path used only by the test to prove authentication (not stored). */
  const [httpTestPath, setHttpTestPath] = useState('');
  const { signals } = useApp();

  // WebSocket
  const [wsUrl, setWsUrl] = useState('');
  const [wsHeaders, setWsHeaders] = useState<HeaderRow[]>([]);
  const [wsTimeout, setWsTimeout] = useState(5000);

  // State
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<CommissionResult | null>(null);

  const protocolChoices = useMemo(
    () => PROTOCOLS.filter((item) => !allowedProtocols || allowedProtocols.includes(item.id)),
    [allowedProtocols],
  );

  const resetProtocolFields = () => {
    setModbusHost('');
    setModbusPort(502);
    setUnitId(1);
    setModbusTimeout(3000);
    setModbusRetries(1);
    setOpcEndpoint('');
    setOpcSecurityMode('None');
    setOpcSecurityPolicy('Basic256Sha256');
    setOpcAuth('anonymous');
    setOpcUsername('');
    setMqttHost('');
    setMqttPort(1883);
    setMqttVersion('3.1.1');
    setClientId('');
    setKeepalive(60);
    setCleanSession(true);
    setMqttAuth('none');
    setMqttUsername('');
    setTls(false);
    setTlsVerify(true);
    setMqttQos(1);
    setHttpBaseUrl('');
    setHttpAuth('none');
    setHttpHeaderName('X-API-Key');
    setHttpUsername('');
    setHttpHeaders([]);
    setHttpTimeout(5000);
    setHttpRateLimit(60);
    setHttpTestPath('');
    setWsUrl('');
    setWsHeaders([]);
    setWsTimeout(5000);
  };

  const applyDetail = (detail: ConnectionDetail) => {
    const proto = protocolFromApi(detail.protocol);
    const cfg = (detail.config_json || detail.config || {}) as Record<string, unknown>;
    const firstJob = detail.jobs?.[0];
    setSavedId(detail.id);
    setVersion(Number(detail.version || 1));
    setBaseConfig(cfg);
    setSecretConfigured(Boolean(detail.secret_configured));
    setJob(firstJob ? { id: firstJob.id, mode: String(firstJob.mode || 'POLL'), interval_ms: firstJob.interval_ms ?? null } : null);
    setProtocol(proto);
    setName(detail.name);
    setSiteId(String(detail.site_id || ''));
    setIntervalMs(num(firstJob?.interval_ms, DEFAULT_INTERVAL[proto] || 1000));
    resetProtocolFields();
    if (proto === 'modbus') {
      setModbusHost(String(cfg.host || ''));
      setModbusPort(num(cfg.port, 502));
      setUnitId(num(cfg.unit_id, 1));
      setModbusTimeout(num(cfg.timeout_ms, 3000));
      setModbusRetries(num(cfg.retries, 1));
    } else if (proto === 'opcua') {
      setOpcEndpoint(String(cfg.endpoint || cfg.endpoint_url || ''));
      const mode = String(cfg.security_mode || 'None');
      setOpcSecurityMode(mode === 'Sign' || mode === 'SignAndEncrypt' ? mode : 'None');
      if (cfg.security_policy && cfg.security_policy !== 'None') setOpcSecurityPolicy(String(cfg.security_policy));
      setOpcAuth(cfg.username ? 'userpass' : 'anonymous');
      setOpcUsername(String(cfg.username || ''));
    } else if (proto === 'mqtt') {
      setMqttHost(String(cfg.host || ''));
      setMqttPort(num(cfg.port, 1883));
      setMqttVersion(String(cfg.protocol_version) === '5' ? '5' : '3.1.1');
      setClientId(String(cfg.client_id || ''));
      setKeepalive(num(cfg.keepalive, 60));
      setCleanSession(cfg.clean_session !== false);
      setMqttAuth(cfg.username ? 'userpass' : 'none');
      setMqttUsername(String(cfg.username || ''));
      setTls(Boolean(cfg.tls));
      setTlsVerify(cfg.tls_verify !== false);
      const qos = num(cfg.qos, 1);
      setMqttQos(qos === 0 || qos === 2 ? qos : 1);
    } else if (proto === 'http') {
      setHttpBaseUrl(String(cfg.base_url || ''));
      const auth = String(cfg.auth || 'none');
      setHttpAuth(auth === 'basic' || auth === 'api_key' || auth === 'bearer' ? auth : 'none');
      setHttpHeaderName(String(cfg.header_name || 'X-API-Key'));
      setHttpUsername(String(cfg.username || ''));
      setHttpHeaders(headersToRows(cfg.headers));
      setHttpTimeout(num(cfg.timeout_ms, 5000));
      setHttpRateLimit(num(cfg.rate_limit_per_min, 60));
    } else if (proto === 'websocket') {
      setWsUrl(String(cfg.url || ''));
      setWsHeaders(headersToRows(cfg.headers));
      setWsTimeout(num(cfg.timeout_ms, 5000));
    }
  };

  // Initialise when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setFieldErrors({});
    setGeneralError(null);
    setTestResult(null);
    setSecret('');
    setHttpTestPath('');
    setShowSecret(false);
    setDirty(false);
    let cancelled = false;
    api<{ items: Array<{ id: string; name: string; code?: string }> }>('/api/v1/sites')
      .then((res) => {
        if (cancelled) return;
        const items = (res.items || []).map((row) => ({ id: String(row.id), name: String(row.name || row.code || row.id) }));
        setSiteOptions(items);
        setSiteId((current) => current || defaultSiteId || items[0]?.id || '');
      })
      .catch((error) => {
        if (!cancelled) setGeneralError(error instanceof Error ? `Could not load sites: ${error.message}` : 'Could not load sites.');
      });
    if (connectionToEdit) {
      setLoadingDetail(true);
      api<ConnectionDetail>(`/api/v1/connections/${encodeURIComponent(connectionToEdit.id)}`)
        .then((detail) => {
          if (!cancelled) applyDetail(detail);
        })
        .catch((error) => {
          if (!cancelled) setGeneralError(error instanceof Error ? `Could not load the connection: ${error.message}` : 'Could not load the connection.');
        })
        .finally(() => {
          if (!cancelled) setLoadingDetail(false);
        });
    } else {
      const proto = defaultProtocol && (!allowedProtocols || allowedProtocols.includes(defaultProtocol))
        ? defaultProtocol
        : (allowedProtocols?.[0] || 'mqtt');
      setSavedId(null);
      setVersion(1);
      setBaseConfig({});
      setJob(null);
      setSecretConfigured(false);
      setName('');
      setSiteId(defaultSiteId || '');
      setProtocol(proto);
      setIntervalMs(DEFAULT_INTERVAL[proto] || 1000);
      resetProtocolFields();
    }
    window.setTimeout(() => firstFieldRef.current?.focus(), 0);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connectionToEdit?.id]);

  // Escape closes the dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving && !isTesting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isSaving, isTesting, onClose]);

  const markDirty = () => {
    setDirty(true);
    setTestResult(null);
  };

  const chooseProtocol = (next: ProtocolType) => {
    setProtocol(next);
    setIntervalMs(DEFAULT_INTERVAL[next] || 1000);
    setSecret('');
    setFieldErrors({});
    markDirty();
  };

  const needsSecret =
    (protocol === 'mqtt' && mqttAuth === 'userpass') ||
    (protocol === 'opcua' && opcAuth === 'userpass') ||
    (protocol === 'http' && httpAuth !== 'none');

  const secretLabel =
    protocol === 'http' && httpAuth === 'api_key'
      ? 'API key'
      : protocol === 'http' && httpAuth === 'bearer'
        ? 'Bearer token'
        : 'Password';

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'Connection name is required.';
    if (!isEdit && !siteId) errors.site = 'Choose a site.';
    const port = (value: number, key: string) => {
      if (!Number.isInteger(value) || value < 1 || value > 65535) errors[key] = 'Port must be between 1 and 65535.';
    };
    if (protocol === 'modbus') {
      if (!modbusHost.trim()) errors.modbusHost = 'Host is required.';
      port(modbusPort, 'modbusPort');
      if (!Number.isInteger(unitId) || unitId < 0 || unitId > 247) errors.unitId = 'Unit ID must be between 0 and 247.';
      if (modbusTimeout < 200 || modbusTimeout > 30000) errors.modbusTimeout = 'Timeout must be 200–30000 ms.';
    } else if (protocol === 'opcua') {
      if (!/^opc\.tcp:\/\/.+/.test(opcEndpoint.trim())) errors.opcEndpoint = 'The endpoint must start with opc.tcp://';
      if (opcAuth === 'userpass' && !opcUsername.trim()) errors.opcUsername = 'Username is required.';
    } else if (protocol === 'mqtt') {
      if (!mqttHost.trim()) errors.mqttHost = 'Broker host is required.';
      port(mqttPort, 'mqttPort');
      if (keepalive < 5 || keepalive > 3600) errors.keepalive = 'Keepalive must be 5–3600 s.';
      if (mqttAuth === 'userpass' && !mqttUsername.trim()) errors.mqttUsername = 'Username is required.';
    } else if (protocol === 'http') {
      if (!/^https?:\/\/[^\s/]+/.test(httpBaseUrl.trim())) errors.httpBaseUrl = 'Base URL must start with http:// or https://';
      if (httpAuth === 'api_key' && !httpHeaderName.trim()) errors.httpHeaderName = 'Header name is required.';
      if (httpAuth === 'basic' && !httpUsername.trim()) errors.httpUsername = 'Username is required.';
      if (httpTimeout < 200 || httpTimeout > 30000) errors.httpTimeout = 'Timeout must be 200–30000 ms.';
      if (!Number.isInteger(httpRateLimit) || httpRateLimit < 1) errors.httpRateLimit = 'Enter requests per minute (1 or more).';
    } else if (protocol === 'websocket') {
      if (!/^wss?:\/\/[^\s/]+/.test(wsUrl.trim())) errors.wsUrl = 'URL must start with ws:// or wss://';
      if (wsTimeout < 200 || wsTimeout > 30000) errors.wsTimeout = 'Timeout must be 200–30000 ms.';
    }
    if (needsSecret && !secret && !(isEdit && secretConfigured)) errors.secret = `${secretLabel} is required.`;
    if (INTERVAL_PROTOCOLS.includes(protocol)) {
      if (!Number.isInteger(intervalMs) || intervalMs < 1000) errors.intervalMs = 'Interval must be at least 1000 ms.';
    }
    return errors;
  };

  const buildConfig = (): Record<string, unknown> => {
    // Start from the stored config so keys this form does not manage (e.g. MQTT topics) are preserved.
    const base: Record<string, unknown> = isEdit ? { ...baseConfig } : {};
    if (protocol === 'modbus') {
      return { ...base, host: modbusHost.trim(), port: modbusPort, unit_id: unitId, timeout_ms: modbusTimeout, retries: modbusRetries };
    }
    if (protocol === 'opcua') {
      const cfg: Record<string, unknown> = {
        ...base,
        endpoint: opcEndpoint.trim(),
        security_mode: opcSecurityMode,
        security_policy: opcSecurityMode === 'None' ? 'None' : opcSecurityPolicy,
        anonymous: opcAuth === 'anonymous',
        username: opcAuth === 'userpass' ? opcUsername.trim() : null,
      };
      delete cfg.endpoint_url;
      return cfg;
    }
    if (protocol === 'mqtt') {
      return {
        ...base,
        host: mqttHost.trim(),
        port: mqttPort,
        protocol_version: mqttVersion,
        client_id: clientId.trim() || null,
        keepalive,
        clean_session: cleanSession,
        anonymous: mqttAuth === 'none',
        username: mqttAuth === 'userpass' ? mqttUsername.trim() : null,
        tls,
        tls_verify: tlsVerify,
        qos: mqttQos,
        topics: Array.isArray(base.topics) ? base.topics : [],
      };
    }
    if (protocol === 'http') {
      return {
        ...base,
        base_url: httpBaseUrl.trim().replace(/\/+$/, ''),
        method: 'GET',
        auth: httpAuth,
        header_name: httpAuth === 'api_key' ? httpHeaderName.trim() : null,
        username: httpAuth === 'basic' ? httpUsername.trim() : null,
        headers: rowsToHeaders(httpHeaders),
        timeout_ms: httpTimeout,
        rate_limit_per_min: httpRateLimit,
      };
    }
    return { ...base, url: wsUrl.trim(), headers: rowsToHeaders(wsHeaders), timeout_ms: wsTimeout };
  };

  const describeError = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'DUPLICATE') {
        setFieldErrors((prev) => ({ ...prev, name: err.message }));
        return err.message;
      }
      if (err.code === 'RESOURCE_VERSION_CONFLICT') {
        return 'This connection was changed elsewhere. Close the dialog and open it again to load the latest version.';
      }
      return err.message || 'The request failed.';
    }
    return err instanceof Error ? err.message : 'An unexpected error occurred.';
  };

  /** Persist the form. Returns the connection id, or null when validation/saving failed. */
  const save = async (): Promise<string | null> => {
    setGeneralError(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length) return null;
    const config = buildConfig();
    setIsSaving(true);
    try {
      if (isEdit && savedId) {
        if (!dirty && !secret) return savedId;
        // Interval lives on the acquisition job; update it first so the PATCH release carries it.
        if (job && INTERVAL_PROTOCOLS.includes(protocol) && job.interval_ms !== intervalMs) {
          await api('/api/v1/jobs', {
            method: 'POST',
            body: JSON.stringify({ connection_id: savedId, mode: job.mode, interval_ms: intervalMs }),
          });
          setJob({ ...job, interval_ms: intervalMs });
        }
        const updated = await api<ConnectionDetail>(`/api/v1/connections/${encodeURIComponent(savedId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            version,
            name: name.trim(),
            config,
            secret_input: secret ? secret : undefined,
          }),
        });
        applyDetail(updated);
        setSecret('');
        setDirty(false);
        onSuccess({ id: updated.id, name: updated.name, protocol });
        return updated.id;
      }
      const siteEdges = edges.filter((edge) => (edge.site_id || edge.siteId) === siteId);
      const created = await api<ConnectionDetail>('/api/v1/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          protocol: STORED_PROTOCOL[protocol],
          site_id: siteId,
          edge_id: siteEdges.length === 1 ? siteEdges[0].id : undefined,
          config: INTERVAL_PROTOCOLS.includes(protocol) ? { ...config, interval_ms: intervalMs } : config,
          secret_input: needsSecret && secret ? secret : undefined,
        }),
      });
      applyDetail(created);
      setSecret('');
      setDirty(false);
      onSuccess({ id: created.id, name: created.name, protocol });
      return created.id;
    } catch (err) {
      setGeneralError(describeError(err));
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = await save();
    if (id) onClose();
  };

  const handleTest = async () => {
    // Unsaved edits of an existing connection are tested as a draft (nothing is stored);
    // a new connection, or a changed secret, has to be saved first.
    if (isEdit && savedId && dirty && !secret) {
      const errors = validate();
      setFieldErrors(errors);
      if (Object.keys(errors).length) return;
      setIsTesting(true);
      setTestResult(null);
      const result = await runConnectionTest(savedId, { mode: 'CONNECTIVITY', config: buildConfig(), testPath: protocol === 'http' ? httpTestPath : undefined });
      setTestResult(result);
      setIsTesting(false);
      return;
    }
    const id = await save();
    if (!id) return;
    setIsTesting(true);
    setTestResult(null);
    const result = await runConnectionTest(id, { mode: 'CONNECTIVITY', testPath: protocol === 'http' ? httpTestPath : undefined });
    setTestResult(result);
    setIsTesting(false);
  };

  if (!isOpen) return null;

  const err = (key: string) => (fieldErrors[key] ? <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors[key]}</p> : null);
  const busy = isSaving || isTesting || loadingDetail;
  const testLabel = isTesting ? 'Testing…' : !isEdit || secret ? 'Save & test' : dirty ? 'Test unsaved changes' : 'Test connection';

  const headerEditor = (rows: HeaderRow[], setRows: (rows: HeaderRow[]) => void, hint: string) => (
    <div className="pt-2 border-t border-[#E2E8F0] space-y-1.5">
      <div className="flex items-center justify-between">
        <span className={labelCls}>Static headers (optional)</span>
        <button
          type="button"
          onClick={() => {
            setRows([...rows, { key: '', value: '' }]);
            markDirty();
          }}
          className="text-[11px] font-bold text-[#134074] flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> Add header
        </button>
      </div>
      <p className="text-[10px] text-[#64748B]">{hint}</p>
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            aria-label="Header name"
            value={row.key}
            onChange={(e) => {
              setRows(rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)));
              markDirty();
            }}
            placeholder="Header name"
            className={inputCls}
          />
          <input
            aria-label="Header value"
            value={row.value}
            onChange={(e) => {
              setRows(rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)));
              markDirty();
            }}
            placeholder="Value"
            className={inputCls}
          />
          <button
            type="button"
            aria-label="Remove header"
            onClick={() => {
              setRows(rows.filter((_, i) => i !== index));
              markDirty();
            }}
            className="p-1.5 text-[#64748B] hover:text-red-600"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );

  const secretInput = (
    <div>
      <label className={labelCls} htmlFor={`${titleId}-secret`}>
        {secretLabel}
        {!(isEdit && secretConfigured) && '*'}
      </label>
      <div className="relative">
        <input
          id={`${titleId}-secret`}
          type={showSecret ? 'text' : 'password'}
          autoComplete="new-password"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            setTestResult(null);
          }}
          placeholder={isEdit && secretConfigured ? 'Stored · leave empty to keep it' : ''}
          className={`${inputCls} pr-8`}
        />
        <button
          type="button"
          aria-label={showSecret ? 'Hide value' : 'Show value'}
          onClick={() => setShowSecret(!showSecret)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748B]"
        >
          {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[10px] text-[#64748B] mt-0.5">Write-only. Stored encrypted and never shown again.</p>
      {err('secret')}
    </div>
  );

  // R2-CN-04: the rate limit applies to the whole connection, i.e. every distinct path bound on it.
  const httpPaths = protocol === 'http' && savedId ? httpPathsOfConnection(signals, savedId) : new Set<string>();
  const httpBudget = protocol === 'http' && httpPaths.size > 0 && intervalMs > 0 ? rateBudget(httpPaths.size, intervalMs, httpRateLimit || 1) : null;

  const intervalHint =
    protocol === 'http'
      ? 'Each distinct path is requested once per interval. Keep requests per minute under the source rate limit (5000 ms recommended).'
      : protocol === 'websocket'
        ? 'Latest values are emitted at most once per interval, only when a frame arrived.'
        : 'How often the collector reads the source.';

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-2xl border border-[#E2E8F0] shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="p-4 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
          <div>
            <h2 id={titleId} className="text-base font-bold text-[#0B2545]">
              {isEdit ? 'Edit Connection' : 'New Connection'}
            </h2>
            <p className="text-xs text-[#64748B]">Endpoint, security and polling parameters used by the Edge collector.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-5 space-y-4" noValidate>
          {generalError && (
            <div role="alert" className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span>{generalError}</span>
            </div>
          )}
          {loadingDetail && <div className="text-xs text-[#64748B]">Loading saved configuration…</div>}

          {!isEdit && (
            <fieldset>
              <legend className="block text-xs font-bold text-[#475569] mb-1.5 uppercase tracking-wider">Protocol</legend>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {protocolChoices.map((item) => {
                  const Icon = item.icon;
                  const active = protocol === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => chooseProtocol(item.id)}
                      className={`p-3 rounded-xl border text-center transition-all flex flex-col items-center gap-1.5 ${
                        active ? 'border-[#134074] bg-[#EFF6FF] text-[#134074] font-bold shadow-sm' : 'border-[#CBD5E1] bg-white text-[#475569] hover:border-[#134074]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span className="text-xs">{item.name}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className={labelCls} htmlFor={`${titleId}-name`}>Connection name*</label>
              <input
                id={`${titleId}-name`}
                ref={firstFieldRef}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  markDirty();
                }}
                placeholder="e.g. Line PLC gateway"
                className={inputCls.replace('font-mono', 'font-semibold')}
              />
              {err('name')}
            </div>
            <div>
              <label className={labelCls} htmlFor={`${titleId}-site`}>Site*</label>
              <select
                id={`${titleId}-site`}
                value={siteId}
                disabled={isEdit}
                onChange={(e) => {
                  setSiteId(e.target.value);
                  markDirty();
                }}
                className="w-full px-3 py-1.5 rounded-lg border border-[#CBD5E1] text-xs font-semibold text-[#0B2545] outline-none bg-white disabled:bg-[#F1F5F9]"
              >
                {!siteId && <option value="">Choose a site</option>}
                {siteOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {siteOptions.length === 0 && <p className="text-[11px] text-amber-700 mt-0.5">Create a site in the Factory Model first.</p>}
              {err('site')}
            </div>
          </div>

          {protocol === 'modbus' && (
            <div className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Host*</label>
                  <input value={modbusHost} onChange={(e) => { setModbusHost(e.target.value); markDirty(); }} placeholder="plc.example.local" className={inputCls} />
                  {err('modbusHost')}
                </div>
                <div>
                  <label className={labelCls}>Port*</label>
                  <input type="number" value={modbusPort} onChange={(e) => { setModbusPort(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  {err('modbusPort')}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>Default unit ID (0–247)</label>
                  <input type="number" value={unitId} onChange={(e) => { setUnitId(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  <p className="text-[10px] text-[#64748B] mt-0.5">Fields can override it per machine.</p>
                  {err('unitId')}
                </div>
                <div>
                  <label className={labelCls}>Timeout (ms)</label>
                  <input type="number" value={modbusTimeout} onChange={(e) => { setModbusTimeout(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  {err('modbusTimeout')}
                </div>
                <div>
                  <label className={labelCls}>Retries</label>
                  <input type="number" min={0} max={5} value={modbusRetries} onChange={(e) => { setModbusRetries(Number(e.target.value)); markDirty(); }} className={inputCls} />
                </div>
              </div>
            </div>
          )}

          {protocol === 'opcua' && (
            <div className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3">
              <div>
                <label className={labelCls}>Endpoint URL*</label>
                <input value={opcEndpoint} onChange={(e) => { setOpcEndpoint(e.target.value); markDirty(); }} placeholder="opc.tcp://server.example.local:4840/path" className={inputCls} />
                {err('opcEndpoint')}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Security mode</label>
                  <select
                    value={opcSecurityMode}
                    onChange={(e) => {
                      setOpcSecurityMode(e.target.value as 'None' | 'Sign' | 'SignAndEncrypt');
                      markDirty();
                    }}
                    className={inputCls}
                  >
                    <option value="None">None</option>
                    <option value="Sign">Sign</option>
                    <option value="SignAndEncrypt">SignAndEncrypt</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Security policy</label>
                  <select
                    disabled={opcSecurityMode === 'None'}
                    value={opcSecurityMode === 'None' ? 'None' : opcSecurityPolicy}
                    onChange={(e) => { setOpcSecurityPolicy(e.target.value); markDirty(); }}
                    className={`${inputCls} disabled:opacity-60`}
                  >
                    {opcSecurityMode === 'None' && <option value="None">None</option>}
                    <option value="Basic256Sha256">Basic256Sha256</option>
                    <option value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</option>
                    <option value="Aes256_Sha256_RsaPss">Aes256_Sha256_RsaPss</option>
                  </select>
                </div>
              </div>
              <fieldset className="pt-2 border-t border-[#E2E8F0]">
                <legend className={labelCls}>Authentication</legend>
                <div className="flex items-center gap-4 text-xs">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="opcAuth" checked={opcAuth === 'anonymous'} onChange={() => { setOpcAuth('anonymous'); markDirty(); }} />
                    <span>Anonymous</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="opcAuth" checked={opcAuth === 'userpass'} onChange={() => { setOpcAuth('userpass'); markDirty(); }} />
                    <span>Username & password</span>
                  </label>
                </div>
                {opcAuth === 'userpass' && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <label className={labelCls}>Username*</label>
                      <input value={opcUsername} onChange={(e) => { setOpcUsername(e.target.value); markDirty(); }} className={inputCls} />
                      {err('opcUsername')}
                    </div>
                    {secretInput}
                  </div>
                )}
              </fieldset>
            </div>
          )}

          {protocol === 'mqtt' && (
            <div className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Broker host*</label>
                  <input value={mqttHost} onChange={(e) => { setMqttHost(e.target.value); markDirty(); }} placeholder="broker.example.local" className={inputCls} />
                  {err('mqttHost')}
                </div>
                <div>
                  <label className={labelCls}>Port*</label>
                  <input type="number" value={mqttPort} onChange={(e) => { setMqttPort(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  {err('mqttPort')}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>MQTT version</label>
                  <select value={mqttVersion} onChange={(e) => { setMqttVersion(e.target.value as '3.1.1' | '5'); markDirty(); }} className={inputCls}>
                    <option value="3.1.1">3.1.1</option>
                    <option value="5">5.0</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Client ID</label>
                  <input value={clientId} onChange={(e) => { setClientId(e.target.value); markDirty(); }} placeholder="Generated by the collector when empty" className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>Keepalive (s)</label>
                  <input type="number" value={keepalive} onChange={(e) => { setKeepalive(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  {err('keepalive')}
                </div>
                <div>
                  <label className={labelCls}>Default QoS</label>
                  <select value={mqttQos} onChange={(e) => { setMqttQos(Number(e.target.value) as 0 | 1 | 2); markDirty(); }} className={inputCls}>
                    <option value={0}>0 – at most once</option>
                    <option value={1}>1 – at least once</option>
                    <option value={2}>2 – exactly once</option>
                  </select>
                </div>
                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-[#0B2545]">
                    <input type="checkbox" checked={cleanSession} onChange={(e) => { setCleanSession(e.target.checked); markDirty(); }} />
                    <span>Clean session</span>
                  </label>
                </div>
              </div>
              <fieldset className="pt-2 border-t border-[#E2E8F0]">
                <legend className={labelCls}>Authentication</legend>
                <div className="flex items-center gap-4 text-xs">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="mqttAuth" checked={mqttAuth === 'none'} onChange={() => { setMqttAuth('none'); markDirty(); }} />
                    <span>Anonymous</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="mqttAuth" checked={mqttAuth === 'userpass'} onChange={() => { setMqttAuth('userpass'); markDirty(); }} />
                    <span>Username & password</span>
                  </label>
                </div>
                {mqttAuth === 'userpass' && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <label className={labelCls}>Username*</label>
                      <input value={mqttUsername} onChange={(e) => { setMqttUsername(e.target.value); markDirty(); }} className={inputCls} />
                      {err('mqttUsername')}
                    </div>
                    {secretInput}
                  </div>
                )}
              </fieldset>
              <div className="pt-2 border-t border-[#E2E8F0] space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-[#0B2545]">
                  <input
                    type="checkbox"
                    checked={tls}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setTls(enabled);
                      if (enabled && mqttPort === 1883) setMqttPort(8883);
                      if (!enabled && mqttPort === 8883) setMqttPort(1883);
                      markDirty();
                    }}
                  />
                  <span>Use TLS</span>
                </label>
                {tls && (
                  <label className="pl-6 flex items-center gap-2 cursor-pointer text-xs text-[#475569]">
                    <input type="checkbox" checked={tlsVerify} onChange={(e) => { setTlsVerify(e.target.checked); markDirty(); }} />
                    <span>Verify server certificate</span>
                  </label>
                )}
              </div>
            </div>
          )}

          {protocol === 'http' && (
            <div className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3">
              <div>
                <label className={labelCls}>Base URL*</label>
                <input value={httpBaseUrl} onChange={(e) => { setHttpBaseUrl(e.target.value); markDirty(); }} placeholder="http://api.example.local:8080" className={inputCls} />
                <p className="text-[10px] text-[#64748B] mt-0.5">Scheme, host and port only. Paths are set per field in Add Data.</p>
                {err('httpBaseUrl')}
              </div>
              <fieldset className="space-y-2">
                <legend className={labelCls}>Authentication</legend>
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  {([
                    ['none', 'None'],
                    ['api_key', 'API key header'],
                    ['basic', 'Basic'],
                    ['bearer', 'Bearer token'],
                  ] as const).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="httpAuth" checked={httpAuth === value} onChange={() => { setHttpAuth(value); setSecret(''); markDirty(); }} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                {httpAuth !== 'none' && (
                  <div className="grid grid-cols-2 gap-3">
                    {httpAuth === 'api_key' && (
                      <div>
                        <label className={labelCls}>Header name*</label>
                        <input value={httpHeaderName} onChange={(e) => { setHttpHeaderName(e.target.value); markDirty(); }} className={inputCls} />
                        {err('httpHeaderName')}
                      </div>
                    )}
                    {httpAuth === 'basic' && (
                      <div>
                        <label className={labelCls}>Username*</label>
                        <input value={httpUsername} onChange={(e) => { setHttpUsername(e.target.value); markDirty(); }} className={inputCls} />
                        {err('httpUsername')}
                      </div>
                    )}
                    {secretInput}
                  </div>
                )}
              </fieldset>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Timeout (ms)</label>
                  <input type="number" value={httpTimeout} onChange={(e) => { setHttpTimeout(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  {err('httpTimeout')}
                </div>
                <div>
                  <label className={labelCls}>Rate limit (requests / min)</label>
                  <input type="number" min={1} value={httpRateLimit} onChange={(e) => { setHttpRateLimit(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  <p className="text-[10px] text-[#64748B] mt-0.5">The collector never exceeds this budget for the host.</p>
                  {err('httpRateLimit')}
                </div>
              </div>
              {headerEditor(httpHeaders, setHttpHeaders, 'Sent with every request. Do not put credentials here; use Authentication so they are stored encrypted.')}
              <div className="pt-2 border-t border-[#E2E8F0]">
                <label className={labelCls} htmlFor={`${titleId}-test-path`}>Test path (optional)</label>
                <input
                  id={`${titleId}-test-path`}
                  value={httpTestPath}
                  onChange={(e) => {
                    setHttpTestPath(e.target.value.trim());
                    setTestResult(null);
                  }}
                  placeholder="/api/v1/machines/<machine>/status"
                  className={`${inputCls} font-mono`}
                />
                <p className="text-[10px] text-[#64748B] mt-0.5">
                  A data path that requires the credentials. The test requests it to prove authentication; without it, Authenticate is reported as not verified. Not stored.
                </p>
              </div>
            </div>
          )}

          {protocol === 'websocket' && (
            <div className="p-4 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] space-y-3">
              <div>
                <label className={labelCls}>URL*</label>
                <input value={wsUrl} onChange={(e) => { setWsUrl(e.target.value); markDirty(); }} placeholder="ws://server.example.local/stream" className={inputCls} />
                <p className="text-[10px] text-[#64748B] mt-0.5">The collector keeps one persistent connection and reconnects automatically.</p>
                {err('wsUrl')}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Timeout (ms)</label>
                  <input type="number" value={wsTimeout} onChange={(e) => { setWsTimeout(Number(e.target.value)); markDirty(); }} className={inputCls} />
                  {err('wsTimeout')}
                </div>
              </div>
              {headerEditor(wsHeaders, setWsHeaders, 'Sent with the WebSocket handshake.')}
            </div>
          )}

          {INTERVAL_PROTOCOLS.includes(protocol) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{protocol === 'websocket' ? 'Emit interval (ms)' : 'Poll interval (ms)'}</label>
                <input type="number" min={1000} step={500} value={intervalMs} onChange={(e) => { setIntervalMs(Number(e.target.value)); markDirty(); }} className={inputCls} />
                {err('intervalMs')}
              </div>
              <p className="text-[10px] text-[#64748B] self-end pb-1">{intervalHint}</p>
              {httpBudget && (
                <p
                  role={httpBudget.over ? 'alert' : undefined}
                  className={`col-span-2 p-2.5 rounded-lg border text-[11px] ${httpBudget.over ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-white border-[#E2E8F0] text-[#64748B]'}`}
                >
                  {httpBudget.message}
                </p>
              )}
            </div>
          )}

          <TestResultPanel
            running={isTesting}
            runningLabel="The Edge collector is testing reachability and authentication…"
            result={testResult}
            successLabel="The Edge collector reached the endpoint"
          />

          <div className="pt-3 border-t border-[#E2E8F0] flex items-center justify-between">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleTest()}
              className="py-2 px-3 rounded-xl border border-[#CBD5E1] hover:border-[#134074] bg-white text-xs font-bold text-[#134074] flex items-center gap-1.5 shadow-sm transition-all disabled:opacity-50"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>{testLabel}</span>
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="py-2 px-4 rounded-xl border border-[#CBD5E1] text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC]">
                {isEdit && !dirty ? 'Close' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="py-2 px-5 rounded-xl bg-[#0B2545] hover:bg-[#134074] text-white text-xs font-bold shadow-sm transition-all disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : isEdit ? 'Save changes' : 'Create connection'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
    </ModalPortal>
  );
};
