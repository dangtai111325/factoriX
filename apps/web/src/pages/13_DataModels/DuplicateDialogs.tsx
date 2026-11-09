// "Duplicate…" (plain copy) and "Duplicate to machines…" (one re-pointed copy per target resource).
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { useSubmit } from '../../lib/useSubmit';
import { duplicateModel, duplicateToTargets, errorText, getModel, isNotFound } from './api';
import { useCatalog } from './hooks';
import { resourceLabel, resourcePath } from './rules';
import { retargetName, unmatchedForTarget, wireOwners } from './spec';
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

interface Plan {
  name: string;
  unmatched: Array<{ ref: string; reason: string }>;
}

export const DuplicateToMachinesDialog: React.FC<{
  model: ModelListItem | null;
  onClose: () => void;
  onDone: (createdIds: string[], message: string) => void;
}> = ({ model, onClose, onDone }) => {
  const { index, loading: catalogLoading } = useCatalog();
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [plans, setPlans] = useState<Map<string, Plan>>(new Map());
  const [planning, setPlanning] = useState(false);
  const [serverPlan, setServerPlan] = useState(true);
  const [results, setResults] = useState<DuplicateOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setTargets(new Set());
    setResults(null);
    setError(null);
    setQuery('');
    if (!model) return;
    let alive = true;
    getModel(model.id)
      .then((d) => alive && setDetail(d))
      .catch((err) => alive && setLoadError(errorText(err, 'Could not load the model.')));
    return () => {
      alive = false;
    };
  }, [model]);

  const owners = useMemo(() => (detail ? wireOwners(detail.spec, index) : []), [detail, index]);
  useEffect(() => {
    if (owners.length && !owners.includes(sourceId)) setSourceId(owners[0]);
  }, [owners, sourceId]);

  const source = index.resById.get(sourceId);
  const candidates = useMemo(() => {
    if (!source) return [];
    const q = query.trim().toLowerCase();
    return index.catalog.resources
      .filter((r) => r.type === source.type && r.id !== source.id)
      .filter((r) => !q || resourceLabel(r).toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      .sort((a, b) => resourceLabel(a).localeCompare(resourceLabel(b), undefined, { numeric: true }));
  }, [source, index, query]);

  const targetKey = Array.from(targets).sort().join(',');

  // Plan: server dry run (exact names and unmatched references), client estimate as fallback.
  useEffect(() => {
    if (!model || !detail || !source || !targets.size) {
      setPlans(new Map());
      return;
    }
    const ids = targetKey.split(',');
    const local = new Map<string, Plan>(
      ids.map((id) => [
        id,
        {
          name: retargetName(detail.name, resourceLabel(source), resourceLabel(index.resById.get(id))),
          unmatched: unmatchedForTarget(detail.spec, index, source.id, id).map((k) => ({ ref: k, reason: `No signal "${k}" under ${resourceLabel(index.resById.get(id))}` })),
        },
      ]),
    );
    setPlans(local);
    if (!serverPlan) return;
    let alive = true;
    setPlanning(true);
    const t = window.setTimeout(() => {
      duplicateToTargets(model.id, source.id, ids, { dryRun: true })
        .then((out) => {
          if (!alive) return;
          const next = new Map(local);
          out.forEach((o, i) => {
            const id = o.targetId || ids[i];
            if (id) next.set(id, { name: o.createdName || local.get(id)?.name || '', unmatched: o.unmatched.map((u) => ({ ref: u.ref, reason: u.reason })) });
          });
          setPlans(next);
        })
        .catch((err) => {
          if (alive && isNotFound(err)) setServerPlan(false);
        })
        .finally(() => alive && setPlanning(false));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [model, detail, source, targetKey, index, serverPlan, targets.size]);

  const submit = useSubmit(async () => {
    if (!model || !source || !targets.size) return;
    setError(null);
    try {
      const out = await duplicateToTargets(model.id, source.id, Array.from(targets), { dryRun: false });
      setResults(out);
    } catch (err) {
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

  const totalUnmatched = Array.from(plans.values()).reduce((n, p) => n + p.unmatched.length, 0);
  const created = results?.filter((r) => r.createdId) || [];

  return (
    <Dialog
      open={Boolean(model)}
      onClose={results ? () => onDone(created.map((c) => c.createdId!), `Created ${created.length} cop${created.length === 1 ? 'y' : 'ies'} of “${model?.name}”.`) : onClose}
      busy={submit.pending}
      width="lg"
      title="Duplicate to machines"
      subtitle={model ? `One copy of “${model.name}” per target. Every reference to the source moves to the signal with the same key on the target.` : undefined}
      footer={
        results ? (
          <Button variant="primary" size="sm" onClick={() => onDone(created.map((c) => c.createdId!), `Created ${created.length} cop${created.length === 1 ? 'y' : 'ies'} of “${model?.name}”.`)}>
            Done
          </Button>
        ) : (
          <>
            {totalUnmatched > 0 && <span className="mr-auto text-[11px] text-amber-800">{totalUnmatched} reference(s) cannot be re-pointed and keep the old target.</span>}
            <Button variant="outline" size="sm" onClick={onClose} disabled={submit.pending}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!targets.size || !source || submit.pending} onClick={() => void submit.run()}>
              {submit.pending ? 'Creating…' : `Create ${targets.size || ''} cop${targets.size === 1 ? 'y' : 'ies'}`}
            </Button>
          </>
        )
      }
    >
      {loadError ? (
        <p role="alert" className="text-[12px] text-red-700">
          {loadError}
        </p>
      ) : !detail || catalogLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-[#657794]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : results ? (
        <ul className="space-y-2" aria-label="Results">
          {results.map((r, i) => (
            <li key={r.createdId || i} className="rounded-lg border border-[#E2E8F0] px-3 py-2">
              <div className="flex items-center gap-2 text-[12px]">
                {r.createdId ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-red-600" />}
                <span className="font-semibold text-[#111B37]">{r.createdName || resourceLabel(index.resById.get(r.targetId || ''))}</span>
                <span className="text-[#657794]">{r.replaced} reference(s) re-pointed</span>
              </div>
              {r.unmatched.length > 0 && (
                <ul className="mt-1 ml-6 text-[11px] text-amber-800 list-disc">
                  {r.unmatched.map((u, j) => (
                    <li key={j}>
                      <span className="font-mono">{u.ref}</span> — {u.reason}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : owners.length === 0 ? (
        <p className="text-[12px] text-[#657794]">This model references no resource, so there is nothing to re-point. Use “Duplicate…” instead.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="dup-source" className={labelCls}>
              Source (replaced in each copy)
            </label>
            <select id="dup-source" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setTargets(new Set()); }} className={`${fieldCls} bg-white`}>
              {owners.map((id) => {
                const r = index.resById.get(id);
                return (
                  <option key={id} value={id}>
                    {resourceLabel(r)} ({index.catalog.typeNames[r?.type || ''] || r?.type}) — {resourcePath(index, id).slice(0, -1).map(resourceLabel).join(' › ')}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className={labelCls}>Targets</span>
              <div className="flex gap-2 text-[11px] font-semibold">
                <button type="button" className="text-[#134074] hover:underline" onClick={() => setTargets(new Set(candidates.map((c) => c.id)))}>
                  Select all
                </button>
                <button type="button" className="text-[#657794] hover:underline" onClick={() => setTargets(new Set())}>
                  None
                </button>
              </div>
            </div>
            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search targets" className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500" />
            </div>
            {candidates.length === 0 ? (
              <p className="text-[12px] text-[#657794]">No other {index.catalog.typeNames[source?.type || ''] || source?.type || 'resource'} found.</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto border border-[#E2E8F0] rounded-lg divide-y divide-slate-100">
                {candidates.map((r) => {
                  const on = targets.has(r.id);
                  const plan = plans.get(r.id);
                  return (
                    <li key={r.id} className={on ? 'bg-blue-50/50' : ''}>
                      <label className="flex items-start gap-2 px-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={on} onChange={() => toggle(r.id)} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-semibold text-[#111B37]">{resourceLabel(r)}</span>
                          <span className="block text-[11px] text-[#657794] truncate">{resourcePath(index, r.id).slice(0, -1).map(resourceLabel).join(' › ')}</span>
                          {on && plan && (
                            <span className="block mt-1 text-[11px]">
                              <span className="text-[#334568]">Creates “{plan.name}”</span>
                              {plan.unmatched.length > 0 ? (
                                <span className="block text-amber-800" title={plan.unmatched.map((u) => `${u.ref}: ${u.reason}`).join('\n')}>
                                  {plan.unmatched.length} unmatched: <span className="font-mono">{plan.unmatched.slice(0, 6).map((u) => u.ref).join(', ')}</span>
                                  {plan.unmatched.length > 6 ? ' …' : ''}
                                </span>
                              ) : (
                                <span className="block text-emerald-700">All references match.</span>
                              )}
                            </span>
                          )}
                        </span>
                        {on && planning && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
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
