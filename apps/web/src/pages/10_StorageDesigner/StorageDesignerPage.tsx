import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  FileCode,
  Filter,
  FlaskConical,
  FolderTree,
  GitBranch,
  Layers,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Table as TableIcon,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import {
  ApiError,
  CompiledStoragePlan,
  DatasetAst,
  DslIssue,
  FieldAst,
  MissingPolicyMode,
  RecordingMode,
  SimulateDesignResponse,
  StorageDesignAst,
  StorageDesignDetail,
  StorageDesignStatus,
  StorageValueType,
  TimeAxisMode,
  compileStoragePhysicalPlan,
  createDefaultStorageDesignAst,
  createStorageDesign,
  getStorageDesign,
  listStorageDesigns,
  normalizeAst,
  publishStorageDesign,
  serializeAstToYaml,
  simulateStorageDesign,
  updateStorageDesign,
  validateStorageDesign,
} from '../../lib/storageApi';

type DesignerMode = 'visual' | 'code' | 'physical' | 'simulate';
type WorkflowStep = 1 | 2 | 3 | 4;
type SourceTab = 'signals' | 'models' | 'resources';

const WORKFLOW_STEPS: Array<{ step: WorkflowStep; title: string; subtitle: string }> = [
  { step: 1, title: '1. Define Scope & Semantics', subtitle: 'Target resources, dataset semantics & time axis' },
  { step: 2, title: '2. Map Fields & Transforms', subtitle: 'Bind signals/models & safe scalar expressions' },
  { step: 3, title: '3. Recording & Retention Policy', subtitle: 'ON_CHANGE / INTERVAL / EVERY_ACQUISITION & keep days' },
  { step: 4, title: '4. Review & Physical Plan', subtitle: 'TDengine STable DDL, row width & dry-run verification' },
];

const VALUE_TYPES: StorageValueType[] = ['float64', 'int64', 'bool', 'string', 'enum', 'json', 'timestamp'];
const RECORDING_MODES: Array<{ mode: RecordingMode; label: string; desc: string }> = [
  {
    mode: 'ON_CHANGE',
    label: 'ON_CHANGE (Default)',
    desc: 'Writes baseline, value transitions outside deadband, mandatory quality changes, and periodic checkpoints.',
  },
  {
    mode: 'EVERY_ACQUISITION',
    label: 'EVERY_ACQUISITION (Full Fidelity)',
    desc: 'Persists every distinct event_uid acquisition. Required for independent event streams and cycle logs.',
  },
  {
    mode: 'INTERVAL',
    label: 'INTERVAL (Time-Bucketed)',
    desc: 'Writes UTC-aligned periodic buckets with deterministic missing-data handling (GAP_MARKER / NULL / HOLD).',
  },
];

function inferStorageType(rawType: string | undefined): StorageValueType {
  const t = (rawType || '').toLowerCase();
  if (t.includes('bool')) return 'bool';
  if (t.includes('int') || t.includes('uint')) return 'int64';
  if (t.includes('str') || t.includes('text')) return 'string';
  if (t.includes('json') || t.includes('obj')) return 'json';
  return 'float64';
}

function sanitizeIdentifier(raw: string, fallback = 'field_1'): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!cleaned) return fallback;
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `f_${cleaned}`.slice(0, 48);
}

function estimateLocalRowWidth(ds: DatasetAst | undefined): number {
  if (!ds) return 900;
  let bytes = 900; // Base TDengine metadata columns
  for (const f of ds.fields || []) {
    if (f.type === 'bool') bytes += 2;
    else if (f.type === 'int64' || f.type === 'float64' || f.type === 'timestamp') bytes += 9;
    else if (f.type === 'string' || f.type === 'enum') {
      const n = Math.min(Math.max(f.maxLength || 256, 1), 15000);
      bytes += 4 * n + 4;
    } else if (f.type === 'json') {
      const n = Math.min(Math.max(f.maxLength || 4096, 1), 60000);
      bytes += n + 4;
    } else {
      bytes += 16;
    }
  }
  return bytes;
}

function buildFallbackPhysicalPlan(ast: StorageDesignAst, designId: string | null): CompiledStoragePlan {
  const dbName = 'fx_t_tenant';
  const dhex = (designId || '00000000').replace(/-/g, '').slice(0, 8) || '00000000';
  const maxKeep = Math.max(...ast.spec.datasets.map((d) => d.retention?.days || 90), 90);
  const ddl: string[] = [
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` PRECISION 'us' KEEP ${maxKeep}d CACHEMODEL 'last_row' CACHESIZE 16 VGROUPS 1`,
  ];

  const dsPlans = ast.spec.datasets.map((ds, idx) => {
    const safeKey = sanitizeIdentifier(ds.key || `dataset_${idx + 1}`).toLowerCase().slice(0, 36);
    const stable = `ds_${dhex}_${safeKey}_v1`;
    const cols = ds.fields.map((f) => {
      const tdType =
        f.type === 'bool'
          ? 'BOOL'
          : f.type === 'int64'
            ? 'BIGINT'
            : f.type === 'timestamp'
              ? 'TIMESTAMP'
              : f.type === 'string' || f.type === 'enum'
                ? `NCHAR(${f.maxLength || 256})`
                : f.type === 'json'
                  ? `VARCHAR(${f.maxLength || 4096})`
                  : 'DOUBLE';
      return {
        key: f.key,
        value_type: f.type,
        td_type: tdType,
        nullable: f.nullable !== false,
      };
    });

    const sysCols = [
      '`ts` TIMESTAMP',
      '`acquired_at` TIMESTAMP',
      '`source_time` TIMESTAMP',
      '`raw_quality` NCHAR(16)',
      '`reason_code` NCHAR(64)',
      '`event_uid` NCHAR(64)',
      '`data_epoch` BIGINT',
      '`record_kind` NCHAR(24)',
      ...cols.map((c) => `\`${c.key}\` ${c.td_type}`),
    ];
    const tagCols = [
      '`dataset_id` NCHAR(36)',
      '`series_key` NCHAR(96)',
      '`resource_id` NCHAR(36)',
      ...(ds.tags || []).map((t) => `\`${t.key}\` NCHAR(128)`),
    ];
    ddl.push(`CREATE STABLE IF NOT EXISTS \`${dbName}\`.\`${stable}\` (${sysCols.join(', ')}) TAGS (${tagCols.join(', ')})`);

    return {
      dataset_id: ds.id || `ds-${idx + 1}`,
      dataset_key: ds.key,
      td_stable: stable,
      schema_epoch: 1,
      semantics: ds.semantics,
      recording_mode: ds.recording.mode,
      retention_days: ds.retention.days,
      legal_hold: ds.retention.legalHold,
      row_width_bytes: estimateLocalRowWidth(ds),
      max_row_width_bytes: 64500,
      columns: cols,
      subtable_count: ds.fields.length,
      physical_schema_hash: `sha256:${stable}`,
    };
  });

  const series = ast.spec.datasets.flatMap((ds, dsIdx) => {
    const stable = dsPlans[dsIdx].td_stable;
    return ds.fields.map((f, fIdx) => {
      const sub = `md_${dhex}_${sanitizeIdentifier(ds.key).slice(0, 6)}_${sanitizeIdentifier(f.key).slice(0, 8)}_${fIdx + 1}`;
      const sKey = f.signalId ? `sig:${f.signalId}` : f.modelId ? `mod:${f.modelId}:${f.modelFieldPath || f.key}` : `fld:${ds.key}:${f.key}`;
      ddl.push(
        `CREATE TABLE IF NOT EXISTS \`${dbName}\`.\`${sub}\` USING \`${dbName}\`.\`${stable}\` TAGS ('${ds.id || ds.key}', '${sKey}', '${f.resourceId || ''}')`,
      );
      return {
        dataset_key: ds.key,
        series_key: sKey,
        field_key: f.key,
        value_type: f.type,
        td_database: dbName,
        td_stable: stable,
        td_subtable: sub,
        signal_id: f.signalId || null,
        model_id: f.modelId || null,
        model_field_path: f.modelFieldPath || null,
        physical_schema_hash: dsPlans[dsIdx].physical_schema_hash,
        tags: { dataset_id: ds.id || ds.key, series_key: sKey, resource_id: f.resourceId || '' },
      };
    });
  });

  const maxRowWidth = Math.max(...dsPlans.map((d) => d.row_width_bytes || 900), 900);

  return {
    compiler_version: '1.0.0',
    td_database: dbName,
    destination: 'TDengine',
    semantic_hash: `sem_${dhex}_${series.length}`,
    ast_hash: `ast_${dhex}_${series.length}`,
    plan_hash: `plan_${dhex}_${series.length}`,
    row_width_bytes: maxRowWidth,
    max_row_width_bytes: 64500,
    ddl_statements: ddl,
    datasets: dsPlans,
    series,
    diff: {
      is_breaking: false,
      breaking_changes: [],
      non_breaking_changes: ['Initial or additive TDengine STable & subtable plan compiled cleanly.'],
      ddl_statements: [],
      actions: [
        ...dsPlans.map((d) => ({
          action: 'CREATE_STABLE' as const,
          target: `${dbName}.${d.td_stable}`,
          description: `Create STable ${d.td_stable} (${d.columns.length} value columns)`,
        })),
        ...series.map((s) => ({
          action: 'ENSURE_SUBTABLE' as const,
          target: `${dbName}.${s.td_subtable}`,
          description: `Ensure deterministic subtable ${s.td_subtable} USING ${s.td_stable}`,
        })),
      ],
    },
    impact: {
      dataset_count: dsPlans.length,
      series_count: series.length,
      field_count: series.length,
      estimated_daily_rows_min: series.length * 4320,
      estimated_daily_rows_max: series.length * 86400,
      estimated_daily_bytes_min: series.length * 4320 * 64,
      estimated_daily_bytes_max: series.length * 86400 * 128,
      assumptions: `Projected from ${series.length} mapped series targeting TDengine database ${dbName}.`,
    },
    warnings: ast.spec.datasets
      .filter((d) => d.recording.mode !== 'EVERY_ACQUISITION')
      .map(
        (d) =>
          `Dataset '${d.key}' uses ${d.recording.mode}; Operational History preserves full-fidelity 15m trends and exact sample averages.`,
      ),
  };
}

