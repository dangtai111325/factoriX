import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Boxes, Clock, LayoutTemplate, Plus, RefreshCw, Rocket, Search, Undo2, X } from 'lucide-react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import type { ModelListItem } from './types';
import { durationLabel, modelSearchText, parentPathLabel, republishLabel, timeAgo } from './modelLogic';
import { Banner, KindBadge, ModelStatusBadge } from './ui';
import { BulkAction, BulkActionDialog, BulkModel } from './BulkActions';

interface Props {
  models: ModelListItem[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  resources: ResourceNode[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onFromTemplate: () => void;
}

const selectCls =
  'h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#334568] focus:outline-none focus:border-blue-500';

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const ModelCatalog: React.FC<Props> = ({ models, loading, error, onReload, resources, onOpen, onNew, onFromTemplate }) => {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ action: BulkAction; items: BulkModel[] } | null>(null);
  const headerBoxRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const byId = new Map(resources.map((r) => [r.id, r]));
    return models
      .map((m) => {
        const res = byId.get(m.resource_id);
        return {
          m,
          scopeName: res?.name || m.resource_name || m.resource_code || 'Unknown resource',
          scopePath: res ? parentPathLabel(resources, res.id) : '',
          haystack: modelSearchText(resources, m),
        };
      })
      .sort((a, b) => byText(a.scopePath, b.scopePath) || byText(a.scopeName, b.scopeName) || byText(a.m.display_name, b.m.display_name));
  }, [models, resources]);

  const scopes = useMemo(() => {
    const seen = new Map<string, string>();
    rows.forEach((r) => seen.set(r.m.resource_id, r.scopeName));
    return Array.from(seen.entries()).sort((a, b) => byText(a[1], b[1]));
  }, [rows]);

  const needle = q.trim().toLowerCase();
  const filtered = rows.filter(({ m, haystack }) => {
    if (scope && m.resource_id !== scope) return false;
    if (kind && m.kind !== kind) return false;
    if (status && m.status !== status) return false;
    return !needle || haystack.includes(needle);
  });

  // Drop selections of models that no longer exist (archived, reloaded).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(models.map((m) => m.id));
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [models]);

  const visibleIds = filtered.map(({ m }) => m.id);
  const visibleSelected = visibleIds.filter((id) => selected.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  useEffect(() => {
    if (headerBoxRef.current) headerBoxRef.current.indeterminate = visibleSelected > 0 && !allVisibleSelected;
  }, [visibleSelected, allVisibleSelected]);

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });

  const selectedRows = rows.filter(({ m }) => selected.has(m.id));
  const hiddenSelected = selectedRows.length - visibleSelected;
  const openBulk = (action: BulkAction) =>
    setBulk({ action, items: selectedRows.map(({ m, scopeName }) => ({ model: m, scopeName })) });

  const published = models.filter((m) => m.status === 'PUBLISHED').length;
  const filtersActive = Boolean(q || scope || kind || status);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Model Catalog</h1>
          <p className="text-[13px] text-[#657794]">
            Clean, contextualised bodies composed from your signals and published to the unified namespace.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onFromTemplate} icon={<LayoutTemplate className="w-3.5 h-3.5" />}>
            New from template
          </Button>
          <Button variant="primary" size="sm" onClick={onNew} icon={<Plus className="w-3.5 h-3.5" />}>
            Create model
          </Button>
        </div>
      </div>

      {error && (
        <Banner tone="error" action={<Button size="sm" variant="outline" onClick={onReload}>Retry</Button>}>
          {error}
        </Banner>
      )}

      <Card className="border border-[#CBD5E1] bg-white overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, key, resource or topic"
              aria-label="Search models"
              className="w-full h-8 pl-8 pr-2 border border-[#D4DFEC] rounded-lg text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>
          <select value={scope} onChange={(e) => setScope(e.target.value)} className={selectCls} aria-label="Filter by resource">
            <option value="">All resources</option>
            {scopes.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectCls} aria-label="Filter by kind">
            <option value="">All kinds</option>
            <option value="STATE">State</option>
            <option value="EVENT">Event</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
          </select>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setScope(''); setKind(''); setStatus(''); }}>
              Clear
            </Button>
          )}
          <span className="ml-auto text-[11px] text-[#657794]">
            {models.length} model{models.length === 1 ? '' : 's'} · {published} published
          </span>
          <Button size="sm" variant="ghost" onClick={onReload} aria-label="Reload" title="Reload" disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {selected.size > 0 && (
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-blue-100 bg-blue-50/60 text-[12px]"
          >
            <span className="font-semibold text-[#111B37]">
              {selected.size} selected
              {hiddenSelected > 0 && <span className="font-normal text-[#657794]"> ({hiddenSelected} hidden by the filters)</span>}
            </span>
            <div className="flex flex-wrap items-center gap-1.5 ml-2">
              <Button size="sm" variant="outline" icon={<Rocket className="w-3.5 h-3.5" />} onClick={() => openBulk('publish')}>
                Publish
              </Button>
              <Button size="sm" variant="outline" icon={<Undo2 className="w-3.5 h-3.5" />} onClick={() => openBulk('unpublish')}>
                Unpublish
              </Button>
              <Button size="sm" variant="outline" icon={<Clock className="w-3.5 h-3.5" />} onClick={() => openBulk('republish')}>
                Set re-publish interval…
              </Button>
              <Button size="sm" variant="danger" icon={<Archive className="w-3.5 h-3.5" />} onClick={() => openBulk('archive')}>
                Archive…
              </Button>
            </div>
            <Button size="sm" variant="ghost" className="ml-auto" icon={<X className="w-3.5 h-3.5" />} onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {loading && models.length === 0 ? (
          <div role="status" className="p-12 text-center text-[12px] text-[#657794]">Loading data models…</div>
        ) : models.length === 0 && error ? (
          <div className="p-10 text-center text-[12px] text-[#657794]">The catalog could not be loaded. Use Retry above.</div>
        ) : models.length === 0 ? (
          <div className="p-12 text-center text-[#657794]">
            <Boxes className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <h3 className="text-[14px] font-bold text-[#111B37]">No data models yet</h3>
            <p className="text-[12px] text-[#657794] mt-1 mb-4 max-w-md mx-auto">
              Start from a template to create the same body for many machines in one step, or design a model field by field.
            </p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={onFromTemplate} icon={<LayoutTemplate className="w-3.5 h-3.5" />}>
                New from template
              </Button>
              <Button variant="primary" size="sm" onClick={onNew} icon={<Plus className="w-3.5 h-3.5" />}>
                Create model
              </Button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-[12px] text-[#657794]">No models match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50 text-[#657794] font-semibold">
                  <th className="py-2.5 pl-4 pr-1 w-8">
                    <input
                      ref={headerBoxRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleVisible}
                      aria-label={allVisibleSelected ? 'Deselect all shown models' : `Select all ${visibleIds.length} shown models`}
                      title={allVisibleSelected ? 'Deselect all shown' : 'Select all shown'}
                    />
                  </th>
                  <th className="py-2.5 px-4">Name</th>
                  <th className="py-2.5 px-4">Scope</th>
                  <th className="py-2.5 px-4">Kind</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Fields</th>
                  <th className="py-2.5 px-4 text-right">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map(({ m, scopeName, scopePath }) => {
                  const isSelected = selected.has(m.id);
                  const republishMs = m.emit_policy?.republish_ms ?? null;
                  return (
                    <tr
                      key={m.id}
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={() => onOpen(m.id)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(m.id)}
                      className={`cursor-pointer transition focus:outline-none focus:bg-blue-50/40 ${isSelected ? 'bg-blue-50/50 hover:bg-blue-50' : 'hover:bg-slate-50'}`}
                    >
                      <td className="py-3 pl-4 pr-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(m.id)}
                          aria-label={`Select ${m.display_name || m.key} on ${scopeName}`}
                        />
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-bold text-[#111B37]">{m.display_name || m.key}</div>
                        <div className="font-mono text-[10px] text-[#657794]">{m.key}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-[#111B37]">{scopeName}</div>
                        {scopePath && <div className="text-[10px] text-[#657794]">{scopePath}</div>}
                      </td>
                      <td className="py-3 px-4">
                        <KindBadge kind={m.kind} />
                        {m.kind === 'STATE' && m.emit_policy && (
                          <div className="text-[10px] text-[#657794] mt-0.5 whitespace-nowrap" title={republishLabel(republishMs, m.kind)}>
                            {republishMs ? `Re-publish ${durationLabel(republishMs / 1000)}` : 'On change only'}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <ModelStatusBadge status={m.status} />
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-[#111B37]">{m.member_count}</td>
                      <td className="py-3 px-4 text-right text-[#657794]" title={m.updated_at || undefined}>
                        {timeAgo(m.updated_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <BulkActionDialog
        action={bulk?.action ?? null}
        items={bulk?.items ?? []}
        onClose={() => setBulk(null)}
        onFinished={() => {
          setSelected(new Set());
          onReload();
        }}
      />
    </div>
  );
};
