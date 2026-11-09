import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Cpu,
  FolderTree,
  Layers,
  Network,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { ProtocolType, ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { validateTopicFilter } from '../../utils/mqttTopic';
import { api, ApiError } from '../../api/client';
import { BrowseNode, COLLECTOR_STARTING_MESSAGE, CommissionResult, runCapture, runConnectionTest, useCollectorStarting } from '../../lib/commissioning';
import { formatValue } from '../../lib/format';
import { ConnectionFormModal, SavedConnection } from '../05_Connections/ConnectionFormModal';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import { ConnectionStatusCell } from '../05_Connections/connectionStatus';
import { TestResultPanel } from '../05_Connections/TestResultPanel';
import { DEFAULT_HTTP_RATE_LIMIT, httpPathsOfConnection, rateBudget } from '../05_Connections/httpRate';
import { FieldTable } from './FieldTable';
import { JsonSampleTree } from './JsonSampleTree';
import { SimilarResourcesDialog } from './SimilarResourcesDialog';
import { useLeaveGuard } from './useLeaveGuard';
import { ResourceTreeNode, buildResourceTree, resourceTreeMatches, resourceTypeGlyph } from '../../components/tree/resourceTree';
import { isEnterSubmit } from '../08_SignalsCatalog/enterSubmit';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { formatInterval, pollIntervalMin, validatePollInterval } from '../05_Connections/pollInterval';
import {
  JNode,
  JsonParseError,
  evaluateNode,
  fromValue,
  hasSiblingTimestamp,
  inferDataType,
  nodePreview,
  parseOrderedJson,
} from './jsonTree';
import {
  AddressSettings,
  FieldRow,
  TargetRewrite,
  TimestampMode,
  addressKindFor,
  applyRewrite,
  buildAddress,
  emptyRow,
  keyFromRawName,
  nodeIdField,
  parseRegisterMap,
  rewriteProblems,
  rewriteText,
  targetAddress,
  validateRows,
} from './wizardModel';

// Hierarchy tree helpers are shared with the Data Model builder's data picker (components/tree/resourceTree).
type WizardTreeNode = ResourceTreeNode<ResourceNode>;
const buildWizardTree = (items: ResourceNode[]): WizardTreeNode[] => buildResourceTree(items);
const nodeOrDescendantMatches = (node: WizardTreeNode, query: string): boolean => resourceTreeMatches(node, query);
const typeIcon = resourceTypeGlyph;

interface ConnDetail {
  id: string;
  name: string;
  protocol: string;
  site_id: string;
  edge_id: string;
  version: number;
  config_json?: Record<string, unknown>;
  jobs?: Array<{ id: string; mode?: string; interval_ms?: number | null }>;
}

interface SampleView {
  topic: string;
  count: number;
  root: JNode;
  /** True when the Center returned no original text: key order may differ from the payload. */
  reordered: boolean;
}

interface TargetOutcome {
  resourceId: string;
  name: string;
  ok: boolean;
  message: string;
}


const POLLING: ProtocolType[] = ['modbus', 'opcua', 'http', 'websocket'];
const JSON_PROTOCOLS: ProtocolType[] = ['mqtt', 'http', 'websocket'];
const DRAFT_KEY = 'fx.addData.draft.v2';

function protocolFromApi(value: string): ProtocolType {
  const v = value.toLowerCase();
  if (v.includes('modbus')) return 'modbus';
  if (v.includes('opc')) return 'opcua';
  if (v.includes('mqtt')) return 'mqtt';
  if (v.includes('websocket') || v === 'ws') return 'websocket';
  return 'http';
}

interface Draft {
  step: number;
  targetId: string;
  connectionId: string;
  fields: FieldRow[];
  mqttTopicFilter: string;
  mqttQos: number;
  httpPath: string;
  intervalMs: number;
  modbusUnitId: number;
  timestampMode: TimestampMode;
  timestampPath: string;
  opcTimestampNodeId: string;
  rewrites: TargetRewrite[];
}

function readDraft(): Partial<Draft> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<Draft>) : null;
  } catch (error) {
    console.warn('Add Data draft could not be read', error);
    return null;
  }
}

