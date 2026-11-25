/**
 * "Edit schema" of a user supertable (B-08, guide H9): add columns and tags only.
 *
 * TDengine can add a column or a tag to a supertable that already holds data (existing rows read NULL
 * in a new column; existing subtables get NULL for a new tag); it cannot reorder, drop-with-history or
 * retype in place, so the editor never offers that (the object menu has Duplicate for a corrected copy).
 * Flow: describe the additions -> "Preview DDL" (dry run, the server's exact ALTER statements) -> Apply.
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ApiError } from '../../../api/client';
import { alterStable, StableAlterResult, StableSchemaAddition, TDColumn, TDTag } from '../../../lib/storagePhysicalApi';
import { TAG_MAX_LENGTH, TD_COLUMN_TYPES, TD_TAG_BASE_TYPES, VAR_LENGTH_TYPES } from './StableWizardSteps';
import { NAME_MAX_LENGTH } from './useServerNameCheck';

interface Draft extends StableSchemaAddition {
  key: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const inputCls = 'h-8 px-2 rounded-lg border border-[#D4DFEC] text-[12px] bg-white focus:outline-none focus:border-blue-500';

function typeLabel(t: { td_type: string; length?: number | null }): string {
  const base = String(t.td_type || '').toUpperCase();
  return t.length && !base.includes('(') && VAR_LENGTH_TYPES.includes(base) ? `${base}(${t.length})` : base;
}

/** Local checks before the server's (same rules: identifier, unique, length for variable-length types). */
function localErrors(drafts: Draft[], taken: Set<string>, kind: 'column' | 'tag'): Record<number, string> {
  const out: Record<number, string> = {};
  const seen = new Set(taken);
  for (const d of drafts) {
    const n = d.name.trim();
    if (!n) out[d.key] = `Enter a ${kind} name.`;
    else if (n.length > NAME_MAX_LENGTH) out[d.key] = `Max ${NAME_MAX_LENGTH} characters.`;
    else if (!IDENT.test(n)) out[d.key] = 'Letters, digits and underscores; starts with a letter or underscore.';
    else if (seen.has(n.toLowerCase())) out[d.key] = `'${n}' already exists.`;
    else if (VAR_LENGTH_TYPES.includes(d.td_type) && !(d.length && d.length > 0)) out[d.key] = `${d.td_type} needs a length.`;
    else if (kind === 'tag' && d.length && d.length > TAG_MAX_LENGTH) out[d.key] = `A tag allows at most ${TAG_MAX_LENGTH} bytes.`;
    seen.add(n.toLowerCase());
  }
  return out;
}

function describeError(err: unknown): string[] {
  if (err instanceof ApiError) {
    const fe = Array.isArray(err.details.field_errors) ? (err.details.field_errors as { field?: string; message?: string }[]) : [];
    const lines = fe.filter((f) => f.message).map((f) => `${f.field ? `${f.field}: ` : ''}${f.message}`);
    return lines.length ? lines : [err.message];
  }
  return [err instanceof Error ? err.message : 'The request failed.'];
}

