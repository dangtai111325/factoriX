/**
 * Subtable wizard steps (WS-H v6).
 *
 * - Bind Sources picks a Data Model FIELD (leaf), never a whole model; the binding carries
 *   source_kind=model_field + model_id + field_path (review P0-1, guide G-02/G-04).
 * - Tag values are picked from the Factory Model context of the bound model (machine / line /
 *   zone), never typed from invented examples (P1-6).
 * - Recording is off until the user starts it; "On new event" writes one atomic row per event (G-06).
 * - The Review step shows the DDL and binding resolution computed by the backend (P1-4).
 * - No simulated rows are shown anywhere (G-09).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Info, Link2, Loader2, Search, Unlink } from 'lucide-react';
import {
  FieldBindingIntent,
  FactoryRef,
  ModelSourceGroup,
  RecordingMode,
  RowAssemblyPolicy,
  SourceRef,
  StoragePlan,
  TDColumn,
  TDStable,
  TagValueAssignment,
  getSources,
  isSystemStorageName,
  listStables,
  planStorageObject,
} from '../../../lib/storagePhysicalApi';
import { useApp } from '../../../store/AppContext';
import { Button } from '../../../components/common/Button';
import { ResourceRefValue } from '../objectViews';
import { DESCRIPTION_MAX_LENGTH } from './useServerNameCheck';

// ============================================================================
// Types & helpers
// ============================================================================

export interface SubtableWizardData {
  stable_id: string;
  stable_name?: string;
  database_name?: string;
  physical_name: string;
  display_name: string;
  description: string;
  tag_values: TagValueAssignment[];
  bindings: FieldBindingIntent[];
  row_assembly_policy: RowAssemblyPolicy;
  recording_mode: RecordingMode;
  max_age_seconds?: number | null;
  time_bucket_seconds?: number | null;
  start_recording?: boolean;
  no_binding?: boolean;
  identity_paths?: string[];
  confirmed?: boolean;
}

export interface SubtableStepProps {
  data: SubtableWizardData;
  onChange: (patch: Partial<SubtableWizardData>) => void;
  errors?: Record<string, string>;
  parentStable?: TDStable | null;
  onSelectStable?: (stable: TDStable) => void;
}

/** Columns the recorder fills itself (guide E1); never a binding target. */
export const WRITER_COLUMNS = new Set([
  'event_key', 'source_timestamp', 'publish_timestamp', 'field_source_timestamp', 'quality', 'quality_reason',
  'is_null', 'model_ref', 'model_field_path', 'model_revision', 'data_epoch', 'source_event_uid', 'time_basis',
]);

export function valueColumns(stable: TDStable | null | undefined): TDColumn[] {
  if (!stable) return [];
  return stable.columns.filter((c, i) => i > 0 && !c.primary_key && !WRITER_COLUMNS.has(c.name));
}

