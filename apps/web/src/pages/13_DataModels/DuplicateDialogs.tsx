// "Duplicate…" (plain copy) and "Duplicate to machines…" (one re-pointed copy per target resource).
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { useSubmit } from '../../lib/useSubmit';
import { duplicateModel, duplicateToTargets, errorText, getModel, isNotFound } from './api';
import { useCatalog } from './hooks';
import { resourceLabel, resourcePath } from './rules';
import { wireOwners } from './spec';
import type { DuplicateOutcome, ModelDetail, ModelListItem } from './types';
import { Dialog, fieldCls, labelCls } from './ui';

export const DuplicateDialog: React.FC<{
  model: ModelListItem | null;
  models: ModelListItem[];
  onClose: () => void;
  onDone: (createdId: string | null, message: string) => void;
}> = ({ model, models, onClose, onDone }) => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!model) return;
    let candidate = `${model.name} (copy)`;
    for (let i = 2; models.some((m) => m.name.toLowerCase() === candidate.toLowerCase()); i += 1) candidate = `${model.name} (copy ${i})`;
    setName(candidate);
    setError(null);
  }, [model, models]);
  const trimmed = name.trim();
  const taken = models.some((m) => m.name.trim().toLowerCase() === trimmed.toLowerCase());
  const submit = useSubmit(async () => {
    if (!model) return;
    setError(null);
    try {
      const out = await duplicateModel(model.id, trimmed);
      onDone(out.createdId, `Created “${out.createdName || trimmed}”.`);
    } catch (err) {
      setError(errorText(err, 'Could not duplicate the model.'));
    }
  });
  return (
    <Dialog
      open={Boolean(model)}
      onClose={onClose}
      busy={submit.pending}
      width="sm"
      title="Duplicate data model"
      subtitle={model ? `A copy of “${model.name}” with the same body and references.` : undefined}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submit.pending}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!trimmed || taken || submit.pending} onClick={() => void submit.run()}>
            {submit.pending ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </>
      }
    >
      <label htmlFor="dup-name" className={labelCls}>
        Name of the copy
      </label>
      <input
        id="dup-name"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && trimmed && !taken) void submit.run();
        }}
        className={fieldCls}
      />
      {taken && <p className="mt-1 text-[11px] text-red-700">Another data model already uses this name.</p>}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
          {error}
        </p>
      )}
    </Dialog>
  );
};


/** One model to copy: its detail and the resource each copy replaces. */
interface Source {
  model: ModelListItem;
  detail: ModelDetail;
  sourceId: string | null;
  /** Why the model cannot take part (several resources, nothing to re-point). */
  problem: string | null;
}

/** Dry-run outcome of every model for one target. */
interface TargetPlan {
  outcomes: Map<string, DuplicateOutcome>;
  /** Fields that would keep reading the source, summed over the models. */
  unmatchedFields: number;
  /** Unmatched references (deduplicated) with the number of fields using each. */
  missing: Array<{ ref: string; reason: string; count: number }>;
}

const DRY_RUN_CHUNK = 100; // server MAX_TARGETS

/**
 * "Duplicate to machines…" for one or several models (UX#2): one copy per model and target. Every
 * reference to the model's source moves to the signal with the same key on the target. Targets that
 * do not have every referenced signal are disabled by default (UX#3); allowing them needs an explicit
 * confirmation, because such a copy keeps reading the source for those fields (R4-DM-15).
 */