export const StableSchemaEditor: React.FC<{
  objectId: string;
  columns: TDColumn[];
  tags: TDTag[];
  subtableCount?: number;
  /** Called after a successful apply (reload the supertable). */
  onApplied?: (result: StableAlterResult) => void;
}> = ({ objectId, columns, tags, subtableCount, onApplied }) => {
  const [cols, setCols] = useState<Draft[]>([]);
  const [newTags, setNewTags] = useState<Draft[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [preview, setPreview] = useState<{ change: string; ddl: string[] } | null>(null);
  const [applied, setApplied] = useState<StableAlterResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string[] | null>(null);

  const taken = useMemo(() => new Set([...columns.map((c) => c.name.toLowerCase()), ...tags.map((t) => t.name.toLowerCase())]), [columns, tags]);
  const colErrors = localErrors(cols, taken, 'column');
  const tagErrors = localErrors(newTags, new Set([...taken, ...cols.map((c) => c.name.trim().toLowerCase())]), 'tag');
  const hasLocalErrors = Object.keys(colErrors).length + Object.keys(tagErrors).length > 0;
  const empty = cols.length === 0 && newTags.length === 0;

  const toBody = (list: Draft[]): StableSchemaAddition[] =>
    list.map((d) => ({ name: d.name.trim(), td_type: d.td_type, length: VAR_LENGTH_TYPES.includes(d.td_type) ? d.length ?? null : null }));
  const change = { add_columns: toBody(cols), add_tags: toBody(newTags) };
  const changeKey = JSON.stringify(change);
  const previewCurrent = preview?.change === changeKey;

  const edit = (setter: React.Dispatch<React.SetStateAction<Draft[]>>, key: number, patch: Partial<Draft>) => {
    setter((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    setApplied(null);
    setError(null);
  };
  const add = (setter: React.Dispatch<React.SetStateAction<Draft[]>>, td_type: string) => {
    setter((list) => [...list, { key: nextKey, name: '', td_type, length: VAR_LENGTH_TYPES.includes(td_type) ? 64 : null }]);
    setNextKey((k) => k + 1);
    setApplied(null);
  };

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const res = await alterStable(objectId, { ...change, dry_run: true });
      setPreview({ change: changeKey, ddl: res.ddl || [] });
    } catch (err) {
      setPreview(null);
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    if (!previewCurrent) return;
    setBusy('apply');
    setError(null);
    try {
      const res = await alterStable(objectId, change);
      setApplied(res);
      setPreview(null);
      setCols([]);
      setNewTags([]);
      onApplied?.(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const draftRows = (list: Draft[], setter: React.Dispatch<React.SetStateAction<Draft[]>>, types: readonly string[], errs: Record<number, string>, kind: 'column' | 'tag') =>
    list.map((d) => (
      <div key={d.key} className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label={`New ${kind} name`} value={d.name} maxLength={NAME_MAX_LENGTH + 1} placeholder={`${kind}_name`}
            onChange={(e) => edit(setter, d.key, { name: e.target.value })} className={`${inputCls} font-mono w-52`} />
          <select aria-label={`New ${kind} type`} value={d.td_type} className={inputCls}
            onChange={(e) => edit(setter, d.key, { td_type: e.target.value, length: VAR_LENGTH_TYPES.includes(e.target.value) ? d.length || 64 : null })}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {VAR_LENGTH_TYPES.includes(d.td_type) && (
            <input aria-label={`New ${kind} length`} type="number" min={1} max={kind === 'tag' ? TAG_MAX_LENGTH : 65517} value={d.length ?? ''}
              onChange={(e) => edit(setter, d.key, { length: e.target.value === '' ? null : Number(e.target.value) })} className={`${inputCls} w-24`} />
          )}
          <button type="button" aria-label={`Remove new ${kind}`} onClick={() => { setter((l) => l.filter((x) => x.key !== d.key)); setApplied(null); }}
            className="p-1.5 rounded-lg text-[#657794] hover:text-[#DB2028] hover:bg-[#FFF5F5]">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {errs[d.key] && <p className="text-[11px] text-[#F2343B] flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{errs[d.key]}</p>}
      </div>
    ));

  return (
    <div className="space-y-5" data-testid="stable-schema-editor">
      <div>
        <h2 className="text-[15px] font-bold text-[#111B37]">Edit schema</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Add columns or tags. Existing columns and tags cannot be removed, renamed or retyped here (use Duplicate for a corrected copy).
          {subtableCount ? ` The ${subtableCount.toLocaleString()} existing subtable${subtableCount === 1 ? '' : 's'} keep their rows; new columns read NULL there, new tags start empty.` : ''}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="border border-[#E3EAF3] rounded-xl p-3 space-y-2">
          <div className="text-[12px] font-semibold text-[#334568]">Columns ({columns.length})</div>
          <ul className="text-[12px] font-mono space-y-0.5 max-h-40 overflow-y-auto">
            {columns.map((c) => <li key={c.name} className="flex justify-between gap-2"><span>{c.name}</span><span className="text-[#657794]">{typeLabel(c)}</span></li>)}
          </ul>
          {draftRows(cols, setCols, TD_COLUMN_TYPES, colErrors, 'column')}
          <Button type="button" size="sm" variant="outline" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => add(setCols, 'DOUBLE')}>Add column</Button>
        </section>
        <section className="border border-[#E3EAF3] rounded-xl p-3 space-y-2">
          <div className="text-[12px] font-semibold text-[#334568]">Tags ({tags.length})</div>
          <ul className="text-[12px] font-mono space-y-0.5 max-h-40 overflow-y-auto">
            {tags.map((t) => <li key={t.name} className="flex justify-between gap-2"><span>{t.name}</span><span className="text-[#657794]">{typeLabel(t)}</span></li>)}
          </ul>
          {draftRows(newTags, setNewTags, TD_TAG_BASE_TYPES, tagErrors, 'tag')}
          <Button type="button" size="sm" variant="outline" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => add(setNewTags, 'VARCHAR')}>Add tag</Button>
        </section>
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-xl border border-[#FAC6C9] bg-[#FFF0F1] text-[12px] text-[#334568] space-y-1">
          {error.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      {applied && (
        <div role="status" className="p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-[12px] text-emerald-900 space-y-1">
          <div className="font-semibold flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />Schema updated ({applied.ddl.length} statement{applied.ddl.length === 1 ? '' : 's'} applied).</div>
          <pre className="font-mono whitespace-pre-wrap break-all">{applied.ddl.join(';\n')}</pre>
        </div>
      )}
      {preview && (
        <div>
          <div className="text-[12px] font-semibold text-[#657794] uppercase tracking-wide mb-1">
            DDL to run (dry run{previewCurrent ? '' : ' — out of date, preview again'})
          </div>
          <pre className={`p-3 rounded-xl bg-[#111B37] text-[#E3EAF3] text-[12px] font-mono whitespace-pre-wrap break-all ${previewCurrent ? '' : 'opacity-50'}`}>
            {preview.ddl.join(';\n') || '—'}
          </pre>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => void runPreview()}
          disabled={empty || hasLocalErrors || busy !== null} loading={busy === 'preview'}>
          Preview DDL
        </Button>
        <Button type="button" size="sm" variant="primary" onClick={() => void runApply()}
          disabled={empty || hasLocalErrors || !previewCurrent || busy !== null} loading={busy === 'apply'}>
          Apply schema change
        </Button>
        {!empty && !previewCurrent && !hasLocalErrors && <span className="text-[11px] text-[#657794]">Preview the DDL first; Apply runs exactly that.</span>}
      </div>
    </div>
  );
};