const TYPE_COMPAT: Record<string, string[]> = {
  float: ['DOUBLE', 'FLOAT'],
  int: ['BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'DOUBLE'],
  bool: ['BOOL', 'TINYINT', 'INT', 'BIGINT'],
  string: ['VARCHAR', 'NCHAR', 'BINARY'],
  timestamp: ['TIMESTAMP', 'VARCHAR', 'NCHAR'],
  json: ['VARCHAR', 'NCHAR'],
  auto: ['DOUBLE', 'FLOAT', 'BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'BOOL', 'VARCHAR', 'NCHAR', 'BINARY'],
};

export function baseType(tdType: string): string {
  return String(tdType || '').toUpperCase().split('(')[0].trim();
}

export function typeCompatible(valueType: string | null | undefined, column: TDColumn): boolean {
  return (TYPE_COMPAT[String(valueType || 'auto').toLowerCase()] || []).includes(baseType(column.td_type));
}

/** Guide F3: float -> value_f64, int -> value_i64, string -> value_text. */
export function suggestColumn(valueType: string | null | undefined, cols: TDColumn[]): string | null {
  const prefs: Record<string, string[]> = {
    float: ['value_f64', 'value_double', 'value'],
    int: ['value_i64', 'value_int', 'value_f64', 'value'],
    bool: ['value_bool', 'value_i64', 'value'],
    string: ['value_text', 'value_str', 'value'],
    timestamp: ['value_text'],
    json: ['value_text'],
    auto: ['value_f64', 'value_i64', 'value_text', 'value'],
  };
  const names = cols.map((c) => c.name);
  for (const cand of prefs[String(valueType || 'auto').toLowerCase()] || []) {
    if (names.includes(cand)) return cand;
  }
  const compatible = cols.find((c) => typeCompatible(valueType, c));
  return compatible ? compatible.name : null;
}

/**
 * Tag values derived from the Factory Model context of a bound model field:
 * `machine*` -> the model's resource, `line*` / `zone*` / `area*` / `site*` -> the nearest ancestor
 * of that type, `field_key` -> the field key. Only empty tags are filled.
 */
export function autoTagValues(
  tags: { name: string }[],
  current: TagValueAssignment[],
  group: ModelSourceGroup | null | undefined,
  leaf: SourceRef | null | undefined,
): TagValueAssignment[] {
  const byName = new Map(current.map((t) => [t.tag_name, t.value]));
  const ancestorOf = (needle: string): FactoryRef | undefined =>
    group?.ancestors.find((a) => a.type_key.toLowerCase().includes(needle));
  return tags.map((t) => {
    const existing = byName.get(t.name) || '';
    if (existing.trim()) return { tag_name: t.name, value: existing };
    const n = t.name.toLowerCase();
    let value = '';
    if (n.startsWith('machine') && group?.resource) value = group.resource.id;
    else if (n.startsWith('resource') && group?.resource) value = group.resource.id;
    else if (n.startsWith('line')) value = ancestorOf('line')?.id || '';
    else if (n.startsWith('zone')) value = ancestorOf('zone')?.id || '';
    else if (n.startsWith('area')) value = ancestorOf('area')?.id || '';
    else if (n.startsWith('site')) value = ancestorOf('site')?.id || '';
    else if (n === 'field_key' && leaf) value = String(leaf.key || leaf.field_path || '').split('/').pop() || '';
    return { tag_name: t.name, value };
  });
}

/** Request body for plan / create (same shape for both). */
export function buildSubtableSpec(data: SubtableWizardData): Record<string, unknown> {
  const [db, st] = data.stable_id.includes('.') ? data.stable_id.split('.', 2) : [data.database_name || '', data.stable_id];
  const atomic = data.recording_mode === 'ON_NEW_EVENT';
  return {
    database: db,
    stable: st,
    name: data.physical_name,
    physical_name: data.physical_name,
    display_name: data.display_name || undefined,
    description: data.description || undefined,
    tag_values: data.tag_values.map((t) => ({ name: t.tag_name, value: t.value })),
    bindings: data.bindings.map((b) => ({
      source_kind: b.source_kind,
      source_id: b.source_id,
      model_id: b.model_id ?? undefined,
      field_path: b.field_path ?? undefined,
      signal_id: b.signal_id ?? undefined,
      column_name: b.column_name,
    })),
    no_binding: data.bindings.length === 0 && !!data.no_binding,
    recording: {
      mode: data.recording_mode,
      row_assembly: atomic ? 'ATOMIC_EVENT' : 'INDEPENDENT_EVENTS',
      start_recording: !!data.start_recording,
      identity_paths: data.identity_paths || [],
    },
  };
}

const inputCls =
  'w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 bg-white';

const Field: React.FC<{ label: string; required?: boolean; error?: string; hint?: string; children: React.ReactNode }> = ({
  label, required, error, hint, children,
}) => (
  <div>
    <label className="block text-[12px] font-semibold text-[#334568] mb-1">
      {label} {required && <span className="text-[#EF1B24]">*</span>}
    </label>
    {children}
    {error ? (
      <p className="text-[12px] text-[#F2343B] mt-1 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>
    ) : hint ? (
      <p className="text-[11px] text-[#657794] mt-1">{hint}</p>
    ) : null}
  </div>
);

const StepHeader: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => (
  <div>
    <h2 className="text-[15px] font-bold text-[#111B37]">{title}</h2>
    <p className="text-[13px] text-[#657794] mt-1">{subtitle}</p>
  </div>
);

// ============================================================================
// Step 1: Identity
// ============================================================================

export const SubtableIdentityStep: React.FC<SubtableStepProps> = ({ data, onChange, errors = {}, onSelectStable }) => {
  const [stables, setStables] = useState<TDStable[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listStables()
      .then((res) => {
        if (!active) return;
        // FactoriX system supertables (operational history) are never a parent (P1-5 / R1-16).
        setStables((res.items || []).filter((s) => !isSystemStorageName(s.physical_name) && !(s as { is_system?: boolean }).is_system));
      })
      .catch((err: Error) => active && setLoadError(err.message || 'Supertables could not be loaded.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const select = (id: string) => {
    const st = stables.find((s) => s.id === id);
    if (!st) return;
    onChange({ stable_id: st.id, stable_name: st.physical_name, database_name: st.database_name });
    onSelectStable?.(st);
  };

  return (
    <div className="space-y-6">
      <StepHeader title="Identity" subtitle="Choose the parent supertable and name the subtable." />
      <div className="space-y-4 max-w-xl">
        <Field label="Parent supertable" required error={errors.stable_id || loadError || undefined}
          hint="Only your own supertables are listed; FactoriX system supertables are read-only.">
          <select value={data.stable_id} onChange={(e) => select(e.target.value)} className={inputCls}>
            <option value="" disabled>{loading ? 'Loading supertables…' : stables.length ? 'Select a supertable…' : 'No user supertable yet — create one first'}</option>
            {stables.map((s) => (
              <option key={s.id} value={s.id}>
                {s.physical_name} · {s.database_name} ({s.subtable_count} subtables)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subtable name" required error={errors.physical_name}
          hint="Physical name in TDengine: lowercase letters, digits and underscores, at most 63 characters.">
          <input type="text" maxLength={63} value={data.physical_name}
            onChange={(e) => onChange({ physical_name: e.target.value.toLowerCase().trim() })}
            className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Display name">
          <input type="text" maxLength={200} value={data.display_name} onChange={(e) => onChange({ display_name: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Description" error={errors.description} hint={`${(data.description || '').length}/${DESCRIPTION_MAX_LENGTH}`}>
          <textarea maxLength={DESCRIPTION_MAX_LENGTH} rows={3} value={data.description} onChange={(e) => onChange({ description: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-[#D4DFEC] text-[13px] focus:outline-none focus:border-blue-500" />
        </Field>
      </div>
    </div>
  );
};

// ============================================================================
// Factory Model resource choices (machine / line / zone) from the models view
// ============================================================================

function useModelGroups(): { groups: ModelSourceGroup[]; loading: boolean; error: string | null } {
  const [groups, setGroups] = useState<ModelSourceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getSources({ view: 'models' })
      .then((res) => active && setGroups(((res.groups || res.items || []) as unknown) as ModelSourceGroup[]))
      .catch((err: Error) => active && setError(err.message || 'Data Models could not be loaded.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);
  return { groups, loading, error };
}

function factoryChoices(groups: ModelSourceGroup[]): FactoryRef[] {
  const seen = new Map<string, FactoryRef>();
  for (const g of groups) {
    if (g.resource) seen.set(g.resource.id, g.resource);
    for (const a of g.ancestors || []) seen.set(a.id, a);
  }
  return [...seen.values()].sort((a, b) => a.type_key.localeCompare(b.type_key) || a.name.localeCompare(b.name));
}

// ============================================================================
// Step 2: Tag values
// ============================================================================

/** Resource types a reference tag usually points at, from its name (machine_ref → machine, line_ref → line…). */
function refTypesFor(tagName: string): string[] {
  const n = tagName.toLowerCase();
  if (n.startsWith('machine') || n.startsWith('resource') || n.startsWith('equipment')) return ['machine', 'equipment', 'cell'];
  if (n.startsWith('line')) return ['line'];
  if (n.startsWith('zone') || n.startsWith('area')) return ['zone', 'area'];
  if (n.startsWith('site') || n.startsWith('plant')) return ['site', 'plant'];
  return [];
}

export const SubtableTagValuesStep: React.FC<SubtableStepProps> = ({ data, onChange, errors = {}, parentStable }) => {
  const { groups } = useModelGroups();
  const { resources, refresh, loadState } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  // The whole Factory Model (live store, so resources created a minute ago are there — R2-19), plus any
  // resource the Data Models know that the store has not loaded.
  const choices = useMemo(() => {
    const m = new Map<string, FactoryRef>();
    for (const r of resources) m.set(r.id, { id: r.id, name: r.name, code: r.code, type_key: String(r.type || '') });
    for (const c of factoryChoices(groups)) if (!m.has(c.id)) m.set(c.id, c);
    return [...m.values()].sort((a, b) => a.type_key.localeCompare(b.type_key) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [resources, groups]);
  const lastRefresh = React.useRef(0);
  const reloadResources = () => {
    // At most every 30 s: the store reload is not free on a busy appliance.
    if (refreshing || Date.now() - lastRefresh.current < 30_000) return;
    lastRefresh.current = Date.now();
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  };
  const tags = parentStable?.tags || [];

  const setValue = (name: string, value: string) => {
    const next = tags.map((t) => ({
      tag_name: t.name,
      value: t.name === name ? value : data.tag_values.find((tv) => tv.tag_name === t.name)?.value || '',
    }));
    onChange({ tag_values: next });
  };

  if (!parentStable) {
    return <p className="text-[13px] text-[#657794]">Select a parent supertable first.</p>;
  }
  return (
    <div className="space-y-6">
      <StepHeader title="Tag values"
        subtitle="Static identity of this subtable. Reference tags (machine, line, zone) store the Factory Model id; pick it instead of typing it." />
      {errors.tag_values && <p className="text-[12px] text-[#F2343B]">{errors.tag_values}</p>}
      <div className="space-y-4 max-w-2xl">
        {tags.map((t) => {
          const value = data.tag_values.find((tv) => tv.tag_name === t.name)?.value || '';
          const isRef = /(_ref|_id)$/.test(t.name);
          const picked = choices.find((c) => c.id === value);
          const wanted = refTypesFor(t.name);
          const suggested = wanted.length ? choices.filter((c) => wanted.includes(c.type_key.toLowerCase())) : [];
          const others = choices.filter((c) => !suggested.includes(c));
          const label = (c: FactoryRef) => `${c.name}${c.code && c.code !== c.name ? ` (${c.code})` : ''} · ${c.type_key}`;
          return (
            <Field key={t.name} label={`${t.name} (${t.td_type}${t.length ? `(${t.length})` : ''})`}
              hint={picked ? `${picked.name}${picked.code ? ` · ${picked.code}` : ''} · ${picked.type_key} · id ${picked.id}` : isRef && value ? 'This id is not in the Factory Model.' : isRef ? 'Pick a Factory Model resource, or paste its id.' : undefined}>
              <div className="flex flex-wrap gap-2">
                {isRef ? (
                  <>
                    <select
                      aria-label={`Pick ${t.name} from Factory Model`}
                      value={picked ? picked.id : ''}
                      onFocus={reloadResources}
                      onChange={(e) => setValue(t.name, e.target.value)}
                      className={`${inputCls} flex-1 min-w-[220px]`}
                    >
                      <option value="">{loadState !== 'ready' || refreshing ? 'Loading the Factory Model…' : 'Pick from Factory Model…'}</option>
                      {suggested.length > 0 && (
                        <optgroup label={`Suggested (${wanted.join(' / ')})`}>
                          {suggested.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
                        </optgroup>
                      )}
                      <optgroup label={suggested.length ? 'Other resources' : 'Resources'}>
                        {others.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
                      </optgroup>
                    </select>
                    <input type="text" value={value} onChange={(e) => setValue(t.name, e.target.value.trim())} placeholder="or paste an id"
                      aria-label={`${t.name} id`} className={`${inputCls} font-mono w-[300px] max-w-full text-[12px]`} />
                  </>
                ) : (
                  <input type="text" value={value} onChange={(e) => setValue(t.name, e.target.value)} className={`${inputCls} font-mono`} />
                )}
              </div>
            </Field>
          );
        })}
      </div>
      <p className="text-[12px] text-[#657794] flex items-center gap-1.5"><Info className="w-3.5 h-3.5" />
        Binding a Data Model field in the next step fills empty machine / line / zone / field_key tags from that model.
      </p>
    </div>
  );
};

// ============================================================================
// Step 3: Bind sources (Data Model field leaves)
// ============================================================================

export const SubtableBindSourcesStep: React.FC<SubtableStepProps> = ({ data, onChange, errors = {}, parentStable }) => {
  const { groups, loading, error } = useModelGroups();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ group: ModelSourceGroup; leaf: SourceRef } | null>(null);
  const [column, setColumn] = useState('');
  const cols = valueColumns(parentStable);
  const atomic = data.recording_mode === 'ON_NEW_EVENT';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => `${g.display_name} ${f.field_path} ${g.resource?.code || ''}`.toLowerCase().includes(q)) }))
      .filter((g) => g.fields.length > 0 || g.display_name.toLowerCase().includes(q));
  }, [groups, search]);

  const choose = (group: ModelSourceGroup, leaf: SourceRef) => {
    setPending({ group, leaf });
    setColumn(suggestColumn(leaf.value_type, cols.filter((c) => !data.bindings.some((b) => b.column_name === c.name))) || '');
  };

  const bind = () => {
    if (!pending || !column) return;
    const { group, leaf } = pending;
    const binding: FieldBindingIntent = {
      column_name: column,
      source_kind: 'model_field',
      source_id: `mod:${group.id}:${leaf.field_path}`,
      source_path: String(leaf.field_path || ''),
      model_id: group.id,
      field_path: leaf.field_path || null,
    };
    const others = atomic ? data.bindings.filter((b) => b.column_name !== column) : [];
    const sameModel = others.filter((b) => b.model_id === group.id);
    onChange({
      bindings: [...sameModel, binding],
      no_binding: false,
      tag_values: autoTagValues(parentStable?.tags || [], data.tag_values, group, leaf),
    });
    setPending(null);
  };

  const remove = (col: string) => onChange({ bindings: data.bindings.filter((b) => b.column_name !== col) });

  return (
    <div className="space-y-5">
      <StepHeader title="Bind sources"
        subtitle={atomic
          ? 'On new event: bind each business field of ONE Data Model to its column; one row is written per new event.'
          : 'Pick one Data Model field and the typed value column it is written to.'} />
      {errors.bindings && <p className="text-[12px] text-[#F2343B]">{errors.bindings}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-[#E3EAF3] rounded-xl bg-white flex flex-col max-h-[480px]">
          <div className="p-3 border-b border-[#E3EAF3]">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search model, machine or field"
                className="w-full pl-8 pr-2 h-8 rounded-lg border border-[#D4DFEC] text-[12px] focus:outline-none focus:border-blue-500" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading && <p className="p-4 text-[12px] text-[#657794] flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading Data Models…</p>}
            {error && <p className="p-4 text-[12px] text-[#F2343B]">{error}</p>}
            {!loading && !error && filtered.length === 0 && <p className="p-4 text-[12px] text-[#657794]">No Data Model matches.</p>}
            {filtered.map((g) => {
              const open = expanded.has(g.id) || !!search;
              return (
                <div key={g.id} className="rounded-lg">
                  <button type="button" onClick={() => setExpanded((prev) => { const n = new Set(prev); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-[#F6F8FC] text-left">
                    <span className="flex items-center gap-1.5 min-w-0">
                      {open ? <ChevronDown className="w-3.5 h-3.5 text-[#657794]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#657794]" />}
                      <span className="text-[12px] font-semibold text-[#111B37] truncate">{g.display_name}</span>
                      {g.resource && <span className="text-[11px] text-[#657794] truncate">· {g.resource.name}</span>}
                    </span>
                    <span className="text-[11px] text-[#657794] shrink-0">{g.fields_count} fields</span>
                  </button>
                  {open && (
                    <div className="pl-6 pb-1 space-y-0.5">
                      {g.fields.map((f) => {
                        const taken = f.bound_to && !(f.bound_to.subtable === data.physical_name);
                        const isPending = pending?.leaf.id === f.id;
                        const isBound = data.bindings.some((b) => b.model_id === g.id && b.field_path === f.field_path);
                        return (
                          <button key={f.id} type="button" disabled={!!taken} onClick={() => choose(g, f)}
                            title={taken ? `Already recorded in ${f.bound_to?.database}.${f.bound_to?.subtable}` : f.display_name}
                            className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded-md text-left text-[12px] ${
                              isPending ? 'bg-[#FFF0F1] text-[#111B37]' : 'hover:bg-[#F6F8FC]'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                            <span className="font-mono truncate">{f.field_path}</span>
                            <span className="flex items-center gap-2 shrink-0 text-[11px] text-[#657794]">
                              <span>{f.value_type}</span>
                              <span className="max-w-[90px] truncate" title="Last value">{f.has_last_value ? String(f.last_value ?? 'null') : '—'}</span>
                              {isBound && <Check className="w-3.5 h-3.5 text-[#0DBA67]" />}
                              {taken && <span>recorded</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <div className="border border-[#E3EAF3] rounded-xl bg-white p-4 space-y-3">
            <div className="text-[12px] font-semibold text-[#657794] uppercase tracking-wide">Selected field</div>
            {pending ? (
              <>
                <div className="text-[13px] text-[#111B37]">
                  <span className="font-semibold">{pending.group.display_name}</span> · <span className="font-mono">{pending.leaf.field_path}</span>
                  <span className="text-[#657794]"> ({pending.leaf.value_type})</span>
                </div>
                <Field label="Target column" required hint="Typed value column of the supertable; audit columns are filled by the recorder.">
                  <select value={column} onChange={(e) => setColumn(e.target.value)} className={inputCls}>
                    <option value="">Choose a column…</option>
                    {cols.map((c) => (
                      <option key={c.name} value={c.name} disabled={!typeCompatible(pending.leaf.value_type, c)}>
                        {c.name} ({c.td_type}){!typeCompatible(pending.leaf.value_type, c) ? ' — incompatible' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="button" onClick={bind} disabled={!column}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[#EF1B24] text-white text-[13px] font-semibold disabled:bg-[#E3EAF3] disabled:text-[#94A3B8]">
                  <Link2 className="w-4 h-4" />Bind
                </button>
              </>
            ) : (
              <p className="text-[12px] text-[#657794]">Expand a Data Model and click one of its fields.</p>
            )}
          </div>

          <div className="border border-[#E3EAF3] rounded-xl bg-white p-4">
            <div className="text-[12px] font-semibold text-[#657794] uppercase tracking-wide mb-2">Bindings ({data.bindings.length})</div>
            {data.bindings.length === 0 ? (
              <label className="flex items-start gap-2 text-[12px] text-[#334568]">
                <input type="checkbox" checked={!!data.no_binding} onChange={(e) => onChange({ no_binding: e.target.checked })} className="mt-0.5" />
                <span>Create this subtable without a binding (nothing will be recorded until a binding exists).</span>
              </label>
            ) : (
              <table className="w-full text-[12px]">
                <thead><tr className="text-[#657794] text-left"><th className="py-1">Source field</th><th>Column</th><th /></tr></thead>
                <tbody>
                  {data.bindings.map((b) => {
                    const g = groups.find((x) => x.id === b.model_id);
                    return (
                      <tr key={b.column_name} className="border-t border-[#E3EAF3]">
                        <td className="py-1.5"><span className="font-semibold">{g?.display_name || b.model_id}</span> · <span className="font-mono">{b.field_path}</span>
                          <div className="text-[11px] text-[#657794]">model_field</div></td>
                        <td className="font-mono">{b.column_name}</td>
                        <td className="text-right"><button type="button" onClick={() => remove(b.column_name)} className="text-[#657794] hover:text-[#F2343B]" aria-label="Remove binding"><Unlink className="w-3.5 h-3.5" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Step 4: Recording
// ============================================================================

const MODES: { id: RecordingMode; label: string; detail: string }[] = [
  { id: 'ON_CHANGE', label: 'On change', detail: 'First value is the baseline; afterwards a row only when the value, null-state or quality changes. Re-publishing the same value writes nothing.' },
  { id: 'ON_NEW_EVENT', label: 'On new event', detail: 'One row holding all bound fields per new event (for example a completion). A repeated identical event is not written again.' },
  { id: 'EVERY_ACQUISITION', label: 'Every model sample', detail: 'A row for every model sample, even when nothing changed. Use only when every sample is needed.' },
];

export const SubtableRowAssemblyStep: React.FC<SubtableStepProps> = ({ data, onChange, parentStable }) => {
  const cols = parentStable?.columns || [];
  return (
    <div className="space-y-6">
      <StepHeader title="Recording" subtitle="How changes of the bound field(s) are written to this subtable." />
      <div className="space-y-2 max-w-2xl">
        {MODES.map((m) => (
          <label key={m.id} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer ${data.recording_mode === m.id ? 'border-[#EF1B24] bg-[#FFF7F8]' : 'border-[#E3EAF3] bg-white'}`}>
            <input type="radio" name="recording_mode" checked={data.recording_mode === m.id}
              onChange={() => onChange({ recording_mode: m.id, row_assembly_policy: m.id === 'ON_NEW_EVENT' ? 'ATOMIC_EVENT' : 'INDEPENDENT_EVENTS' })} className="mt-1" />
            <span><span className="text-[13px] font-semibold text-[#111B37]">{m.label}</span><span className="block text-[12px] text-[#657794]">{m.detail}</span></span>
          </label>
        ))}
      </div>
      {data.recording_mode === 'ON_NEW_EVENT' && (
        <div className="max-w-2xl p-3 rounded-xl border border-[#FFE2B3] bg-[#FFF6E5] text-[12px] text-[#334568]">
          The event identity is the bound fields plus the model body <span className="font-mono">source_timestamp</span>.
          The source is the sampled Data Model body: two events between two model samples cannot be told apart.
        </div>
      )}
      <label className="flex items-start gap-2 max-w-2xl text-[13px] text-[#334568]">
        <input type="checkbox" checked={!!data.start_recording} onChange={(e) => onChange({ start_recording: e.target.checked })} className="mt-1" />
        <span><span className="font-semibold">Start recording after creation</span>
          <span className="block text-[12px] text-[#657794]">Off by default. You can start or pause recording later from the object page.</span></span>
      </label>
      {cols.length > 0 && (
        <div className="max-w-2xl">
          <div className="text-[12px] font-semibold text-[#657794] uppercase tracking-wide mb-1">Columns written per row</div>
          <div className="flex flex-wrap gap-1.5">
            {cols.map((c, i) => {
              const bound = data.bindings.some((b) => b.column_name === c.name);
              const writer = i === 0 || c.primary_key || WRITER_COLUMNS.has(c.name);
              return (
                <span key={c.name} className={`px-2 py-0.5 rounded-md text-[11px] font-mono border ${bound ? 'border-[#EF1B24] text-[#111B37]' : writer ? 'border-[#D4DFEC] text-[#334568]' : 'border-[#E3EAF3] text-[#94A3B8]'}`}
                  title={bound ? 'Bound value' : writer ? 'Filled by the recorder' : 'Left empty'}>{c.name}</span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Step 5: Review (backend plan)
// ============================================================================

/** Kept for compatibility; the Review step shows the backend plan instead. */
export function generateSubtableDDL(data: SubtableWizardData): string {
  return `-- Generated by the backend on Review (${data.physical_name})`;
}

/** TAG_MACHINE_MISMATCH errors of a plan by tag name (`field = tag_values.<tag>`, R2-09). */
export function machineMismatchByTag(plan: Pick<StoragePlan, 'errors'> | null): Map<string, { message: string; expected?: string }> {
  const out = new Map<string, { message: string; expected?: string }>();
  for (const e of plan?.errors || []) {
    if (e.code !== 'TAG_MACHINE_MISMATCH' || !e.field?.startsWith('tag_values.')) continue;
    const tag = e.field.slice('tag_values.'.length);
    if (!out.has(tag)) out.set(tag, { message: e.message, expected: e.expected });
  }
  return out;
}

export const SubtableReviewStep: React.FC<SubtableStepProps> = ({ data, onChange, errors = {} }) => {
  const { resources } = useApp();
  const [plan, setPlan] = useState<StoragePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const specKey = JSON.stringify(buildSubtableSpec(data));

  useEffect(() => {
    let active = true;
    setLoading(true);
    planStorageObject('subtable', JSON.parse(specKey))
      .then((p) => active && setPlan(p))
      .catch((err: Error) => active && setPlanError(err.message || 'The plan could not be computed.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [specKey]);

  const mismatches = machineMismatchByTag(plan);
  const otherErrors = (plan?.errors || []).filter((e) => !(e.code === 'TAG_MACHINE_MISMATCH' && e.field?.startsWith('tag_values.')));
  const machineName = (id?: string) => {
    const r = id ? resources.find((x) => x.id === id) : undefined;
    return r ? `${r.name}${r.code && r.code !== r.name ? ` (${r.code})` : ''}` : id || '';
  };
  const applyMachine = (tag: string, id: string) =>
    onChange({ tag_values: data.tag_values.map((tv) => (tv.tag_name === tag ? { ...tv, value: id } : tv)), confirmed: false });

  return (
    <div className="space-y-5">
      <StepHeader title="Review" subtitle="Exactly what the backend will execute and register." />
      {loading && <p className="text-[12px] text-[#657794] flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Computing the plan…</p>}
      {planError && <p className="text-[12px] text-[#F2343B]">{planError}</p>}
      {plan && (
        <>
          {otherErrors.length > 0 && (
            <div className="p-3 rounded-xl border border-[#FAC6C9] bg-[#FFF0F1] text-[12px] text-[#334568] space-y-1">
              {otherErrors.map((e, i) => <div key={i}><span className="font-semibold">{e.field || 'spec'}:</span> {e.message}</div>)}
            </div>
          )}
          {mismatches.size > 0 && (
            <p className="text-[12px] text-[#F2343B] flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              A machine tag does not match the machine of the bound field. Fix it below before creating.
            </p>
          )}
          {plan.warnings.length > 0 && (
            <div className="p-3 rounded-xl border border-[#FFE2B3] bg-[#FFF6E5] text-[12px] text-[#334568] space-y-1">
              {plan.warnings.map((e, i) => <div key={i}>{e.message}</div>)}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
            <div className="p-3 rounded-xl border border-[#E3EAF3] bg-white"><div className="text-[#657794]">Target</div><div className="font-mono text-[#111B37]">{data.stable_id} → {data.physical_name}</div></div>
            <div className="p-3 rounded-xl border border-[#E3EAF3] bg-white"><div className="text-[#657794]">Recording</div><div className="text-[#111B37]">{plan.recording?.mode || data.recording_mode} · {plan.recording?.start_recording ? 'starts after creation' : 'off until started'}</div></div>
            <div className="p-3 rounded-xl border border-[#E3EAF3] bg-white"><div className="text-[#657794]">Bindings</div><div className="text-[#111B37]">{(plan.bindings || []).length || (data.no_binding ? 'none (explicit)' : '0')}</div></div>
          </div>
          {data.tag_values.length > 0 && (
            <div className="p-3 rounded-xl border border-[#E3EAF3] bg-white text-[12px] space-y-1.5">
              <div className="text-[#657794]">Tag values</div>
              {data.tag_values.map((tv) => {
                const mm = mismatches.get(tv.tag_name);
                return (
                  <div key={tv.tag_name} data-tag-error={mm ? 'TAG_MACHINE_MISMATCH' : undefined}
                    className={mm ? 'rounded-lg border border-[#FAC6C9] bg-[#FFF0F1] p-2 -mx-1' : undefined}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold text-[#111B37] w-28 shrink-0">{tv.tag_name}</span>
                      {/(_ref|_id)$/.test(tv.tag_name) ? <ResourceRefValue value={tv.value} /> : <span className="font-mono break-all">{tv.value || '—'}</span>}
                    </div>
                    {mm && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-0 sm:pl-[7.5rem]">
                        <span className="text-[12px] text-[#B3261E] flex items-start gap-1">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          {mm.expected
                            ? `This tag points to machine ${machineName(tv.value)} but the bound field belongs to machine ${machineName(mm.expected)}.`
                            : mm.message}
                        </span>
                        {mm.expected && (
                          <Button type="button" size="sm" variant="outline" onClick={() => applyMachine(tv.tag_name, mm.expected as string)}>
                            Use {machineName(mm.expected)}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {(plan.bindings || []).length > 0 && (
            <table className="w-full text-[12px] border border-[#E3EAF3] rounded-xl bg-white">
              <thead><tr className="text-left text-[#657794] bg-[#F6F8FC]"><th className="p-2">Kind</th><th>Model</th><th>Field path</th><th>Column</th></tr></thead>
              <tbody>{(plan.bindings || []).map((b) => (
                <tr key={b.target_column} className="border-t border-[#E3EAF3]"><td className="p-2">{b.source_kind}</td><td>{b.model_name || b.model_id}</td><td className="font-mono">{b.model_field_path}</td><td className="font-mono">{b.target_column}</td></tr>
              ))}</tbody>
            </table>
          )}
          <div>
            <div className="text-[12px] font-semibold text-[#657794] uppercase tracking-wide mb-1">Physical DDL (from the backend)</div>
            <pre className="p-3 rounded-xl bg-[#111B37] text-[#E3EAF3] text-[12px] font-mono whitespace-pre-wrap break-all">{plan.ddl.join(';\n') || '—'}</pre>
          </div>
        </>
      )}
      <label className="flex items-start gap-2 text-[13px] text-[#334568]">
        <input type="checkbox" checked={!!data.confirmed} disabled={!plan || !plan.valid} onChange={(e) => onChange({ confirmed: e.target.checked })} className="mt-1" />
        <span>I reviewed the DDL and bindings and want to create this subtable.</span>
      </label>
      {errors.confirmed && <p className="text-[12px] text-[#F2343B]">{errors.confirmed}</p>}
    </div>
  );
};
