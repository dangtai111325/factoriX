/**
 * "Generate subtables from Data Models" (review §4.1, guide H7/H8).
 *
 * Supertable x (models x fields) matrix -> one subtable per (model, field) — or one per model in
 * "On new event" mode — named from a template, tags filled from the Factory Model, target column
 * suggested from the field type. Every row goes through the same backend saga as the single
 * wizard (validation, DDL, read-back, registry), one idempotent operation per row, in chunks.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, Loader2, Search } from 'lucide-react';
import {
  BulkRowResult,
  ModelSourceGroup,
  RecordingMode,
  SourceRef,
  TDStable,
  BulkJob,
  bulkCreateSubtables,
  getBulkJob,
  getSources,
  isSystemStorageName,
  listStables,
} from '../../../lib/storagePhysicalApi';
import { autoTagValues, suggestColumn, typeCompatible, valueColumns } from './SubtableWizardSteps';
import { useStorageBackTarget } from './WizardShared';
import { useApp } from '../../../store/AppContext';
import { Button } from '../../../components/common/Button';
import { Banner, DraftChip, LoadingBlock, WizardHeader, WizardStepper, selectCls } from '../../historian/hsUi';

interface PlannedRow {
  key: string;
  name: string;
  group: ModelSourceGroup;
  fields: { leaf: SourceRef; column: string }[];
  tags: { tag_name: string; value: string }[];
  problem?: string;
}

/** Outcome of the last Create run, shown above the table (R2-04). */
interface RunSummary {
  dryRun: boolean;
  created: number;
  exists: number;
  failed: number;
  invalid: number;
  valid: number;
  at: string;
}

const STATUS_TEXT: Record<string, string> = { CREATED: 'Created', EXISTS: 'Exists', VALID: 'Valid', INVALID: 'Invalid', FAILED: 'Failed' };

/** The running/last bulk job of this tab: survives leaving the page and coming back (the job runs on the Center). */
const JOB_KEY = 'fx_bulk_subtables_job';
interface StoredJob {
  jobId: string;
  total: number;
  startedAt: string;
  stableId: string;
}
function readStoredJob(): StoredJob | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null');
    return v && typeof v.jobId === 'string' ? (v as StoredJob) : null;
  } catch {
    return null;
  }
}
function writeStoredJob(j: StoredJob | null) {
  try {
    if (j) sessionStorage.setItem(JOB_KEY, JSON.stringify(j));
    else sessionStorage.removeItem(JOB_KEY);
  } catch {
    /* private mode */
  }
}
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function defaultPrefix(stableName: string): string {
  const s = stableName.replace(/^st_/, '').replace(/^machine_/, '');
  return s.split('_')[0] || s;
}

