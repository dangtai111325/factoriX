import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, CircleAlert, CircleDashed, Search, Trash2 } from 'lucide-react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { ApplyResult, ModelTemplate } from './types';
import { applyTemplate, deleteTemplate, errorText } from './modelApi';
import { useTemplates } from './hooks';
import { parentPathLabel } from './modelLogic';
import { Banner, KindBadge, Modal } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  resources: ResourceNode[];
}

type Step = 'templates' | 'machines' | 'review';
type Grid = Record<string, Record<string, ApplyResult>>; // templateId -> resourceId -> result

const signalFieldCount = (t: ModelTemplate) => t.members.filter((m) => m.kind === 'signal' || m.kind === 'snapshot').length;

export const TemplateWizard: React.FC<Props> = ({ open, onClose, onCreated, resources }) => {
  const { templates, loading, error, reload } = useTemplates(open);
  const [step, setStep] = useState<Step>('templates');
  const [selTemplates, setSelTemplates] = useState<string[]>([]);
  const [selMachines, setSelMachines] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [q, setQ] = useState('');
  const [publish, setPublish] = useState(false);
  const [grid, setGrid] = useState<Grid>({});
  const [created, setCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ t: string; r: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const types = useMemo(() => Array.from(new Set(resources.map((r) => String(r.type)))).sort(), [resources]);

  useEffect(() => {
    if (!open) return;
    setStep('templates');
    setSelTemplates([]);
    setSelMachines([]);
    setQ('');
    setPublish(false);
    setGrid({});
    setCreated(false);
    setOpError(null);
    setFocus(null);
    setTypeFilter(types.includes('machine') ? 'machine' : '');
  }, [open]);

  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return resources
      .filter((r) => !typeFilter || String(r.type) === typeFilter)
      .map((r) => ({ r, path: parentPathLabel(resources, r.id) }))
      .filter(({ r, path }) => !needle || `${r.name} ${r.code} ${path}`.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path) || a.r.name.localeCompare(b.r.name));
  }, [resources, typeFilter, q]);

  const chosenTemplates = templates.filter((t) => selTemplates.includes(t.id));
  const chosenMachines = selMachines.map((id) => resources.find((r) => r.id === id)).filter(Boolean) as ResourceNode[];
  const allCandidatesSelected = candidates.length > 0 && candidates.every(({ r }) => selMachines.includes(r.id));

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const runApply = async (dryRun: boolean) => {
    setBusy(true);
    setOpError(null);
    const next: Grid = dryRun ? {} : { ...grid };
    const failures: string[] = [];
    for (const t of chosenTemplates) {
      try {
        const results = await applyTemplate(t.id, selMachines, { publish, dryRun });
        next[t.id] = Object.fromEntries(results.map((r) => [r.resource_id, r]));
      } catch (err) {
        failures.push(`${t.display_name}: ${errorText(err)}`);
      }
    }
    setGrid(next);
    setBusy(false);
    if (failures.length) setOpError(failures.join(' · '));
    if (!dryRun) {
      setCreated(true);
      onCreated();
    }
  };

  const allResults = Object.values(grid).flatMap((row) => Object.values(row));
  const ready = allResults.filter((r) => r.status === 'dry_run').length;
  const withMissing = allResults.filter((r) => r.status === 'missing').length;
  const exists = allResults.filter((r) => r.status === 'exists').length;
  const createdCount = allResults.filter((r) => r.status === 'created').length;

  const handleDelete = async (id: string) => {
    setConfirmDelete(null);
    try {
      await deleteTemplate(id);
      setSelTemplates((s) => s.filter((x) => x !== id));
      await reload();
    } catch (err) {
      setOpError(errorText(err, 'Could not delete the template.'));
    }
  };

  const stepIdx = { templates: 0, machines: 1, review: 2 }[step];
  const focusResult = focus ? grid[focus.t]?.[focus.r] : null;

  const footer = (
    <>
      {step !== 'templates' && !created && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setStep(step === 'review' ? 'machines' : 'templates')}>
          Back
        </Button>
      )}
      <div className="flex-1" />
      {step === 'templates' && (
        <Button size="sm" disabled={selTemplates.length === 0} onClick={() => setStep('machines')}>
          Next: choose resources
        </Button>
      )}
      {step === 'machines' && (
        <Button
          size="sm"
          disabled={selMachines.length === 0}
          loading={busy}
          onClick={() => {
            setStep('review');
            void runApply(true);
          }}
        >
          Next: check signals
        </Button>
      )}
      {step === 'review' && !created && (
        <>
          <label className="flex items-center gap-1.5 text-[12px] text-[#334568] mr-2">
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
            Publish after creating
          </label>
          <Button size="sm" loading={busy} disabled={busy || ready === 0} onClick={() => void runApply(false)}>
            Create {ready} model{ready === 1 ? '' : 's'}
          </Button>
        </>
      )}
      {created && (
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xl"
      title="New models from template"
      subtitle="Pick one or more templates, pick the machines, check which signals resolve, then create every model in one step."
      footer={footer}
    >
      <div className="flex items-center gap-2 mb-4 text-[12px]">
        {['Templates', 'Resources', 'Check & create'].map((label, i) => (
          <React.Fragment key={label}>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold ${
                i === stepIdx ? 'bg-[#111B37] text-white' : i < stepIdx ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {i + 1}. {label}
            </span>
            {i < 2 && <ChevronRight className="w-3.5 h-3.5 text-slate-300" />}
          </React.Fragment>
        ))}
      </div>

      {opError && (
        <div className="mb-3">
          <Banner tone="error" onClose={() => setOpError(null)}>
            {opError}
          </Banner>
        </div>
      )}

      {step === 'templates' && (
        <div className="space-y-3">
          {error && (
            <Banner tone="error" action={<Button size="sm" variant="outline" onClick={() => void reload()}>Retry</Button>}>
              {error}
            </Banner>
          )}
          {loading && templates.length === 0 && <p className="text-[12px] text-[#657794]">Loading templates…</p>}
          {!loading && !error && templates.length === 0 && (
            <p className="text-[12px] text-[#657794]">No templates are available. Save a model as a template from the model editor.</p>
          )}
          {templates.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[#657794]">{selTemplates.length} selected</span>
              <Button size="sm" variant="ghost" onClick={() => setSelTemplates(selTemplates.length === templates.length ? [] : templates.map((t) => t.id))}>
                {selTemplates.length === templates.length ? 'Clear selection' : 'Select all'}
              </Button>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {templates.map((t) => {
              const on = selTemplates.includes(t.id);
              return (
                <div
                  key={t.id}
                  role="checkbox"
                  aria-checked={on}
                  tabIndex={0}
                  onClick={() => setSelTemplates(toggle(selTemplates, t.id))}
                  onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), setSelTemplates(toggle(selTemplates, t.id)))}
                  className={`p-3 rounded-lg border cursor-pointer transition ${
                    on ? 'border-[#EF1B24] bg-red-50/30 ring-1 ring-[#EF1B24]/30' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <input type="checkbox" readOnly checked={on} tabIndex={-1} className="pointer-events-none" />
                      <span className="font-bold text-[13px] text-[#111B37] truncate">{t.display_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <KindBadge kind={t.kind} />
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                        {t.builtin ? 'Built-in' : 'Custom'}
                      </span>
                      {!t.builtin &&
                        (confirmDelete === t.id ? (
                          <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button className="text-[10px] font-bold text-red-700 hover:underline" onClick={() => void handleDelete(t.id)}>
                              Delete
                            </button>
                            <button className="text-[10px] text-slate-500 hover:underline" onClick={() => setConfirmDelete(null)}>
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            aria-label={`Delete template ${t.display_name}`}
                            className="p-0.5 rounded text-slate-400 hover:text-red-600"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(t.id);
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ))}
                    </div>
                  </div>
                  <div className="text-[11px] text-[#657794] mt-1">
                    {t.members.length} fields · {signalFieldCount(t)} from signals
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.members.map((m) => (
                      <span
                        key={m.alias}
                        title={m.kind}
                        className={`font-mono text-[10px] px-1 rounded ${
                          m.kind === 'signal' || m.kind === 'snapshot' ? 'bg-slate-100 text-slate-700' : 'bg-blue-50 text-blue-700'
                        }`}
                      >
                        {m.alias}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {step === 'machines' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white"
              aria-label="Resource type"
            >
              <option value="">All resource types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search resources"
                className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={candidates.length === 0}
              onClick={() =>
                setSelMachines(
                  allCandidatesSelected
                    ? selMachines.filter((id) => !candidates.some(({ r }) => r.id === id))
                    : Array.from(new Set([...selMachines, ...candidates.map(({ r }) => r.id)])),
                )
              }
            >
              {allCandidatesSelected ? 'Deselect shown' : `Select all shown (${candidates.length})`}
            </Button>
            <span className="text-[12px] text-[#657794]">{selMachines.length} selected</span>
          </div>
          {candidates.length === 0 ? (
            <p className="text-[12px] text-[#657794] p-6 text-center border border-dashed border-slate-200 rounded-lg">
              No resources match. Build the factory model first, or change the type filter.
            </p>
          ) : (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[50vh] overflow-y-auto">
              {candidates.map(({ r, path }) => (
                <label key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                  <input type="checkbox" checked={selMachines.includes(r.id)} onChange={() => setSelMachines(toggle(selMachines, r.id))} />
                  <span className="font-semibold text-[12px] text-[#111B37]">{r.name}</span>
                  <span className="font-mono text-[10px] text-[#657794]">{r.code}</span>
                  <span className="ml-auto text-[11px] text-[#657794] truncate">{path}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-3">
          {!created ? (
            <Banner tone="info">
              {busy
                ? 'Checking which template fields resolve to signals on each resource…'
                : `${ready} ready · ${withMissing} with missing signals · ${exists} already exist. Signal fields resolve by signal key (e.g. "status"). "Create" creates every ready cell; cells with missing signals or an existing model are skipped. Click a cell for details.`}
            </Banner>
          ) : (
            <Banner tone="success">
              {createdCount} model{createdCount === 1 ? '' : 's'} created{publish ? ' and published' : ' as drafts'}.
              {allResults.length - createdCount > 0 && ` ${allResults.length - createdCount} skipped (see grid).`}
            </Banner>
          )}
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50 text-[#657794] font-semibold border-b border-slate-200">
                  <th className="text-left py-2 px-3 sticky left-0 bg-slate-50">Resource</th>
                  {chosenTemplates.map((t) => (
                    <th key={t.id} className="py-2 px-3 text-center whitespace-nowrap">
                      {t.display_name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {chosenMachines.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 px-3 font-semibold text-[#111B37] sticky left-0 bg-white whitespace-nowrap">{r.name}</td>
                    {chosenTemplates.map((t) => {
                      const res = grid[t.id]?.[r.id];
                      const total = signalFieldCount(t);
                      const isFocus = focus?.t === t.id && focus?.r === r.id;
                      return (
                        <td key={t.id} className="py-1.5 px-2 text-center">
                          <button
                            type="button"
                            disabled={!res}
                            onClick={() => setFocus(isFocus ? null : { t: t.id, r: r.id })}
                            className={`w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border ${
                              isFocus ? 'ring-2 ring-blue-300' : ''
                            } ${cellCls(res)}`}
                          >
                            {cellIcon(res)}
                            {cellLabel(res, total)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {focusResult && (
            <div className="p-3 border border-slate-200 rounded-lg bg-slate-50 text-[12px]">
              <div className="font-semibold text-[#111B37] mb-1">
                {focusResult.resource_name || chosenMachines.find((m) => m.id === focusResult.resource_id)?.name} ·{' '}
                {chosenTemplates.find((t) => t.id === focus?.t)?.display_name}
              </div>
              {focusResult.missing_keys.length === 0 ? (
                <p className="text-[#657794]">All signal fields resolve on this resource.</p>
              ) : (
                <>
                  <p className="text-[#657794] mb-1">No active signal with these keys on this resource:</p>
                  <div className="flex flex-wrap gap-1">
                    {focusResult.missing_keys.map((k) => (
                      <span key={k} className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
                        {k}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

function cellCls(r: ApplyResult | undefined): string {
  if (!r) return 'border-slate-200 text-slate-400 bg-white';
  if (r.status === 'created') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (r.status === 'exists') return 'border-slate-200 bg-slate-100 text-slate-600';
  if (r.missing_keys.length > 0) return r.status === 'missing' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-emerald-200 bg-white text-emerald-700';
}

function cellIcon(r: ApplyResult | undefined) {
  if (!r) return <CircleDashed className="w-3 h-3" />;
  if (r.status === 'exists') return <CircleDashed className="w-3 h-3" />;
  if (r.missing_keys.length > 0 && r.status !== 'created') return <CircleAlert className="w-3 h-3" />;
  return <CheckCircle2 className="w-3 h-3" />;
}

function cellLabel(r: ApplyResult | undefined, total: number): string {
  if (!r) return '…';
  if (r.status === 'exists') return r.published ? 'Exists · published' : 'Exists';
  if (r.status === 'created') return r.missing_keys.length ? `Created · ${r.missing_keys.length} unmapped` : 'Created';
  if (r.missing_keys.length > 0) return `${Math.max(0, total - r.missing_keys.length)}/${total} · ${r.missing_keys.length} missing`;
  return `Ready ${total}/${total}`;
}
