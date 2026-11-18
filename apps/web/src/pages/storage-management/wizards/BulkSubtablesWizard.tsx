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
  bulkCreateSubtables,
  getSources,
  isSystemStorageName,
  listStables,
} from '../../../lib/storagePhysicalApi';
import { autoTagValues, suggestColumn, typeCompatible, valueColumns } from './SubtableWizardSteps';

interface PlannedRow {
  key: string;
  name: string;
  group: ModelSourceGroup;
  fields: { leaf: SourceRef; column: string }[];
  tags: { tag_name: string; value: string }[];
  problem?: string;
  result?: BulkRowResult;
}

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

  useEffect(() => {
    Promise.all([listStables(), getSources({ view: 'models' })])
      .then(([st, src]) => {
        setStables((st.items || []).filter((s) => !isSystemStorageName(s.physical_name)));
        setGroups(((src.groups || src.items || []) as unknown) as ModelSourceGroup[]);
      })
      .catch((err: Error) => setLoadError(err.message || 'Could not load supertables or Data Models.'))
      .finally(() => setLoading(false));
  }, []);

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

  const chosenGroups = groups.filter((g) => selectedModels.has(g.id));
  const fieldUnion = useMemo(() => {
    const m = new Map<string, SourceRef>();
    for (const g of chosenGroups) for (const f of g.fields) if (f.field_path && !m.has(f.field_path)) m.set(f.field_path, f);
    return [...m.values()];
  }, [chosenGroups]);

  // Column suggestion per field (guide F3), editable.
  useEffect(() => {
    setColumnFor((prev) => {
      const next = { ...prev };
      for (const f of fieldUnion) {
        const path = f.field_path as string;
        if (!next[path]) next[path] = atomic && cols.some((c) => c.name === f.key) ? String(f.key) : suggestColumn(f.value_type, cols) || '';
      }
      return next;
    });
  }, [fieldUnion, stableId, atomic]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plan rows whenever the matrix changes.
  useEffect(() => {
    if (!stable) { setRows([]); return; }
    const planned: PlannedRow[] = [];
    for (const g of chosenGroups) {
      const machine = slug(g.resource?.code || g.resource?.name || g.display_name);
      const leaves = g.fields.filter((f) => selectedFields.has(f.field_path as string));
      if (atomic) {
        if (!leaves.length) continue;
        const name = `${prefix}_${machine}`.slice(0, 63);
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
    const names = new Map<string, number>();
    planned.forEach((r) => names.set(r.name, (names.get(r.name) || 0) + 1));
    planned.forEach((r) => { if ((names.get(r.name) || 0) > 1) r.problem = r.problem || 'Duplicate name in this batch'; });
    setRows(planned);
  }, [stable, chosenGroups.length, selectedFields, columnFor, prefix, atomic]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const run = async (dryRun: boolean) => {
    const todo = rows.filter((r) => !r.problem && r.result?.status !== 'CREATED' && r.result?.status !== 'EXISTS');
    if (!todo.length) return;
    setRunning(dryRun ? 'validate' : 'create');
    setRunError(null);
    setProgress(0);
    const chunk = dryRun ? 50 : 20;
    try {
      for (let i = 0; i < todo.length; i += chunk) {
        const part = todo.slice(i, i + chunk);
        const res = await bulkCreateSubtables(part.map(specOf), dryRun);
        const byName = new Map(res.items.map((it) => [it.name, it]));
        setRows((prev) => prev.map((r) => (byName.has(r.name) ? { ...r, result: byName.get(r.name) } : r)));
        setProgress(Math.min(todo.length, i + part.length));
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'The request failed; already created rows are kept and are skipped on retry.');
    } finally {
      setRunning(null);
    }
  };

  const manifest = () => rows.map((r) => ({
    subtable: r.name,
    stable: stable?.id,
    model_id: r.group.id,
    model: r.group.display_name,
    machine: r.group.resource?.name,
    fields: r.fields.map((f) => ({ field_path: f.leaf.field_path, target_column: f.column })),
    tags: Object.fromEntries(r.tags.map((t) => [t.tag_name, t.value])),
    recording_mode: mode,
    status: r.result?.status || (r.problem ? 'BLOCKED' : 'NOT_RUN'),
    operation_id: r.result?.operation_id || null,
    error: r.result?.message || r.problem || null,
  }));

  const downloadCsv = () => {
    const head = ['subtable', 'stable', 'model_id', 'model', 'machine', 'field_path', 'target_column', 'status', 'operation_id', 'error'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = manifest().map((m) => [m.subtable, m.stable, m.model_id, m.model, m.machine,
      m.fields.map((f) => f.field_path).join('|'), m.fields.map((f) => f.target_column).join('|'), m.status, m.operation_id, m.error].map(esc).join(','));
    download('storage-subtables-manifest.csv', 'text/csv', [head.join(','), ...lines].join('\r\n'));
  };

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const k = r.result?.status || (r.problem ? 'BLOCKED' : 'PLANNED');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const runnable = rows.filter((r) => !r.problem && r.result?.status !== 'CREATED' && r.result?.status !== 'EXISTS').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/historian/storage?tab=objects')} aria-label="Back to Storage Management"
            className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[#D4DFEC] bg-white text-[#334568]"><ArrowLeft className="w-4 h-4" /></button>
          <div>
            <h1 className="text-[20px] font-bold text-[#111B37]">Generate subtables from Data Models</h1>
            <p className="text-[13px] text-[#657794]">One subtable per machine and field, through the same checks as the single wizard.</p>
          </div>
        </div>
      </div>

      {loading && <p className="text-[13px] text-[#657794] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>}
      {loadError && <p className="text-[13px] text-[#F2343B]">{loadError}</p>}

      {!loading && !loadError && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* 1. Supertable + recording */}
          <section className="bg-white border border-[#E3EAF3] rounded-xl p-4 space-y-3">
            <h2 className="text-[14px] font-bold text-[#111B37]">1. Supertable</h2>
            <select aria-label="Parent supertable" value={stableId} onChange={(e) => { setStableId(e.target.value); setPrefix(''); setColumnFor({}); }}
              className="w-full h-9 px-2 rounded-lg border border-[#D4DFEC] bg-white text-[13px]">
              <option value="">{stables.length ? 'Select a supertable…' : 'Create a supertable first'}</option>
              {stables.map((s) => <option key={s.id} value={s.id}>{s.physical_name} · {s.database_name}</option>)}
            </select>
            {stable && (
              <div className="text-[12px] text-[#657794] space-y-1">
                <div>Value columns: <span className="font-mono text-[#334568]">{cols.map((c) => c.name).join(', ') || 'none'}</span></div>
                <div>Tags: <span className="font-mono text-[#334568]">{stable.tags.map((t) => t.name).join(', ')}</span></div>
              </div>
            )}
            <label className="block text-[12px] font-semibold text-[#111B37]">Name prefix
              <input value={prefix} onChange={(e) => setPrefix(slug(e.target.value))} className="mt-1 w-full h-9 px-2 rounded-lg border border-[#D4DFEC] text-[13px] font-mono" />
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
          <section className="bg-white border border-[#E3EAF3] rounded-xl p-4 space-y-3 flex flex-col">
            <h2 className="text-[14px] font-bold text-[#111B37]">2. Data Models ({selectedModels.size} selected)</h2>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="Filter, e.g. State"
                className="w-full pl-8 h-9 rounded-lg border border-[#D4DFEC] text-[13px]" />
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
          <section className="bg-white border border-[#E3EAF3] rounded-xl p-4 space-y-3 flex flex-col">
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
        <section className="bg-white border border-[#E3EAF3] rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-bold text-[#111B37]">4. Review {rows.length} subtables</h2>
              <p className="text-[12px] text-[#657794]">{Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={!!running || runnable === 0} onClick={() => run(true)}
                className="h-9 px-4 rounded-lg border border-[#D4DFEC] bg-white text-[13px] font-semibold text-[#334568] disabled:opacity-50">
                {running === 'validate' ? `Validating ${progress}/${runnable}…` : 'Validate'}
              </button>
              <button type="button" disabled={!!running || runnable === 0} onClick={() => run(false)}
                className="h-9 px-4 rounded-lg bg-[#EF1B24] text-white text-[13px] font-semibold disabled:bg-[#E3EAF3] disabled:text-[#94A3B8]">
                {running === 'create' ? `Creating ${progress}/${runnable}…` : `Create ${runnable} subtables`}
              </button>
              <button type="button" onClick={downloadCsv} className="h-9 px-3 rounded-lg border border-[#D4DFEC] bg-white text-[13px] font-semibold text-[#334568] inline-flex items-center gap-1.5"><Download className="w-4 h-4" />CSV</button>
              <button type="button" onClick={() => download('storage-subtables-manifest.json', 'application/json', JSON.stringify(manifest(), null, 2))}
                className="h-9 px-3 rounded-lg border border-[#D4DFEC] bg-white text-[13px] font-semibold text-[#334568] inline-flex items-center gap-1.5"><Download className="w-4 h-4" />JSON</button>
            </div>
          </div>
          {runError && <p className="text-[12px] text-[#F2343B] flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{runError}</p>}
          <div className="overflow-x-auto max-h-[480px]">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[#F6F8FC]"><tr className="text-left text-[#657794] uppercase text-[11px]">
                <th className="p-2">Subtable</th><th>Model</th><th>Field → column</th><th>Tags</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-[#E3EAF3] align-top">
                    <td className="p-2 font-mono text-[#111B37]">{r.name}</td>
                    <td className="py-2">{r.group.display_name}<div className="text-[11px] text-[#657794]">{r.group.resource?.name}</div></td>
                    <td className="py-2 font-mono">{r.fields.map((f) => `${f.leaf.field_path} → ${f.column || '?'}`).join(', ')}</td>
                    <td className="py-2 font-mono text-[11px] text-[#657794]">{r.tags.map((t) => `${t.tag_name}=${t.value ? (t.value.length > 12 ? `${t.value.slice(0, 8)}…` : t.value) : '∅'}`).join(' ')}</td>
                    <td className="py-2">
                      {r.result ? (
                        <span className={`font-semibold ${STATUS_STYLE[r.result.status] || ''}`} title={r.result.message || (r.result.errors || []).map((e) => e.message).join('; ')}>
                          {r.result.status === 'CREATED' && <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />}{r.result.status}
                          {(r.result.message || r.result.errors?.length) && <div className="font-normal text-[11px] text-[#657794] max-w-[280px]">{r.result.message || r.result.errors?.[0]?.message}</div>}
                        </span>
                      ) : r.problem ? (
                        <span className="text-[#F2343B]">{r.problem}</span>
                      ) : r.tags.some((t) => !t.value) ? (
                        <span className="text-[#FFAA23]">Missing tag value</span>
                      ) : (
                        <span className="text-[#657794]">Planned</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#657794]">Rows that already exist are reported as EXISTS and never created twice. Retrying a failed run only sends the remaining rows.
            {' '}<Link to="/historian/storage?tab=objects" className="text-[#2A82E7] font-semibold">Open Objects table</Link></p>
        </section>
      )}
    </div>
  );
};