function download(name: string, mime: string, text: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_STYLE: Record<string, string> = {
  CREATED: 'text-[#0DBA67]',
  VALID: 'text-[#2A82E7]',
  EXISTS: 'text-[#657794]',
  INVALID: 'text-[#F2343B]',
  FAILED: 'text-[#F2343B]',
};

export const BulkSubtablesWizard: React.FC = () => {
  const navigate = useNavigate();
  const backTarget = useStorageBackTarget('/historian/storage');
  const [params] = useSearchParams();
  const [stables, setStables] = useState<TDStable[]>([]);
  const [groups, setGroups] = useState<ModelSourceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stableId, setStableId] = useState(params.get('stable') || '');
  const [modelSearch, setModelSearch] = useState(params.get('model_search') || '');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set(params.get('model') ? [params.get('model') as string] : []));
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [columnFor, setColumnFor] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<RecordingMode>('ON_CHANGE');
  const [prefix, setPrefix] = useState('');
  const [startRecording, setStartRecording] = useState(false);
  const [rows, setRows] = useState<PlannedRow[]>([]);
  const [running, setRunning] = useState<'validate' | 'create' | null>(null);
  const [progress, setProgress] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  // Results are kept by subtable name, apart from the planned rows: re-planning (any edit, or the reload of the
  // Data Models after a create) never wipes what the server answered (R2-04).
  const [results, setResults] = useState<Record<string, BulkRowResult>>({});
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [reloading, setReloading] = useState(false);
  // Background job (H-R4.3): live progress, resumable after navigation; `gone` = the Center no longer knows it.
  const [job, setJob] = useState<BulkJob | null>(null);
  const [jobGone, setJobGone] = useState<string | null>(null);
  const pollingRef = React.useRef<string | null>(null);
  const { resources } = useApp();
  const resById = useMemo(() => new Map(resources.map((x) => [x.id, x])), [resources]);

  const loadSources = (initial: boolean) =>
    Promise.all([listStables(), getSources({ view: 'models' })])
      .then(([st, src]) => {
        setStables((st.items || []).filter((s) => !isSystemStorageName(s.physical_name)));
        setGroups(((src.groups || src.items || []) as unknown) as ModelSourceGroup[]);
      })
      .catch((err: Error) => {
        if (initial) setLoadError(err.message || 'Could not load supertables or Data Models.');
      })
      .finally(() => {
        if (initial) setLoading(false);
      });

  useEffect(() => {
    void loadSources(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stable = stables.find((s) => s.id === stableId) || null;
  const cols = valueColumns(stable);
  const atomic = mode === 'ON_NEW_EVENT';
  useEffect(() => {
    if (stable && !prefix) setPrefix(defaultPrefix(stable.physical_name));
    if (stable && stable.columns.some((c) => ['so', 'wo', 'qty', 'lot_serial'].includes(c.name)) && !cols.some((c) => c.name.startsWith('value_'))) setMode('ON_NEW_EVENT');
  }, [stable]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return groups.filter((g) => !q || `${g.display_name} ${g.resource?.name || ''} ${g.resource?.code || ''}`.toLowerCase().includes(q));
  }, [groups, modelSearch]);

  const chosenGroups = useMemo(() => groups.filter((g) => selectedModels.has(g.id)), [groups, selectedModels]);
  const fieldUnion = useMemo(() => {
    const m = new Map<string, SourceRef>();
    for (const g of chosenGroups) for (const f of g.fields) if (f.field_path && !m.has(f.field_path)) m.set(f.field_path, f);
    return [...m.values()];
  }, [chosenGroups]);

  // Column suggestion per field (guide F3), editable.
  useEffect(() => {
    setColumnFor((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const f of fieldUnion) {
        const path = f.field_path as string;
        if (!next[path]) {
          const v = atomic && cols.some((c) => c.name === f.key) ? String(f.key) : suggestColumn(f.value_type, cols) || '';
          if (v) {
            next[path] = v;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [fieldUnion, stableId, atomic]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plan rows whenever the matrix changes.
  useEffect(() => {
    if (!stable) { setRows([]); return; }
    const planned: PlannedRow[] = [];
    const machineOf = (g: ModelSourceGroup) => slug(g.resource?.code || g.resource?.name || g.display_name);
    // On new event: one subtable per model -> `{prefix}_{machine}` when the machine has one selected model,
    // `{prefix}_{machine}_{model}` when it has several (lead decision, tdengine_guide §I.7).
    const modelsPerMachine = new Map<string, number>();
    for (const g of chosenGroups)
      if (g.fields.some((f) => selectedFields.has(f.field_path as string))) modelsPerMachine.set(machineOf(g), (modelsPerMachine.get(machineOf(g)) || 0) + 1);
    const modelSlug = (g: ModelSourceGroup) => {
      const own = g.resource?.name ? g.display_name.replace(new RegExp(`^${g.resource.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*·\\s*`), '') : g.display_name;
      return slug(own) || slug(g.display_name);
    };
    for (const g of chosenGroups) {
      const machine = machineOf(g);
      const leaves = g.fields.filter((f) => selectedFields.has(f.field_path as string));
      if (atomic) {
        if (!leaves.length) continue;
        const name = ((modelsPerMachine.get(machine) || 0) > 1 ? `${prefix}_${machine}_${modelSlug(g)}` : `${prefix}_${machine}`).slice(0, 63);
        const fields = leaves.map((leaf) => ({ leaf, column: columnFor[leaf.field_path as string] || '' }));
        const problem = fields.find((f) => !f.column)?.leaf.field_path;
        planned.push({ key: `${g.id}`, name, group: g, fields, tags: autoTagValues(stable.tags, [], g, null),
          problem: problem ? `No column for ${problem}` : undefined });
      } else {
        for (const leaf of leaves) {
          const path = leaf.field_path as string;
          const column = columnFor[path] || '';
          const col = cols.find((c) => c.name === column);
          const key = String(leaf.key || path.split('/').pop());
          const name = `${prefix}_${machine}_${slug(key)}`.slice(0, 63);
          let problem: string | undefined;
          if (!col) problem = 'Choose a target column';
          else if (!typeCompatible(leaf.value_type, col)) problem = `${leaf.value_type} does not fit ${col.td_type}`;
          else if (leaf.bound_to) problem = `Already recorded in ${leaf.bound_to.subtable}`;
          planned.push({ key: `${g.id}:${path}`, name, group: g, fields: [{ leaf, column }],
            tags: autoTagValues(stable.tags, [], g, leaf), problem });
        }
      }
    }
    // Never produce in-batch duplicates: a clash gets the model name, then a number.
    const count = new Map<string, number>();
    planned.forEach((r) => count.set(r.name, (count.get(r.name) || 0) + 1));
    const used = new Set<string>();
    planned.forEach((r) => {
      let n = r.name;
      if ((count.get(n) || 0) > 1 && !atomic) n = `${r.name}_${modelSlug(r.group)}`.slice(0, 63);
      for (let i = 2; used.has(n); i++) n = `${r.name.slice(0, 59)}_${i}`;
      used.add(n);
      r.name = n;
    });
    setRows(planned);
  }, [stable, chosenGroups, selectedFields, columnFor, prefix, atomic]); // eslint-disable-line react-hooks/exhaustive-deps

  const specOf = (r: PlannedRow): Record<string, unknown> => ({
    stable: stable?.id,
    name: r.name,
    display_name: atomic ? `${r.group.resource?.name || r.group.display_name} · ${r.group.display_name}` :
      `${r.group.resource?.name || r.group.display_name} · ${r.fields[0].leaf.field_path}`,
    description: `${r.group.display_name} (${r.group.id})`,
    tag_values: r.tags.map((t) => ({ name: t.tag_name, value: t.value })),
    bindings: r.fields.map((f) => ({ source_kind: 'model_field', model_id: r.group.id, field_path: f.leaf.field_path, column_name: f.column })),
    recording: { mode, row_assembly: atomic ? 'ATOMIC_EVENT' : 'INDEPENDENT_EVENTS', start_recording: startRecording },
  });

  const resultOf = (r: PlannedRow): BulkRowResult | undefined => results[r.name];
  const done = (r: PlannedRow) => {
    const st = resultOf(r)?.status;
    return st === 'CREATED' || st === 'EXISTS';
  };
  // A row whose field is now recorded by the row we just created is done, not "Already recorded" (problem).
  const blocking = (r: PlannedRow) => (done(r) ? undefined : r.problem);

  const run = async (dryRun: boolean) => {
    const todo = rows.filter((r) => !blocking(r) && !done(r));
    if (!todo.length) return;
    setRunning(dryRun ? 'validate' : 'create');
    setRunError(null);
    setSummary(null);
    setProgress(0);
    const chunk = dryRun ? 50 : 1000;
    const tally: RunSummary = { dryRun, created: 0, exists: 0, failed: 0, invalid: 0, valid: 0, at: new Date().toLocaleTimeString() };
    try {
      for (let i = 0; i < todo.length; i += chunk) {
        const part = todo.slice(i, i + chunk);
        const res = await bulkCreateSubtables(part.map(specOf), dryRun);
        if (!dryRun && res.job_id) {
          // H-R4.3: the Center runs the rows in the background; follow the job (also after leaving the page).
          writeStoredJob({ jobId: res.job_id, total: res.total ?? part.length, startedAt: new Date().toISOString(), stableId });
          setRunning(null);
          await followJob(res.job_id);
          return;
        }
        setResults((prev) => {
          const next = { ...prev };
          res.items.forEach((it) => {
            next[it.name] = it;
          });
          return next;
        });
        res.items.forEach((it) => {
          if (it.status === 'CREATED') tally.created++;
          else if (it.status === 'EXISTS') tally.exists++;
          else if (it.status === 'FAILED') tally.failed++;
          else if (it.status === 'INVALID') tally.invalid++;
          else if (it.status === 'VALID') tally.valid++;
        });
        setProgress(Math.min(todo.length, i + part.length));
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'The request failed; already created rows are kept and are skipped on retry.');
    } finally {
      setRunning(null);
      setSummary(tally);
    }
    if (!dryRun && (tally.created || tally.exists)) {
      // Refresh the Data Models: their fields now carry "recorded in …" (statuses update without a reload).
      setReloading(true);
      await loadSources(false);
      setReloading(false);
    }
  };

  /** Poll a background job until it finishes; per-row results appear as rows complete (batches of 50). */
  const followJob = async (jobId: string) => {
    if (pollingRef.current === jobId) return;
    pollingRef.current = jobId;
    setJobGone(null);
    setSummary(null);
    try {
      for (;;) {
        let j: BulkJob;
        try {
          j = await getBulkJob(jobId);
        } catch (err) {
          if ((err as { status?: number }).status === 404) {
            writeStoredJob(null);
            setJob(null);
            setJobGone(
              'The Center no longer knows this bulk job (jobs are kept 1 hour after they finish and are lost when the Center restarts). Every row it created is kept: press Validate to see which subtables already exist.',
            );
            return;
          }
          await sleep(3000); // transient (busy appliance): keep following
          continue;
        }
        setJob(j);
        setResults((prev) => {
          const next = { ...prev };
          (j.items || []).forEach((it) => {
            next[it.name] = it;
          });
          return next;
        });
        if (j.status === 'DONE' || j.status === 'FAILED') {
          const sm = j.summary || {};
          setSummary({ dryRun: false, created: sm.CREATED || 0, exists: sm.EXISTS || 0, failed: sm.FAILED || 0, invalid: sm.INVALID || 0, valid: 0, at: new Date(j.finished_at || Date.now()).toLocaleTimeString() });
          if (j.status === 'FAILED') setRunError(`The bulk job stopped: ${j.error || 'unknown error'}. Rows already created are kept; press Create again for the rest.`);
          writeStoredJob(null);
          if ((sm.CREATED || 0) + (sm.EXISTS || 0) > 0) {
            setReloading(true);
            await loadSources(false);
            setReloading(false);
          }
          return;
        }
        await sleep(Math.max(800, j.poll_after_ms || 1000));
      }
    } finally {
      pollingRef.current = null;
    }
  };

  // Coming back to the page while a job runs (or just finished): pick it up again.
  useEffect(() => {
    const stored = readStoredJob();
    if (!stored) return;
    if (!stableId && stored.stableId) setStableId(stored.stableId);
    void followJob(stored.jobId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const jobActive = !!job && (job.status === 'QUEUED' || job.status === 'RUNNING');

  const manifest = () => rows.map((r) => ({
    subtable: r.name,
    stable: stable?.id,
    model_id: r.group.id,
    model: r.group.display_name,
    machine: r.group.resource?.name,
    fields: r.fields.map((f) => ({ field_path: f.leaf.field_path, target_column: f.column })),
    tags: Object.fromEntries(r.tags.map((t) => [t.tag_name, t.value])),
    recording_mode: mode,
    status: resultOf(r)?.status || (blocking(r) ? 'BLOCKED' : 'NOT_RUN'),
    operation_id: resultOf(r)?.operation_id || null,
    error: resultOf(r)?.message || blocking(r) || null,
  }));

  const downloadCsv = () => {
    const head = ['subtable', 'stable', 'model_id', 'model', 'machine', 'field_path', 'target_column', 'status', 'operation_id', 'error'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = manifest().map((m) => [m.subtable, m.stable, m.model_id, m.model, m.machine,
      m.fields.map((f) => f.field_path).join('|'), m.fields.map((f) => f.target_column).join('|'), m.status, m.operation_id, m.error].map(esc).join(','));
    download('storage-subtables-manifest.csv', 'text/csv', [head.join(','), ...lines].join('\r\n'));
  };

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const k = resultOf(r)?.status || (blocking(r) ? 'BLOCKED' : 'PLANNED');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const runnable = rows.filter((r) => !blocking(r) && !done(r)).length;
  const allDone = rows.length > 0 && rows.every((r) => done(r));
  const bulkStep = !stableId ? 0 : selectedModels.size === 0 ? 1 : rows.length === 0 ? 2 : 3;

  return (
    <div className="space-y-5">
      <WizardHeader
        backLabel="Storage Management"
        onBack={() => navigate(backTarget)}
        title="Subtables from Data Models"
        chip={<DraftChip state={counts.CREATED ? 'saved' : 'new'} label={counts.CREATED ? `${counts.CREATED} created` : undefined} />}
        note={<span>One subtable per machine and field, through the same checks as the single wizard.</span>}
        stepper={
          <WizardStepper
            steps={[{ id: 'st', label: 'Supertable' }, { id: 'models', label: 'Data Models' }, { id: 'fields', label: 'Fields' }, { id: 'review', label: 'Review' }]}
            current={bulkStep}
            maxReachable={3}
            onGo={(i) => document.getElementById(`bulk-step-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          />
        }
      />

      {jobGone && <Banner tone="warning" onClose={() => setJobGone(null)}>{jobGone}</Banner>}
      {job && (jobActive || rows.length === 0) && (
        <Banner tone={job.status === 'FAILED' ? 'error' : jobActive ? 'info' : 'success'}>
          <div className="space-y-1.5">
            <div className="font-semibold">
              {jobActive
                ? `Creating subtables in the background: ${job.done} of ${job.total} done (${Math.round(job.progress_pct ?? (job.total ? (job.done / job.total) * 100 : 0))} %). You can leave this page; come back to see the result.`
                : `Bulk job ${job.status === 'FAILED' ? 'stopped' : 'finished'}: ${job.summary?.CREATED || 0} created · ${job.summary?.EXISTS || 0} already existed · ${(job.summary?.FAILED || 0) + (job.summary?.INVALID || 0)} failed.`}
            </div>
            <div className="h-1.5 w-full max-w-md rounded-full bg-blue-100 overflow-hidden" aria-hidden="true">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${job.total ? Math.min(100, (job.done / job.total) * 100) : 0}%` }} />
            </div>
            {rows.length === 0 && (job.items || []).length > 0 && (
              <ul className="text-[11px] max-h-40 overflow-y-auto">
                {(job.items || []).filter((it) => it.status !== 'CREATED').slice(0, 50).map((it) => (
                  <li key={it.name}>
                    <span className="font-mono">{it.name}</span>: {STATUS_TEXT[it.status] || it.status}
                    {it.message ? ` — ${it.code ? `${it.code}: ` : ''}${it.message}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Banner>
      )}
      {loading && <LoadingBlock label="Loading supertables and Data Models…" />}
      {loadError && <Banner tone="error">{loadError}</Banner>}

      {!loading && !loadError && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* 1. Supertable + recording */}
          <section id="bulk-step-0" className="bg-white border border-[#CBD5E1] rounded-xl p-4 space-y-3 scroll-mt-24">
            <h2 className="text-[14px] font-bold text-[#111B37]">1. Supertable</h2>
            <select aria-label="Parent supertable" value={stableId} onChange={(e) => { setStableId(e.target.value); setPrefix(''); setColumnFor({}); }}
              className={`${selectCls} w-full h-9 text-[13px]`}>
              <option value="">{stables.length ? 'Select a supertable…' : 'Create a supertable first'}</option>
              {stables.map((s) => <option key={s.id} value={s.id}>{s.physical_name} · {s.database_name}</option>)}
            </select>
            {stable && (
              <div className="text-[12px] text-[#657794] space-y-1">
                <div>Value columns: <span className="font-mono text-[#334568]">{cols.map((c) => c.name).join(', ') || 'none'}</span></div>
                <div>Tags: <span className="font-mono text-[#334568]">{stable.tags.map((t) => t.name).join(', ')}</span></div>
              </div>
            )}
            <label className="block text-[12px] font-semibold text-[#334568]">Name prefix
              <input value={prefix} onChange={(e) => setPrefix(slug(e.target.value))} className="mt-1 w-full h-9 px-2 rounded-lg border border-[#D4DFEC] text-[13px] font-mono focus:outline-none focus:border-blue-500" />
            </label>
            <p className="text-[11px] text-[#657794]">Name = <span className="font-mono">{atomic ? `${prefix || 'prefix'}_<machine>` : `${prefix || 'prefix'}_<machine>_<field>`}</span>, e.g. <span className="font-mono">{atomic ? `${prefix}_aa10_01` : `${prefix}_aa10_01_status`}</span></p>
            <div className="space-y-1.5">
              {(['ON_CHANGE', 'ON_NEW_EVENT', 'EVERY_ACQUISITION'] as RecordingMode[]).map((m) => (
                <label key={m} className="flex items-center gap-2 text-[13px] text-[#334568]">
                  <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
                  {m === 'ON_CHANGE' ? 'On change (one subtable per field)' : m === 'ON_NEW_EVENT' ? 'On new event (one subtable per model, atomic rows)' : 'Every model sample'}
                </label>
              ))}
            </div>
            <label className="flex items-start gap-2 text-[13px] text-[#334568]">
              <input type="checkbox" checked={startRecording} onChange={(e) => setStartRecording(e.target.checked)} className="mt-1" />
              <span>Start recording after creation <span className="block text-[11px] text-[#657794]">Off by default; start later per object or in bulk.</span></span>
            </label>
          </section>

          {/* 2. Models */}
          <section id="bulk-step-1" className="bg-white border border-[#CBD5E1] rounded-xl p-4 space-y-3 flex flex-col min-w-0 scroll-mt-24">
            <h2 className="text-[14px] font-bold text-[#111B37]">2. Data Models ({selectedModels.size} selected)</h2>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="Filter, e.g. State"
                className="w-full pl-8 h-8 rounded-lg border border-[#D4DFEC] text-[12px] focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex gap-2 text-[12px]">
              <button type="button" className="font-semibold text-[#2A82E7]" onClick={() => setSelectedModels(new Set([...selectedModels, ...shownModels.map((g) => g.id)]))}>Select shown ({shownModels.length})</button>
              <button type="button" className="font-semibold text-[#657794]" onClick={() => setSelectedModels(new Set())}>Clear</button>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[360px] space-y-1">
              {shownModels.map((g) => (
                <label key={g.id} className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[#F6F8FC] text-[12px]">
                  <input type="checkbox" checked={selectedModels.has(g.id)} onChange={(e) => {
                    const n = new Set(selectedModels);
                    if (e.target.checked) n.add(g.id); else n.delete(g.id);
                    setSelectedModels(n);
                  }} />
                  <span className="font-semibold text-[#111B37] truncate">{g.display_name}</span>
                  <span className="text-[#657794] truncate">{g.resource?.name || 'no machine'}</span>
                  <span className="ml-auto text-[#94A3B8]">{g.fields_count}</span>
                </label>
              ))}
            </div>
          </section>

          {/* 3. Fields x column */}
          <section id="bulk-step-2" className="bg-white border border-[#CBD5E1] rounded-xl p-4 space-y-3 flex flex-col min-w-0 scroll-mt-24">
            <h2 className="text-[14px] font-bold text-[#111B37]">3. Fields ({selectedFields.size} selected)</h2>
            <div className="flex gap-2 text-[12px]">
              <button type="button" className="font-semibold text-[#2A82E7]" onClick={() => setSelectedFields(new Set(fieldUnion.filter((f) => !f.is_timestamp).map((f) => f.field_path as string)))}>Select all value fields</button>
              <button type="button" className="font-semibold text-[#657794]" onClick={() => setSelectedFields(new Set())}>Clear</button>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[360px]">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[#657794]"><th /><th className="py-1">Field</th><th>Type</th><th>Column</th></tr></thead>
                <tbody>
                  {fieldUnion.map((f) => {
                    const path = f.field_path as string;
                    return (
                      <tr key={path} className="border-t border-[#E3EAF3]">
                        <td className="py-1"><input type="checkbox" checked={selectedFields.has(path)} onChange={(e) => {
                          const n = new Set(selectedFields);
                          if (e.target.checked) n.add(path); else n.delete(path);
                          setSelectedFields(n);
                        }} /></td>
                        <td className="font-mono">{path}</td>
                        <td className="text-[#657794]">{f.value_type}</td>
                        <td>
                          <select aria-label={`Column for ${path}`} value={columnFor[path] || ''} onChange={(e) => setColumnFor({ ...columnFor, [path]: e.target.value })}
                            className="h-7 px-1 rounded border border-[#D4DFEC] bg-white text-[12px] font-mono">
                            <option value="">—</option>
                            {cols.map((c) => <option key={c.name} value={c.name} disabled={!typeCompatible(f.value_type, c)}>{c.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!fieldUnion.length && <p className="text-[12px] text-[#657794] py-4">Select Data Models first.</p>}
            </div>
          </section>
        </div>
      )}

      {/* 4. Preview + run */}
      {rows.length > 0 && (
        <section id="bulk-step-3" className="bg-white border border-[#CBD5E1] rounded-xl p-4 space-y-3 min-w-0 scroll-mt-24">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-bold text-[#111B37]">4. Review {rows.length} subtables</h2>
              <p className="text-[12px] text-[#657794]">{Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!!running || jobActive || runnable === 0} onClick={() => run(true)}>
                {running === 'validate' ? `Validating ${progress}/${runnable}…` : 'Validate'}
              </Button>
              <Button variant="primary" size="sm" disabled={!!running || jobActive || runnable === 0} onClick={() => run(false)} aria-busy={running === 'create' || jobActive}>
                {jobActive
                  ? `Creating ${job!.done}/${job!.total}…`
                  : running === 'create'
                  ? `Submitting ${runnable}…`
                  : runnable > 0
                    ? `Create ${runnable} subtable${runnable === 1 ? '' : 's'}`
                    : allDone
                      ? 'All rows created'
                      : 'Nothing to create'}
              </Button>
              <Button variant="outline" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={downloadCsv}>CSV</Button>
              <Button variant="outline" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => download('storage-subtables-manifest.json', 'application/json', JSON.stringify(manifest(), null, 2))}>JSON</Button>
            </div>
          </div>
          {runError && <Banner tone="error">{runError}</Banner>}
          {summary && (
            <Banner
              tone={summary.failed || summary.invalid ? 'warning' : 'success'}
              onClose={() => setSummary(null)}
              action={
                !summary.dryRun ? (
                  <Link
                    to={`/historian/storage?tab=objects&type=subtable&q=${encodeURIComponent(prefix)}`}
                    className="shrink-0 text-[12px] font-semibold text-[#2A82E7] hover:underline whitespace-nowrap"
                  >
                    Open in Objects table
                  </Link>
                ) : undefined
              }
            >
              <span className="font-semibold">
                {summary.dryRun
                  ? `Validation ${summary.at}: ${summary.valid} valid · ${summary.exists} already exist · ${summary.invalid + summary.failed} with problems.`
                  : `Create finished ${summary.at}: ${summary.created} created · ${summary.exists} already existed · ${summary.failed + summary.invalid} failed.`}
              </span>
              {(summary.failed > 0 || summary.invalid > 0) && <span> The reason is shown on each failed row; fix it and press Create again — only the remaining rows are sent.</span>}
              {reloading && <span className="ml-1 text-[#657794]">Refreshing Data Model fields…</span>}
            </Banner>
          )}
          <div className="overflow-auto max-h-[480px] border border-[#E3EAF3] rounded-lg">
            <table className="fx-table">
              <thead className="sticky top-0 z-[1]"><tr>
                <th>Subtable</th><th>Model</th><th>Field → column</th><th>Tags</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="align-top">
                    <td className="font-mono text-[#111B37] whitespace-nowrap">{r.name}</td>
                    <td>{r.group.display_name}<div className="text-[11px] text-[#657794]">{r.group.resource?.name}</div></td>
                    <td className="font-mono">{r.fields.map((f) => `${f.leaf.field_path} → ${f.column || '?'}`).join(', ')}</td>
                    <td className="text-[11px] text-[#657794]">
                      {r.tags.map((t) => {
                        const res = t.value && /_ref$/.test(t.tag_name) ? resById.get(t.value) : undefined;
                        return (
                          <div key={t.tag_name} className="whitespace-nowrap" title={t.value || ''}>
                            <span className="font-mono">{t.tag_name}</span>={' '}
                            {res ? <span className="text-[#334568]">{res.name}</span> : <span className="font-mono">{t.value ? (t.value.length > 12 ? `${t.value.slice(0, 8)}…` : t.value) : '∅'}</span>}
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      {resultOf(r) ? (
                        <span className={`font-semibold ${STATUS_STYLE[resultOf(r)!.status] || ''}`} title={resultOf(r)!.message || (resultOf(r)!.errors || []).map((e) => e.message).join('; ')}>
                          {resultOf(r)!.status === 'CREATED' && <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />}
                          {(resultOf(r)!.status === 'FAILED' || resultOf(r)!.status === 'INVALID') && <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />}
                          {STATUS_TEXT[resultOf(r)!.status] || resultOf(r)!.status}
                          {(resultOf(r)!.message || resultOf(r)!.errors?.length) && (
                            <div className="font-normal text-[11px] text-[#657794] max-w-[280px]">
                              {resultOf(r)!.code ? `${resultOf(r)!.code}: ` : ''}
                              {resultOf(r)!.message || resultOf(r)!.errors?.map((e) => e.message).join('; ')}
                            </div>
                          )}
                        </span>
                      ) : blocking(r) ? (
                        <span className="text-[#F2343B]">{blocking(r)}</span>
                      ) : r.tags.some((t) => !t.value) ? (
                        <span className="text-[#B76E00] font-semibold">Missing tag value</span>
                      ) : (
                        <span className="text-[#657794]">Planned</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#657794]">Rows that already exist are reported as Exists and never created twice. Retrying a failed run only sends the remaining rows.
            {' '}<Link to={`/historian/storage?tab=objects&type=subtable${prefix ? `&q=${encodeURIComponent(prefix)}` : ''}`} className="text-[#2A82E7] font-semibold hover:underline">Open Objects table</Link></p>
        </section>
      )}
    </div>
  );
};