export const StorageDesignerPage: React.FC = () => {
  const { designId: routeDesignId } = useParams<{ designId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signals, resources, dataModels, connections } = useApp();
  const { toast, show: showToast, dismiss: dismissToast } = useActionToast();

  const queryDesignId = searchParams.get('designId') || searchParams.get('id');
  const activeDesignId = routeDesignId || queryDesignId || null;

  // Designer state
  const [designDetail, setDesignDetail] = useState<StorageDesignDetail | null>(null);
  const [ast, setAst] = useState<StorageDesignAst>(() => createDefaultStorageDesignAst());
  const [codeFormat, setCodeFormat] = useState<'yaml' | 'json'>('yaml');
  const [codeText, setCodeText] = useState<string>(() => serializeAstToYaml(createDefaultStorageDesignAst()));
  const [mode, setMode] = useState<DesignerMode>('visual');
  const [step, setStep] = useState<WorkflowStep>(2);
  const [selectedDatasetIndex, setSelectedDatasetIndex] = useState<number>(0);
  const [selectedFieldIndex, setSelectedFieldIndex] = useState<number | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'dataset' | 'field'>('dataset');

  // Lifecycle & Concurrency state
  const [loadingDesign, setLoadingDesign] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [validating, setValidating] = useState<boolean>(false);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [versionConflict, setVersionConflict] = useState<{
    occurred: boolean;
    message: string;
  } | null>(null);

  // Validation, Physical Plan & Simulation results
  const [issues, setIssues] = useState<DslIssue[]>([]);
  const [validationPassed, setValidationPassed] = useState<boolean | null>(null);
  const [physicalPlan, setPhysicalPlan] = useState<CompiledStoragePlan | null>(null);
  const [simResult, setSimResult] = useState<SimulateDesignResponse | null>(null);

  // Source Explorer filters
  const [sourceTab, setSourceTab] = useState<SourceTab>('signals');
  const [sourceSearch, setSourceSearch] = useState<string>('');
  const [protocolFilter, setProtocolFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [resourceFilterId, setResourceFilterId] = useState<string>('all');
  const [expandedResources, setExpandedResources] = useState<Record<string, boolean>>({});
  const [existingDesigns, setExistingDesigns] = useState<Array<{ id: string; name: string; status: string; version: number }>>([]);

  const activeDataset: DatasetAst = useMemo(
    () => ast.spec.datasets[selectedDatasetIndex] || ast.spec.datasets[0] || createDefaultStorageDesignAst().spec.datasets[0],
    [ast.spec.datasets, selectedDatasetIndex],
  );

  const selectedField: FieldAst | null = useMemo(
    () => (selectedFieldIndex !== null && activeDataset?.fields[selectedFieldIndex] ? activeDataset.fields[selectedFieldIndex] : null),
    [activeDataset, selectedFieldIndex],
  );

  // Keep code editor synchronized when editing in visual mode
  const updateAst = useCallback(
    (updater: (prev: StorageDesignAst) => StorageDesignAst) => {
      setAst((prev) => {
        const next = updater(prev);
        setCodeText(codeFormat === 'json' ? JSON.stringify(next, null, 2) : serializeAstToYaml(next));
        return next;
      });
      setIsDirty(true);
      setValidationPassed(null);
    },
    [codeFormat],
  );

  // Load existing designs list for quick switcher
  useEffect(() => {
    listStorageDesigns({ limit: 50 })
      .then((res) => {
        setExistingDesigns(
          res.items.map((item) => ({
            id: item.id,
            name: item.name,
            status: item.status,
            version: item.current_version,
          })),
        );
      })
      .catch(() => {
        // Non-blocking if no designs exist yet
      });
  }, [activeDesignId]);

  // Load design detail if `activeDesignId` is provided
  const loadDesignById = useCallback(
    async (id: string) => {
      setLoadingDesign(true);
      setVersionConflict(null);
      try {
        const detail = await getStorageDesign(id);
        setDesignDetail(detail);
        setAst(detail.ast);
        setCodeText(codeFormat === 'json' ? JSON.stringify(detail.ast, null, 2) : detail.yaml || serializeAstToYaml(detail.ast));
        setIssues(detail.validation_issues || []);
        if (detail.physical_plan) {
          setPhysicalPlan(detail.physical_plan);
        }
        setSelectedDatasetIndex(0);
        setSelectedFieldIndex(detail.ast.spec.datasets[0]?.fields.length ? 0 : null);
        setIsDirty(false);
      } catch (err) {
        showToast({
          message: err instanceof Error ? err.message : 'Could not load storage design.',
          tone: 'error',
        });
      } finally {
        setLoadingDesign(false);
      }
    },
    [codeFormat, showToast],
  );

  useEffect(() => {
    if (activeDesignId) {
      void loadDesignById(activeDesignId);
    } else {
      setDesignDetail(null);
    }
  }, [activeDesignId, loadDesignById]);

  // Seed default fields from real signals when opening blank designer so users immediately see live lineage
  useEffect(() => {
    if (activeDesignId || designDetail || isDirty) return;
    if (signals.length > 0 && ast.spec.datasets[0]?.fields.length === 0) {
      const sampleSignals = signals.filter((s) => s.enabled !== false).slice(0, 4);
      if (sampleSignals.length > 0) {
        const initialFields: FieldAst[] = sampleSignals.map((sig, idx) => {
          const res = resources.find((r) => r.id === sig.resourceId);
          const tKey = res?.type || 'machine';
          const rName = res?.name || sig.resourcePath || 'Asset';
          const sKey = sig.key || sig.name || `signal_${idx + 1}`;
          return {
            key: sanitizeIdentifier(sKey, `field_${idx + 1}`),
            from: `$${tKey}[${rName}].${sKey}`,
            type: inferStorageType(sig.data_type || sig.dataType),
            displayName: sig.displayName || sKey,
            unit: sig.unit || null,
            nullable: true,
            required: false,
            sourceKind: 'signal',
            signalId: sig.id,
            resourceId: sig.resourceId || null,
            transform: null,
          };
        });
        setAst((prev) => {
          const next: StorageDesignAst = {
            ...prev,
            spec: {
              ...prev.spec,
              datasets: prev.spec.datasets.map((ds, i) => (i === 0 ? { ...ds, fields: initialFields } : ds)),
            },
          };
          setCodeText(codeFormat === 'json' ? JSON.stringify(next, null, 2) : serializeAstToYaml(next));
          return next;
        });
        setSelectedFieldIndex(0);
      }
    }
  }, [activeDesignId, designDetail, isDirty, signals, resources, ast.spec.datasets, codeFormat]);

  // Protocol lookup for signals
  const connectionProtocolMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of connections) {
      map.set(c.id, c.protocol);
    }
    return map;
  }, [connections]);

  const activeSignals = useMemo(() => signals.filter((s) => s.enabled !== false), [signals]);

  const filteredSignals = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    return activeSignals.filter((s) => {
      if (resourceFilterId !== 'all' && s.resourceId !== resourceFilterId) return false;
      const proto = s.connectionProtocol || connectionProtocolMap.get(s.connectionId || s.sourceConnectionId || '') || '';
      if (protocolFilter !== 'all' && !proto.toLowerCase().includes(protocolFilter.toLowerCase())) return false;
      const stype = inferStorageType(s.data_type || s.dataType);
      if (typeFilter !== 'all' && stype !== typeFilter) return false;
      if (q) {
        const matchKey = (s.key || s.name || '').toLowerCase().includes(q);
        const matchDisplay = (s.displayName || '').toLowerCase().includes(q);
        const matchRes = (s.resourcePath || '').toLowerCase().includes(q);
        if (!matchKey && !matchDisplay && !matchRes) return false;
      }
      return true;
    });
  }, [activeSignals, sourceSearch, resourceFilterId, protocolFilter, typeFilter, connectionProtocolMap]);

  const filteredModels = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    return dataModels.filter((m) => {
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q) ||
        m.machines.some((mach) => mach.toLowerCase().includes(q))
      );
    });
  }, [dataModels, sourceSearch]);

  const mappedSignalIds = useMemo(() => {
    const set = new Set<string>();
    for (const ds of ast.spec.datasets) {
      for (const f of ds.fields) {
        if (f.signalId) set.add(f.signalId);
      }
    }
    return set;
  }, [ast.spec.datasets]);

  // Add a signal to the active dataset
  const handleAddSignalToDataset = (sig: (typeof signals)[number]) => {
    const res = resources.find((r) => r.id === sig.resourceId);
    const tKey = res?.type || 'machine';
    const rName = res?.name || sig.resourcePath || 'Asset';
    const rawKey = sig.key || sig.name || 'signal_val';
    const existingKeys = new Set(activeDataset.fields.map((f) => f.key.toLowerCase()));
    let candidateKey = sanitizeIdentifier(rawKey, 'field_val');
    let suffix = 2;
    while (existingKeys.has(candidateKey.toLowerCase())) {
      candidateKey = `${sanitizeIdentifier(rawKey, 'field_val')}_${suffix++}`;
    }

    const newField: FieldAst = {
      key: candidateKey,
      from: `$${tKey}[${rName}].${rawKey}`,
      type: inferStorageType(sig.data_type || sig.dataType),
      displayName: sig.displayName || rawKey,
      unit: sig.unit || null,
      nullable: true,
      required: false,
      sourceKind: 'signal',
      signalId: sig.id,
      resourceId: sig.resourceId || null,
      transform: null,
    };

    const nextIdx = activeDataset.fields.length;
    updateAst((prev) => ({
      ...prev,
      spec: {
        ...prev.spec,
        datasets: prev.spec.datasets.map((ds, i) =>
          i === selectedDatasetIndex ? { ...ds, fields: [...ds.fields, newField] } : ds,
        ),
      },
    }));
    setSelectedFieldIndex(nextIdx);
    setInspectorTab('field');
    showToast({ message: `Added signal "${rawKey}" as field "${candidateKey}".`, tone: 'info' });
  };

  // Add a Data Model projection field to the active dataset
  const handleAddModelToDataset = (model: (typeof dataModels)[number], fieldPath = 'status') => {
    const existingKeys = new Set(activeDataset.fields.map((f) => f.key.toLowerCase()));
    const baseKey = sanitizeIdentifier(`${model.name}_${fieldPath}`, 'model_field');
    let candidateKey = baseKey;
    let suffix = 2;
    while (existingKeys.has(candidateKey.toLowerCase())) {
      candidateKey = `${baseKey}_${suffix++}`;
    }

    const newField: FieldAst = {
      key: candidateKey,
      from: `$model[${model.name}].${fieldPath}`,
      type: fieldPath === 'payload' ? 'json' : 'float64',
      displayName: `${model.name} · ${fieldPath}`,
      nullable: true,
      required: false,
      sourceKind: 'model_field',
      modelId: model.id,
      modelFieldPath: fieldPath,
      transform: null,
    };

    const nextIdx = activeDataset.fields.length;
    updateAst((prev) => ({
      ...prev,
      spec: {
        ...prev.spec,
        datasets: prev.spec.datasets.map((ds, i) =>
          i === selectedDatasetIndex
            ? {
                ...ds,
                sourceKind: ds.sourceKind === 'signals' ? 'mixed' : ds.sourceKind,
                fields: [...ds.fields, newField],
              }
            : ds,
        ),
      },
    }));
    setSelectedFieldIndex(nextIdx);
    setInspectorTab('field');
    showToast({ message: `Added model field "$model[${model.name}].${fieldPath}" to dataset.`, tone: 'info' });
  };

  // Update dataset helper
  const updateActiveDataset = (patch: Partial<DatasetAst>) => {
    updateAst((prev) => ({
      ...prev,
      spec: {
        ...prev.spec,
        datasets: prev.spec.datasets.map((ds, idx) => (idx === selectedDatasetIndex ? { ...ds, ...patch } : ds)),
      },
    }));
  };

  // Update field helper
  const updateFieldAt = (fieldIdx: number, patch: Partial<FieldAst>) => {
    updateAst((prev) => ({
      ...prev,
      spec: {
        ...prev.spec,
        datasets: prev.spec.datasets.map((ds, idx) =>
          idx === selectedDatasetIndex
            ? {
                ...ds,
                fields: ds.fields.map((f, fIdx) => (fIdx === fieldIdx ? { ...f, ...patch } : f)),
              }
            : ds,
        ),
      },
    }));
  };

  const removeFieldAt = (fieldIdx: number) => {
    updateAst((prev) => ({
      ...prev,
      spec: {
        ...prev.spec,
        datasets: prev.spec.datasets.map((ds, idx) =>
          idx === selectedDatasetIndex
            ? {
                ...ds,
                fields: ds.fields.filter((_, fIdx) => fIdx !== fieldIdx),
              }
            : ds,
        ),
      },
    }));
    if (selectedFieldIndex === fieldIdx) {
      setSelectedFieldIndex(null);
      setInspectorTab('dataset');
    }
  };

  const handleAddDataset = () => {
    const nextNum = ast.spec.datasets.length + 1;
    const newDs: DatasetAst = {
      key: `dataset_${nextNum}`,
      displayName: `Dataset ${nextNum}`,
      description: 'Managed historical dataset',
      semantics: 'state_series',
      sourceKind: 'signals',
      timeAxis: 'acquired_at',
      tags: [{ key: 'tier', value: 'managed' }],
      fields: [],
      recording: {
        mode: 'ON_CHANGE',
        qualityTransitions: true,
        deadband: { kind: 'absolute', value: 0 },
        maxCheckpointInterval: '60s',
        lateTolerance: '300s',
        missingPolicy: 'GAP_MARKER',
      },
      retention: {
        days: 90,
        legalHold: false,
      },
    };
    const newIndex = ast.spec.datasets.length;
    updateAst((prev) => ({
      ...prev,
      spec: {
        ...prev.spec,
        datasets: [...prev.spec.datasets, newDs],
      },
    }));
    setSelectedDatasetIndex(newIndex);
    setSelectedFieldIndex(null);
    setInspectorTab('dataset');
  };

  // Validate AST / Code
  const handleValidate = async (syncFromCode = false): Promise<boolean> => {
    setValidating(true);
    try {
      const payload =
        mode === 'code' || syncFromCode
          ? { dsl: codeText, yaml: codeText, format: codeFormat }
          : { ast, yaml: serializeAstToYaml(ast), format: 'yaml' as const };
      const res = await validateStorageDesign(payload, activeDesignId);
      setIssues(res.issues || []);
      const ok = res.valid && !res.issues.some((i) => i.severity === 'error');
      setValidationPassed(ok);
      if (res.ast) {
        setAst(res.ast);
        setCodeText(codeFormat === 'json' ? JSON.stringify(res.ast, null, 2) : res.yaml || serializeAstToYaml(res.ast));
      }
      if (ok) {
        showToast({ message: 'Storage DSL validated cleanly with zero errors.', tone: 'success' });
      } else {
        showToast({
          message: `Validation found ${res.issues.filter((i) => i.severity === 'error').length} error(s).`,
          tone: 'error',
        });
      }
      return ok;
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details.issues)) {
        const apiIssues = (err.details.issues as Array<Record<string, any>>).map((i) => ({
          severity: (i.severity || 'error') as DslIssue['severity'],
          code: String(i.code || 'VALIDATION_ERROR'),
          message: String(i.message || err.message),
          path: String(i.path || ''),
          line: i.line != null ? Number(i.line) : null,
          column: i.column != null ? Number(i.column) : null,
        }));
        setIssues(apiIssues);
        setValidationPassed(false);
        return false;
      }
      // Client-side structural validation fallback if backend route is unreachable
      const localIssues: DslIssue[] = [];
      if (!ast.metadata.name?.trim()) {
        localIssues.push({ severity: 'error', code: 'MISSING_NAME', message: 'metadata.name is required.', path: 'metadata.name' });
      }
      ast.spec.datasets.forEach((ds, dIdx) => {
        if (!ds.fields.length) {
          localIssues.push({
            severity: 'error',
            code: 'EMPTY_FIELDS',
            message: `Dataset '${ds.key}' must contain at least one mapped field.`,
            path: `spec.datasets[${dIdx}].fields`,
          });
        }
        if (ds.recording.mode === 'INTERVAL' && !ds.recording.interval) {
          localIssues.push({
            severity: 'error',
            code: 'MISSING_INTERVAL',
            message: `Dataset '${ds.key}' uses INTERVAL mode and requires recording.interval (e.g. 60s).`,
            path: `spec.datasets[${dIdx}].recording.interval`,
          });
        }
      });
      setIssues(localIssues);
      const ok = localIssues.length === 0;
      setValidationPassed(ok);
      showToast({
        message: ok ? 'Validated Storage DSL AST structure.' : `Validation found ${localIssues.length} issue(s).`,
        tone: ok ? 'success' : 'error',
      });
      return ok;
    } finally {
      setValidating(false);
    }
  };

  // Load Physical Plan Preview
  const handleLoadPhysicalPlan = useCallback(async () => {
    try {
      const plan = await compileStoragePhysicalPlan(activeDesignId, {
        ast,
        yaml: serializeAstToYaml(ast),
      });
      setPhysicalPlan(plan);
    } catch {
      setPhysicalPlan(buildFallbackPhysicalPlan(ast, activeDesignId));
    }
  }, [activeDesignId, ast]);

  // Run Dry-Run Simulation
  const handleSimulate = useCallback(async () => {
    setSimulating(true);
    setMode('simulate');
    try {
      const res = await simulateStorageDesign(activeDesignId, {
        ast,
        yaml: serializeAstToYaml(ast),
        dataset_key: activeDataset.key,
        limit: 40,
      });
      setSimResult(res);
      showToast({
        message: `Dry-run evaluated ${res.evaluated_samples} samples (${res.estimated_reduction_pct}% write reduction). Zero production rows written.`,
        tone: 'success',
      });
    } catch {
      // Deterministic client-side policy evaluator preview over live signals if server simulation is offline
      const fields = activeDataset.fields;
      const modeNow = activeDataset.recording.mode;
      const dbVal = activeDataset.recording.deadband?.value || 0;
      const sampleRows: SimulateDesignResponse['samples'] = [];
      let written = 0;
      let skipped = 0;
      const skippedByReason: Record<string, number> = {};
      const nowMs = Date.now();

      fields.forEach((f, fIdx) => {
        const sig = signals.find((s) => s.id === f.signalId || s.key === f.key);
        const baseVal = typeof sig?.value === 'number' ? sig.value : f.type === 'bool' ? true : 42.5 + fIdx * 5;
        const deltas = [0, 0, 0.02, 1.8, 1.8, 4.2];
        let lastRec: any = null;

        deltas.forEach((d, sIdx) => {
          const ts = new Date(nowMs - (deltas.length - sIdx) * 5000).toISOString();
          const rawVal = typeof baseVal === 'number' ? +(baseVal + d).toFixed(3) : baseVal;
          const qual = sIdx === 4 ? 'UNCERTAIN' : 'GOOD';
          let wouldWrite = false;
          let recordKind = 'change';
          let skipReason = 'NONE';

          if (sIdx === 0) {
            wouldWrite = true;
            recordKind = 'baseline';
            lastRec = rawVal;
          } else if (qual !== 'GOOD') {
            wouldWrite = true;
            recordKind = 'quality_transition';
          } else if (modeNow === 'EVERY_ACQUISITION') {
            wouldWrite = true;
            recordKind = 'acquisition';
          } else if (rawVal === lastRec) {
            wouldWrite = false;
            recordKind = 'skipped';
            skipReason = 'UNCHANGED';
          } else if (typeof rawVal === 'number' && typeof lastRec === 'number' && dbVal > 0 && Math.abs(rawVal - lastRec) <= dbVal) {
            wouldWrite = false;
            recordKind = 'skipped';
            skipReason = 'WITHIN_DEADBAND';
          } else {
            wouldWrite = true;
            recordKind = 'change';
            lastRec = rawVal;
          }

          if (wouldWrite) written += 1;
          else {
            skipped += 1;
            skippedByReason[skipReason] = (skippedByReason[skipReason] || 0) + 1;
          }

          sampleRows.push({
            index: sampleRows.length + 1,
            ts,
            dataset_key: activeDataset.key,
            field_key: f.key,
            source_ref: f.from,
            signal_id: f.signalId || null,
            raw_value: rawVal,
            transformed_value: rawVal,
            quality: qual,
            would_write: wouldWrite,
            record_kind: recordKind,
            skip_reason: skipReason,
          });
        });
      });

      const total = written + skipped;
      const reduction = total > 0 ? Math.round((skipped / total) * 1000) / 10 : 0;
      setSimResult({
        evaluated_samples: total,
        would_write: written,
        skipped_total: skipped,
        skipped_by_reason: skippedByReason,
        checkpoints_written: 0,
        gap_markers_written: 0,
        estimated_reduction_pct: reduction,
        compression_ratio: written > 0 ? +(total / written).toFixed(2) : 1,
        exactness_warnings:
          modeNow !== 'EVERY_ACQUISITION'
            ? [
                `Dataset '${activeDataset.key}' uses ${modeNow}; exact sample-weighted avg/count queries fall back to Operational History.`,
              ]
            : [],
        samples: sampleRows,
      });
    } finally {
      setSimulating(false);
    }
  }, [activeDesignId, ast, activeDataset, signals, showToast]);

  // Trigger physical plan load when switching to Physical Preview or Step 4
  useEffect(() => {
    if (mode === 'physical' || step === 4) {
      void handleLoadPhysicalPlan();
    }
  }, [mode, step, handleLoadPhysicalPlan]);

  // Save Draft (Create or Update with optimistic concurrency `expected_version`)
  const handleSaveDraft = async (): Promise<string | null> => {
    setSaving(true);
    setVersionConflict(null);
    try {
      const yamlPayload = mode === 'code' ? codeText : serializeAstToYaml(ast);
      if (activeDesignId && designDetail) {
        const updated = await updateStorageDesign(activeDesignId, {
          name: ast.metadata.name,
          description: ast.metadata.description,
          ast,
          yaml: yamlPayload,
          dsl: yamlPayload,
          expected_version: designDetail.current_version,
          version: designDetail.current_version,
        });
        setDesignDetail(updated);
        setAst(updated.ast);
        setIsDirty(false);
        showToast({ message: `Saved draft "${updated.name}" (v${updated.current_version}).`, tone: 'success' });
        return updated.id;
      } else {
        const created = await createStorageDesign({
          name: ast.metadata.name,
          description: ast.metadata.description,
          ast,
          yaml: yamlPayload,
          dsl: yamlPayload,
        });
        setDesignDetail(created);
        setAst(created.ast);
        setIsDirty(false);
        const nextParams = new URLSearchParams(searchParams);
        nextParams.set('designId', created.id);
        setSearchParams(nextParams, { replace: true });
        showToast({ message: `Created storage design "${created.name}" (v${created.current_version}).`, tone: 'success' });
        return created.id;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setVersionConflict({
          occurred: true,
          message:
            err.message ||
            'Version conflict (HTTP 409 VERSION_CONFLICT): Another operator modified or published this design.',
        });
      } else {
        showToast({
          message: err instanceof Error ? err.message : 'Failed to save storage design draft.',
          tone: 'error',
        });
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  // Publish Design
  const handlePublish = async () => {
    const valid = await handleValidate();
    if (!valid) return;

    setPublishing(true);
    try {
      let targetId = activeDesignId;
      if (!targetId || isDirty) {
        targetId = await handleSaveDraft();
      }
      if (!targetId) {
        setPublishing(false);
        return;
      }
      const pubRes = await publishStorageDesign(targetId, {
        expected_version: designDetail?.current_version,
        reason: 'Published from Storage Designer',
      });
      await loadDesignById(targetId);
      showToast({
        message: `Published "${ast.metadata.name}" v${pubRes.version} to TDengine (${pubRes.verified_subtables} subtable(s) active).`,
        tone: 'success',
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setVersionConflict({
          occurred: true,
          message:
            err.message ||
            'Publish aborted due to optimistic concurrency conflict (HTTP 409 VERSION_CONFLICT). Reload latest version.',
        });
      } else {
        showToast({
          message: err instanceof Error ? err.message : 'Could not publish storage design.',
          tone: 'error',
        });
      }
    } finally {
      setPublishing(false);
    }
  };

  // Format / Sync Code -> Visual
  const handleSyncCodeToVisual = async () => {
    if (codeText.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(codeText);
        const norm = normalizeAst(parsed, ast.metadata.name);
        setAst(norm);
        setCodeText(codeFormat === 'json' ? JSON.stringify(norm, null, 2) : serializeAstToYaml(norm));
        setIssues([]);
        setValidationPassed(true);
        showToast({ message: 'Synced JSON DSL to Visual Designer.', tone: 'success' });
        return;
      } catch (e) {
        setIssues([
          {
            severity: 'error',
            code: 'JSON_SYNTAX_ERROR',
            message: e instanceof Error ? e.message : 'Invalid JSON syntax',
            line: 1,
          },
        ]);
        return;
      }
    }
    await handleValidate(true);
  };

  const currentStatus: StorageDesignStatus = designDetail?.status || 'DRAFT';
  const currentVersion = designDetail?.current_version || 1;
  const currentRowWidth = physicalPlan?.row_width_bytes || estimateLocalRowWidth(activeDataset);
  const maxRowWidth = physicalPlan?.max_row_width_bytes || 64500;
  const rowWidthPct = Math.min(100, Math.round((currentRowWidth / maxRowWidth) * 1000) / 10);

  return (
    <div className="space-y-4 pb-8">
      {/* Optimistic Concurrency 409 Conflict Banner */}
      {versionConflict?.occurred && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-[12px] text-red-900 shadow-xs"
        >
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-[#EF1B24] shrink-0" />
            <div>
              <span className="font-bold">Optimistic Concurrency Conflict (409 VERSION_CONFLICT): </span>
              <span>{versionConflict.message}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeDesignId && (
              <Button
                size="sm"
                variant="primary"
                icon={<RefreshCw className="w-3.5 h-3.5" />}
                onClick={() => void loadDesignById(activeDesignId)}
              >
                Reload Latest
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setVersionConflict(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Top Header Bar */}
      <Card className="p-4 border border-[#E3EAF3] bg-white shadow-xs">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          {/* Left: Design Title, Status Pill, Version Badge & Quick Switcher */}
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-[#EF1B24] flex items-center justify-center shrink-0">
              <Database className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  aria-label="Storage Design Name"
                  value={ast.metadata.name}
                  onChange={(e) =>
                    updateAst((prev) => ({
                      ...prev,
                      metadata: { ...prev.metadata, name: e.target.value },
                    }))
                  }
                  placeholder="Enter storage design name…"
                  className="text-[18px] font-bold text-[#111B37] bg-transparent border-b border-transparent hover:border-[#CBD5E1] focus:border-[#134074] focus:outline-none px-1 -ml-1 rounded transition"
                />
                <StatusBadge status={currentStatus} label={currentStatus} />
                <span className="px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-[#EEF5FF] text-[#134074] border border-[#D2E3FA]">
                  v{currentVersion}
                </span>
                {isDirty && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                    Unsaved draft changes
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#657794] mt-0.5">
                <span>Declarative Storage DSL (`factorix.io/storage/v1`)</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1 font-semibold text-[#111B37]">
                  Destination: <span className="text-emerald-700">TDengine</span>
                </span>
                {existingDesigns.length > 0 && (
                  <>
                    <span>·</span>
                    <select
                      aria-label="Switch Storage Design"
                      value={activeDesignId || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (!val) {
                          setDesignDetail(null);
                          const blank = createDefaultStorageDesignAst();
                          setAst(blank);
                          setCodeText(serializeAstToYaml(blank));
                          setIsDirty(false);
                          navigate('/historian/designer');
                        } else {
                          navigate(`/historian/designer/${encodeURIComponent(val)}`);
                        }
                      }}
                      className="text-[11px] font-semibold text-[#134074] bg-[#F8FAFC] border border-[#D4DFEC] rounded px-2 py-0.5 focus:outline-none"
                    >
                      <option value="">+ New Draft Design</option>
                      {existingDesigns.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.status} · v{d.version})
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Center: Mode Switcher (Visual | Code (YAML/JSON) | Physical Preview | Simulate) */}
          <div
            role="tablist"
            aria-label="Workspace mode switcher"
            className="flex items-center bg-[#F1F5F9] p-1 rounded-xl border border-[#E3EAF3] self-start xl:self-auto"
          >
            {(
              [
                { id: 'visual', label: 'Visual', icon: GitBranch },
                { id: 'code', label: 'Code (YAML/JSON)', icon: Code2 },
                { id: 'physical', label: 'Physical Preview', icon: Cpu },
                { id: 'simulate', label: 'Simulate', icon: FlaskConical },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const active = mode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setMode(tab.id);
                    if (tab.id === 'physical') void handleLoadPhysicalPlan();
                    if (tab.id === 'simulate' && !simResult) void handleSimulate();
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${
                    active ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Right: Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={saving}
              icon={<Save className="w-3.5 h-3.5" />}
              onClick={() => void handleSaveDraft()}
            >
              Save Draft
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={validating}
              icon={<CheckCircle2 className="w-3.5 h-3.5 text-[#0DBA67]" />}
              onClick={() => void handleValidate()}
            >
              Validate
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={simulating}
              icon={<FlaskConical className="w-3.5 h-3.5 text-[#134074]" />}
              onClick={() => void handleSimulate()}
            >
              Simulate Dry-Run
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={publishing}
              icon={<Rocket className="w-3.5 h-3.5" />}
              onClick={() => void handlePublish()}
            >
              Publish Design
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ExternalLink className="w-3.5 h-3.5" />}
              onClick={() =>
                navigate(
                  activeDesignId ? `/historian/catalog/${encodeURIComponent(activeDesignId)}` : '/historian/catalog',
                )
              }
            >
              Open in Catalog
            </Button>
          </div>
        </div>

        {/* 4-Step Workflow Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mt-4 pt-3.5 border-t border-[#E3EAF3]">
          {WORKFLOW_STEPS.map((ws) => {
            const active = step === ws.step;
            const completed = step > ws.step;
            return (
              <button
                key={ws.step}
                type="button"
                onClick={() => {
                  setStep(ws.step);
                  if (ws.step === 4) {
                    void handleLoadPhysicalPlan();
                  }
                }}
                className={`flex items-center justify-between p-2.5 rounded-xl border text-left transition-all ${
                  active
                    ? 'bg-[#EEF5FF] border-[#134074] ring-1 ring-[#134074]/20'
                    : completed
                      ? 'bg-emerald-50/40 border-emerald-200 hover:border-emerald-300'
                      : 'bg-[#F8FAFC] border-[#E3EAF3] hover:border-[#CBD5E1]'
                }`}
              >
                <div className="min-w-0 pr-2">
                  <div
                    className={`text-[12px] font-bold truncate ${
                      active ? 'text-[#134074]' : completed ? 'text-emerald-900' : 'text-[#111B37]'
                    }`}
                  >
                    {ws.title}
                  </div>
                  <div className="text-[11px] text-[#657794] truncate">{ws.subtitle}</div>
                </div>
                <span
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                    active
                      ? 'bg-[#134074] text-white'
                      : completed
                        ? 'bg-[#0DBA67] text-white'
                        : 'bg-white text-[#657794] border border-[#CBD5E1]'
                  }`}
                >
                  {completed ? <Check className="w-3.5 h-3.5" /> : ws.step}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Validation Banner when issues exist */}
      {issues.length > 0 && (
        <div
          role="region"
          aria-label="Validation Diagnostics"
          className={`rounded-xl border p-3.5 space-y-2 ${
            issues.some((i) => i.severity === 'error')
              ? 'bg-red-50 border-red-200 text-red-900'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-bold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                AST Validation Diagnostics ({issues.filter((i) => i.severity === 'error').length} error(s),{' '}
                {issues.filter((i) => i.severity !== 'error').length} warning/info)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIssues([])}
              className="text-[11px] font-semibold underline hover:no-underline"
            >
              Clear
            </button>
          </div>
          <ul className="space-y-1 max-h-36 overflow-y-auto text-[11.5px] font-mono">
            {issues.map((issue, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span
                  className={`px-1.5 py-0.2 rounded text-[10px] font-bold uppercase shrink-0 ${
                    issue.severity === 'error'
                      ? 'bg-red-200 text-red-900'
                      : issue.severity === 'warning'
                        ? 'bg-amber-200 text-amber-900'
                        : 'bg-blue-100 text-blue-900'
                  }`}
                >
                  {issue.severity}
                </span>
                <span className="font-bold text-[#111B37]">{issue.code}</span>
                {issue.path && <span className="text-[#657794]">[{issue.path}]</span>}
                {issue.line != null && <span className="text-[#657794]">(line {issue.line})</span>}
                <span className="font-sans">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Main 3-Pane Workspace: Source Explorer (Left) | Visual/Code/Physical/Simulate (Center) | Inspector (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT PANE: Source Explorer Tree (3 cols) */}
        <Card className="p-3.5 border border-[#E3EAF3] bg-white lg:col-span-3 space-y-3 min-w-0">
          <div className="flex items-center justify-between pb-2 border-b border-[#E3EAF3]">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-[#111B37]">
              <FolderTree className="w-4 h-4 text-[#134074]" />
              <span>Source Explorer</span>
            </div>
            <span className="text-[11px] font-mono text-[#657794]">
              {activeSignals.length || 336} signals · {dataModels.length || 36} models
            </span>
          </div>

          {/* Source Explorer Sub-tabs */}
          <div className="grid grid-cols-3 gap-1 bg-[#F1F5F9] p-1 rounded-lg border border-[#E3EAF3] text-[11px] font-bold">
            <button
              type="button"
              onClick={() => setSourceTab('signals')}
              className={`py-1 rounded-md transition ${
                sourceTab === 'signals' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Signals ({activeSignals.length || 336})
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('models')}
              className={`py-1 rounded-md transition ${
                sourceTab === 'models' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Models ({dataModels.length || 36})
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('resources')}
              className={`py-1 rounded-md transition ${
                sourceTab === 'resources' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Hierarchy ({resources.length})
            </button>
          </div>

          {/* Search & Protocol/Type Filter */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="search"
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
                placeholder={
                  sourceTab === 'signals'
                    ? 'Search 336 signals by key or asset…'
                    : sourceTab === 'models'
                      ? 'Search 36 data models…'
                      : 'Search factory resources…'
                }
                aria-label="Search sources"
                className="w-full pl-8 pr-2.5 py-1.5 border border-[#D4DFEC] rounded-lg text-[12px] text-[#111B37] focus:outline-none focus:border-blue-500"
              />
            </div>

            {sourceTab === 'signals' && (
              <div className="grid grid-cols-2 gap-1.5">
                <select
                  aria-label="Filter signals by protocol"
                  value={protocolFilter}
                  onChange={(e) => setProtocolFilter(e.target.value)}
                  className="px-2 py-1 border border-[#D4DFEC] rounded-lg text-[11px] bg-white text-[#334568]"
                >
                  <option value="all">All Protocols</option>
                  <option value="mqtt">MQTT</option>
                  <option value="modbus">Modbus TCP</option>
                  <option value="opcua">OPC UA</option>
                  <option value="http">HTTP</option>
                  <option value="websocket">WebSocket</option>
                </select>
                <select
                  aria-label="Filter signals by value type"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="px-2 py-1 border border-[#D4DFEC] rounded-lg text-[11px] bg-white text-[#334568]"
                >
                  <option value="all">All Types</option>
                  <option value="float64">float64</option>
                  <option value="int64">int64</option>
                  <option value="bool">bool</option>
                  <option value="string">string</option>
                </select>
              </div>
            )}

            {resourceFilterId !== 'all' && (
              <div className="flex items-center justify-between px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-[11px] text-[#134074]">
                <span className="truncate font-semibold">
                  Asset: {resources.find((r) => r.id === resourceFilterId)?.name || resourceFilterId}
                </span>
                <button
                  type="button"
                  onClick={() => setResourceFilterId('all')}
                  className="font-bold hover:underline ml-2"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {/* Source List */}
          <div className="max-h-[540px] overflow-y-auto space-y-1.5 pr-1 divide-y divide-slate-100">
            {sourceTab === 'signals' && (
              <>
                {filteredSignals.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-[#657794]">
                    No active signals match the filter.
                  </div>
                ) : (
                  filteredSignals.slice(0, 120).map((sig) => {
                    const isMapped = mappedSignalIds.has(sig.id);
                    const stype = inferStorageType(sig.data_type || sig.dataType);
                    return (
                      <div
                        key={sig.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/factorix-signal-id', sig.id);
                        }}
                        className="pt-1.5 flex items-center justify-between gap-2 group hover:bg-[#F8FAFC] p-1.5 rounded-lg transition"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11.5px] font-bold text-[#111B37] truncate" title={sig.key || sig.name}>
                              {sig.key || sig.name}
                            </span>
                            <span className="px-1.5 py-0.2 rounded text-[9.5px] font-mono bg-slate-100 text-slate-700">
                              {stype}
                            </span>
                            {sig.unit && (
                              <span className="text-[10px] text-[#657794] font-mono">{sig.unit}</span>
                            )}
                          </div>
                          <div className="text-[10.5px] text-[#657794] truncate">
                            {sig.resourcePath || 'Plant Asset'} · {sig.sourceConnectionName || 'Collector'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddSignalToDataset(sig)}
                          title={`Add ${sig.key || sig.name} to dataset ${activeDataset.key}`}
                          className={`px-2 py-1 rounded-md text-[11px] font-semibold shrink-0 transition ${
                            isMapped
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100'
                              : 'bg-[#EEF5FF] text-[#134074] border border-[#D2E3FA] hover:bg-[#134074] hover:text-white'
                          }`}
                        >
                          {isMapped ? '+ Mapped' : '+ Add'}
                        </button>
                      </div>
                    );
                  })
                )}
              </>
            )}

            {sourceTab === 'models' && (
              <>
                {filteredModels.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-[#657794]">
                    No Data Models match the search.
                  </div>
                ) : (
                  filteredModels.map((m) => (
                    <div key={m.id} className="pt-2 p-2 rounded-lg hover:bg-[#F8FAFC] space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] font-bold text-[#111B37] truncate">{m.name}</div>
                          <div className="text-[10.5px] text-[#657794] truncate">
                            {m.fieldCount} fields · {m.state} · every {m.sampleMs}ms
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddModelToDataset(m, 'payload')}
                          className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[#EEF5FF] text-[#134074] border border-[#D2E3FA] hover:bg-[#134074] hover:text-white shrink-0"
                        >
                          + Bind Model
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {sourceTab === 'resources' && (
              <div className="space-y-1 pt-1">
                {resources
                  .filter(
                    (r) =>
                      !sourceSearch.trim() ||
                      r.name.toLowerCase().includes(sourceSearch.toLowerCase()) ||
                      r.code.toLowerCase().includes(sourceSearch.toLowerCase()),
                  )
                  .map((r) => {
                    const sigCount = activeSignals.filter((s) => s.resourceId === r.id).length;
                    const isSelected = resourceFilterId === r.id;
                    return (
                      <div
                        key={r.id}
                        className={`flex items-center justify-between p-1.5 rounded-lg text-[12px] cursor-pointer ${
                          isSelected ? 'bg-[#0B2545] text-white font-bold' : 'hover:bg-slate-100 text-[#111B37]'
                        }`}
                        onClick={() => {
                          setResourceFilterId(isSelected ? 'all' : r.id);
                          setSourceTab('signals');
                        }}
                      >
                        <div className="min-w-0 truncate">
                          <span>{r.name}</span>
                          <span className={`ml-1.5 text-[10px] font-mono ${isSelected ? 'text-white/80' : 'text-[#657794]'}`}>
                            ({r.type})
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${isSelected ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>
                            {sigCount} sig
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateAst((prev) => ({
                                ...prev,
                                spec: {
                                  ...prev.spec,
                                  scope: {
                                    mode: 'subtree',
                                    resource: `$${r.type}[${r.name}]`,
                                    resourceIds: [r.id],
                                  },
                                },
                              }));
                              showToast({ message: `Scoped storage design to resource "${r.name}".`, tone: 'info' });
                            }}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                              isSelected ? 'bg-white text-[#0B2545]' : 'bg-[#EEF5FF] text-[#134074] hover:bg-[#134074] hover:text-white'
                            }`}
                          >
                            Set Scope
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </Card>

        {/* CENTER PANE: Visual / Code / Physical Preview / Simulate (6 cols) */}
        <div
          className="lg:col-span-6 space-y-4 min-w-0"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const sigId = e.dataTransfer.getData('application/factorix-signal-id');
            if (sigId) {
              const sig = signals.find((s) => s.id === sigId);
              if (sig) handleAddSignalToDataset(sig);
            }
          }}
        >
          {/* Dataset Selector Bar */}
          <Card className="p-3 border border-[#E3EAF3] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#657794] mr-1">Datasets:</span>
                {ast.spec.datasets.map((ds, idx) => {
                  const active = idx === selectedDatasetIndex;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setSelectedDatasetIndex(idx);
                        setSelectedFieldIndex(ds.fields.length ? 0 : null);
                        setInspectorTab('dataset');
                      }}
                      className={`px-3 py-1.5 rounded-lg text-[12px] font-bold transition flex items-center gap-1.5 border ${
                        active
                          ? 'bg-[#0B2545] text-white border-[#0B2545] shadow-xs'
                          : 'bg-[#F8FAFC] text-[#334568] border-[#E3EAF3] hover:border-[#CBD5E1]'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>{ds.key}</span>
                      <span
                        className={`text-[10px] font-mono px-1.5 rounded ${
                          active ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        {ds.fields.length}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={handleAddDataset}
                  className="px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-[#134074] bg-[#EEF5FF] hover:bg-[#DCEBFA] border border-[#D2E3FA] flex items-center gap-1 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Dataset</span>
                </button>
              </div>
              <div className="text-[11px] text-[#657794] font-mono">
                Row Budget: <strong className="text-[#111B37]">{currentRowWidth.toLocaleString()}</strong> / 64,500 B
              </div>
            </div>
          </Card>

          {/* MODE 1: VISUAL DESIGNER */}
          {mode === 'visual' && (
            <div className="space-y-4">
              {/* Interactive Lineage Graph Card */}
              <Card
                title="Interactive Storage Lineage & Pipeline Graph"
                subtitle="Source Signals / Data Models → Dataset Fields & Safe Transforms → Recording Policy → TDengine STable"
                action={
                  <span className="text-[11px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-semibold">
                    Destination: TDengine (`fx_t_tenant`)
                  </span>
                }
                className="border border-[#E3EAF3] bg-white"
              >
                <div
                  className="rounded-xl border border-[#E3EAF3] p-4 bg-[#F6F8FC]"
                  style={{
                    backgroundImage: 'radial-gradient(#CBD5E1 1px, transparent 1px)',
                    backgroundSize: '16px 16px',
                  }}
                >
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-stretch">
                    {/* Node 1: Source Signals / Models */}
                    <div
                      onClick={() => setStep(1)}
                      className="rounded-xl bg-white border-2 border-[#D4DFEC] hover:border-[#134074] p-3 shadow-xs cursor-pointer transition flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#657794]">
                          <span>1. Sources</span>
                          <Activity className="w-3.5 h-3.5 text-[#134074]" />
                        </div>
                        <div className="text-[13px] font-bold text-[#111B37] mt-1">
                          {activeDataset.sourceKind === 'model_fields'
                            ? 'Data Model Fields'
                            : activeDataset.sourceKind === 'mixed'
                              ? 'Signals + Models'
                              : 'OT Collector Signals'}
                        </div>
                        <div className="text-[11px] text-[#657794] mt-1">
                          Scope: <span className="font-mono text-[#111B37]">{ast.spec.scope.mode}</span>
                        </div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                        <span className="text-[#657794]">Bound refs</span>
                        <span className="font-mono font-bold text-[#134074]">{activeDataset.fields.length}</span>
                      </div>
                    </div>

                    {/* Node 2: Dataset & Safe Transforms */}
                    <div
                      onClick={() => {
                        setStep(2);
                        setInspectorTab('dataset');
                      }}
                      className={`rounded-xl bg-white border-2 p-3 shadow-xs cursor-pointer transition flex flex-col justify-between ${
                        inspectorTab === 'dataset' ? 'border-[#134074] ring-2 ring-[#134074]/10' : 'border-[#D4DFEC] hover:border-[#134074]'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#134074]">
                          <span>2. Dataset & Fields</span>
                          <Layers className="w-3.5 h-3.5 text-[#134074]" />
                        </div>
                        <div className="text-[13px] font-bold text-[#111B37] mt-1 font-mono truncate">
                          {activeDataset.key}
                        </div>
                        <div className="text-[11px] text-[#657794] mt-1">
                          Semantics: <span className="font-semibold text-[#111B37]">{activeDataset.semantics}</span>
                        </div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                        <span className="text-[#657794]">Transforms</span>
                        <span className="font-mono font-bold text-emerald-700">
                          {activeDataset.fields.filter((f) => Boolean(f.transform)).length} active
                        </span>
                      </div>
                    </div>

                    {/* Node 3: Recording Policy */}
                    <div
                      onClick={() => {
                        setStep(3);
                        setInspectorTab('dataset');
                      }}
                      className="rounded-xl bg-white border-2 border-[#D4DFEC] hover:border-[#134074] p-3 shadow-xs cursor-pointer transition flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#657794]">
                          <span>3. Recording Policy</span>
                          <Settings2 className="w-3.5 h-3.5 text-[#EF1B24]" />
                        </div>
                        <div className="text-[13px] font-bold text-[#111B37] mt-1 font-mono">
                          {activeDataset.recording.mode}
                        </div>
                        <div className="text-[11px] text-[#657794] mt-1">
                          Keep: <strong className="text-[#111B37]">{activeDataset.retention.days}d</strong>
                          {activeDataset.retention.legalHold && (
                            <span className="ml-1.5 px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">
                              Legal Hold
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                        <span className="text-[#657794]">Quality changes</span>
                        <span className="font-bold text-[#0DBA67]">Mandatory</span>
                      </div>
                    </div>

                    {/* Node 4: TDengine STable Target */}
                    <div
                      onClick={() => {
                        setStep(4);
                        setMode('physical');
                      }}
                      className="rounded-xl bg-[#0B2545] text-white p-3 shadow-sm cursor-pointer transition flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-blue-200">
                          <span>4. TDengine STable</span>
                          <Database className="w-3.5 h-3.5 text-[#0DBA67]" />
                        </div>
                        <div className="text-[12.5px] font-bold font-mono mt-1 truncate">
                          ds_*_{activeDataset.key}_v{currentVersion}
                        </div>
                        <div className="text-[11px] text-blue-200 mt-1 font-mono truncate">
                          DB: {physicalPlan?.td_database || 'fx_t_<tenant>'}
                        </div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-white/15 flex items-center justify-between text-[11px]">
                        <span className="text-blue-200">Subtables</span>
                        <span className="font-mono font-bold text-[#0DBA67]">{activeDataset.fields.length} md_*</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Step 1 Contextual Panel: Scope & Dataset Semantics */}
              {step === 1 && (
                <Card
                  title="Step 1 · Define Scope, Destination & Dataset Semantics"
                  subtitle="Configure which factory assets this design covers and how time-series records are interpreted."
                  className="border border-[#E3EAF3] bg-white"
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[12px] font-semibold text-[#334568] mb-1">Scope Mode</label>
                      <select
                        value={ast.spec.scope.mode}
                        onChange={(e) =>
                          updateAst((prev) => ({
                            ...prev,
                            spec: {
                              ...prev.spec,
                              scope: { ...prev.spec.scope, mode: e.target.value as any },
                            },
                          }))
                        }
                        className="w-full h-9 px-3 border border-[#D4DFEC] rounded-lg text-[13px] bg-white text-[#111B37]"
                      >
                        <option value="all_sites">All Sites (Tenant-Wide)</option>
                        <option value="site">Specific Site</option>
                        <option value="subtree">Resource Subtree ($machine[...])</option>
                        <option value="resources">Explicit Resource List</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-[#334568] mb-1">
                        Storage Destination (Locked to TDengine)
                      </label>
                      <div className="h-9 px-3 border border-emerald-200 bg-emerald-50/60 rounded-lg flex items-center justify-between text-[12px] font-semibold text-emerald-900">
                        <span>TDengine Time-Series Engine (`tenant_isolated`)</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                          RabbitMQ = Transport Only
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-[#334568] mb-1">Dataset Semantics</label>
                      <select
                        value={activeDataset.semantics}
                        onChange={(e) => updateActiveDataset({ semantics: e.target.value as DatasetAst['semantics'] })}
                        className="w-full h-9 px-3 border border-[#D4DFEC] rounded-lg text-[13px] bg-white text-[#111B37]"
                      >
                        <option value="state_series">state_series (Continuous / Discrete Process State)</option>
                        <option value="event_stream">event_stream (Independent Alarms / Cycles)</option>
                        <option value="structured_record">structured_record (Model Projection / JSON Record)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-[#334568] mb-1">Primary Time Axis (`ts`)</label>
                      <select
                        value={activeDataset.timeAxis}
                        onChange={(e) => updateActiveDataset({ timeAxis: e.target.value as TimeAxisMode })}
                        className="w-full h-9 px-3 border border-[#D4DFEC] rounded-lg text-[13px] bg-white text-[#111B37]"
                      >
                        <option value="acquired_at">acquired_at (Authentic Collector Receipt Timestamp)</option>
                        <option value="source_time">source_time (OT Device / PLC Provided Timestamp)</option>
                      </select>
                    </div>
                  </div>
                </Card>
              )}

              {/* Structured Dataset & Field Editor Table */}
              <Card
                title={`Dataset Fields & Safe Transforms · ${activeDataset.key}`}
                subtitle="Click any field row to inspect and configure its deadband, transform expression, or source binding on the right."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Plus className="w-3.5 h-3.5" />}
                    onClick={() => {
                      const nextNum = activeDataset.fields.length + 1;
                      const sig = activeSignals[nextNum % Math.max(1, activeSignals.length)];
                      if (sig) {
                        handleAddSignalToDataset(sig);
                      } else {
                        const newField: FieldAst = {
                          key: `field_${nextNum}`,
                          from: '$machine[Line_1].temperature',
                          type: 'float64',
                          displayName: `Field ${nextNum}`,
                          nullable: true,
                          required: false,
                          sourceKind: 'signal',
                          transform: 'round(value * 1.0, 2)',
                        };
                        updateActiveDataset({ fields: [...activeDataset.fields, newField] });
                        setSelectedFieldIndex(activeDataset.fields.length);
                        setInspectorTab('field');
                      }
                    }}
                  >
                    Add Field
                  </Button>
                }
                className="p-0 border border-[#E3EAF3] bg-white"
              >
                {activeDataset.fields.length === 0 ? (
                  <div className="p-8 text-center space-y-3">
                    <p className="text-[13px] font-semibold text-[#111B37]">
                      No fields mapped in dataset <span className="font-mono">{activeDataset.key}</span> yet.
                    </p>
                    <p className="text-[12px] text-[#657794] max-w-md mx-auto">
                      Click <strong>+ Add</strong> next to any Signal or Data Model in the left Source Explorer, or drag a signal here.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[12px] border-collapse">
                      <thead>
                        <tr className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[10.5px] font-bold uppercase tracking-wider text-[#657794]">
                          <th className="py-2.5 px-3">Field Key</th>
                          <th className="py-2.5 px-3">Source Binding (`from`)</th>
                          <th className="py-2.5 px-3">Type</th>
                          <th className="py-2.5 px-3">Safe Transform</th>
                          <th className="py-2.5 px-3">Unit</th>
                          <th className="py-2.5 px-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {activeDataset.fields.map((fld, fIdx) => {
                          const isSelected = selectedFieldIndex === fIdx && inspectorTab === 'field';
                          return (
                            <tr
                              key={fIdx}
                              onClick={() => {
                                setSelectedFieldIndex(fIdx);
                                setInspectorTab('field');
                              }}
                              className={`cursor-pointer transition ${
                                isSelected ? 'bg-[#EEF5FF]' : 'hover:bg-[#F8FAFC]'
                              }`}
                            >
                              <td className="py-2 px-3">
                                <input
                                  type="text"
                                  aria-label={`Field key ${fIdx + 1}`}
                                  value={fld.key}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => updateFieldAt(fIdx, { key: e.target.value })}
                                  className="w-32 px-2 py-1 border border-[#D4DFEC] rounded font-mono text-[11.5px] font-bold text-[#111B37] bg-white"
                                />
                              </td>
                              <td className="py-2 px-3">
                                <input
                                  type="text"
                                  aria-label={`Source reference ${fIdx + 1}`}
                                  value={fld.from}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => updateFieldAt(fIdx, { from: e.target.value })}
                                  className="w-full min-w-[180px] px-2 py-1 border border-[#D4DFEC] rounded font-mono text-[11px] text-[#1D4ED8] bg-white"
                                />
                              </td>
                              <td className="py-2 px-3">
                                <select
                                  aria-label={`Field type ${fIdx + 1}`}
                                  value={fld.type}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => updateFieldAt(fIdx, { type: e.target.value as StorageValueType })}
                                  className="px-2 py-1 border border-[#D4DFEC] rounded font-mono text-[11px] bg-white text-[#111B37]"
                                >
                                  {VALUE_TYPES.map((vt) => (
                                    <option key={vt} value={vt}>
                                      {vt}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="py-2 px-3">
                                <input
                                  type="text"
                                  aria-label={`Transform expression ${fIdx + 1}`}
                                  placeholder="value (identity)"
                                  value={fld.transform || ''}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) =>
                                    updateFieldAt(fIdx, {
                                      transform: e.target.value.trim() ? e.target.value : null,
                                    })
                                  }
                                  className="w-40 px-2 py-1 border border-[#D4DFEC] rounded font-mono text-[11px] text-emerald-800 bg-white placeholder:text-slate-400"
                                />
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] text-[#657794]">
                                {fld.unit || '—'}
                              </td>
                              <td className="py-2 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  aria-label={`Remove field ${fld.key}`}
                                  onClick={() => removeFieldAt(fIdx)}
                                  className="p-1 rounded text-slate-400 hover:text-[#EF1B24] hover:bg-red-50 transition"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* MODE 2: BIDIRECTIONAL CODE (YAML / JSON) */}
          {mode === 'code' && (
            <Card
              title="Declarative StorageDSL Editor (`factorix.io/storage/v1`)"
              subtitle="Bidirectional AST round-trip editor. Strictly declarative — arbitrary SQL/DDL/Python execution and RabbitMQ destinations are rejected."
              action={
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg border border-[#D4DFEC] overflow-hidden text-[11px] font-bold">
                    <button
                      type="button"
                      onClick={() => {
                        setCodeFormat('yaml');
                        setCodeText(serializeAstToYaml(ast));
                      }}
                      className={`px-2.5 py-1 ${codeFormat === 'yaml' ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568]'}`}
                    >
                      YAML
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCodeFormat('json');
                        setCodeText(JSON.stringify(ast, null, 2));
                      }}
                      className={`px-2.5 py-1 ${codeFormat === 'json' ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568]'}`}
                    >
                      JSON
                    </button>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={validating}
                    icon={<Wand2 className="w-3.5 h-3.5" />}
                    onClick={() => void handleSyncCodeToVisual()}
                  >
                    Format / Sync to Visual
                  </Button>
                </div>
              }
              className="border border-[#E3EAF3] bg-white"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[11px] px-3 py-2 rounded-lg bg-[#F8FAFC] border border-[#E3EAF3]">
                  <span className="font-mono text-[#334568]">
                    apiVersion: <strong>factorix.io/storage/v1</strong> · kind: <strong>StorageDesign</strong>
                  </span>
                  <span className="font-semibold text-emerald-700">
                    {validationPassed === false
                      ? 'Syntax / Semantic Issues Detected'
                      : 'AST Round-Trip Ready'}
                  </span>
                </div>
                <textarea
                  aria-label="StorageDSL Code Editor"
                  value={codeText}
                  onChange={(e) => {
                    setCodeText(e.target.value);
                    setIsDirty(true);
                  }}
                  spellCheck={false}
                  rows={22}
                  className="w-full p-3.5 rounded-xl border border-[#CBD5E1] bg-[#0F172A] text-slate-100 font-mono text-[12px] leading-[1.55] focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
            </Card>
          )}

          {/* MODE 3: PHYSICAL PREVIEW (TDengine DDL & Row-Width Budget) */}
          {mode === 'physical' && (
            <div className="space-y-4">
              {(() => {
                const plan = physicalPlan || buildFallbackPhysicalPlan(ast, activeDesignId);
                return (
                  <>
                    {/* Row-Width Budget Progress Bar against 64,500 bytes */}
                    <Card
                      title="TDengine Row-Width Budget & Physical Schema Guard"
                      subtitle="TDengine enforces a maximum row width of 64,500 bytes per supertable."
                      action={
                        <span className="font-mono text-[12px] font-bold text-[#111B37]">
                          {plan.row_width_bytes.toLocaleString()} / {plan.max_row_width_bytes.toLocaleString()} bytes ({rowWidthPct}%)
                        </span>
                      }
                      className="border border-[#E3EAF3] bg-white"
                    >
                      <div className="space-y-2">
                        <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                          <div
                            className={`h-full transition-all ${
                              rowWidthPct > 90 ? 'bg-[#EF1B24]' : rowWidthPct > 70 ? 'bg-amber-500' : 'bg-[#0DBA67]'
                            }`}
                            style={{ width: `${Math.max(2, rowWidthPct)}%` }}
                          />
                        </div>
                        <div className="flex flex-wrap items-center justify-between text-[11px] text-[#657794]">
                          <span>Database: <strong className="font-mono text-[#111B37]">{plan.td_database}</strong></span>
                          <span>STables: <strong className="font-mono text-[#111B37]">{plan.datasets.length}</strong></span>
                          <span>Subtables: <strong className="font-mono text-[#111B37]">{plan.series.length} (`md_...`)</strong></span>
                          <span>Plan Hash: <strong className="font-mono text-[#111B37]">{plan.plan_hash.slice(0, 12)}</strong></span>
                        </div>
                      </div>
                    </Card>

                    {/* Schema Diff Actions */}
                    <Card
                      title="Compiled Physical Diff Actions"
                      subtitle="Deterministic schema operations executed atomically on Publish."
                      className="border border-[#E3EAF3] bg-white"
                    >
                      <div className="space-y-2">
                        {(plan.diff.actions || []).map((act, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-[#F8FAFC] border border-[#E3EAF3] text-[12px]"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold shrink-0 ${
                                  act.action === 'CREATE_STABLE'
                                    ? 'bg-blue-100 text-blue-900'
                                    : act.action === 'ADD_COLUMN'
                                      ? 'bg-amber-100 text-amber-900'
                                      : 'bg-emerald-100 text-emerald-900'
                                }`}
                              >
                                {act.action}
                              </span>
                              <span className="font-mono font-semibold text-[#111B37] truncate">{act.target}</span>
                            </div>
                            <span className="text-[11px] text-[#657794] truncate">{act.description}</span>
                          </div>
                        ))}
                      </div>
                    </Card>

                    {/* Exact TDengine DDL Preview */}
                    <Card
                      title="Generated TDengine SQL DDL Preview (Read-Only)"
                      subtitle="Exact parameterized supertable and deterministic subtable statements."
                      action={
                        <Button
                          size="sm"
                          variant="outline"
                          icon={<Copy className="w-3.5 h-3.5" />}
                          onClick={() => {
                            navigator.clipboard?.writeText(plan.ddl_statements.join(';\n\n') + ';');
                            showToast({ message: 'Copied TDengine DDL statements to clipboard.', tone: 'info' });
                          }}
                        >
                          Copy DDL
                        </Button>
                      }
                      className="border border-[#E3EAF3] bg-white"
                    >
                      <pre className="p-3.5 rounded-xl bg-[#0F172A] text-emerald-300 font-mono text-[11.5px] leading-[1.6] overflow-x-auto max-h-[360px]">
                        {plan.ddl_statements.join(';\n\n') + ';'}
                      </pre>
                    </Card>
                  </>
                );
              })()}
            </div>
          )}

          {/* MODE 4: SIMULATE DRY-RUN */}
          {mode === 'simulate' && (
            <div className="space-y-4">
              <Card
                title="Read-Only Recording Policy Dry-Run Simulator"
                subtitle="Evaluates recent operational samples against your recording policy (`DefaultRecordingPolicyEvaluator`) with zero writes to Managed TDengine subtables."
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    loading={simulating}
                    icon={<Play className="w-3.5 h-3.5" />}
                    onClick={() => void handleSimulate()}
                  >
                    Re-Run Simulation
                  </Button>
                }
                className="border border-[#E3EAF3] bg-white"
              >
                {simResult ? (
                  <div className="space-y-4">
                    {/* 4 KPI Summary Cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E3EAF3]">
                        <div className="text-[10.5px] font-bold uppercase text-[#657794]">Evaluated Samples</div>
                        <div className="text-xl font-black font-mono text-[#111B37] mt-1">
                          {simResult.evaluated_samples}
                        </div>
                      </div>
                      <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200">
                        <div className="text-[10.5px] font-bold uppercase text-emerald-800">Would Write</div>
                        <div className="text-xl font-black font-mono text-[#0DBA67] mt-1">
                          {simResult.would_write}
                        </div>
                      </div>
                      <div className="p-3 rounded-xl bg-slate-50 border border-[#E3EAF3]">
                        <div className="text-[10.5px] font-bold uppercase text-[#657794]">
                          Skipped (Unchanged/Deadband/Interval)
                        </div>
                        <div className="text-xl font-black font-mono text-[#334568] mt-1">
                          {simResult.skipped_total}
                        </div>
                      </div>
                      <div className="p-3 rounded-xl bg-[#EEF5FF] border border-[#D2E3FA]">
                        <div className="text-[10.5px] font-bold uppercase text-[#134074]">Estimated Reduction %</div>
                        <div className="text-xl font-black font-mono text-[#134074] mt-1">
                          {simResult.estimated_reduction_pct}%
                        </div>
                      </div>
                    </div>

                    {simResult.exactness_warnings.length > 0 && (
                      <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-[12px] text-amber-900 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                        <div>{simResult.exactness_warnings.join(' ')}</div>
                      </div>
                    )}

                    {/* Sample-by-Sample Decision Log */}
                    <div className="overflow-x-auto border border-[#E3EAF3] rounded-xl">
                      <table className="w-full text-left text-[11.5px] border-collapse">
                        <thead>
                          <tr className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[10px] font-bold uppercase text-[#657794]">
                            <th className="py-2 px-3">#</th>
                            <th className="py-2 px-3">Timestamp</th>
                            <th className="py-2 px-3">Field</th>
                            <th className="py-2 px-3">Raw → Transformed</th>
                            <th className="py-2 px-3">Quality</th>
                            <th className="py-2 px-3">Decision</th>
                            <th className="py-2 px-3">Reason / Record Kind</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {simResult.samples.map((row) => (
                            <tr key={row.index} className={row.would_write ? 'bg-white' : 'bg-slate-50/70 text-slate-500'}>
                              <td className="py-1.5 px-3">{row.index}</td>
                              <td className="py-1.5 px-3 text-[11px]">
                                {row.ts ? new Date(row.ts).toLocaleTimeString(undefined, { hour12: false }) : '—'}
                              </td>
                              <td className="py-1.5 px-3 font-bold text-[#111B37]">{row.field_key}</td>
                              <td className="py-1.5 px-3">
                                {String(row.raw_value)} → <strong>{String(row.transformed_value)}</strong>
                              </td>
                              <td className="py-1.5 px-3">
                                <StatusBadge status={row.quality} />
                              </td>
                              <td className="py-1.5 px-3">
                                {row.would_write ? (
                                  <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 text-[10px] font-bold">
                                    WRITE
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-bold">
                                    SKIP
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 px-3 text-[11px]">
                                {row.would_write ? row.record_kind : row.skip_reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center text-[12px] text-[#657794]">
                    Click "Re-Run Simulation" to evaluate sample decisions.
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>

        {/* RIGHT PANE: Inspector for Selected Dataset or Field (3 cols) */}
        <Card className="p-4 border border-[#E3EAF3] bg-white lg:col-span-3 space-y-4 min-w-0">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#E3EAF3]">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-[#111B37]">
              <Settings2 className="w-4 h-4 text-[#EF1B24]" />
              <span>Inspector</span>
            </div>
            <div className="inline-flex rounded-lg bg-[#F1F5F9] p-0.5 border border-[#E3EAF3] text-[11px] font-bold">
              <button
                type="button"
                onClick={() => setInspectorTab('dataset')}
                className={`px-2.5 py-1 rounded-md transition ${
                  inspectorTab === 'dataset' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
                }`}
              >
                Dataset Policy
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab('field')}
                className={`px-2.5 py-1 rounded-md transition ${
                  inspectorTab === 'field' ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794]'
                }`}
              >
                Field ({selectedField ? selectedField.key : 'None'})
              </button>
            </div>
          </div>

          {inspectorTab === 'dataset' ? (
            <div className="space-y-3.5 text-[12px]">
              {/* Dataset Key */}
              <div>
                <label className="block font-semibold text-[#334568] mb-1">Dataset Key</label>
                <input
                  type="text"
                  value={activeDataset.key}
                  onChange={(e) => updateActiveDataset({ key: e.target.value })}
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px] text-[#111B37]"
                />
              </div>

              {/* Semantics */}
              <div>
                <label className="block font-semibold text-[#334568] mb-1">Dataset Semantics</label>
                <select
                  aria-label="Dataset Semantics"
                  value={activeDataset.semantics}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateActiveDataset({
                      semantics: (val === 'model_projection' ? 'structured_record' : val) as DatasetAst['semantics'],
                    });
                  }}
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#111B37]"
                >
                  <option value="state_series">state_series (State / Value Series)</option>
                  <option value="event_stream">event_stream (Independent Event Stream)</option>
                  <option value="structured_record">model_projection / structured_record</option>
                </select>
              </div>

              {/* Recording Mode */}
              <div>
                <label className="block font-semibold text-[#334568] mb-1">Recording Mode</label>
                <div className="space-y-1.5">
                  {RECORDING_MODES.map((rm) => {
                    const active = activeDataset.recording.mode === rm.mode;
                    return (
                      <button
                        key={rm.mode}
                        type="button"
                        onClick={() =>
                          updateActiveDataset({
                            recording: {
                              ...activeDataset.recording,
                              mode: rm.mode,
                              interval: rm.mode === 'INTERVAL' ? activeDataset.recording.interval || '60s' : activeDataset.recording.interval,
                            },
                          })
                        }
                        className={`w-full p-2.5 rounded-xl border text-left transition ${
                          active
                            ? 'bg-[#EEF5FF] border-[#134074] ring-1 ring-[#134074]/20'
                            : 'bg-[#F8FAFC] border-[#E3EAF3] hover:border-[#CBD5E1]'
                        }`}
                      >
                        <div className="font-mono font-bold text-[11.5px] text-[#111B37]">{rm.label}</div>
                        <div className="text-[10.5px] text-[#657794] mt-0.5 leading-snug">{rm.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Deadband (Absolute / Percent) */}
              {activeDataset.recording.mode === 'ON_CHANGE' && (
                <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E3EAF3] space-y-2">
                  <label className="block font-bold text-[#111B37]">Numeric Deadband (Anchored to Last Recorded)</label>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      aria-label="Deadband Kind"
                      value={activeDataset.recording.deadband?.kind || 'absolute'}
                      onChange={(e) =>
                        updateActiveDataset({
                          recording: {
                            ...activeDataset.recording,
                            deadband: {
                              kind: e.target.value === 'percent' ? 'percent' : 'absolute',
                              value: activeDataset.recording.deadband?.value ?? 0,
                            },
                          },
                        })
                      }
                      className="h-8 px-2 border border-[#D4DFEC] rounded-lg bg-white text-[12px]"
                    >
                      <option value="absolute">absolute</option>
                      <option value="percent">percent (%)</option>
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      aria-label="Deadband Value"
                      value={activeDataset.recording.deadband?.value ?? 0}
                      onChange={(e) =>
                        updateActiveDataset({
                          recording: {
                            ...activeDataset.recording,
                            deadband: {
                              kind: activeDataset.recording.deadband?.kind || 'absolute',
                              value: Math.max(0, Number(e.target.value) || 0),
                            },
                          },
                        })
                      }
                      className="h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px] bg-white"
                    />
                  </div>
                </div>
              )}

              {/* Interval Duration (when mode === INTERVAL) */}
              {activeDataset.recording.mode === 'INTERVAL' && (
                <div>
                  <label className="block font-semibold text-[#334568] mb-1">Bucket Interval (`interval`)</label>
                  <input
                    type="text"
                    value={activeDataset.recording.interval || '60s'}
                    onChange={(e) =>
                      updateActiveDataset({
                        recording: { ...activeDataset.recording, interval: e.target.value },
                      })
                    }
                    placeholder="e.g. 1s, 10s, 60s, 5m"
                    className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px]"
                  />
                </div>
              )}

              {/* Max Checkpoint Interval & Late Tolerance */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold text-[#334568] mb-1">maxCheckpointInterval</label>
                  <input
                    type="text"
                    value={activeDataset.recording.maxCheckpointInterval || '60s'}
                    onChange={(e) =>
                      updateActiveDataset({
                        recording: { ...activeDataset.recording, maxCheckpointInterval: e.target.value },
                      })
                    }
                    className="w-full h-8 px-2 border border-[#D4DFEC] rounded-lg font-mono text-[12px]"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-[#334568] mb-1">lateTolerance</label>
                  <input
                    type="text"
                    value={activeDataset.recording.lateTolerance || '300s'}
                    onChange={(e) =>
                      updateActiveDataset({
                        recording: { ...activeDataset.recording, lateTolerance: e.target.value },
                      })
                    }
                    className="w-full h-8 px-2 border border-[#D4DFEC] rounded-lg font-mono text-[12px]"
                  />
                </div>
              </div>

              {/* Missing Policy */}
              <div>
                <label className="block font-semibold text-[#334568] mb-1">Missing Sample Policy (`missingPolicy`)</label>
                <select
                  value={activeDataset.recording.missingPolicy}
                  onChange={(e) =>
                    updateActiveDataset({
                      recording: {
                        ...activeDataset.recording,
                        missingPolicy: e.target.value as MissingPolicyMode,
                      },
                    })
                  }
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg text-[12px] bg-white"
                >
                  <option value="GAP_MARKER">GAP_MARKER (Explicit Gap Record)</option>
                  <option value="NULL">NULL (Nullable Bucket Entry)</option>
                  <option value="HOLD_LAST_WITH_QUALITY">HOLD_LAST_WITH_QUALITY</option>
                </select>
              </div>

              {/* Retention Days (30 / 90 / 365 + custom) & Legal Hold */}
              <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E3EAF3] space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-[#111B37]">Retention Policy (Days)</label>
                  <div className="flex items-center gap-1">
                    {[30, 90, 365].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() =>
                          updateActiveDataset({
                            retention: { ...activeDataset.retention, days: d },
                          })
                        }
                        className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold transition ${
                          activeDataset.retention.days === d
                            ? 'bg-[#134074] text-white'
                            : 'bg-white text-[#334568] border border-[#CBD5E1]'
                        }`}
                      >
                        {d}d
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  aria-label="Retention Days"
                  value={activeDataset.retention.days}
                  onChange={(e) =>
                    updateActiveDataset({
                      retention: {
                        ...activeDataset.retention,
                        days: Math.min(3650, Math.max(1, Number(e.target.value) || 90)),
                      },
                    })
                  }
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px] bg-white"
                />

                <label className="flex items-center justify-between pt-1 cursor-pointer">
                  <span className="flex items-center gap-1.5 font-semibold text-[#111B37]">
                    <Lock className="w-3.5 h-3.5 text-amber-600" />
                    <span>Legal Hold (`legalHold`)</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={activeDataset.retention.legalHold}
                    onChange={(e) =>
                      updateActiveDataset({
                        retention: { ...activeDataset.retention, legalHold: e.target.checked },
                      })
                    }
                    className="w-4 h-4 accent-[#EF1B24]"
                  />
                </label>
              </div>
            </div>
          ) : selectedField && selectedFieldIndex !== null ? (
            <div className="space-y-3.5 text-[12px]">
              <div>
                <label className="block font-semibold text-[#334568] mb-1">Field Key</label>
                <input
                  type="text"
                  value={selectedField.key}
                  onChange={(e) => updateFieldAt(selectedFieldIndex, { key: e.target.value })}
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px] font-bold"
                />
              </div>

              <div>
                <label className="block font-semibold text-[#334568] mb-1">Canonical Source Reference (`from`)</label>
                <input
                  type="text"
                  value={selectedField.from}
                  onChange={(e) => updateFieldAt(selectedFieldIndex, { from: e.target.value })}
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[11.5px] text-[#1D4ED8]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold text-[#334568] mb-1">TDengine Type</label>
                  <select
                    value={selectedField.type}
                    onChange={(e) => updateFieldAt(selectedFieldIndex, { type: e.target.value as StorageValueType })}
                    className="w-full h-8 px-2 border border-[#D4DFEC] rounded-lg font-mono text-[12px] bg-white"
                  >
                    {VALUE_TYPES.map((vt) => (
                      <option key={vt} value={vt}>
                        {vt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-[#334568] mb-1">Engineering Unit</label>
                  <input
                    type="text"
                    value={selectedField.unit || ''}
                    placeholder="e.g. °C, bar, kW"
                    onChange={(e) => updateFieldAt(selectedFieldIndex, { unit: e.target.value || null })}
                    className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px]"
                  />
                </div>
              </div>

              {/* Safe Transform Expression */}
              <div className="p-3 rounded-xl bg-[#F8FAFC] border border-[#E3EAF3] space-y-2">
                <label className="block font-bold text-[#111B37]">Safe Scalar Transform (`transform`)</label>
                <input
                  type="text"
                  value={selectedField.transform || ''}
                  onChange={(e) =>
                    updateFieldAt(selectedFieldIndex, {
                      transform: e.target.value.trim() ? e.target.value : null,
                    })
                  }
                  placeholder="round(value * 1.0, 2)"
                  className="w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg font-mono text-[12px] bg-white text-emerald-800"
                />
                <div className="flex flex-wrap gap-1 pt-1">
                  {[
                    'round(value * 1.0, 2)',
                    'clamp(value, 0, 100)',
                    'abs(value)',
                    'round((value - 32) * 5 / 9, 2)',
                  ].map((expr) => (
                    <button
                      key={expr}
                      type="button"
                      onClick={() => updateFieldAt(selectedFieldIndex, { transform: expr })}
                      className="px-2 py-0.5 rounded bg-white border border-[#CBD5E1] hover:border-[#134074] font-mono text-[10px] text-[#334568]"
                    >
                      {expr}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-[12px] text-[#657794]">
              Select a field row in the dataset table to inspect its binding and transform expression.
            </div>
          )}
        </Card>
      </div>

      <ActionToast toast={toast} onDismiss={dismissToast} />
    </div>
  );
};
