// Catalog of Data Models: a grid of cards with a live mini preview, search and filters.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Boxes, Clock, Copy, CopyPlus, EllipsisVertical, Pause, Pencil, Play, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { formatJsonText } from './json';
import { useModelBody } from './hooks';
import type { ModelListItem } from './types';
import { Banner, IconMenu, Skeleton, StateChip, sampleLabel, timeAgo, useNow } from './ui';

export interface CardActions {
  open: (m: ModelListItem) => void;
  edit: (m: ModelListItem) => void;
  duplicate: (m: ModelListItem) => void;
  duplicateToMachines: (m: ModelListItem) => void;
  toggleRunning: (m: ModelListItem) => void;
  remove: (m: ModelListItem) => void;
}

/** Actions on several selected cards (UX#4); each one confirms with the count first. */
export interface BulkActions {
  pause: (models: ModelListItem[]) => void;
  resume: (models: ModelListItem[]) => void;
  remove: (models: ModelListItem[]) => void;
  duplicateToMachines: (models: ModelListItem[]) => void;
}

interface Props {
  models: ModelListItem[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  onReload: () => void;
  onCreate: () => void;
  actions: CardActions;
  bulk: BulkActions;
  /** Ids with a pause/resume request running (in-flight guard). */
  busyIds: Set<string>;
  /** Selected card ids (kept by the page so a bulk action can clear it when done). */
  selection: Set<string>;
  onSelection: (next: Set<string>) => void;
}

function useInView<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

const PREVIEW_LINES = 6;

const ModelCard: React.FC<{ model: ModelListItem; actions: CardActions; busy: boolean; now: number; selected: boolean; onToggle: (shift: boolean) => void }> = ({
  model,
  actions,
  busy,
  now,
  selected,
  onToggle,
}) => {
  const [ref, visible] = useInView<HTMLDivElement>();
  const running = model.state === 'RUNNING';
  const live = useModelBody(model.id, { enabled: visible && running, initial: model.latest_body, pollMs: Math.max(5000, model.sample_ms) });
  const body = live.body ?? model.latest_body;
  const sampledAt = live.sampledAt ?? model.last_sampled_at;
  const errorCount = live.errors.length || model.error_count;
  const lines = useMemo(() => {
    if (!body) return [];
    const all = formatJsonText(body, true).split('\n');
    return all.length > PREVIEW_LINES ? [...all.slice(0, PREVIEW_LINES), '  …'] : all;
  }, [body]);

  const items = [
    { key: 'edit', label: 'Edit', icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => actions.edit(model) },
    { key: 'dup', label: 'Duplicate…', icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => actions.duplicate(model) },
    { key: 'dupm', label: 'Duplicate to machines…', icon: <CopyPlus className="w-3.5 h-3.5" />, onSelect: () => actions.duplicateToMachines(model) },
    {
      key: 'run',
      label: running ? 'Pause' : 'Resume',
      icon: running ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />,
      disabled: busy,
      onSelect: () => actions.toggleRunning(model),
      separator: true,
    },
    { key: 'del', label: 'Delete…', icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, onSelect: () => actions.remove(model), separator: true },
  ];

  return (
    <div
      ref={ref}
      role="listitem"
      className={`group relative flex flex-col bg-white border rounded-xl shadow-sm hover:shadow-md transition focus-within:ring-2 focus-within:ring-blue-300 ${
        selected ? 'border-blue-500 ring-1 ring-blue-300' : 'border-[#CBD5E1] hover:border-[#9FB4D1]'
      }`}
    >
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => undefined}
          onClick={(e) => onToggle(e.shiftKey)}
          aria-label={`Select ${model.name}`}
          title="Select (Shift+click selects a range)"
          className="mt-1 shrink-0"
        />
        <button
          type="button"
          onClick={() => actions.open(model)}
          className="min-w-0 flex-1 text-left outline-none"
          aria-label={`Open ${model.name}`}
        >
          <h3 className="text-[14px] font-bold text-[#111B37] truncate group-hover:text-[#134074]" title={model.name}>
            {model.name}
          </h3>
          <p className="text-[11px] text-[#657794] truncate" title={model.description}>
            {model.description || ' '}
          </p>
        </button>
        <StateChip state={model.state} />
        <IconMenu label={`Actions for ${model.name}`} icon={<EllipsisVertical className="w-4 h-4" />} items={items} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 mt-2 text-[11px] text-[#334568]">
        <span className="inline-flex items-center gap-1" title="Sampling rate">
          <Clock className="w-3 h-3 text-slate-400" /> every {sampleLabel(model.sample_ms)}
        </span>
        <span>{model.field_count} field{model.field_count === 1 ? '' : 's'}</span>
        {errorCount > 0 && (
          <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
            <AlertTriangle className="w-3 h-3" /> {errorCount} error{errorCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="px-4 mt-1.5 flex flex-wrap gap-1 min-h-[20px]">
        {model.machines.slice(0, 4).map((m) => (
          <span key={m} className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#EEF5FF] text-[#1D4ED8] border border-[#D2E3FA]">
            {m}
          </span>
        ))}
        {model.machines.length > 4 && <span className="text-[10px] text-[#657794]">+{model.machines.length - 4}</span>}
      </div>
      <button
        type="button"
        tabIndex={-1}
        onClick={() => actions.open(model)}
        aria-hidden="true"
        className="mx-4 mt-2.5 mb-2 text-left rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2 h-[118px] overflow-hidden"
      >
        {live.loading && !body ? (
          <div className="space-y-1.5">
            <Skeleton className="h-2.5 w-1/3" />
            <Skeleton className="h-2.5 w-2/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        ) : lines.length ? (
          <pre className={`font-mono text-[10.5px] leading-[1.45] text-[#334568] whitespace-pre overflow-hidden ${running ? '' : 'opacity-60'}`}>{lines.join('\n')}</pre>
        ) : (
          <span className="text-[11px] text-slate-400">{running ? 'Waiting for the first sample…' : 'Paused — no body is produced.'}</span>
        )}
      </button>
      <div className="flex items-center justify-between px-4 pb-3 text-[10px] text-[#94A3B8]">
        <span>Last sample {timeAgo(sampledAt, now)}</span>
        {running && visible && live.stream === 'open' && <span className="inline-flex items-center gap-1 text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-[#0DBA67] animate-pulse" /> live</span>}
      </div>
    </div>
  );
};

const selectCls = 'h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#334568] focus:outline-none focus:border-blue-500';

export const ModelCatalog: React.FC<Props> = ({ models, loading, loaded, error, onReload, onCreate, actions, bulk, busyIds, selection, onSelection }) => {
  const [q, setQ] = useState('');
  const [machine, setMachine] = useState('');
  const [state, setState] = useState('');
  const now = useNow(5000);
  const anchor = useRef<string | null>(null);

  const machineOptions = useMemo(() => Array.from(new Set(models.flatMap((m) => m.machines))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [models]);
  const needle = q.trim().toLowerCase();
  const filtered = models
    .filter((m) => (!state || m.state === state) && (!machine || m.machines.includes(machine)))
    .filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.description.toLowerCase().includes(needle) || m.machines.some((x) => x.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const filtersActive = Boolean(q || machine || state);
  // R4-DM-09: the counter describes what is shown ("11 of 47 models · 9 running").
  const runningShown = filtered.filter((m) => m.state === 'RUNNING').length;
  const selectedModels = models.filter((m) => selection.has(m.id));
  const hiddenSelected = selectedModels.filter((m) => !filtered.some((f) => f.id === m.id)).length;

  const toggle = (id: string, shift: boolean) => {
    const next = new Set(selection);
    const from = anchor.current ? filtered.findIndex((m) => m.id === anchor.current) : -1;
    const to = filtered.findIndex((m) => m.id === id);
    if (shift && from >= 0 && to >= 0) {
      filtered.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((m) => next.add(m.id));
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    anchor.current = id;
    onSelection(next);
  };
  const allShownSelected = filtered.length > 0 && filtered.every((m) => selection.has(m.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Data models</h1>
          <p className="text-[13px] text-[#657794]">Design clean JSON bodies from any signals and watch them live at their own sampling rate.</p>
        </div>
        <Button variant="primary" size="lg" onClick={onCreate} icon={<Plus className="w-4 h-4" />}>
          Create model
        </Button>
      </div>

      {error && (
        <Banner tone="error" action={<Button size="sm" variant="outline" onClick={onReload}>Retry</Button>}>
          {error}
        </Banner>
      )}

      {(models.length > 0 || filtersActive) && (
        <div className="flex flex-wrap items-center gap-2 bg-white border border-[#CBD5E1] rounded-xl p-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, description or machine"
              aria-label="Search data models"
              className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>
          <select value={machine} onChange={(e) => setMachine(e.target.value)} className={selectCls} aria-label="Filter by machine">
            <option value="">All machines</option>
            {machineOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select value={state} onChange={(e) => setState(e.target.value)} className={selectCls} aria-label="Filter by state">
            <option value="">All states</option>
            <option value="RUNNING">Running</option>
            <option value="PAUSED">Paused</option>
          </select>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setMachine(''); setState(''); }}>
              Clear
            </Button>
          )}
          <span className="ml-auto text-[11px] text-[#657794]" aria-live="polite">
            {filtersActive ? `${filtered.length} of ${models.length}` : models.length} model{models.length === 1 ? '' : 's'} · {runningShown} running
          </span>
          <button type="button" onClick={onReload} disabled={loading} aria-label="Reload" title="Reload" className="p-1.5 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}

      {filtered.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selection"
          className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[12px] ${selection.size ? 'bg-blue-50/70 border border-blue-100' : ''}`}
        >
          <label className="inline-flex items-center gap-2 font-semibold text-[#334568] cursor-pointer">
            <input
              type="checkbox"
              checked={allShownSelected}
              onChange={() => {
                const next = new Set(selection);
                filtered.forEach((m) => (allShownSelected ? next.delete(m.id) : next.add(m.id)));
                onSelection(next);
              }}
              aria-label="Select all shown models"
            />
            {selection.size ? `${selection.size} selected` : 'Select'}
            {hiddenSelected > 0 && <span className="font-normal text-[#657794]">({hiddenSelected} hidden by the filters)</span>}
          </label>
          {selection.size > 0 && (
            <>
              <Button size="sm" variant="outline" icon={<Pause className="w-3.5 h-3.5" />} onClick={() => bulk.pause(selectedModels)}>
                Pause
              </Button>
              <Button size="sm" variant="outline" icon={<Play className="w-3.5 h-3.5" />} onClick={() => bulk.resume(selectedModels)}>
                Resume
              </Button>
              <Button size="sm" variant="outline" icon={<CopyPlus className="w-3.5 h-3.5" />} onClick={() => bulk.duplicateToMachines(selectedModels)}>
                Duplicate to machines…
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => bulk.remove(selectedModels)}>
                Delete…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onSelection(new Set())}>
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {!loaded && loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading data models">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white border border-[#E2E8F0] rounded-xl p-4 space-y-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      ) : loaded && models.length === 0 ? (
        <EmptyState onCreate={onCreate} />
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-dashed border-[#CBD5E1] rounded-xl py-12 text-center text-[13px] text-[#657794]">No data model matches the filters.</div>
      ) : (
        <div role="list" aria-label="Data models" className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {filtered.map((m) => (
            <ModelCard key={m.id} model={m} actions={actions} busy={busyIds.has(m.id)} now={now} selected={selection.has(m.id)} onToggle={(shift) => toggle(m.id, shift)} />
          ))}
        </div>
      )}
    </div>
  );
};

const EmptyState: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="bg-white border border-[#CBD5E1] rounded-xl p-8 md:p-10">
    <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-[1fr_280px] gap-8 items-center">
      <div>
        <div className="w-11 h-11 rounded-xl bg-[#EEF5FF] text-[#134074] flex items-center justify-center mb-4">
          <Boxes className="w-6 h-6" />
        </div>
        <h2 className="text-[18px] font-bold text-[#111B37]">Build your first data model</h2>
        <p className="mt-2 text-[13px] text-[#334568] leading-relaxed">
          A data model is a JSON body you design: any keys, any nesting, values from any machines, lines or zones. Map a key to a signal, or compute it with a rule
          (constants, names from the hierarchy, timestamps, math, filters).
        </p>
        <ul className="mt-3 space-y-1.5 text-[12px] text-[#334568]">
          <li>
            <strong>1.</strong> Name it and pick a sampling rate (default 1 s).
          </li>
          <li>
            <strong>2.</strong> Click signals in the data tree — or “Map all” on a machine, or paste a sample body.
          </li>
          <li>
            <strong>3.</strong> Save &amp; run: every sample the model reads the latest value of each signal and produces a new body you can watch live.
          </li>
          <li>
            <strong>4.</strong> “Duplicate to machines…” clones it for other machines in two clicks.
          </li>
        </ul>
        <Button className="mt-5" variant="primary" onClick={onCreate} icon={<Plus className="w-4 h-4" />}>
          Create model
        </Button>
      </div>
      <pre className="hidden md:block font-mono text-[11px] leading-[1.55] bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-4 text-[#334568]" aria-hidden="true">
        {`{
  "line_name": "…",
  "source_timestamp": "…",
  "status": 1,
  "electrical": {
    "voltage_1": 229.8,
    "power": 4.2
  }
}`}
      </pre>
    </div>
  </div>
);