export const DuplicateToMachinesDialog: React.FC<{
  models: ModelListItem[] | null;
  onClose: () => void;
  onDone: (createdIds: string[], message: string) => void;
}> = ({ models, onClose, onDone }) => {
  const { index, loading: catalogLoading } = useCatalog();
  const [details, setDetails] = useState<Map<string, ModelDetail>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickedSource, setPickedSource] = useState('');
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [plans, setPlans] = useState<Map<string, TargetPlan>>(new Map());
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [onlyComplete, setOnlyComplete] = useState(true);
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [results, setResults] = useState<Array<{ model: ModelListItem; outcome: DuplicateOutcome }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(models && models.length);
  const modelKey = (models || []).map((m) => m.id).join(',');

  useEffect(() => {
    setDetails(new Map());
    setLoadError(null);
    setTargets(new Set());
    setResults(null);
    setError(null);
    setQuery('');
    setPickedSource('');
    setOnlyComplete(true);
    setConfirmPartial(false);
    if (!models || !models.length) return;
    let alive = true;
    Promise.all(models.map((m) => getModel(m.id)))
      .then((list) => alive && setDetails(new Map(list.map((d) => [d.id, d]))))
      .catch((err) => alive && setLoadError(errorText(err, 'Could not load the model(s).')));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  const single = (models || []).length === 1;
  const firstOwners = useMemo(() => {
    const d = models && models[0] ? details.get(models[0].id) : undefined;
    return d ? wireOwners(d.spec, index) : [];
  }, [models, details, index]);
  useEffect(() => {
    if (firstOwners.length && !firstOwners.includes(pickedSource)) setPickedSource(firstOwners[0]);
  }, [firstOwners, pickedSource]);

  /** The resource type being replaced: the (picked) source of the first model. */
  const sourceType = index.resById.get(pickedSource)?.type || '';

  const sources = useMemo<Source[]>(() => {
    if (!models) return [];
    return models.map((model, i) => {
      const detail = details.get(model.id);
      if (!detail) return { model, detail: detail as unknown as ModelDetail, sourceId: null, problem: 'Loading…' };
      const owners = wireOwners(detail.spec, index);
      if (i === 0 && pickedSource) return { model, detail, sourceId: pickedSource, problem: null };
      if (!owners.length) return { model, detail, sourceId: null, problem: 'References no resource; nothing to re-point.' };
      const sameType = owners.filter((id) => index.resById.get(id)?.type === sourceType);
      if (sameType.length === 1) return { model, detail, sourceId: sameType[0], problem: null };
      if (!sameType.length) return { model, detail, sourceId: null, problem: `Uses no ${index.catalog.typeNames[sourceType] || sourceType || 'resource'} of the same type.` };
      return { model, detail, sourceId: null, problem: 'Uses several resources of this type; duplicate it on its own to choose the source.' };
    });
  }, [models, details, index, pickedSource, sourceType]);
  const usable = sources.filter((s) => s.sourceId);
  const sourceIds = new Set(usable.map((s) => s.sourceId!));

  const candidates = useMemo(() => {
    if (!sourceType) return [];
    return index.catalog.resources
      .filter((r) => r.type === sourceType && !sourceIds.has(r.id))
      .sort((a, b) => resourceLabel(a).localeCompare(resourceLabel(b), undefined, { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, index, Array.from(sourceIds).sort().join(',')]);

  // Dry run of every model against every candidate once: exact names and unmatched references per target.
  const planKey = `${usable.map((s) => `${s.model.id}:${s.sourceId}`).join('|')}#${candidates.map((c) => c.id).join(',')}`;
  useEffect(() => {
    setPlans(new Map());
    setPlanError(null);
    if (!open || !usable.length || !candidates.length) return;
    let alive = true;
    setPlanning(true);
    (async () => {
      const next = new Map<string, TargetPlan>();
      candidates.forEach((c) => next.set(c.id, { outcomes: new Map(), unmatchedFields: 0, missing: [] }));
      for (const s of usable) {
        const ids = candidates.map((c) => c.id);
        for (let i = 0; i < ids.length; i += DRY_RUN_CHUNK) {
          const chunk = ids.slice(i, i + DRY_RUN_CHUNK);
          const out = await duplicateToTargets(s.model.id, s.sourceId!, chunk, { dryRun: true });
          out.forEach((o, k) => {
            const plan = next.get(o.targetId || chunk[k]);
            if (!plan) return;
            plan.outcomes.set(s.model.id, o);
            plan.unmatchedFields += o.unmatchedFields;
            o.unmatched.forEach((u) => {
              const hit = plan.missing.find((x) => x.ref === u.ref);
              if (hit) hit.count += u.count;
              else plan.missing.push({ ref: u.ref, reason: u.reason, count: u.count });
            });
          });
        }
      }
      if (alive) setPlans(next);
    })()
      .catch((err) => alive && setPlanError(isNotFound(err) ? 'This server cannot check targets in advance.' : errorText(err, 'Could not check the targets.')))
      .finally(() => alive && setPlanning(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, open]);

  const q = query.trim().toLowerCase();
  const shown = candidates.filter((r) => !q || resourceLabel(r).toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
  const complete = (id: string) => {
    const p = plans.get(id);
    return Boolean(p) && p!.unmatchedFields === 0;
  };
  const selectable = (id: string) => !onlyComplete || complete(id);
  const selected = Array.from(targets).filter((id) => candidates.some((c) => c.id === id) && selectable(id));
  const partial = selected.filter((id) => !complete(id));
  const partialFields = partial.reduce((n, id) => n + (plans.get(id)?.unmatchedFields || 0), 0);
  const copies = selected.length * usable.length;
  const needsConfirm = partial.length > 0 && !confirmPartial;

  useEffect(() => {
    if (!partial.length) setConfirmPartial(false);
  }, [partial.length]);

  const submit = useSubmit(async () => {
    if (!selected.length || !usable.length) return;
    setError(null);
    const out: Array<{ model: ModelListItem; outcome: DuplicateOutcome }> = [];
    try {
      for (const s of usable) {
        const res = await duplicateToTargets(s.model.id, s.sourceId!, selected, { dryRun: false, skipUnmatched: !confirmPartial });
        res.forEach((o) => out.push({ model: s.model, outcome: o }));
      }
      setResults(out);
    } catch (err) {
      if (out.length) setResults(out);
      setError(errorText(err, 'Could not create the copies.'));
    }
  });

  const toggle = (id: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const created = results?.filter((r) => r.outcome.createdId) || [];
  const finish = () =>
    onDone(
      created.map((c) => c.outcome.createdId!),
      `Created ${created.length} cop${created.length === 1 ? 'y' : 'ies'}${single && models ? ` of “${models[0].name}”` : ` of ${usable.length} models`}.`,
    );
  const loading = !loadError && (catalogLoading || (models || []).some((m) => !details.has(m.id)));
  const typeName = index.catalog.typeNames[sourceType] || sourceType || 'resource';

  return (
    <Dialog
      open={open}
      onClose={results ? finish : onClose}
      busy={submit.pending}
      width="lg"
      title={single ? 'Duplicate to machines' : `Duplicate ${models?.length || 0} models to machines`}
      subtitle={
        models && models.length
          ? `One copy ${single ? `of “${models[0].name}”` : 'of each model'} per target. Every reference to the source moves to the signal with the same key on the target.`
          : undefined
      }
      footer={
        results ? (
          <Button variant="primary" size="sm" onClick={finish}>
            Done
          </Button>
        ) : (
          <>
            {partial.length > 0 && (
              <span className="mr-auto text-[11px] text-amber-800">
                {partial.length} target(s) miss signals: {partialFields} field(s) would keep reading the source.
              </span>
            )}
            <Button variant="outline" size="sm" onClick={onClose} disabled={submit.pending}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!copies || submit.pending || needsConfirm || planning} onClick={() => void submit.run()}>
              {submit.pending ? 'Creating…' : `Create ${copies || ''} cop${copies === 1 ? 'y' : 'ies'}`}
            </Button>
          </>
        )
      }
    >
      {loadError ? (
        <p role="alert" className="text-[12px] text-red-700">
          {loadError}
        </p>
      ) : loading ? (
        <div className="flex items-center gap-2 text-[12px] text-[#657794]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : results ? (
        <ul className="space-y-2" aria-label="Results">
          {results.map(({ model, outcome: r }, i) => (
            <li key={`${model.id}-${r.targetId || i}`} className="rounded-lg border border-[#E2E8F0] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                {r.createdId ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-amber-600" />}
                <span className="font-semibold text-[#111B37]">{r.createdName || resourceLabel(index.resById.get(r.targetId || ''))}</span>
                {r.skipped ? (
                  <span className="text-amber-800">Not created: {r.unmatchedFields} field(s) have no matching signal on the target.</span>
                ) : (
                  <span className="text-[#657794]">{r.replaced} reference(s) re-pointed</span>
                )}
              </div>
              {r.unmatched.length > 0 && (
                <ul className="mt-1 ml-6 text-[11px] text-amber-800 list-disc">
                  {r.unmatched.map((u) => (
                    <li key={u.ref}>
                      <span className="font-mono">{u.ref}</span> — {u.reason}
                      {u.count > 1 ? ` (${u.count} fields)` : ''}
                      {!r.skipped && ' · still reads the source'}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
          {error && (
            <li role="alert" className="text-[12px] text-red-700">
              {error}
            </li>
          )}
        </ul>
      ) : !sourceType ? (
        <p className="text-[12px] text-[#657794]">{single ? 'This model references no resource, so there is nothing to re-point. Use “Duplicate…” instead.' : 'The first selected model references no resource.'}</p>
      ) : (
        <div className="space-y-4">
          {single ? (
            <div>
              <label htmlFor="dup-source" className={labelCls}>
                Source (replaced in each copy)
              </label>
              <select
                id="dup-source"
                value={pickedSource}
                onChange={(e) => {
                  setPickedSource(e.target.value);
                  setTargets(new Set());
                }}
                className={`${fieldCls} bg-white`}
              >
                {firstOwners.map((id) => {
                  const r = index.resById.get(id);
                  return (
                    <option key={id} value={id}>
                      {resourceLabel(r)} ({index.catalog.typeNames[r?.type || ''] || r?.type}) — {resourcePath(index, id).slice(0, -1).map(resourceLabel).join(' › ')}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : (
            <div>
              <span className={labelCls}>Models and their source</span>
              <ul className="max-h-36 overflow-y-auto border border-[#E2E8F0] rounded-lg divide-y divide-slate-100 text-[12px]">
                {sources.map((s) => (
                  <li key={s.model.id} className="px-3 py-1.5 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[#111B37]">{s.model.name}</span>
                    {s.sourceId ? (
                      <span className="text-[#657794]">replaces {resourceLabel(index.resById.get(s.sourceId))}</span>
                    ) : (
                      <span className="text-amber-800">Skipped: {s.problem}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <span className={labelCls}>Targets ({typeName})</span>
              <div className="flex gap-3 text-[11px] font-semibold">
                <button type="button" className="text-[#134074] hover:underline" onClick={() => setTargets(new Set(shown.filter((c) => selectable(c.id)).map((c) => c.id)))}>
                  Select all{onlyComplete ? ' matching' : ''}
                </button>
                <button type="button" className="text-[#657794] hover:underline" onClick={() => setTargets(new Set())}>
                  None
                </button>
              </div>
            </div>
            <label className="flex items-start gap-2 mb-2 text-[12px] text-[#334568] cursor-pointer">
              <input type="checkbox" checked={onlyComplete} onChange={(e) => setOnlyComplete(e.target.checked)} className="mt-0.5" />
              <span>
                Only {typeName}s that have every referenced signal
                <span className="block text-[11px] text-[#657794]">Others are listed but cannot be selected: their copy would keep reading the source for the missing signals.</span>
              </span>
            </label>
            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search targets" className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500" />
            </div>
            {planError && <p className="mb-2 text-[11px] text-amber-800">{planError}</p>}
            {shown.length === 0 ? (
              <p className="text-[12px] text-[#657794]">No other {typeName} found.</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto border border-[#E2E8F0] rounded-lg divide-y divide-slate-100">
                {shown.map((r) => {
                  const plan = plans.get(r.id);
                  const can = selectable(r.id) && (Boolean(plan) || Boolean(planError));
                  const on = targets.has(r.id) && can;
                  const firstName = plan && models ? plan.outcomes.get(models[0].id)?.createdName : undefined;
                  return (
                    <li key={r.id} className={on ? 'bg-blue-50/50' : !can ? 'bg-slate-50' : ''}>
                      <label className={`flex items-start gap-2 px-3 py-2 ${can ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}>
                        <input type="checkbox" checked={on} disabled={!can} onChange={() => toggle(r.id)} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-semibold text-[#111B37]">{resourceLabel(r)}</span>
                          <span className="block text-[11px] text-[#657794] truncate">{resourcePath(index, r.id).slice(0, -1).map(resourceLabel).join(' › ')}</span>
                          {plan && (
                            <span className="block mt-1 text-[11px]">
                              {on && <span className="block text-[#334568]">{single ? `Creates “${firstName || ''}”` : `Creates ${usable.length} copies`}</span>}
                              {plan.missing.length > 0 ? (
                                <span className="block text-amber-800" title={plan.missing.map((u) => `${u.ref}: ${u.reason}`).join('\n')}>
                                  Missing {plan.missing.length} signal(s):{' '}
                                  <span className="font-mono">
                                    {plan.missing
                                      .slice(0, 5)
                                      .map((u) => `${u.ref.split('.').pop()}${u.count > 1 ? ` ×${u.count}` : ''}`)
                                      .join(', ')}
                                  </span>
                                  {plan.missing.length > 5 ? ' …' : ''}
                                </span>
                              ) : (
                                <span className="block text-emerald-700">All references match.</span>
                              )}
                            </span>
                          )}
                        </span>
                        {planning && !plan && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {partial.length > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 cursor-pointer">
              <input type="checkbox" checked={confirmPartial} onChange={(e) => setConfirmPartial(e.target.checked)} className="mt-0.5" />
              <span>
                Create the copies for {partial.map((id) => resourceLabel(index.resById.get(id))).join(', ')} anyway. {partialFields} field(s) in them keep reading the source
                {usable.length === 1 ? ` ${resourceLabel(index.resById.get(usable[0].sourceId!))}` : ''} until you fix them.
              </span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
};