export const AddDataWizardPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { resources, connections, edges, signals, refresh } = useApp();

  const queryResourceId = searchParams.get('resourceId');
  const queryConnectionId = searchParams.get('connectionId');

  const [currentStep, setCurrentStep] = useState(1);

  // Step 1
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [expandedTargetNodes, setExpandedTargetNodes] = useState<Record<string, boolean>>({});

  // Step 2
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [connDetail, setConnDetail] = useState<ConnDetail | null>(null);
  const [connDetailError, setConnDetailError] = useState<string | null>(null);
  const [isConnFormOpen, setIsConnFormOpen] = useState(false);
  const [newConnCreated, setNewConnCreated] = useState<SavedConnection | null>(null);

  // Step 3
  const [mqttTopicFilter, setMqttTopicFilter] = useState('');
  const [mqttQos, setMqttQos] = useState(1);
  const [httpPath, setHttpPath] = useState('');
  const [intervalMs, setIntervalMs] = useState(1000);
  const [modbusUnitId, setModbusUnitId] = useState(1);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Step 4
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [timestampMode, setTimestampMode] = useState<TimestampMode>('sibling');
  const [timestampPath, setTimestampPath] = useState('');
  const [opcTimestampNodeId, setOpcTimestampNodeId] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [mapText, setMapText] = useState('');
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [nodeText, setNodeText] = useState('');
  const [nodeMessage, setNodeMessage] = useState<string | null>(null);
  const [browseStack, setBrowseStack] = useState<Array<{ nodeId: string; label: string }>>([]);
  const [browseNodes, setBrowseNodes] = useState<BrowseNode[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);

  // Step 4/5: tests
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CommissionResult | null>(null);
  const [liveValues, setLiveValues] = useState<Record<string, string>>({});
  const [acceptUntested, setAcceptUntested] = useState(false);

  // Step 5
  const [rewrites, setRewrites] = useState<TargetRewrite[]>([]);
  const [similarOpen, setSimilarOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcomes, setOutcomes] = useState<TargetOutcome[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  /** Connection whose interval / unit id come from the restored draft instead of the server. */
  const draftConnectionRef = useRef<string | null>(null);
  /** QoS chosen by the user in this wizard; otherwise it follows the connection's default QoS. */
  const qosTouchedRef = useRef(false);
  const [connectionQos, setConnectionQos] = useState<number | null>(null);
  const collectorStarting = useCollectorStarting();
  /** Value read from the OPC UA source-time node by the last test (R2-AD-05). */
  const [sourceTimeValue, setSourceTimeValue] = useState<string | null>(null);

  // Restore draft, then apply deep-link parameters. R3-AD-02: a draft started from a deep link
  // (?resourceId= / ?connectionId=, e.g. "Add data" on a filtered Signals page) is restored too when
  // the link still points at the same target / connection — F5 keeps the URL, so it used to drop it.
  const restoredDraftRef = useRef(false);
  useEffect(() => {
    const draft = readDraft();
    const matchesQuery =
      Boolean(draft) &&
      (!queryResourceId || draft?.targetId === queryResourceId) &&
      (!queryConnectionId || draft?.connectionId === queryConnectionId);
    restoredDraftRef.current = false;
    if (draft && matchesQuery) {
      restoredDraftRef.current = true;
      draftConnectionRef.current = draft.connectionId || null;
      if (draft.targetId) setSelectedTargetId(draft.targetId);
      if (draft.connectionId) setSelectedConnectionId(draft.connectionId);
      if (Array.isArray(draft.fields)) setFields(draft.fields);
      if (draft.mqttTopicFilter) setMqttTopicFilter(draft.mqttTopicFilter);
      if (typeof draft.mqttQos === 'number') setMqttQos(draft.mqttQos);
      if (draft.httpPath) setHttpPath(draft.httpPath);
      if (typeof draft.intervalMs === 'number') setIntervalMs(draft.intervalMs);
      if (typeof draft.modbusUnitId === 'number') setModbusUnitId(draft.modbusUnitId);
      if (draft.timestampMode) setTimestampMode(draft.timestampMode);
      if (draft.timestampPath) setTimestampPath(draft.timestampPath);
      if (draft.opcTimestampNodeId) setOpcTimestampNodeId(draft.opcTimestampNodeId);
      if (Array.isArray(draft.rewrites)) setRewrites(draft.rewrites);
      if (draft.step) setCurrentStep(draft.step);
    }
    if (queryResourceId) setSelectedTargetId(queryResourceId);
    if (queryConnectionId) {
      setSelectedConnectionId(queryConnectionId);
      if (!restoredDraftRef.current) setCurrentStep(queryResourceId ? 3 : 1);
    }
  }, [queryResourceId, queryConnectionId]);

  useEffect(() => {
    if (!selectedTargetId && !selectedConnectionId && fields.length === 0) return;
    const draft: Draft = {
      step: currentStep,
      targetId: selectedTargetId,
      connectionId: selectedConnectionId,
      fields,
      mqttTopicFilter,
      mqttQos,
      httpPath,
      intervalMs,
      modbusUnitId,
      timestampMode,
      timestampPath,
      opcTimestampNodeId,
      rewrites,
    };
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (error) {
      console.warn('Add Data draft could not be saved', error);
    }
  }, [currentStep, selectedTargetId, selectedConnectionId, fields, mqttTopicFilter, mqttQos, httpPath, intervalMs, modbusUnitId, timestampMode, timestampPath, opcTimestampNodeId, rewrites]);

  const clearDraft = () => {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (error) {
      console.warn('Add Data draft could not be cleared', error);
    }
  };

  const wizardTree = useMemo(() => buildWizardTree(resources), [resources]);
  const targetResource = useMemo(() => resources.find((r) => r.id === selectedTargetId), [resources, selectedTargetId]);
  const targetSiteId = targetResource?.attributes?.siteId || '';

  const targetPathString = useMemo(() => {
    if (!targetResource) return '';
    const parts: string[] = [targetResource.name || targetResource.code];
    let cursor: ResourceNode | undefined = targetResource;
    while (cursor?.parentId) {
      const parent = resources.find((r) => r.id === cursor?.parentId);
      if (!parent) break;
      parts.unshift(parent.name || parent.code);
      cursor = parent;
    }
    return parts.join(' / ');
  }, [targetResource, resources]);

  const siteConnections = useMemo(
    () => (targetSiteId ? connections.filter((c) => !c.siteId || c.siteId === targetSiteId) : connections),
    [connections, targetSiteId],
  );

  const selectedConnection = connections.find((c) => c.id === selectedConnectionId);
  const protocol: ProtocolType = connDetail ? protocolFromApi(connDetail.protocol) : selectedConnection?.protocol || 'mqtt';
  const isJson = JSON_PROTOCOLS.includes(protocol);
  const isPolling = POLLING.includes(protocol);
  const job = connDetail?.jobs?.[0];

  // Load the connection detail (config, job interval, edge) whenever the selection changes.
  useEffect(() => {
    if (!selectedConnectionId) {
      setConnDetail(null);
      return;
    }
    let cancelled = false;
    setConnDetailError(null);
    api<ConnDetail>(`/api/v1/connections/${encodeURIComponent(selectedConnectionId)}`)
      .then((detail) => {
        if (cancelled) return;
        setConnDetail(detail);
        const cfg = detail.config_json || {};
        const jobInterval = detail.jobs?.[0]?.interval_ms;
        const proto = protocolFromApi(detail.protocol);
        const fallback = proto === 'http' ? 5000 : 1000;
        // R2-AD-04: the field QoS defaults to the connection's QoS unless the user picked another one.
        const cfgQos = Number(cfg.qos);
        const defaultQos = cfgQos === 0 || cfgQos === 1 || cfgQos === 2 ? cfgQos : 1;
        if (proto === 'mqtt') {
          setConnectionQos(defaultQos);
          if (!qosTouchedRef.current) setMqttQos(defaultQos);
        } else {
          setConnectionQos(null);
        }
        if (draftConnectionRef.current === detail.id) {
          // Keep the values restored from the draft once.
          draftConnectionRef.current = null;
          return;
        }
        setIntervalMs(Number(jobInterval) || fallback);
        if (proto === 'modbus') setModbusUnitId(Number(cfg.unit_id ?? 1));
      })
      .catch((error) => {
        if (!cancelled) setConnDetailError(error instanceof Error ? error.message : 'Could not load the connection.');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConnectionId]);

  const invalidateTest = useCallback(() => {
    setTestResult(null);
    setLiveValues({});
    setSourceTimeValue(null);
    setAcceptUntested(false);
  }, []);

  const settings: AddressSettings = useMemo(
    () => ({ protocol, mqttQos, timestampMode, timestampPath, opcTimestampNodeId, modbusUnitId }),
    [protocol, mqttQos, timestampMode, timestampPath, opcTimestampNodeId, modbusUnitId],
  );

  // ---------------------------------------------------------------- Step 3 helpers
  const connectionSignals = useMemo(() => signals.filter((s) => s.sourceConnectionId === selectedConnectionId), [signals, selectedConnectionId]);

  /** Addresses already used on this connection, rewritten to the target machine code where possible. */
  const addressSuggestions = useMemo(() => {
    if (!targetResource) return [] as string[];
    const out = new Set<string>();
    const field = protocol === 'mqtt' ? 'topic' : 'path';
    connectionSignals.forEach((s) => {
      const value = String((s.addressJson as Record<string, unknown> | undefined)?.[field] || '');
      if (!value) return;
      const owner = resources.find((r) => r.id === s.resourceId);
      if (owner?.code && owner.code !== targetResource.code && value.includes(owner.code)) {
        out.add(value.split(owner.code).join(targetResource.code));
      } else if (owner?.id === targetResource.id) {
        out.add(value);
      }
    });
    if (protocol === 'mqtt') {
      const cfgTopics = (connDetail?.config_json?.topics as string[] | undefined) || [];
      cfgTopics.forEach((t) => out.add(t));
      (discovered || []).filter((t) => t.includes(targetResource.code)).forEach((t) => out.add(t));
    }
    return Array.from(out).slice(0, 12);
  }, [connectionSignals, connDetail, discovered, protocol, resources, targetResource]);

  useEffect(() => {
    if (currentStep !== 3) return;
    if (protocol === 'mqtt' && !mqttTopicFilter && addressSuggestions.length) setMqttTopicFilter(addressSuggestions[0]);
    if (protocol === 'http' && !httpPath && addressSuggestions.length) setHttpPath(addressSuggestions[0]);
  }, [currentStep, protocol, addressSuggestions, mqttTopicFilter, httpPath]);

  const handleDiscoverTopics = async () => {
    if (!selectedConnectionId) return;
    const filter = mqttTopicFilter && !validateTopicFilter(mqttTopicFilter) ? mqttTopicFilter : '#';
    setDiscovering(true);
    setDiscoverError(null);
    const result = await runCapture(selectedConnectionId, { topics: [filter], topic_filter: filter, duration_seconds: 5, max_messages: 200 });
    setDiscovering(false);
    if (!result.passed) {
      setDiscoverError(result.message || 'Capture failed.');
      return;
    }
    const topics = Array.from(new Set(result.captured.map((s) => s.topic).filter(Boolean))).sort();
    setDiscovered(topics);
    if (!topics.length) setDiscoverError(`No message on "${filter}" within 5 s.`);
  };

  const step3Valid = (): string | null => {
    if (protocol === 'mqtt') return validateTopicFilter(mqttTopicFilter);
    if (protocol === 'http' && !httpPath.trim().startsWith('/')) return 'Enter the request path, starting with /.';
    if (isPolling && intervalError) return intervalError;
    if (protocol === 'modbus' && (!Number.isInteger(modbusUnitId) || modbusUnitId < 0 || modbusUnitId > 247)) return 'Unit ID must be 0–247.';
    return null;
  };

  // R3-AD-01: the interval belongs to the connection job, so it is validated inline and the change
  // is spelled out for every machine read through that connection.
  const intervalError = isPolling ? validatePollInterval(protocol, intervalMs) : null;
  const currentJobInterval = job?.interval_ms != null ? Number(job.interval_ms) : null;
  const intervalChanges = isPolling && currentJobInterval !== null && !intervalError && currentJobInterval !== intervalMs;
  const connectionMachineCount = useMemo(
    () => new Set(connectionSignals.map((s) => s.resourceId).filter(Boolean)).size,
    [connectionSignals],
  );

  // ---------------------------------------------------------------- Step 4: JSON protocols
  const activeSample = samples[sampleIndex];
  const selectedPaths = useMemo(() => {
    const set = new Set<string>();
    fields.forEach((f) => {
      if (protocol === 'mqtt' && activeSample && f.topic !== activeSample.topic) return;
      if (f.jsonpath) set.add(f.jsonpath);
    });
    return set;
  }, [fields, protocol, activeSample]);

  const handleCapture = async () => {
    if (!selectedConnectionId) return;
    setCapturing(true);
    setCaptureError(null);
    const request =
      protocol === 'mqtt'
        ? { topics: [mqttTopicFilter], topic_filter: mqttTopicFilter, duration_seconds: 10, max_messages: 100 }
        : protocol === 'http'
          ? { topics: [httpPath], topic_filter: httpPath, duration_seconds: 5, max_messages: 1 }
          : { duration_seconds: 5, max_messages: 20 };
    const result = await runCapture(selectedConnectionId, request);
    setCapturing(false);
    if (!result.passed) {
      setCaptureError(result.message || 'Capture failed.');
      return;
    }
    const views: SampleView[] = [];
    result.captured.forEach((sample) => {
      let root: JNode | null = null;
      let reordered = true;
      if (sample.raw) {
        try {
          root = parseOrderedJson(sample.raw);
          reordered = false;
        } catch (error) {
          console.warn('Captured payload text is not valid JSON', error);
        }
      }
      if (!root) root = fromValue(sample.payload);
      views.push({
        topic: sample.topic || (protocol === 'http' ? httpPath : protocol === 'mqtt' ? mqttTopicFilter : ''),
        count: sample.count,
        root,
        reordered,
      });
    });
    setSamples(views);
    setSampleIndex(0);
    if (!views.length) setCaptureError(protocol === 'mqtt' ? `No message on "${mqttTopicFilter}" within 10 s.` : 'The source returned no payload.');
  };

  const handleApplyPaste = () => {
    setPasteError(null);
    try {
      const root = parseOrderedJson(pasteText.trim());
      const topic = protocol === 'mqtt' ? (/[#+]/.test(mqttTopicFilter) ? '' : mqttTopicFilter) : protocol === 'http' ? httpPath : '';
      setSamples((prev) => [...prev, { topic, count: 1, root, reordered: false }]);
      setSampleIndex(samples.length);
      setPasteOpen(false);
      setPasteText('');
    } catch (error) {
      setPasteError(error instanceof JsonParseError || error instanceof Error ? error.message : 'Invalid JSON.');
    }
  };

  const rowFromLeaf = (path: string, key: string, node: JNode, sample: SampleView): FieldRow => {
    const inferred = inferDataType(node);
    const rawKey = keyFromRawName(key);
    return emptyRow(protocol, {
      key: rawKey,
      displayName: rawKey,
      jsonpath: path,
      topic: protocol === 'mqtt' ? sample.topic : undefined,
      path: protocol === 'http' ? httpPath : undefined,
      dataType: inferred.dataType,
      nullable: node.kind === 'null' || node.kind === 'string',
      sample: nodePreview(node),
      sampleWarning: inferred.warning,
    });
  };

  const sameAddress = (row: FieldRow, path: string, sample: SampleView) =>
    row.jsonpath === path && (protocol !== 'mqtt' || row.topic === sample.topic);

  const handlePickLeaf = (path: string, key: string, node: JNode) => {
    if (!activeSample) return;
    invalidateTest();
    setFields((prev) => {
      if (prev.some((row) => sameAddress(row, path, activeSample))) return prev.filter((row) => !sameAddress(row, path, activeSample));
      return [...prev, rowFromLeaf(path, key, node, activeSample)];
    });
  };

  const handlePickObject = (leaves: Array<{ path: string; key: string; node: JNode }>) => {
    if (!activeSample) return;
    invalidateTest();
    setFields((prev) => {
      const next = [...prev];
      leaves.forEach((leaf) => {
        if (!next.some((row) => sameAddress(row, leaf.path, activeSample))) next.push(rowFromLeaf(leaf.path, leaf.key, leaf.node, activeSample));
      });
      return next;
    });
  };

  /** Unmap captured leaves of the active sample (tree "Clear" / "Clear all"). */
  const handleClearPaths = (paths: string[]) => {
    if (!activeSample || !paths.length) return;
    const drop = new Set(paths);
    invalidateTest();
    setFields((prev) => prev.filter((row) => !(row.jsonpath && drop.has(row.jsonpath) && (protocol !== 'mqtt' || row.topic === activeSample.topic))));
  };

  const [clearFieldsOpen, setClearFieldsOpen] = useState(false);

  /** Step 3 "Next" (also on Enter in a step 3 field). */
  const goToStep4 = () => {
    if (!connDetail || (isPolling && intervalError)) return;
    const error = step3Valid();
    setAddressError(error);
    if (!error) setCurrentStep(4);
  };

  const siblingTsInfo = useMemo(() => {
    if (!isJson || !fields.length) return null;
    const withTs = fields.filter((row) => samples.some((s) => (protocol !== 'mqtt' || s.topic === row.topic) && row.jsonpath && hasSiblingTimestamp(s.root, row.jsonpath)));
    return `${withTs.length} of ${fields.length} field(s) have a sibling source_timestamp in the captured sample.`;
  }, [fields, isJson, protocol, samples]);

  // ---------------------------------------------------------------- Step 4: OPC UA / Modbus
  const handleAddNodeIds = () => {
    const lines = nodeText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const added: FieldRow[] = [];
    let tsNode = '';
    lines.forEach((nodeId) => {
      const field = nodeIdField(nodeId);
      if (field === 'source_timestamp') {
        tsNode = nodeId;
        return;
      }
      if (fields.some((row) => row.nodeId === nodeId) || added.some((row) => row.nodeId === nodeId)) return;
      const key = keyFromRawName(field);
      added.push(emptyRow('opcua', { key, displayName: key, nodeId, dataType: 'float64' }));
    });
    if (tsNode) setOpcTimestampNodeId(tsNode);
    setFields((prev) => [...prev, ...added]);
    setNodeText('');
    invalidateTest();
    setNodeMessage(
      `${added.length} node(s) added.${tsNode ? ` ${tsNode} is used as the source timestamp of every field.` : ''}`,
    );
  };

  const browse = async (nodeId: string, label: string, push: boolean) => {
    if (!selectedConnectionId) return;
    setBrowsing(true);
    setBrowseError(null);
    const result = await runCapture(selectedConnectionId, { browse_node: nodeId, duration_seconds: 5, max_messages: 1 });
    setBrowsing(false);
    if (!result.passed) {
      setBrowseError(result.message || 'Browse failed.');
      return;
    }
    if (!result.browse.length) {
      setBrowseError('The collector returned no child nodes. Paste node IDs instead.');
      setBrowseNodes([]);
      return;
    }
    setBrowseNodes(result.browse);
    setBrowseStack((prev) => (push ? [...prev, { nodeId, label }] : [{ nodeId, label }]));
  };

  const handleAddRegisterMap = () => {
    const parsed = parseRegisterMap(mapText);
    const added = parsed.rows.map((partial) => emptyRow('modbus', partial));
    setFields((prev) => [...prev, ...added]);
    setMapMessage(`${added.length} field(s) added.${parsed.errors.length ? ` ${parsed.errors.join(' ')}` : ''}`);
    if (added.length) setMapText('');
    invalidateTest();
  };

  // ---------------------------------------------------------------- Validation and tests
  const existingKeys = useCallback(
    (resourceId: string) => new Set(signals.filter((s) => s.resourceId === resourceId).map((s) => s.key || '')),
    [signals],
  );

  const validateCurrentRows = (): boolean => {
    const result = validateRows(fields, protocol, existingKeys(selectedTargetId));
    setFields(result.rows);
    if (result.hasError) setRowsError('Fix the highlighted rows.');
    else if (!result.rows.length) setRowsError('Add at least one field.');
    else setRowsError(null);
    if (protocol === 'opcua' && opcTimestampNodeId.trim() && !/^(ns=\d+;|nsu=[^;]+;)?[isgb]=.+$/.test(opcTimestampNodeId.trim())) {
      setRowsError('The timestamp node ID is not a valid node ID.');
      return false;
    }
    if (isJson && timestampMode === 'custom' && !timestampPath.trim().startsWith('$')) {
      setRowsError('The timestamp JSONPath starts with $.');
      return false;
    }
    return !result.hasError && result.rows.length > 0;
  };

  const handleRunTest = async () => {
    if (!selectedConnectionId || !validateCurrentRows()) return;
    setTesting(true);
    setTestResult(null);
    setLiveValues({});
    setSourceTimeValue(null);
    // OPC UA: also read the source-time node so the operator sees the group timestamp it returns.
    const tsNode = protocol === 'opcua' ? opcTimestampNodeId.trim() : '';
    const usedKeys = new Set(fields.map((row) => row.key.trim()));
    const tsKey = tsNode ? ['source_timestamp', 'source_time_node', '_source_time_node'].find((k) => !usedKeys.has(k)) || '' : '';
    const testFields = fields.map((row) => ({ key: row.key.trim(), name: row.displayName || row.key, data_type: row.dataType, address: buildAddress(row, settings) }));
    if (tsKey) testFields.push({ key: tsKey, name: 'Source time', data_type: 'string', address: { node_id: tsNode, nullable: true } });
    const result = await runConnectionTest(selectedConnectionId, { mode: 'FULL', fields: testFields });
    setTesting(false);
    setTestResult(result);
    const samplesObj = result.samples && typeof result.samples === 'object' && !Array.isArray(result.samples) ? (result.samples as Record<string, unknown>) : {};
    const responseDoc = samplesObj.response !== undefined ? fromValue(samplesObj.response) : null;
    const values: Record<string, string> = {};
    fields.forEach((row) => {
      const key = row.key.trim();
      let value: unknown;
      let found = false;
      if (key in samplesObj && key !== 'meta') {
        value = samplesObj[key];
        found = true;
      } else if (row.nodeId && row.nodeId in samplesObj) {
        value = samplesObj[row.nodeId];
        found = true;
      } else if (responseDoc && row.jsonpath) {
        const node = evaluateNode(responseDoc, row.jsonpath);
        if (node) {
          value = nodePreview(node);
          found = true;
        }
      }
      if (found) values[row.id] = typeof value === 'string' && responseDoc ? value : formatValue(value);
    });
    setLiveValues(values);
    if (tsKey) {
      const raw = tsKey in samplesObj ? samplesObj[tsKey] : tsNode in samplesObj ? samplesObj[tsNode] : undefined;
      setSourceTimeValue(raw === undefined || raw === null ? 'not returned' : formatValue(raw));
    }
  };

  // ---------------------------------------------------------------- Similar machines
  const similarCandidates = useMemo(() => {
    if (!targetResource) return [];
    return resources
      .filter((r) => r.id !== targetResource.id && r.type === targetResource.type && (r.attributes?.siteId || '') === targetSiteId)
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  }, [resources, targetResource, targetSiteId]);

  const rewriteRows = useMemo(
    () =>
      rewrites.map((rw) => ({
        rw,
        rows: fields.map((row) => applyRewrite(protocol, row, rw)),
        // Full address_json per source row: every address string (incl. source time node / path) rewritten.
        addresses: fields.map((row) => targetAddress(row, settings, rw)),
        problems: rewriteProblems(protocol, fields, rw, { settings, sourceCode: targetResource?.code || '' }),
      })),
    [rewrites, fields, protocol, settings, targetResource?.code],
  );

  // ---------------------------------------------------------------- Start collecting
  /** In-flight guard (R3-DM-04): a double click on Start collecting creates the signals once. */
  const startRunningRef = useRef(false);
  const handleStartCollecting = async () => {
    if (startRunningRef.current) return;
    startRunningRef.current = true;
    try {
      await startCollecting();
    } finally {
      startRunningRef.current = false;
    }
  };

  const startCollecting = async () => {
    if (!selectedTargetId || !connDetail || !validateCurrentRows()) return;
    if (isPolling && intervalError) {
      setSubmitError(intervalError);
      return;
    }
    setSubmitError(null);
    setOutcomes(null);
    const targets: Array<{ resourceId: string; name: string; rows: FieldRow[]; addresses: Array<Record<string, unknown>> }> = [
      {
        resourceId: selectedTargetId,
        name: targetResource?.name || targetResource?.code || 'Target',
        rows: fields,
        addresses: fields.map((row) => buildAddress(row, settings)),
      },
      ...rewriteRows.map(({ rw, rows, addresses }) => ({ resourceId: rw.resourceId, name: rw.resourceName, rows, addresses })),
    ];
    // Validate every target before creating anything.
    for (const { rw, problems } of rewriteRows) {
      if (problems.length) {
        setSubmitError(`${rw.resourceName}: ${problems.join(' ')}`);
        return;
      }
    }
    for (const target of targets.slice(1)) {
      const check = validateRows(target.rows, protocol, existingKeys(target.resourceId));
      const bad = check.rows.find((row) => row.error);
      if (bad) {
        setSubmitError(`${target.name}: ${bad.key} — ${bad.error}`);
        return;
      }
    }
    setSubmitting(true);
    const results: TargetOutcome[] = [];
    try {
      let jobId = job?.id || '';
      const subscribe = protocol === 'mqtt';
      if (!jobId) {
        const created = await api<{ id: string }>('/api/v1/jobs', {
          method: 'POST',
          body: JSON.stringify({ connection_id: connDetail.id, mode: subscribe || protocol === 'websocket' ? 'SUBSCRIBE' : 'POLL', interval_ms: subscribe ? 1000 : intervalMs }),
        });
        jobId = created.id;
      } else if (isPolling && job && Number(job.interval_ms) !== intervalMs) {
        await api('/api/v1/jobs', {
          method: 'POST',
          body: JSON.stringify({ connection_id: connDetail.id, mode: job.mode || 'POLL', interval_ms: intervalMs }),
        });
      }
      const expected = isPolling ? intervalMs : 1000;
      for (const target of targets) {
        try {
          await api('/api/v1/signals/bulk', {
            method: 'POST',
            body: JSON.stringify({
              resource_id: target.resourceId,
              atomic: true,
              items: target.rows.map((row, index) => ({
                key: row.key.trim(),
                name: (row.displayName || row.key).trim(),
                data_type: row.dataType,
                unit: row.unit.trim() || undefined,
                expected_interval_ms: expected,
                source_field: {
                  acquisition_job_id: jobId,
                  address_kind: addressKindFor(protocol),
                  address: target.addresses[index],
                },
              })),
            }),
          });
          results.push({ resourceId: target.resourceId, name: target.name, ok: true, message: `${target.rows.length} signal(s) created` });
        } catch (error) {
          results.push({ resourceId: target.resourceId, name: target.name, ok: false, message: error instanceof Error ? error.message : 'Request failed' });
        }
      }
      if (results.some((r) => r.ok) && connDetail.edge_id) {
        await api('/api/v1/config-releases/publish', { method: 'POST', body: JSON.stringify({ edge_id: connDetail.edge_id }) });
      }
      await refresh().catch((error) => console.warn('Refresh after Start collecting failed', error));
      setOutcomes(results);
      if (results.every((r) => r.ok)) {
        clearDraft();
        leaveGuard.allowNext();
        navigate(`/collector/signals?resourceId=${encodeURIComponent(selectedTargetId)}`);
      }
    } catch (error) {
      setOutcomes(results.length ? results : null);
      setSubmitError(error instanceof ApiError || error instanceof Error ? error.message : 'Could not start collecting.');
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------- Cancel / leave (R3-AD-02)
  const hasUnsavedSettings = !submitting && (currentStep >= 3 || fields.length > 0 || rewrites.length > 0 || Boolean(newConnCreated));
  const leaveGuard = useLeaveGuard(hasUnsavedSettings);

  const handleCancel = () => {
    if (newConnCreated) {
      setConfirmCancelOpen(true);
      return;
    }
    // With unsaved settings, navigate(-1) is held by the leave guard and its dialog asks first.
    if (!hasUnsavedSettings) clearDraft();
    navigate(-1);
  };

  const confirmLeave = () => {
    clearDraft();
    leaveGuard.proceed();
  };

  const handleDiscardNewConn = async (keep: boolean) => {
    setCancelError(null);
    if (!keep && newConnCreated) {
      try {
        await api(`/api/v1/connections/${encodeURIComponent(newConnCreated.id)}/pause`, { method: 'POST' });
        await api(`/api/v1/connections/${encodeURIComponent(newConnCreated.id)}`, { method: 'DELETE' });
        await refresh().catch((refreshError) => console.warn('Refresh after archiving the new connection failed', refreshError));
      } catch (error) {
        setCancelError(`The connection could not be archived: ${error instanceof Error ? error.message : 'request failed'}. Archive it from Connections.`);
        return;
      }
    }
    clearDraft();
    setConfirmCancelOpen(false);
    leaveGuard.allowNext();
    navigate(-1);
  };

  // R2-AD-01: entering Review runs the live test automatically (Modbus / OPC keep the result of their
  // "Test read" in step 4 unless the fields changed since).
  const autoTestedRef = useRef(false);
  useEffect(() => {
    if (currentStep !== 5) {
      autoTestedRef.current = false;
      return;
    }
    if (autoTestedRef.current || testing || testResult || !fields.length || !connDetail) return;
    autoTestedRef.current = true;
    void handleRunTest();
    // handleRunTest reads the current state; re-running it on every field edit is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, connDetail]);

  const testPassed = Boolean(testResult?.passed);
  const canStart = fields.length > 0 && (testPassed || acceptUntested) && !submitting && !(isPolling && intervalError);

  // ---------------------------------------------------------------- Render
  const stepTitle = ['Choose target resource', 'Select data source', 'Source address', 'Map fields', 'Review & start'][currentStep - 1];
  const labelCls = 'block text-[11px] font-semibold text-[#657794] uppercase mb-1';
  const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded text-[12px] focus:outline-none focus:border-blue-500';
  // R2-CN-04: the rate limit covers the whole connection: every distinct path already bound on it plus
  // the paths this wizard adds (target + similar machines), each requested once per interval.
  const rateLimit = Number(connDetail?.config_json?.rate_limit_per_min ?? DEFAULT_HTTP_RATE_LIMIT) || DEFAULT_HTTP_RATE_LIMIT;
  const httpBudget = (() => {
    if (protocol !== 'http' || !selectedConnectionId || intervalMs <= 0) return null;
    const paths = httpPathsOfConnection(signals, selectedConnectionId);
    const existing = paths.size;
    const newPath = httpPath.trim();
    if (newPath) {
      paths.add(newPath);
      rewrites.forEach((rw) => paths.add(rewriteText(newPath, 'http', rw)));
    }
    return { ...rateBudget(paths.size, intervalMs, rateLimit), existing };
  })();

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-blue-600 flex items-center gap-1.5 flex-wrap">
            <span>Add Data</span>
            {targetPathString && (
              <>
                <ChevronRight className="w-3 h-3 text-slate-400" />
                <span className="text-[#111B37] font-mono break-all">{targetPathString}</span>
              </>
            )}
            {selectedConnection && (
              <>
                <ChevronRight className="w-3 h-3 text-slate-400" />
                <span className="text-[#111B37]">{selectedConnection.name} · {PROTOCOL_LABEL[protocol]}</span>
              </>
            )}
          </div>
          <h1 className="text-[20px] font-bold text-[#111B37] mt-0.5">
            {currentStep}. {stepTitle}
          </h1>
        </div>
        <Button variant="outline" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
      </div>

      <ol className="grid grid-cols-5 gap-1 sm:gap-2" aria-label="Wizard steps">
        {['Target', 'Source', 'Address', 'Fields', 'Review'].map((title, index) => {
          const num = index + 1;
          return (
            <li
              key={title}
              aria-current={currentStep === num ? 'step' : undefined}
              className={`p-1.5 sm:p-2.5 rounded-lg border text-center transition min-w-0 ${
                currentStep === num
                  ? 'bg-blue-50 border-blue-400 text-blue-700 font-bold'
                  : currentStep > num
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                    : 'bg-white border-slate-200 text-slate-400 font-medium'
              }`}
            >
              <div className="text-[10px] sm:text-[11px] uppercase tracking-wider">
                <span className="hidden sm:inline">Step </span>{num}
              </div>
              <div className="text-[11px] sm:text-[13px] truncate">{title}</div>
            </li>
          );
        })}
      </ol>

      {/* STEP 1 */}
      {currentStep === 1 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Select the resource that owns the data</h3>
              <p className="text-[12px] text-[#657794]">Signals can be bound to any level (machine, line, zone…).</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => setExpandedTargetNodes(Object.fromEntries(resources.map((r) => [r.id, true])))} className="px-2 py-1 text-[11px] font-semibold text-[#134074] hover:bg-[#F1F5F9] rounded-lg">
                Expand all
              </button>
              <span className="text-slate-300">|</span>
              <button type="button" onClick={() => setExpandedTargetNodes(Object.fromEntries(resources.map((r) => [r.id, false])))} className="px-2 py-1 text-[11px] font-semibold text-[#64748B] hover:bg-[#F1F5F9] rounded-lg">
                Collapse all
              </button>
            </div>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input type="text" aria-label="Search resources" placeholder="Search resources by name or code…" value={targetSearch} onChange={(e) => setTargetSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500" />
          </div>
          <div role="tree" aria-label="Target resource" className="border border-slate-200 rounded-xl max-h-96 overflow-y-auto p-2 bg-[#F8FAFC]">
            {wizardTree.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-xs font-medium">No resources yet. Build the factory model first.</div>
            ) : (
              (() => {
                const renderNode = (node: WizardTreeNode, depth: number): React.ReactNode => {
                  if (!nodeOrDescendantMatches(node, targetSearch)) return null;
                  const hasChildren = node.children.length > 0;
                  const expanded = targetSearch.trim() ? true : expandedTargetNodes[node.resource.id] ?? true;
                  const selected = selectedTargetId === node.resource.id;
                  return (
                    <React.Fragment key={node.resource.id}>
                      <div
                        role="treeitem"
                        aria-label={`${node.resource.name || node.resource.code} (${node.resource.type}${node.resource.code ? `, ${node.resource.code}` : ''})`}
                        aria-level={depth + 1}
                        aria-selected={selected}
                        aria-expanded={hasChildren ? expanded : undefined}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedTargetId(node.resource.id);
                            invalidateTest();
                          }
                        }}
                        onClick={() => {
                          setSelectedTargetId(node.resource.id);
                          invalidateTest();
                        }}
                        style={{ paddingLeft: depth * 18 + 8 }}
                        className={`py-2 pr-3 flex items-center justify-between cursor-pointer rounded-lg transition mb-0.5 ${selected ? 'bg-white border-2 border-blue-600 shadow-sm text-blue-900 font-bold' : 'hover:bg-white text-[#111B37]'}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {hasChildren ? (
                            <button
                              type="button"
                              aria-label={expanded ? 'Collapse' : 'Expand'}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedTargetNodes((prev) => ({ ...prev, [node.resource.id]: !expanded }));
                              }}
                              className="p-1 rounded hover:bg-slate-200 text-slate-500"
                            >
                              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </button>
                          ) : (
                            <span className="w-5" />
                          )}
                          {typeIcon(node.resource.type)}
                          <span className="text-[13px] font-semibold truncate" title={node.resource.name}>{node.resource.name || node.resource.code}</span>
                          <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">{node.resource.type}</span>
                          <span className="text-[11px] text-[#657794] font-mono">{node.resource.code}</span>
                        </div>
                        {selected ? <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" /> : <Circle className="w-5 h-5 text-slate-300 shrink-0" />}
                      </div>
                      {hasChildren && expanded && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
                    </React.Fragment>
                  );
                };
                return wizardTree.map((root) => renderNode(root, 0));
              })()
            )}
          </div>
          <div className="flex justify-end pt-3 border-t border-slate-100">
            <Button variant="primary" size="sm" disabled={!selectedTargetId} onClick={() => setCurrentStep(selectedConnectionId ? 3 : 2)}>
              Next: {selectedConnectionId ? 'Source address' : 'Select source'} <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 2 */}
      {currentStep === 2 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Select the data connection</h3>
              <p className="text-[12px] text-[#657794]">Connections of the same site as {targetResource?.name || 'the target'}.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setIsConnFormOpen(true)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> New connection
            </Button>
          </div>
          {siteConnections.length === 0 ? (
            <div className="p-8 text-center text-[#657794] border border-dashed border-slate-300 rounded-lg text-[12px]">
              No connection exists for this site yet. Click "New connection".
            </div>
          ) : (
            <div role="radiogroup" aria-label="Connections" className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {siteConnections.map((c) => (
                <div
                  key={c.id}
                  role="radio"
                  aria-checked={selectedConnectionId === c.id}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedConnectionId(c.id);
                      invalidateTest();
                    }
                  }}
                  onClick={() => {
                    if (c.id !== selectedConnectionId) {
                      if (c.protocol !== protocol) {
                        setFields([]);
                        setRewrites([]);
                      }
                      setSelectedConnectionId(c.id);
                      setSamples([]);
                      setDiscovered(null);
                      invalidateTest();
                    }
                  }}
                  className={`p-3 flex items-center justify-between cursor-pointer transition ${selectedConnectionId === c.id ? 'bg-blue-50/70 border-l-4 border-blue-600' : 'hover:bg-slate-50'}`}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-[#111B37] flex items-center gap-2">
                      <span>{c.name}</span>
                      <span className="text-[10px] font-bold px-1.5 bg-slate-100 text-slate-700 rounded">{PROTOCOL_LABEL[c.protocol]}</span>
                    </div>
                    <div className="text-[11px] text-[#657794] font-mono mt-0.5 truncate">{c.endpoint || '—'}</div>
                  </div>
                  <ConnectionStatusCell conn={c} compact />
                </div>
              ))}
            </div>
          )}
          {connDetailError && <p role="alert" className="text-[12px] text-red-600">{connDetailError}</p>}
          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(1)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
            </Button>
            <Button variant="primary" size="sm" disabled={!selectedConnectionId || !connDetail} onClick={() => setCurrentStep(3)}>
              Next: Source address <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 3 */}
      {currentStep === 3 && (
        <div
          onKeyDown={(event) => {
            // Enter in a step 3 field = "Next: Map fields".
            if (!isEnterSubmit(event)) return;
            event.preventDefault();
            goToStep4();
          }}
        >
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div>
            <h3 className="text-[14px] font-bold text-[#111B37]">{PROTOCOL_LABEL[protocol]} address for {targetResource?.name || 'the target'}</h3>
            <p className="text-[12px] text-[#657794]">
              {protocol === 'mqtt' && 'Topic filter used to capture sample messages. MQTT is push-based: messages are processed as they arrive.'}
              {protocol === 'http' && 'Request path on the connection base URL. The configured authentication is sent with every request.'}
              {protocol === 'websocket' && 'The collector keeps one connection to the stream URL; fields are picked from the frames in the next step.'}
              {protocol === 'opcua' && 'Nodes are read in one batch per cycle. Node IDs are entered or browsed in the next step.'}
              {protocol === 'modbus' && 'Unit ID of this machine and the poll interval. Registers are defined in the next step.'}
            </p>
          </div>

          {protocol === 'mqtt' && (
            <div className="space-y-3 text-[12px]">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={labelCls} htmlFor="wiz-topic">Topic filter*</label>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => { setMqttTopicFilter('#'); setAddressError(null); }} className="text-blue-600 hover:underline text-[11px] font-semibold">
                      Use the broker root (#)
                    </button>
                    <button type="button" disabled={discovering} onClick={() => void handleDiscoverTopics()} className="text-blue-600 hover:underline text-[11px] font-semibold disabled:opacity-50">
                      {discovering ? 'Listening 5 s…' : 'Discover topics'}
                    </button>
                  </div>
                </div>
                <input
                  id="wiz-topic"
                  type="text"
                  value={mqttTopicFilter}
                  onChange={(e) => {
                    setMqttTopicFilter(e.target.value.trim());
                    setAddressError(validateTopicFilter(e.target.value.trim()));
                    invalidateTest();
                  }}
                  placeholder="e.g. plant/line/machine/telemetry or plant/+/telemetry"
                  className={`${inputCls} font-mono ${addressError ? 'border-red-400' : ''}`}
                />
                {addressError && <p className="text-[11px] text-red-600 mt-1">{addressError}</p>}
              </div>
              {addressSuggestions.length > 0 && (
                <div>
                  <span className={labelCls}>Suggested for {targetResource?.code}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {addressSuggestions.map((t) => (
                      <button key={t} type="button" onClick={() => { setMqttTopicFilter(t); setAddressError(null); }} className={`px-2 py-0.5 rounded border font-mono text-[11px] ${mqttTopicFilter === t ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-400'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {discoverError && <p className="text-[11px] text-red-600">{discoverError}</p>}
              {discovered && discovered.length > 0 && (
                <div>
                  <span className={labelCls}>Topics seen on the broker ({discovered.length})</span>
                  <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {discovered.map((t) => (
                      <button key={t} type="button" onClick={() => { setMqttTopicFilter(t); setAddressError(null); }} className={`w-full text-left px-2 py-1 font-mono text-[11px] ${mqttTopicFilter === t ? 'bg-blue-50 font-bold' : 'hover:bg-slate-50'} ${targetResource && t.includes(targetResource.code) ? 'text-blue-800' : 'text-[#111B37]'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="max-w-xs">
                <label className={labelCls} htmlFor="wiz-qos">QoS</label>
                <select id="wiz-qos" value={mqttQos} onChange={(e) => { qosTouchedRef.current = true; setMqttQos(Number(e.target.value)); invalidateTest(); }} className={`${inputCls} bg-white`}>
                  <option value={0}>0 – at most once</option>
                  <option value={1}>1 – at least once</option>
                  <option value={2}>2 – exactly once</option>
                </select>
                {connectionQos !== null && (
                  <p className="text-[10px] text-[#657794] mt-1">
                    {mqttQos === connectionQos ? `Default QoS of the connection (${connectionQos}).` : `The connection default is ${connectionQos}; these fields use ${mqttQos}.`}
                  </p>
                )}
              </div>
            </div>
          )}

          {protocol === 'http' && (
            <div className="space-y-3 text-[12px]">
              <div>
                <label className={labelCls} htmlFor="wiz-path">Request path*</label>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-[11px] text-[#657794] truncate max-w-[260px]">{String(connDetail?.config_json?.base_url || '')}</span>
                  <input id="wiz-path" value={httpPath} onChange={(e) => { setHttpPath(e.target.value.trim()); invalidateTest(); }} placeholder="/api/v1/…" className={`${inputCls} font-mono`} />
                </div>
              </div>
              {addressSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {addressSuggestions.map((p) => (
                    <button key={p} type="button" onClick={() => setHttpPath(p)} className={`px-2 py-0.5 rounded border font-mono text-[11px] ${httpPath === p ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-400'}`}>
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {protocol === 'modbus' && (
            <div className="max-w-xs text-[12px]">
              <label className={labelCls} htmlFor="wiz-unit">Unit ID of this machine*</label>
              <input id="wiz-unit" type="number" min={0} max={247} value={modbusUnitId} onChange={(e) => { setModbusUnitId(Number(e.target.value)); invalidateTest(); }} className={`${inputCls} font-mono`} />
              <p className="text-[10px] text-[#657794] mt-1">Written into every field (overrides the connection default {String(connDetail?.config_json?.unit_id ?? '—')}).</p>
            </div>
          )}

          {isPolling && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
              <div>
                <label className={labelCls} htmlFor="wiz-interval">{protocol === 'websocket' ? 'Emit interval (ms)' : 'Poll interval (ms)'}</label>
                <input
                  id="wiz-interval"
                  type="number"
                  min={pollIntervalMin(protocol)}
                  max={86400000}
                  step={100}
                  value={Number.isFinite(intervalMs) ? intervalMs : ''}
                  onChange={(e) => {
                    setIntervalMs(e.target.value === '' ? Number.NaN : Number(e.target.value));
                    invalidateTest();
                  }}
                  aria-invalid={Boolean(intervalError)}
                  aria-describedby="wiz-interval-help"
                  className={`${inputCls} font-mono ${intervalError ? 'border-red-400 focus:border-red-500' : ''}`}
                />
                {intervalError && (
                  <p role="alert" className="text-[11px] text-red-600 mt-1">{intervalError}</p>
                )}
                <p id="wiz-interval-help" className="text-[10px] text-[#657794] mt-1">
                  This is the interval of the whole connection job, not of this machine only: every machine read through{' '}
                  <span className="font-semibold">{selectedConnection?.name || 'this connection'}</span>
                  {connectionMachineCount > 0 ? ` (${connectionMachineCount} machine${connectionMachineCount === 1 ? '' : 's'} today)` : ''} uses it.
                  {' '}Current: {currentJobInterval !== null ? `${currentJobInterval} ms` : 'not set yet'}. Allowed {pollIntervalMin(protocol)}–86 400 000 ms.
                </p>
                {intervalChanges && (
                  <p role="status" className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mt-1.5">
                    Start collecting changes the interval of {selectedConnection?.name || 'the connection'} from {formatInterval(currentJobInterval as number)} to {formatInterval(intervalMs)}
                    {connectionMachineCount > 0 ? ` for all ${connectionMachineCount} machine${connectionMachineCount === 1 ? '' : 's'} on it` : ''}.
                  </p>
                )}
              </div>
              {httpBudget && <HttpBudgetNote budget={httpBudget} />}
            </div>
          )}

          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(2)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!connDetail || Boolean(isPolling && intervalError)}
              onClick={goToStep4}
            >
              Next: Map fields <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
          {addressError && protocol !== 'mqtt' && <p className="text-[11px] text-red-600">{addressError}</p>}
        </Card>
        </div>
      )}

      {/* STEP 4 */}
      {currentStep === 4 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Map fields to signals</h3>
              <p className="text-[12px] text-[#657794]">The signal key is the raw source field name; data models refer to it. Display names are free text.</p>
            </div>
            <div className="flex items-center gap-2">
              {isJson && (
                <>
                  <Button size="sm" variant="outline" onClick={() => { setPasteError(null); setPasteOpen(true); }}>
                    <Braces className="w-3.5 h-3.5 mr-1" /> Paste sample JSON
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void handleCapture()} disabled={capturing}>
                    {capturing ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1" />}
                    {capturing ? 'Capturing…' : protocol === 'mqtt' ? 'Capture sample (10 s)' : protocol === 'http' ? 'Fetch sample' : 'Capture frames (5 s)'}
                  </Button>
                </>
              )}
              {(protocol === 'opcua' || protocol === 'modbus') && (
                <Button size="sm" variant="outline" onClick={() => void handleRunTest()} disabled={testing || fields.length === 0}>
                  <Play className={`w-3.5 h-3.5 mr-1 ${testing ? 'animate-spin' : ''}`} /> {testing ? 'Reading…' : 'Test read'}
                </Button>
              )}
            </div>
          </div>

          {collectorStarting && (capturing || browsing || testing) && (
            <p role="status" className="text-[12px] text-[#134074] bg-[#EEF5FF] border border-[#D2E3FA] rounded-lg px-3 py-2">{COLLECTOR_STARTING_MESSAGE}</p>
          )}
          {captureError && <p role="alert" className="text-[12px] text-red-600">{captureError}</p>}

          {isJson && samples.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3 bg-slate-50 border border-slate-200 rounded-xl">
              <div className="space-y-1.5">
                <span className="text-[11px] font-bold uppercase text-[#657794] block">{protocol === 'mqtt' ? 'Captured topics' : 'Samples'}</span>
                {samples.map((s, index) => (
                  <button
                    key={`${s.topic}-${index}`}
                    type="button"
                    onClick={() => setSampleIndex(index)}
                    title={s.topic}
                    className={`w-full text-left p-2 rounded text-[11px] font-mono flex items-center justify-between gap-2 ${sampleIndex === index ? 'bg-blue-600 text-white font-bold' : 'bg-white hover:bg-slate-200 text-slate-800 border border-slate-200'}`}
                  >
                    <span className="truncate">{s.topic || '(pasted sample)'}</span>
                    <span className="text-[10px] opacity-80 shrink-0">{s.count} msg</span>
                  </button>
                ))}
              </div>
              <div className="md:col-span-2 space-y-1.5">
                {activeSample?.reordered && (
                  <p className="text-[10px] text-amber-700">The collector returned a parsed payload only; fields may not be in source order and whole numbers may hide decimals.</p>
                )}
                {protocol === 'mqtt' && activeSample && !activeSample.topic && (
                  <p className="text-[10px] text-amber-700">Pasted sample: enter the exact topic in each row.</p>
                )}
                {activeSample && (
                  <JsonSampleTree
                    root={activeSample.root}
                    selectedPaths={selectedPaths}
                    onPickLeaf={handlePickLeaf}
                    onPickObject={handlePickObject}
                    onClearPaths={handleClearPaths}
                  />
                )}
              </div>
            </div>
          )}

          {isJson && (
            <div className="p-3 border border-slate-200 rounded-lg text-[12px] space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <label className="font-semibold text-[#111B37]" htmlFor="wiz-ts-mode">Source time</label>
                <select id="wiz-ts-mode" value={timestampMode} onChange={(e) => { setTimestampMode(e.target.value as TimestampMode); invalidateTest(); }} className="px-2 py-1 border border-slate-300 rounded text-[12px] bg-white">
                  <option value="sibling">Sibling source_timestamp (default)</option>
                  <option value="custom">Custom JSONPath</option>
                  <option value="none">None (use read time only)</option>
                </select>
                {timestampMode === 'custom' && (
                  <input aria-label="Timestamp JSONPath" value={timestampPath} onChange={(e) => { setTimestampPath(e.target.value); invalidateTest(); }} placeholder="$.meta.updated_at" className="px-2 py-1 border border-slate-300 rounded text-[12px] font-mono w-full sm:w-auto sm:min-w-[240px]" />
                )}
              </div>
              <p className="text-[11px] text-[#657794]">
                The source time is shown as "Last change"; the read time is always the clock for history.{' '}
                {timestampMode === 'sibling' && siblingTsInfo}
              </p>
            </div>
          )}

          {protocol === 'opcua' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-2 text-[12px]">
                <label className={labelCls} htmlFor="wiz-nodes">Node IDs (one per line)</label>
                <textarea id="wiz-nodes" rows={6} value={nodeText} onChange={(e) => setNodeText(e.target.value)} placeholder={'ns=2;s=Device.Group.field_1\nns=2;s=Device.Group.field_2'} className="w-full p-2 font-mono text-[11px] border border-slate-300 rounded" />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleAddNodeIds} disabled={!nodeText.trim()}>
                    Add nodes
                  </Button>
                  {nodeMessage && <span className="text-[11px] text-[#657794]">{nodeMessage}</span>}
                </div>
                <div className="pt-2">
                  <label className={labelCls} htmlFor="wiz-ts-node">Source time</label>
                  <input id="wiz-ts-node" value={opcTimestampNodeId} onChange={(e) => { setOpcTimestampNodeId(e.target.value.trim()); invalidateTest(); }} placeholder="Empty = DataValue.SourceTimestamp of each node" className={`${inputCls} font-mono`} />
                  <p className="text-[10px] text-[#657794] mt-1">Optional node holding the group timestamp; read in the same batch.</p>
                </div>
              </div>
              <div className="space-y-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className={labelCls}>Browse the server</span>
                  <Button size="sm" variant="outline" disabled={browsing} onClick={() => void browse('i=85', 'Objects', false)}>
                    {browsing ? 'Browsing…' : 'Browse Objects'}
                  </Button>
                </div>
                {browseStack.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-[11px]">
                    {browseStack.map((crumb, index) => (
                      <button key={`${crumb.nodeId}-${index}`} type="button" onClick={() => { setBrowseStack(browseStack.slice(0, index)); void browse(crumb.nodeId, crumb.label, true); }} className="text-blue-600 hover:underline font-mono">
                        {crumb.label} /
                      </button>
                    ))}
                  </div>
                )}
                {browseError && <p className="text-[11px] text-red-600">{browseError}</p>}
                {browseNodes && browseNodes.some((node) => node.node_class.toLowerCase().includes('variable')) && (() => {
                  const variables = browseNodes.filter((node) => node.node_class.toLowerCase().includes('variable'));
                  const pending = variables.filter((node) => !fields.some((row) => row.nodeId === node.node_id) && node.node_id !== opcTimestampNodeId);
                  const addedHere = variables.filter((node) => fields.some((row) => row.nodeId === node.node_id));
                  const folder = browseStack[browseStack.length - 1]?.label || 'this folder';
                  return (
                    <div role="toolbar" aria-label={`Variables in ${folder}`} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className="text-[#657794]" aria-live="polite">
                        <span className="font-semibold text-[#111B37]">{addedHere.length}</span> of {variables.length} variable(s) in {folder} selected
                      </span>
                      <span className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={addedHere.length === 0}
                        onClick={() => {
                          const drop = new Set(addedHere.map((node) => node.node_id));
                          setFields((prev) => prev.filter((row) => !(row.nodeId && drop.has(row.nodeId))));
                          invalidateTest();
                        }}
                        aria-label={`Clear the ${addedHere.length} selected variables of ${folder}`}
                        className="font-semibold text-slate-600 hover:underline disabled:text-slate-400 disabled:no-underline"
                      >
                        Clear all
                      </button>
                      <button
                        type="button"
                        disabled={pending.length === 0}
                        onClick={() => {
                          const added: FieldRow[] = [];
                          let tsNode = '';
                          pending.forEach((node) => {
                            const field = nodeIdField(node.node_id) || node.browse_name;
                            // A variable named source_timestamp is the group timestamp, not a signal.
                            if (field === 'source_timestamp' && !opcTimestampNodeId.trim()) {
                              tsNode = node.node_id;
                              return;
                            }
                            const key = keyFromRawName(field);
                            added.push(emptyRow('opcua', { key, displayName: node.display_name || key, nodeId: node.node_id }));
                          });
                          if (tsNode) setOpcTimestampNodeId(tsNode);
                          setFields((prev) => [...prev, ...added]);
                          setNodeMessage(`${added.length} node(s) added.${tsNode ? ` ${tsNode} is used as the source time of every field.` : ''}`);
                          invalidateTest();
                        }}
                        className="font-semibold text-emerald-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                      >
                        {pending.length === 0 ? 'All added' : `Add all variables (${pending.length})`}
                      </button>
                      </span>
                    </div>
                  );
                })()}
                {browseNodes && browseNodes.length > 0 && (
                  <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {browseNodes.map((node) => {
                      const added = fields.some((row) => row.nodeId === node.node_id);
                      return (
                        <div key={node.node_id} className="flex items-center justify-between gap-2 px-2 py-1">
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold text-[#111B37] truncate">{node.display_name || node.browse_name}</div>
                            <div className="text-[10px] font-mono text-[#657794] truncate">{node.node_id} · {node.node_class}</div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {node.has_children && (
                              <button type="button" onClick={() => void browse(node.node_id, node.browse_name || node.node_id, true)} className="text-[11px] text-blue-600 hover:underline">
                                Open
                              </button>
                            )}
                            {node.node_class.toLowerCase().includes('variable') && (
                              <button
                                type="button"
                                aria-pressed={added}
                                aria-label={`${added ? 'Remove' : 'Add'} variable ${node.display_name || node.browse_name}`}
                                onClick={() => {
                                  // Toggle, like the JSON tree: a second click removes the field again.
                                  if (added) setFields((prev) => prev.filter((row) => row.nodeId !== node.node_id));
                                  else {
                                    const key = keyFromRawName(nodeIdField(node.node_id) || node.browse_name);
                                    setFields((prev) => [...prev, emptyRow('opcua', { key, displayName: node.display_name || key, nodeId: node.node_id })]);
                                  }
                                  invalidateTest();
                                }}
                                className={`text-[11px] hover:underline ${added ? 'text-slate-600' : 'text-emerald-700'}`}
                              >
                                {added ? 'Remove' : 'Add'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {protocol === 'modbus' && (
            <div className="space-y-2 text-[12px]">
              <label className={labelCls} htmlFor="wiz-map">Paste a register map (one field per line: name, type, offset[, count][, unit])</label>
              <textarea
                id="wiz-map"
                rows={5}
                value={mapText}
                onChange={(e) => setMapText(e.target.value)}
                placeholder={'field_a, uint16, 100\nfield_b, float32, 102-103, rpm\nlabel, ascii, 104-111\nsource_timestamp, uint64, 112-115'}
                className="w-full p-2 font-mono text-[11px] border border-slate-300 rounded"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleAddRegisterMap} disabled={!mapText.trim()}>
                  Add fields from map
                </Button>
                {mapMessage && <span className="text-[11px] text-[#657794]">{mapMessage}</span>}
              </div>
              <p className="text-[10px] text-[#657794]">
                Offsets are 0-based PDU addresses (FC03 holding register 0 = 40001). Types: bool, uint16, int16, uint32, int32, uint64, int64, float32, float64, ascii.
                Mark the uint64 epoch-ms field as "Source ts" to use it as the source time of the other fields of this unit.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-bold text-[#111B37]">Fields ({fields.length})</span>
              <span className="flex items-center gap-2">
              {fields.length > 1 && (
                <Button size="sm" variant="ghost" className="text-[11px] h-7" onClick={() => setClearFieldsOpen(true)}>
                  Remove all
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="text-[11px] h-7"
                onClick={() => {
                  setFields((prev) => [
                    ...prev,
                    emptyRow(protocol, {
                      topic: protocol === 'mqtt' ? activeSample?.topic || (/[#+]/.test(mqttTopicFilter) ? '' : mqttTopicFilter) : undefined,
                      path: protocol === 'http' ? httpPath : undefined,
                      jsonpath: isJson ? '$.' : undefined,
                    }),
                  ]);
                  invalidateTest();
                }}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add field
              </Button>
              </span>
            </div>
            {fields.length === 0 ? (
              <div className="p-8 text-center text-[#657794] border border-dashed border-slate-300 rounded-lg text-[12px]">
                {isJson ? 'Capture a sample and click fields in the tree, or add fields manually.' : protocol === 'opcua' ? 'Paste or browse node IDs.' : 'Paste a register map or add fields manually.'}
              </div>
            ) : (
              <FieldTable
                protocol={protocol}
                rows={fields}
                liveValues={liveValues}
                onChange={(rows) => {
                  setFields(rows);
                  invalidateTest();
                }}
              />
            )}
            {rowsError && <p role="alert" className="text-[12px] text-red-600">{rowsError}</p>}
          </div>

          {(protocol === 'opcua' || protocol === 'modbus') && (testing || testResult) && (
            <TestResultPanel running={testing} result={testResult} successLabel="Values read by the Edge collector are shown in the table" />
          )}
          {protocol === 'opcua' && sourceTimeValue !== null && (
            <p className="text-[12px] text-[#334568]">
              Source time node <span className="font-mono text-[11px]">{opcTimestampNodeId}</span>:{' '}
              <span className={`font-mono text-[11px] ${sourceTimeValue === 'not returned' ? 'text-slate-400' : 'text-emerald-700 font-semibold'}`}>{sourceTimeValue}</span>
            </p>
          )}

          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(3)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
            </Button>
            <Button variant="primary" size="sm" disabled={fields.length === 0} onClick={() => { if (validateCurrentRows()) setCurrentStep(5); }}>
              Next: Review <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}

      {pasteOpen && (
        <ModalPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="wiz-paste-title" className="bg-white rounded-2xl border border-slate-300 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 id="wiz-paste-title" className="text-sm font-bold text-[#111B37] flex items-center gap-2">
                <Braces className="w-4 h-4 text-blue-600" /> Paste a sample payload
              </h3>
              <button type="button" aria-label="Close" onClick={() => setPasteOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-[#657794]">Field order and number formatting are kept as pasted. Values are only used to suggest types.</p>
            <textarea rows={10} value={pasteText} onChange={(e) => setPasteText(e.target.value)} className="w-full p-3 font-mono text-xs border border-slate-300 rounded-xl" aria-label="Sample JSON" />
            {pasteError && <p className="text-xs text-red-600 font-semibold">{pasteError}</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => setPasteOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleApplyPaste} disabled={!pasteText.trim()}>
                Show fields
              </Button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}

      {/* STEP 5 */}
      {currentStep === 5 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div>
            <h3 className="text-[14px] font-bold text-[#111B37]">Review and start collecting</h3>
            <p className="text-[12px] text-[#657794]">The Edge collector reads the real source to verify the mapping.</p>
          </div>

          <dl className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-[12px] divide-y divide-slate-200">
            {[
              ['Target', targetPathString],
              ['Connection', `${selectedConnection?.name || '—'} (${PROTOCOL_LABEL[protocol]})`],
              ...(protocol === 'mqtt' ? [['Topic filter', mqttTopicFilter]] : []),
              ...(protocol === 'http' ? [['Path', httpPath]] : []),
              ...(protocol === 'modbus' ? [['Unit ID', String(modbusUnitId)]] : []),
              ...(isPolling
                ? [[
                    protocol === 'websocket' ? 'Emit interval (whole connection)' : 'Poll interval (whole connection)',
                    intervalChanges ? `${intervalMs} ms (changes from ${currentJobInterval} ms)` : `${intervalMs} ms`,
                  ]]
                : []),
              ['Fields', `${fields.length}${rewrites.length ? ` (+ ${rewrites.length * fields.length} on ${rewrites.length} similar machine(s))` : ''}`],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 py-1.5">
                <dt className="text-[#657794]">{label}</dt>
                <dd className="font-medium text-[#111B37] font-mono text-right break-all">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-[13px] font-bold text-[#111B37]">Similar machines</h4>
              <Button size="sm" variant="outline" disabled={!targetResource || similarCandidates.length === 0} onClick={() => setSimilarOpen(true)}>
                {rewrites.length ? 'Edit machines…' : 'Apply to similar machines…'}
              </Button>
            </div>
            {similarCandidates.length === 0 && <p className="text-[11px] text-[#657794]">No other {targetResource?.type} in this site.</p>}
            {httpBudget && (httpBudget.over || rewrites.length > 0) && <HttpBudgetNote budget={httpBudget} />}
            {rewrites.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {rewriteRows.map(({ rw, problems }) => (
                  <span key={rw.resourceId} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${problems.length ? 'border-red-300 bg-red-50 text-red-800' : 'border-slate-200 bg-white'}`}>
                    {rw.resourceName}
                    <button type="button" aria-label={`Remove ${rw.resourceName}`} onClick={() => setRewrites((prev) => prev.filter((r) => r.resourceId !== rw.resourceId))} className="text-slate-400 hover:text-red-600">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <h4 className="text-[13px] font-bold text-[#111B37]">Live verification on {targetResource?.name}</h4>
              <Button size="sm" variant="outline" onClick={() => void handleRunTest()} disabled={testing}>
                <Play className={`w-3.5 h-3.5 mr-1 ${testing ? 'animate-spin' : ''}`} />
                {testing ? 'Running test…' : 'Run test'}
              </Button>
            </div>
            <TestResultPanel running={testing} runningLabel="The Edge collector is reading the source…" result={testResult} successLabel="All fields were read from the source" />
            {testResult && (
              <div className="border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-[11px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[#657794] font-semibold">
                      <th className="py-2 px-3">Key</th>
                      <th className="py-2 px-3">Address</th>
                      <th className="py-2 px-3">Value read</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {fields.map((row) => (
                      <tr key={row.id}>
                        <td className="py-1.5 px-3 font-semibold text-[#111B37]">{row.key}</td>
                        <td className="py-1.5 px-3 text-[#657794] break-all">{buildAddressSummary(row, protocol)}</td>
                        <td className={`py-1.5 px-3 break-all ${liveValues[row.id] !== undefined ? 'text-emerald-700' : 'text-slate-400'}`}>{liveValues[row.id] ?? 'not returned'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {testResult && !testPassed && (
              <label className="flex items-start gap-2 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2">
                <input type="checkbox" checked={acceptUntested} onChange={(e) => setAcceptUntested(e.target.checked)} className="mt-0.5" />
                <span>Start collecting anyway. Signals will show Bad or No data until the source can be read; check the error above first.</span>
              </label>
            )}
          </div>

          {submitError && <p role="alert" className="text-[12px] text-red-600">{submitError}</p>}
          {outcomes && (
            <ul className="text-[12px] space-y-1">
              {outcomes.map((o) => (
                <li key={o.resourceId} className={o.ok ? 'text-emerald-700' : 'text-red-700'}>
                  {o.ok ? '✓' : '✗'} {o.name}: {o.message}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap justify-between gap-2 pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(4)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to fields
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {!canStart && !submitting && (
                <span id="wiz-start-hint" className="text-[11px] text-[#657794] text-right">
                  {isPolling && intervalError
                    ? `Fix the interval in step 3: ${intervalError}`
                    : testing
                    ? 'Waiting for the test result…'
                    : !testResult
                      ? 'Run the test first.'
                      : 'The test failed: fix the fields, or tick "Start collecting anyway".'}
                </span>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={!canStart}
                aria-describedby={!canStart && !submitting ? 'wiz-start-hint' : undefined}
                onClick={() => void handleStartCollecting()}
              >
                {submitting ? 'Starting collection…' : 'Start collecting'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {targetResource && (
        <SimilarResourcesDialog
          isOpen={similarOpen}
          protocol={protocol}
          source={targetResource}
          candidates={similarCandidates}
          rows={fields}
          settings={settings}
          sourceUnitId={modbusUnitId}
          initial={rewrites}
          onCancel={() => setSimilarOpen(false)}
          onConfirm={(next) => {
            setRewrites(next);
            setSimilarOpen(false);
          }}
        />
      )}

      <ConnectionFormModal
        isOpen={isConnFormOpen}
        onClose={() => setIsConnFormOpen(false)}
        edges={edges}
        defaultSiteId={targetSiteId || undefined}
        onSuccess={(saved) => {
          void refresh();
          if (saved) {
            if (saved.protocol !== protocol) {
              setFields([]);
              setRewrites([]);
            }
            setNewConnCreated(saved);
            setSelectedConnectionId(saved.id);
            setSamples([]);
            setDiscovered(null);
            invalidateTest();
          }
        }}
      />

      <ConfirmDialog
        isOpen={clearFieldsOpen}
        title={`Remove all ${fields.length} fields?`}
        message="The mapped fields of this wizard are removed. Captured samples stay, so you can select fields again."
        confirmText="Remove all"
        variant="warning"
        onConfirm={() => {
          setFields([]);
          invalidateTest();
          setClearFieldsOpen(false);
        }}
        onCancel={() => setClearFieldsOpen(false)}
      />

      <ConfirmDialog
        isOpen={Boolean(leaveGuard.pending)}
        title="Leave Add Data?"
        message={(() => {
          const parts = [
            targetResource ? targetResource.name || targetResource.code : '',
            selectedConnection?.name || '',
            fields.length ? `${fields.length} mapped field${fields.length === 1 ? '' : 's'}` : '',
          ].filter(Boolean);
          return `The settings of this wizard are not saved yet${parts.length ? ` (${parts.join(', ')})` : ''}. If you leave, they are discarded and nothing is collected.`;
        })()}
        confirmText="Leave and discard"
        cancelText="Stay"
        variant="warning"
        onConfirm={confirmLeave}
        onCancel={leaveGuard.cancel}
      />

      {confirmCancelOpen && (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div role="dialog" aria-modal="true" aria-labelledby="wiz-cancel-title" className="w-full max-w-sm max-h-[90vh] overflow-y-auto p-5 bg-white border border-slate-300 shadow-xl rounded-xl space-y-4">
            <h3 id="wiz-cancel-title" className="text-[14px] font-bold text-[#111B37]">Keep the new connection "{newConnCreated?.name}"?</h3>
            <p className="text-[12px] text-[#657794]">You created it in step 2. Keep it in Connections or archive it.</p>
            {cancelError && <p role="alert" className="text-[12px] text-red-600">{cancelError}</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => void handleDiscardNewConn(false)}>
                Archive connection
              </Button>
              <Button variant="primary" size="sm" onClick={() => void handleDiscardNewConn(true)}>
                Keep connection
              </Button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}
    </div>
  );
};

/** Request budget of the whole HTTP connection after this wizard (R2-CN-04). */
const HttpBudgetNote: React.FC<{ budget: ReturnType<typeof rateBudget> & { existing: number } }> = ({ budget }) => (
  <div
    role={budget.over ? 'alert' : undefined}
    className={`p-2.5 rounded-lg border text-[11px] self-start ${budget.over ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-slate-50 border-slate-200 text-[#657794]'}`}
  >
    {budget.existing > 0 && (
      <span className="block font-semibold mb-0.5">
        Connection total: {budget.existing} path(s) already bound + {Math.max(budget.paths - budget.existing, 0)} added by this wizard.
      </span>
    )}
    {budget.message}
  </div>
);

function buildAddressSummary(row: FieldRow, protocol: ProtocolType): string {
  switch (protocol) {
    case 'mqtt':
      return `${row.topic} ${row.jsonpath}`;
    case 'http':
      return `GET ${row.path} ${row.jsonpath}`;
    case 'websocket':
      return row.jsonpath || '';
    case 'opcua':
      return row.nodeId || '';
    default:
      return `${row.registerArea || 'holding'} ${row.offset} ${row.nativeType}`;
  }
}
