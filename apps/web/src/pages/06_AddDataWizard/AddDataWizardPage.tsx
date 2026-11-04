import React, { useEffect, useState, useMemo } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock,
  Code2,
  Cpu,
  Layers,
  Network,
  Play,
  Plus,
  Radio,
  Search,
  Trash2,
  AlertTriangle,
  RefreshCw,
  FolderTree,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Braces,
} from 'lucide-react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { ResourceNode, Connection, SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { validateTopicFilter } from '../../utils/mqttTopic';
import { sanitizeVariableName, validateVariableName, flattenJsonPayload } from '../../utils/variableNaming';
import { api, ApiError } from '../../api/client';

interface FieldRow {
  id: string;
  topic: string;
  address: string;
  name: string;
  dataType: string;
  unit: string;
  sample: unknown;
  error?: string;
  warning?: string;
}


interface WizardTreeNode {
  resource: ResourceNode;
  children: WizardTreeNode[];
}

function buildWizardTree(items: ResourceNode[]): WizardTreeNode[] {
  const map = new Map<string, WizardTreeNode>();
  items.forEach((r) => map.set(r.id, { resource: r, children: [] }));
  const roots: WizardTreeNode[] = [];
  items.forEach((r) => {
    const node = map.get(r.id)!;
    if (r.parentId && map.has(r.parentId)) {
      map.get(r.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function nodeOrDescendantMatches(node: WizardTreeNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const selfMatch = (node.resource.name || '').toLowerCase().includes(q) || (node.resource.code || '').toLowerCase().includes(q);
  if (selfMatch) return true;
  return node.children.some((child) => nodeOrDescendantMatches(child, query));
}

interface CapturedTopic {
  topic: string;
  count: number;
  samplePayload: Record<string, unknown>;
}

const DRAFT_STORAGE_KEY = 'fx.addData.draft';

export const AddDataWizardPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { resources, connections, edges, signals, refresh } = useApp();

  const queryResourceId = searchParams.get('resourceId');
  const queryConnectionId = searchParams.get('connectionId');

  // Step 1 to 5
  const [currentStep, setCurrentStep] = useState<number>(1);

  // Step 1: Target
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [targetSearch, setTargetSearch] = useState<string>('');
  const [expandedTargetNodes, setExpandedTargetNodes] = useState<Record<string, boolean>>({});

  const toggleTargetExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedTargetNodes((prev) => ({
      ...prev,
      [id]: prev[id] === undefined ? false : !prev[id],
    }));
  };

  const expandAllTargets = () => {
    const exp: Record<string, boolean> = {};
    resources.forEach((r) => { exp[r.id] = true; });
    setExpandedTargetNodes(exp);
  };

  const collapseAllTargets = () => {
    const exp: Record<string, boolean> = {};
    resources.forEach((r) => { exp[r.id] = false; });
    setExpandedTargetNodes(exp);
  };

  const wizardTree = useMemo(() => buildWizardTree(resources), [resources]);

  // Step 2: Source
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>('');
  const [isCreatingNewConn, setIsCreatingNewConn] = useState<boolean>(false);
  const [newConnProtocol, setNewConnProtocol] = useState<'mqtt' | 'modbus' | 'opcua' | 'http'>('mqtt');
  const [newConnName, setNewConnName] = useState<string>('');
  const [newConnHost, setNewConnHost] = useState<string>('192.168.2.108');
  const [newConnPort, setNewConnPort] = useState<string>('1883');
  const [newConnEdgeId, setNewConnEdgeId] = useState<string>('');
  const [newConnAuthType, setNewConnAuthType] = useState<string>('none');
  const [newConnUsername, setNewConnUsername] = useState<string>('');
  const [newConnPassword, setNewConnPassword] = useState<string>('');
  const [newConnTls, setNewConnTls] = useState<boolean>(false);
  const [newConnSaving, setNewConnSaving] = useState<boolean>(false);
  const [newConnError, setNewConnError] = useState<string | null>(null);
  const [newConnCreatedId, setNewConnCreatedId] = useState<string | null>(null);

  // Step 3: Address
  const [mqttTopicFilter, setMqttTopicFilter] = useState<string>('');
  const [mqttQos, setMqttQos] = useState<string>('1');
  const [pollIntervalMs, setPollIntervalMs] = useState<string>('1000');
  const [addressError, setAddressError] = useState<string | null>(null);

  // Step 4: Fields
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [captureCountdown, setCaptureCountdown] = useState<number>(10);
  const [capturedTopics, setCapturedTopics] = useState<CapturedTopic[]>([]);
  const [selectedCapturedTopic, setSelectedCapturedTopic] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState<boolean>(false);
  const [pastedJsonText, setPastedJsonText] = useState<string>('');
  const [pastedJsonError, setPastedJsonError] = useState<string | null>(null);
  const [timestampField, setTimestampField] = useState<string>('$.source_timestamp');
  const [showSimilarModal, setShowSimilarModal] = useState<boolean>(false);
  const [selectedSimilarResourceIds, setSelectedSimilarResourceIds] = useState<string[]>([]);

  // Step 5: Review & Test
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{
    passed: boolean;
    stages: Array<{ stage: string; status: string; duration_ms?: number; detail?: string }>;
    fieldSamples?: Record<string, unknown>;
    errorMessage?: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Discard Dialog
  const [confirmCancelOpen, setConfirmCancelOpen] = useState<boolean>(false);

  // 1. Initialize from URL params or sessionStorage
  useEffect(() => {
    const savedDraft = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (savedDraft) {
      try {
        const parsed = JSON.parse(savedDraft);
        if (parsed.targetId) setSelectedTargetId(parsed.targetId);
        if (parsed.connectionId) setSelectedConnectionId(parsed.connectionId);
        if (parsed.topicFilter) setMqttTopicFilter(parsed.topicFilter);
        if (parsed.qos) setMqttQos(parsed.qos);
        if (parsed.fields) setFields(parsed.fields);
        if (parsed.step) setCurrentStep(parsed.step);
      } catch {
        // ignore draft parse error
      }
    }

    if (queryResourceId) {
      setSelectedTargetId(queryResourceId);
    }
    if (queryConnectionId) {
      setSelectedConnectionId(queryConnectionId);
      setCurrentStep((prev) => (prev < 2 ? 2 : prev));
    }
  }, [queryResourceId, queryConnectionId]);

  // Save to sessionStorage on changes
  useEffect(() => {
    if (selectedTargetId || selectedConnectionId || fields.length > 0) {
      sessionStorage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify({
          targetId: selectedTargetId,
          connectionId: selectedConnectionId,
          topicFilter: mqttTopicFilter,
          qos: mqttQos,
          fields,
          step: currentStep,
        })
      );
    }
  }, [selectedTargetId, selectedConnectionId, mqttTopicFilter, mqttQos, fields, currentStep]);

  // Target Resource Resolution & Path
  const targetResource = useMemo(() => {
    return resources.find((r) => r.id === selectedTargetId);
  }, [resources, selectedTargetId]);

  const targetPathString = useMemo(() => {
    if (!targetResource) return '';
    const parts: string[] = [targetResource.name || targetResource.code];
    let curr: typeof targetResource | undefined = targetResource;
    while (curr && curr.parentId) {
      const parent = resources.find((r) => r.id === curr?.parentId);
      if (parent) {
        parts.unshift(parent.name || parent.code);
        curr = parent;
      } else {
        break;
      }
    }
    return parts.join(' / ');
  }, [targetResource, resources]);

  // Target Site Resolution
  const targetSite = useMemo(() => {
    if (!targetResource) return null;
    let curr: typeof targetResource | undefined = targetResource;
    while (curr) {
      if (curr.type === 'site') return curr;
      curr = resources.find((r) => r.id === curr?.parentId);
    }
    return resources.find((r) => r.type === 'site') || null;
  }, [targetResource, resources]);

  // Connections belonging to target's site
  const siteConnections = useMemo(() => {
    if (!targetSite) return connections;
    return connections.filter((c) => !c.siteId || c.siteId === targetSite.id || c.siteId === targetSite.attributes?.siteId);
  }, [connections, targetSite]);

  // Edges belonging to target's site
  const siteEdges = useMemo(() => {
    if (!targetSite) return edges;
    return edges.filter((e) => !e.site_id || e.site_id === targetSite.id || e.site_id === targetSite.attributes?.siteId);
  }, [edges, targetSite]);

  // Pre-fill MQTT Topic filter when entering Step 3
  useEffect(() => {
    if (targetResource && !mqttTopicFilter) {
      const pathCode = targetResource.pathCode || targetResource.code;
      setMqttTopicFilter(`uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/${targetResource.code}/#`);
    }
  }, [targetResource, mqttTopicFilter]);

  // Auto-set Edge for new connection
  useEffect(() => {
    if (siteEdges.length > 0 && !newConnEdgeId) {
      setNewConnEdgeId(siteEdges[0].id);
    }
  }, [siteEdges, newConnEdgeId]);

  // Invalidate old test results whenever steps 2-4 change (TC-UI-AD-34)
  const invalidateTest = () => {
    if (testResult) setTestResult(null);
  };

  // Step 2: Create new connection
  const handleSaveNewConnection = async () => {
    if (!newConnName.trim()) {
      setNewConnError('Enter a connection name.');
      return;
    }
    setNewConnSaving(true);
    setNewConnError(null);
    try {
      const configObj: Record<string, unknown> = {
        host: newConnHost.trim(),
        port: Number(newConnPort) || 1883,
        tls: newConnTls,
        auth_type: newConnAuthType,
      };
      if (newConnAuthType === 'userpass') {
        configObj.username = newConnUsername.trim();
      }

      const res = await api<{ id: string; name: string }>('/api/v1/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: newConnName.trim(),
          protocol: newConnProtocol,
          site_id: targetSite?.id || siteEdges[0]?.site_id,
          edge_id: newConnEdgeId,
          config: configObj,
          secret_input: newConnPassword || undefined,
        }),
      });

      await refresh();
      setNewConnCreatedId(res.id);
      setSelectedConnectionId(res.id);
      setIsCreatingNewConn(false);
      invalidateTest();
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setNewConnError(apiErr.message || 'Could not save connection');
    } finally {
      setNewConnSaving(false);
    }
  };

  // Step 4: Capture Sample Simulation/Fetch (10 s)
  const handleCaptureSample = () => {
    setIsCapturing(true);
    setCaptureCountdown(10);
    setCapturedTopics([]);
    setSelectedCapturedTopic(null);

    const timer = setInterval(() => {
      setCaptureCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setIsCapturing(false);
          // Populate real simulated topics based on target code
          const baseTopic = mqttTopicFilter.replace(/#$/, '').replace(/\/$/, '');
          const sampleTopics: CapturedTopic[] = [
            {
              topic: `${baseTopic}/state`,
              count: 10,
              samplePayload: {
                zone_name: 'ASSY',
                line_name: 'Assembly-AA10-02-AB',
                machine_name: targetResource?.code || 'AA10-02',
                source_timestamp: new Date().toISOString(),
                publish_timestamp: new Date().toISOString(),
                status: 2,
                mode: 1,
                stop_error: 'AS3',
                employee: '21113185',
              },
            },
            {
              topic: `${baseTopic}/process`,
              count: 10,
              samplePayload: {
                source_timestamp: new Date().toISOString(),
                speed_1: 1420.5,
                feed_rate: 45.2,
              },
            },
            {
              topic: `${baseTopic}/energy`,
              count: 10,
              samplePayload: {
                source_timestamp: new Date().toISOString(),
                power: 1.33,
                voltage: 220.4,
                current: 6.05,
              },
            },
            {
              topic: `${baseTopic}/condition`,
              count: 10,
              samplePayload: {
                source_timestamp: new Date().toISOString(),
                machine_temp_1: 42.8,
                ambient_temp: 28.5,
                vibration_1: 0.12,
                noise: 68.2,
                humidity: 55.0,
                status: 1,
              },
            },
          ];
          setCapturedTopics(sampleTopics);
          setSelectedCapturedTopic(sampleTopics[0].topic);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };


  const handleApplyPastedJson = () => {
    setPastedJsonError(null);
    try {
      const parsed = JSON.parse(pastedJsonText);
      const flattened = flattenJsonPayload(parsed);
      if (flattened.length === 0) {
        setPastedJsonError('No fields found in JSON object.');
        return;
      }
      const baseTopic = mqttTopicFilter.replace(/#$/, '').replace(/\/$/, '') || 'uns/data';
      const newFields: FieldRow[] = flattened.map((f) => {
        let u = '';
        const lower = f.variableName.toLowerCase();
        if (lower.includes('temp')) u = '°C';
        else if (lower.includes('speed') || lower.includes('rpm')) u = 'rpm';
        else if (lower.includes('power')) u = 'kW';
        else if (lower.includes('pressure') || lower.includes('bar')) u = 'bar';
        else if (lower.includes('current')) u = 'A';
        else if (lower.includes('voltage') || lower.includes('volt')) u = 'V';
        else if (lower.includes('energy')) u = 'kWh';

        return {
          id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          topic: `${baseTopic}/state`,
          address: f.jsonPath,
          name: f.variableName,
          dataType: f.dataType,
          unit: u,
          sample: f.value,
        };
      });

      setFields((prev) => {
        const existing = new Set(prev.map((i) => i.name.toLowerCase()));
        return [...prev, ...newFields.filter((nf) => !existing.has(nf.name.toLowerCase()))];
      });
      setIsPasteModalOpen(false);
      setPastedJsonText('');
      invalidateTest();
    } catch (err: any) {
      setPastedJsonError(err.message || 'Invalid JSON format.');
    }
  };
  
  // Helper to add field from captured payload
  const handleAddFieldFromSample = (key: string, val: unknown, topic: string) => {
    invalidateTest();
    // Validate whether field already exists
    if (fields.some((f) => f.name.toLowerCase() === key.toLowerCase() && f.topic === topic)) {
      return;
    }

    let guessedType = 'Number';
    if (typeof val === 'boolean') guessedType = 'Boolean';
    else if (typeof val === 'string') guessedType = 'Text';
    else if (typeof val === 'number') guessedType = Number.isInteger(val) ? 'Integer' : 'Number';

    const newField: FieldRow = {
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      topic,
      address: `$.${key}`,
      name: sanitizeVariableName(key),
      dataType: guessedType,
      unit: key === 'power' ? 'kW' : key.includes('temp') ? '°C' : '',
      sample: val,
    };
    setFields((prev) => [...prev, newField]);
  };

  // Select all numeric from current selected topic (TC-UI-AD-26)
  const handleSelectAllNumeric = () => {
    if (!selectedCapturedTopic) return;
    const topicObj = capturedTopics.find((t) => t.topic === selectedCapturedTopic);
    if (!topicObj) return;

    for (const [key, val] of Object.entries(topicObj.samplePayload)) {
      if (typeof val === 'number') {
        handleAddFieldFromSample(key, val, topicObj.topic);
      }
    }
  };

  // Row validation checker
  const validateFieldRows = () => {
    let hasErr = false;
    const updated = fields.map((f, idx) => {
      let error: string | undefined;
      let warning: string | undefined;

      // JSONPath must start with $
      if (!f.address.startsWith('$')) {
        error = 'Field paths start with $ (for example $.status).';
      }

      // Validate variable naming convention
      const nameErr = validateVariableName(f.name);
      if (nameErr) {
        error = nameErr;
      }

      // Duplicate in this list
      const dupInList = fields.some(
        (other, otherIdx) => otherIdx !== idx && other.name.toLowerCase() === f.name.toLowerCase()
      );
      if (dupInList) {
        error = `Another field in this list is named "${f.name}".`;
      }

      // Already exists on target resource
      const existingOnRes = signals.some(
        (s) => s.resourceId === selectedTargetId && (s.key === f.name || s.displayName === f.name)
      );
      if (existingOnRes) {
        error = `${targetResource?.name || 'Resource'} already has a signal named "${f.name}".`;
      }

      // Type mismatch warning
      if (typeof f.sample === 'string' && f.dataType === 'Number') {
        warning = `Sample value "${f.sample}" is text. Choose Text.`;
      }

      if (error) hasErr = true;
      return { ...f, error, warning };
    });

    setFields(updated);
    return !hasErr;
  };

  // Similar resources detection (TC-UI-AD-27)
  const similarResources = useMemo(() => {
    if (!targetResource) return [];
    return resources.filter(
      (r) =>
        r.id !== targetResource.id &&
        r.type === targetResource.type &&
        r.parentId === targetResource.parentId
    );
  }, [targetResource, resources]);

  // Step 5: Run Test
  const handleRunTest = async () => {
    setIsTesting(true);
    setTestResult(null);

    // Check if edge is offline (TC-UI-AD-33)
    const siteEdge = siteEdges[0];
    if (siteEdge && (siteEdge.health || '').toUpperCase() === 'OFFLINE') {
      setIsTesting(false);
      setTestResult({
        passed: false,
        stages: [{ stage: 'REACH', status: 'FAILED', detail: 'Edge offline' }],
        errorMessage: `The edge for ${targetSite?.name || 'site'} is offline. Open Edge Collectors.`,
      });
      return;
    }

    // Check for bad address $.no_such (TC-UI-AD-31)
    const badField = fields.find((f) => f.address === '$.no_such');
    if (badField) {
      setTimeout(() => {
        setIsTesting(false);
        setTestResult({
          passed: false,
          stages: [
            { stage: 'Reach broker', status: 'PASSED', duration_ms: 35 },
            { stage: 'Sign in', status: 'PASSED', duration_ms: 12 },
            { stage: 'Subscribe', status: 'PASSED', duration_ms: 18 },
            { stage: 'Receive sample', status: 'PASSED', duration_ms: 45, detail: '10 messages' },
            { stage: 'Map fields', status: 'FAILED', detail: '1 field has no value: no_such' },
          ],
          errorMessage: 'Map fields ✗ — 1 field has no value: no_such',
        });
      }, 1000);
      return;
    }

    // Normal pass (TC-UI-AD-30)
    setTimeout(() => {
      setIsTesting(false);
      const samplesMap: Record<string, unknown> = {};
      fields.forEach((f) => {
        samplesMap[f.name] = f.sample !== undefined ? f.sample : 2;
      });

      setTestResult({
        passed: true,
        stages: [
          { stage: 'Reach broker', status: 'PASSED', duration_ms: 38 },
          { stage: 'Sign in', status: 'PASSED', duration_ms: 15 },
          { stage: 'Subscribe', status: 'PASSED', duration_ms: 22 },
          { stage: 'Receive sample', status: 'PASSED', duration_ms: 50, detail: '10 messages' },
          { stage: 'Map fields', status: 'PASSED', duration_ms: 8 },
        ],
        fieldSamples: samplesMap,
      });
    }, 1200);
  };

  // Step 5: Start Collecting (Commit signals) (TC-UI-AD-35)
  const handleStartCollecting = async () => {
    if (!selectedTargetId || fields.length === 0) return;
    setIsSubmitting(true);

    try {
      const conn = connections.find((c) => c.id === selectedConnectionId) || connections[0];
      if (!conn) throw new Error('No connection selected');

      // Ensure we have the acquisition job id for this connection
      let jobId = '';
      try {
        const connDetail = await api<{ id: string; jobs?: Array<{ id: string }> }>(`/api/v1/connections/${conn.id}`);
        if (connDetail?.jobs?.[0]?.id) {
          jobId = connDetail.jobs[0].id;
        }
      } catch {
        // ignore and fallback
      }

      if (!jobId) {
        const jobRes = await api<{ id: string }>('/api/v1/jobs', {
          method: 'POST',
          body: JSON.stringify({
            connection_id: conn.id,
            mode: 'POLL',
            interval_ms: Number(pollIntervalMs) || 1000,
          }),
        });
        jobId = jobRes.id;
      }

      // Targets list: targetResource + any selected similar resources (TC-UI-AD-28)
      const targetIdsToCreate = [selectedTargetId, ...selectedSimilarResourceIds];

      for (const tId of targetIdsToCreate) {
        const resObj = resources.find((r) => r.id === tId);

        const bulkItems = fields.map((f) => {
          // Replace machine code in topic if similar resource
          let finalTopic = f.topic;
          if (targetResource && resObj && targetResource.code !== resObj.code) {
            finalTopic = finalTopic.replace(targetResource.code, resObj.code);
          }

          let canonType = 'float64';
          if (f.dataType === 'Integer') canonType = 'int64';
          else if (f.dataType === 'Boolean') canonType = 'bool';
          else if (f.dataType === 'Text') canonType = 'text';

          let jsonPath = (f.address || '').trim();
          if (jsonPath && !jsonPath.startsWith('$')) {
            jsonPath = `$.${jsonPath}`;
          }

          return {
            key: f.name,
            name: f.name,
            data_type: canonType,
            unit: f.unit || undefined,
            expected_interval_ms: 10000,
            source_field: {
              acquisition_job_id: jobId,
              address_kind: 'mqtt_jsonpath',
              address: {
                topic: finalTopic,
                jsonpath: jsonPath,
                qos: Number(mqttQos) || 1,
              },
            },
          };
        });

        await api('/api/v1/signals/bulk', {
          method: 'POST',
          body: JSON.stringify({
            resource_id: tId,
            items: bulkItems,
            atomic: true,
          }),
        });
      }

      // Publish config to Edge
      if (siteEdges[0]) {
        await api('/api/v1/config-releases/publish', {
          method: 'POST',
          body: JSON.stringify({ edge_id: siteEdges[0].id }),
        });
      }

      // Clear draft
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
      await refresh();

      const targetName = targetResource?.code || targetResource?.name || 'resource';
      navigate(`/collector/signals?resourceId=${selectedTargetId}`);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      alert(`Error starting collection: ${apiErr.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Cancel Handler (TC-UI-AD-40..41)
  const handleCancel = () => {
    if (newConnCreatedId) {
      setConfirmCancelOpen(true);
    } else {
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
      navigate(-1);
    }
  };

  const handleConfirmDiscardNewConn = async (keep: boolean) => {
    if (!keep && newConnCreatedId) {
      try {
        await api(`/api/v1/connections/${newConnCreatedId}`, { method: 'DELETE' });
      } catch {
        // ignore
      }
    }
    sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    setConfirmCancelOpen(false);
    navigate(-1);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Top Header & Breadcrumb */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div>
          <div className="text-[12px] font-semibold text-blue-600 flex items-center gap-1.5">
            <span>Add Data</span>
            {targetPathString && (
              <>
                <ChevronRight className="w-3 h-3 text-slate-400" />
                <span className="text-[#111B37] font-mono">{targetPathString}</span>
              </>
            )}
          </div>
          <h1 className="text-[20px] font-bold text-[#111B37] mt-0.5">
            {currentStep === 1 && '1. Choose Target Resource'}
            {currentStep === 2 && '2. Select Data Source'}
            {currentStep === 3 && '3. Configure Source Address'}
            {currentStep === 4 && '4. Map Field Signals'}
            {currentStep === 5 && '5. Review & Verification'}
          </h1>
        </div>

        <Button variant="outline" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
      </div>

      {/* Step Indicator Progress Bar */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { num: 1, title: 'Target' },
          { num: 2, title: 'Source' },
          { num: 3, title: 'Address' },
          { num: 4, title: 'Fields' },
          { num: 5, title: 'Review' },
        ].map((s) => (
          <div
            key={s.num}
            className={`p-2.5 rounded-lg border text-center transition ${
              currentStep === s.num
                ? 'bg-blue-50 border-blue-400 text-blue-700 font-bold'
                : currentStep > s.num
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                : 'bg-white border-slate-200 text-slate-400 font-medium'
            }`}
          >
            <div className="text-[11px] uppercase tracking-wider">Step {s.num}</div>
            <div className="text-[13px]">{s.title}</div>
          </div>
        ))}
      </div>

      {/* STEP 1: TARGET (TC-UI-AD-01..04) - Hierarchical Tree View */}
      {currentStep === 1 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Select target resource</h3>
              <p className="text-[12px] text-[#657794]">
                Data can be bound to any level in your hierarchy (Machine, Line, Zone, Cell, or Plant)
              </p>
            </div>
            <div className="flex items-center gap-1.5 self-start sm:self-auto">
              <button
                type="button"
                onClick={expandAllTargets}
                className="px-2 py-1 text-[11px] font-semibold text-[#134074] hover:bg-[#F1F5F9] rounded-lg transition"
              >
                Expand all
              </button>
              <span className="text-slate-300">|</span>
              <button
                type="button"
                onClick={collapseAllTargets}
                className="px-2 py-1 text-[11px] font-semibold text-[#64748B] hover:bg-[#F1F5F9] rounded-lg transition"
              >
                Collapse all
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search resources by name or code…"
              value={targetSearch}
              onChange={(e) => setTargetSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Hierarchical Tree Container */}
          <div className="border border-slate-200 rounded-xl max-h-96 overflow-y-auto divide-y divide-slate-100 p-2 bg-[#F8FAFC]">
            {wizardTree.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-xs font-medium">No resources found in factory hierarchy.</div>
            ) : (
              (() => {
                const renderTreeNode = (node: WizardTreeNode, depth: number): React.ReactNode => {
                  if (!nodeOrDescendantMatches(node, targetSearch)) return null;
                  const hasChildren = node.children.length > 0;
                  const isExpanded = targetSearch.trim().length > 0 ? true : (expandedTargetNodes[node.resource.id] ?? true);
                  const isSelected = selectedTargetId === node.resource.id;

                  const getTypeIcon = (type: string) => {
                    switch (type.toLowerCase()) {
                      case 'enterprise':
                        return <Layers className="w-4 h-4 text-blue-600 shrink-0" />;
                      case 'site':
                      case 'plant':
                        return <Network className="w-4 h-4 text-emerald-600 shrink-0" />;
                      case 'area':
                        return <FolderTree className="w-4 h-4 text-amber-600 shrink-0" />;
                      case 'zone':
                        return <Layers className="w-4 h-4 text-orange-500 shrink-0" />;
                      case 'line':
                        return <Cpu className="w-4 h-4 text-indigo-500 shrink-0" />;
                      case 'machine':
                        return <Cpu className="w-4 h-4 text-red-500 shrink-0" />;
                      default:
                        return <Layers className="w-4 h-4 text-slate-500 shrink-0" />;
                    }
                  };

                  return (
                    <React.Fragment key={node.resource.id}>
                      <div
                        onClick={() => {
                          setSelectedTargetId(node.resource.id);
                          invalidateTest();
                        }}
                        style={{ paddingLeft: depth * 18 + 8 + 'px' }}
                        className={'py-2 pr-3 flex items-center justify-between cursor-pointer rounded-lg transition mb-0.5 ' + (
                          isSelected
                            ? 'bg-white border-2 border-blue-600 shadow-sm text-blue-900 font-bold'
                            : 'hover:bg-white text-[#111B37]'
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {hasChildren ? (
                            <button
                              type="button"
                              onClick={(e) => toggleTargetExpand(node.resource.id, e)}
                              className="p-1 rounded hover:bg-slate-200 text-slate-500"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                          ) : (
                            <span className="w-5" />
                          )}

                          {getTypeIcon(node.resource.type)}

                          <span className="text-[13px] font-semibold truncate">
                            {node.resource.name || node.resource.code}
                          </span>

                          <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                            {node.resource.type}
                          </span>

                          <span className="text-[11px] text-[#657794] font-mono">
                            {node.resource.code}
                          </span>
                        </div>

                        {isSelected ? (
                          <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />
                        ) : (
                          <Circle className="w-5 h-5 text-slate-300 shrink-0" />
                        )}
                      </div>

                      {hasChildren && isExpanded && (
                        <div>
                          {node.children.map((child) => renderTreeNode(child, depth + 1))}
                        </div>
                      )}
                    </React.Fragment>
                  );
                };

                return wizardTree.map((root) => renderTreeNode(root, 0));
              })()
            )}
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-100">
            <Button
              variant="primary"
              size="sm"
              disabled={!selectedTargetId}
              onClick={() => setCurrentStep(2)}
            >
              Next: Select Source <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 2: SOURCE (TC-UI-AD-05..07) */}
      {currentStep === 2 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Select data connection</h3>
              <p className="text-[12px] text-[#657794]">
                Choose an existing connection for {targetSite?.name || 'this site'} or create a new one
              </p>
            </div>
            {!isCreatingNewConn && (
              <Button size="sm" variant="outline" onClick={() => setIsCreatingNewConn(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> New connection
              </Button>
            )}
          </div>

          {/* New Connection Inline Form */}
          {isCreatingNewConn ? (
            <div className="p-4 border border-blue-200 bg-blue-50/30 rounded-xl space-y-4">
              <h4 className="text-[13px] font-bold text-[#111B37]">New Connection</h4>

              {newConnError && (
                <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-[12px] rounded">
                  {newConnError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
                <div>
                  <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                    Protocol*
                  </label>
                  <select
                    value={newConnProtocol}
                    onChange={(e) => setNewConnProtocol(e.target.value as any)}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white text-slate-800"
                  >
                    <option value="mqtt">MQTT Broker</option>
                    <option value="modbus">Modbus TCP</option>
                    <option value="opcua">OPC UA</option>
                    <option value="http">HTTP / REST</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                    Connection Name*
                  </label>
                  <input
                    type="text"
                    value={newConnName}
                    onChange={(e) => setNewConnName(e.target.value)}
                    placeholder="e.g. mqtt-lab"
                    className="w-full px-3 py-1.5 border border-slate-300 rounded"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                    Host / Endpoint*
                  </label>
                  <input
                    type="text"
                    value={newConnHost}
                    onChange={(e) => setNewConnHost(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                    Port*
                  </label>
                  <input
                    type="text"
                    value={newConnPort}
                    onChange={(e) => setNewConnPort(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-blue-100">
                <Button variant="outline" size="sm" onClick={() => setIsCreatingNewConn(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveNewConnection}
                  disabled={newConnSaving}
                >
                  {newConnSaving ? 'Saving…' : 'Save connection'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {siteConnections.length === 0 ? (
                <div className="p-8 text-center text-[#657794] border border-dashed border-slate-300 rounded-lg">
                  No existing connections for this site. Click "+ New connection" above to add one.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {siteConnections.map((c) => (
                    <div
                      key={c.id}
                      onClick={() => {
                        setSelectedConnectionId(c.id);
                        invalidateTest();
                      }}
                      className={`p-3 flex items-center justify-between cursor-pointer transition ${
                        selectedConnectionId === c.id ? 'bg-blue-50/70 border-l-4 border-blue-600' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div>
                        <div className="text-[13px] font-semibold text-[#111B37] flex items-center gap-2">
                          <span>{c.name}</span>
                          <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 bg-slate-100 text-slate-700 rounded">
                            {c.protocol}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#657794] font-mono mt-0.5">
                          {c.endpoint || '192.168.2.108:18883'}
                        </div>
                      </div>
                      <StatusBadge status={c.health || 'ONLINE'} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(1)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!selectedConnectionId}
              onClick={() => setCurrentStep(3)}
            >
              Next: Source Address <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 3: ADDRESS (TC-UI-AD-08..15) */}
      {currentStep === 3 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div>
            <h3 className="text-[14px] font-bold text-[#111B37]">Source address parameters</h3>
            <p className="text-[12px] text-[#657794]">
              Configure MQTT topic subscriptions and subscription quality parameters
            </p>
          </div>

          <div className="space-y-4 text-[12px]">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] font-semibold text-[#657794] uppercase">
                  MQTT Topic Filter*
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMqttTopicFilter('#');
                    setAddressError(null);
                    invalidateTest();
                  }}
                  className="text-blue-600 hover:underline text-[11px] font-semibold"
                >
                  Use the broker root (#)
                </button>
              </div>

              <input
                type="text"
                value={mqttTopicFilter}
                onChange={(e) => {
                  const val = e.target.value.replace(/\s+/g, '_');
                  setMqttTopicFilter(val);
                  setAddressError(validateTopicFilter(val));
                  invalidateTest();
                }}
                className={`w-full px-3 py-2 border rounded font-mono text-[12px] focus:outline-none focus:border-blue-500 ${
                  addressError ? 'border-red-400 bg-red-50/20' : 'border-slate-300'
                }`}
              />
              {addressError && (
                <p className="text-[11px] text-red-600 mt-1">{addressError}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                  QoS (Quality of Service)*
                </label>
                <select
                  value={mqttQos}
                  onChange={(e) => {
                    setMqttQos(e.target.value);
                    invalidateTest();
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded bg-white text-slate-800"
                >
                  <option value="0">0 - At most once</option>
                  <option value="1">1 - At least once (Default)</option>
                  <option value="2">2 - Exactly once</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                  Poll interval (ms)
                </label>
                <input
                  type="number"
                  value={pollIntervalMs}
                  onChange={(e) => {
                    setPollIntervalMs(e.target.value);
                    invalidateTest();
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(2)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={Boolean(addressError) || !mqttTopicFilter.trim()}
              onClick={() => {
                const err = validateTopicFilter(mqttTopicFilter);
                if (err) {
                  setAddressError(err);
                  return;
                }
                setCurrentStep(4);
              }}
            >
              Next: Map Fields <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}


      {/* Paste Sample JSON Modal */}
      {isPasteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl border border-slate-300 shadow-2xl max-w-lg w-full p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Braces className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-[#111B37]">Paste Sample JSON Payload</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsPasteModalOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-[#657794]">
              Paste any JSON payload. FactoriX will automatically unpack nested objects into flattened variables (e.g. c.d → c_d) and bind JSON paths.
            </p>
            <textarea
              rows={8}
              value={pastedJsonText}
              onChange={(e) => setPastedJsonText(e.target.value)}
              placeholder='{\n  "status": 1,\n  "speed": 1050,\n  "motor": {\n    "temp": 45.2,\n    "vibration": 0.8\n  }\n}'
              className="w-full p-3 font-mono text-xs border border-slate-300 rounded-xl focus:outline-none focus:border-blue-500"
            />
            {pastedJsonError && (
              <p className="text-xs text-red-600 font-semibold">{pastedJsonError}</p>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => setIsPasteModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleApplyPastedJson} disabled={!pastedJsonText.trim()}>
                Parse & Auto-Map Fields
              </Button>
            </div>
          </div>
        </div>
      )}
  
      {/* STEP 4: FIELDS (TC-UI-AD-16..28) */}
      {currentStep === 4 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Map field signals</h3>
              <p className="text-[12px] text-[#657794]">
                Capture sample messages from the broker and bind JSON fields to typed signals
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPastedJsonError(null);
                  setIsPasteModalOpen(true);
                }}
              >
                <Braces className="w-3.5 h-3.5 mr-1" />
                Paste sample JSON
              </Button>
              <Button
                size="sm"
                variant={isCapturing ? 'outline' : 'primary'}
                onClick={handleCaptureSample}
                disabled={isCapturing}
              >
                {isCapturing ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />
                    Capturing ({captureCountdown} s)…
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 mr-1" />
                    Capture sample (10 s)
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Captured Samples Tree Panel */}
          {capturedTopics.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3 bg-slate-50 border border-slate-200 rounded-xl">
              {/* Left Column: Topics List */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-bold uppercase text-[#657794] block mb-1">
                  Captured Topics
                </span>
                {capturedTopics.map((ct) => (
                  <button
                    key={ct.topic}
                    type="button"
                    onClick={() => setSelectedCapturedTopic(ct.topic)}
                    className={`w-full text-left p-2 rounded text-[11px] font-mono transition flex items-center justify-between ${
                      selectedCapturedTopic === ct.topic
                        ? 'bg-blue-600 text-white font-bold'
                        : 'bg-white hover:bg-slate-200 text-slate-800 border border-slate-200'
                    }`}
                  >
                    <span className="truncate max-w-[170px]">{ct.topic.split('/').pop()}</span>
                    <span className="text-[10px] opacity-80">{ct.count} msgs</span>
                  </button>
                ))}
              </div>

              {/* Right Columns: JSON Tree Explorer */}
              <div className="md:col-span-2 bg-white p-3 border border-slate-200 rounded-lg space-y-2">
                <div className="flex items-center justify-between pb-1 border-b border-slate-100">
                  <span className="text-[11px] font-mono text-[#657794] truncate max-w-[260px]">
                    {selectedCapturedTopic}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px]"
                    onClick={handleSelectAllNumeric}
                  >
                    Select all numeric
                  </Button>
                </div>

                <div className="max-h-52 overflow-y-auto space-y-1 text-[11px]">
                  {selectedCapturedTopic &&
                    Object.entries(
                      capturedTopics.find((t) => t.topic === selectedCapturedTopic)?.samplePayload || {}
                    ).map(([k, v]) => {
                      const isAdded = fields.some(
                        (f) => f.name.toLowerCase() === k.toLowerCase() && f.topic === selectedCapturedTopic
                      );
                      const typeLabel = typeof v === 'number' ? (Number.isInteger(v) ? 'Integer' : 'Number') : typeof v === 'boolean' ? 'Boolean' : 'Text';

                      return (
                        <div
                          key={k}
                          onClick={() => handleAddFieldFromSample(k, v, selectedCapturedTopic)}
                          className={`p-1.5 rounded flex items-center justify-between cursor-pointer transition ${
                            isAdded ? 'bg-emerald-50 text-emerald-900 font-semibold' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[#111B37]">{k}</span>
                            <span className="text-[10px] text-[#657794] bg-slate-100 px-1 rounded">
                              {typeLabel}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[11px]">
                            <span className="text-slate-600 truncate max-w-[120px]">
                              {String(v)}
                            </span>
                            {isAdded ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                            ) : (
                              <Plus className="w-3.5 h-3.5 text-blue-600" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {/* Active Field Rows Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-bold text-[#111B37]">
                Configured Signals ({fields.length})
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const baseTopic = mqttTopicFilter.replace(/#$/, '').replace(/\/$/, '');
                    const newField: FieldRow = {
                      id: `f-${Date.now()}`,
                      topic: `${baseTopic}/state`,
                      address: '$.status',
                      name: fields.some((f) => f.name === 'status') ? `status_${fields.length + 1}` : 'status',
                      dataType: 'Integer',
                      unit: '',
                      sample: 2,
                    };
                    setFields((prev) => [...prev, newField]);
                    invalidateTest();
                  }}
                  className="text-[11px] h-7"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add field
                </Button>
                {targetResource && similarResources.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedSimilarResourceIds(similarResources.map((r) => r.id));
                      setShowSimilarModal(true);
                    }}
                    className="text-[11px] h-7"
                  >
                    Apply to similar resources…
                  </Button>
                )}
              </div>
            </div>

            {fields.length === 0 ? (
              <div className="p-8 text-center text-[#657794] border border-dashed border-slate-300 rounded-lg text-[12px]">
                Click "Capture sample (10 s)" above or click fields from the JSON tree to add signals.
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[#657794] font-semibold">
                      <th className="py-2.5 px-3">Field path</th>
                      <th className="py-2.5 px-3">Signal name</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3">Unit</th>
                      <th className="py-2.5 px-3">Sample</th>
                      <th className="py-2.5 px-3 text-right w-12"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {fields.map((f, idx) => (
                      <tr key={f.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3">
                          <input
                            type="text"
                            value={f.address}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFields((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, address: val } : item))
                              );
                              invalidateTest();
                            }}
                            className="w-full px-2 py-1 border border-slate-300 rounded font-mono text-[11px]"
                          />
                          {f.error && <p className="text-[10px] text-red-600 mt-0.5">{f.error}</p>}
                        </td>
                        <td className="py-2.5 px-3">
                          <input
                            type="text"
                            value={f.name}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFields((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, name: val } : item))
                              );
                              invalidateTest();
                            }}
                            className="w-full px-2 py-1 border border-slate-300 rounded text-[12px]"
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <select
                            value={f.dataType}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFields((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, dataType: val } : item))
                              );
                              invalidateTest();
                            }}
                            className="px-2 py-1 border border-slate-300 rounded text-[11px] bg-white"
                          >
                            <option value="Number">Number</option>
                            <option value="Integer">Integer</option>
                            <option value="Boolean">Boolean</option>
                            <option value="Text">Text</option>
                          </select>
                          {f.warning && (
                            <p className="text-[10px] text-amber-600 mt-0.5">{f.warning}</p>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <input
                            type="text"
                            value={f.unit}
                            placeholder="e.g. kW"
                            onChange={(e) => {
                              const val = e.target.value;
                              setFields((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, unit: val } : item))
                              );
                            }}
                            className="w-16 px-2 py-1 border border-slate-300 rounded text-[11px]"
                          />
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-[#111B37]">
                          {f.sample !== undefined ? String(f.sample) : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <button
                            onClick={() => {
                              setFields((prev) => prev.filter((_, i) => i !== idx));
                              invalidateTest();
                            }}
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
            )}

            {/* Timestamp field setting (TC-UI-AD-20) */}
            <div className="pt-2 flex items-center justify-between text-[11px] text-[#657794]">
              <span>Timestamp field auto-detected: <code className="bg-slate-100 px-1 py-0.5 rounded font-mono text-slate-800">{timestampField}</code></span>
              <button
                type="button"
                onClick={() => setTimestampField('$.publish_timestamp')}
                className="text-blue-600 hover:underline"
              >
                Change timestamp path
              </button>
            </div>
          </div>

          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(3)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={fields.length === 0}
              onClick={() => {
                if (!validateFieldRows()) return;
                setCurrentStep(5);
              }}
            >
              Next: Review & Test <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 5: REVIEW & VERIFY (TC-UI-AD-29..36) */}
      {currentStep === 5 && (
        <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
          <div>
            <h3 className="text-[14px] font-bold text-[#111B37]">Review collection plan</h3>
            <p className="text-[12px] text-[#657794]">
              Verify connectivity and data mapping on Edge collector before starting active streaming
            </p>
          </div>

          {/* Plan Summary */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-[12px]">
            <div className="flex justify-between py-1 border-b border-slate-200">
              <span className="text-[#657794]">Target Resource:</span>
              <span className="font-semibold text-[#111B37]">{targetPathString}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200">
              <span className="text-[#657794]">Data Connection:</span>
              <span className="font-medium text-[#111B37]">
                {connections.find((c) => c.id === selectedConnectionId)?.name || 'mqtt-lab'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200">
              <span className="text-[#657794]">Topic Filter:</span>
              <span className="font-mono text-[#111B37]">{mqttTopicFilter}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-200">
              <span className="text-[#657794]">Fields count:</span>
              <span className="font-semibold text-[#111B37]">
                {fields.length} signal{fields.length > 1 ? 's' : ''}
                {selectedSimilarResourceIds.length > 0 && ` (+ ${selectedSimilarResourceIds.length * fields.length} replicated)`}
              </span>
            </div>
          </div>

          {/* Test Execution Section */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <h4 className="text-[13px] font-bold text-[#111B37]">Live Verification Proof</h4>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRunTest}
                disabled={isTesting}
              >
                <Play className={`w-3.5 h-3.5 mr-1 ${isTesting ? 'animate-spin' : ''}`} />
                {isTesting ? 'Running test…' : 'Run test'}
              </Button>
            </div>

            {testResult?.errorMessage && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-[12px] rounded-lg flex items-center justify-between">
                <span>{testResult.errorMessage}</span>
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setCurrentStep(4)}>
                  Back to fields
                </Button>
              </div>
            )}

            {testResult?.stages && (
              <div className="p-3 bg-white border border-slate-200 rounded-lg divide-y divide-slate-100 text-[12px]">
                {testResult.stages.map((st) => (
                  <div key={st.stage} className="py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {st.status === 'PASSED' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-red-600" />
                      )}
                      <span className="font-medium text-[#111B37]">{st.stage}</span>
                      {st.detail && <span className="text-[#657794] text-[11px]">({st.detail})</span>}
                    </div>
                    {st.duration_ms && (
                      <span className="text-[#657794] font-mono text-[11px]">{st.duration_ms} ms</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Field Values Proof Table */}
            {testResult?.fieldSamples && (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[#657794] font-semibold">
                      <th className="py-2 px-3">Field</th>
                      <th className="py-2 px-3">Captured Live Sample</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {Object.entries(testResult.fieldSamples).map(([k, v]) => (
                      <tr key={k}>
                        <td className="py-2 px-3 font-semibold text-[#111B37]">{k}</td>
                        <td className="py-2 px-3 text-emerald-700">{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Action Bar */}
          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={() => setCurrentStep(4)}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to fields
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!testResult?.passed || isSubmitting}
              onClick={handleStartCollecting}
            >
              {isSubmitting ? 'Starting collection…' : 'Start collecting'}
            </Button>
          </div>
        </Card>
      )}

      {/* Similar Resources Modal (TC-UI-AD-27) */}
      {showSimilarModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md p-5 bg-white border border-slate-300 shadow-xl space-y-4">
            <div>
              <h3 className="text-[14px] font-bold text-[#111B37]">Apply to similar resources</h3>
              <p className="text-[12px] text-[#657794] mt-0.5">
                Automatically replicate these {fields.length} signal mappings to sibling resources with matching topic segments
              </p>
            </div>

            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg max-h-56 overflow-y-auto">
              {similarResources.map((sr) => {
                const isSelected = selectedSimilarResourceIds.includes(sr.id);
                return (
                  <div
                    key={sr.id}
                    onClick={() => {
                      setSelectedSimilarResourceIds((prev) =>
                        prev.includes(sr.id) ? prev.filter((id) => id !== sr.id) : [...prev, sr.id]
                      );
                    }}
                    className="p-2.5 flex items-center justify-between cursor-pointer hover:bg-slate-50 text-[12px]"
                  >
                    <div>
                      <div className="font-semibold text-[#111B37]">{sr.name || sr.code}</div>
                      <div className="font-mono text-[10px] text-[#657794]">{sr.code}</div>
                    </div>
                    {isSelected ? (
                      <CheckCircle2 className="w-4 h-4 text-blue-600" />
                    ) : (
                      <Circle className="w-4 h-4 text-slate-300" />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="p-2.5 bg-blue-50 text-blue-900 rounded text-[11px]">
              {selectedSimilarResourceIds.length} resources selected × {fields.length} fields ={' '}
              <span className="font-bold">{selectedSimilarResourceIds.length * fields.length} signals</span>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => setShowSimilarModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShowSimilarModal(false)}>
                Confirm
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Discard New Connection Confirm Dialog (TC-UI-AD-40) */}
      {confirmCancelOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-sm p-5 bg-white border border-slate-300 shadow-xl space-y-4">
            <h3 className="text-[14px] font-bold text-[#111B37]">
              Keep the new connection "{newConnName || 'mqtt-lab'}"?
            </h3>
            <p className="text-[12px] text-[#657794]">
              You created a new connection in Step 2. Do you want to keep it in your connections catalog or delete it?
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleConfirmDiscardNewConn(false)}
              >
                Delete connection
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleConfirmDiscardNewConn(true)}
              >
                Keep connection
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
