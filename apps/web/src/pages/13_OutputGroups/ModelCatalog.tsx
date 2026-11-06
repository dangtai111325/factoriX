import React, { useMemo, useState } from 'react';
import { Boxes, LayoutTemplate, Plus, RefreshCw, Search } from 'lucide-react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import type { ModelListItem } from './types';
import { parentPathLabel, timeAgo } from './modelLogic';
import { Banner, KindBadge, ModelStatusBadge } from './ui';

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

export const ModelCatalog: React.FC<Props> = ({ models, loading, error, onReload, resources, onOpen, onNew, onFromTemplate }) => {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');

  const rows = useMemo(() => {
    const byId = new Map(resources.map((r) => [r.id, r]));
    return models
      .map((m) => {
        const res = byId.get(m.resource_id);
        return {
          m,
          scopeName: res?.name || m.resource_name || m.resource_code || 'Unknown resource',
          scopePath: res ? parentPathLabel(resources, res.id) : '',
        };
      })
      .sort((a, b) => a.scopePath.localeCompare(b.scopePath) || a.scopeName.localeCompare(b.scopeName) || a.m.display_name.localeCompare(b.m.display_name));
  }, [models, resources]);

  const scopes = useMemo(() => {
    const seen = new Map<string, string>();
    rows.forEach((r) => seen.set(r.m.resource_id, r.scopeName));
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = rows.filter(({ m, scopeName, scopePath }) => {
    if (scope && m.resource_id !== scope) return false;
    if (kind && m.kind !== kind) return false;
    if (status && m.status !== status) return false;
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      return [m.display_name, m.key, scopeName, scopePath, m.topic_template].some((v) => v.toLowerCase().includes(needle));
    }
    return true;
  });

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
          <Button size="sm" variant="ghost" onClick={onReload} aria-label="Reload" disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {loading && models.length === 0 ? (
          <div className="p-12 text-center text-[12px] text-[#657794]">Loading data models…</div>
        ) : models.length === 0 && !error ? (
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
                  <th className="py-2.5 px-4">Name</th>
                  <th className="py-2.5 px-4">Scope</th>
                  <th className="py-2.5 px-4">Kind</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Fields</th>
                  <th className="py-2.5 px-4 text-right">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map(({ m, scopeName, scopePath }) => (
                  <tr
                    key={m.id}
                    tabIndex={0}
                    onClick={() => onOpen(m.id)}
                    onKeyDown={(e) => e.key === 'Enter' && onOpen(m.id)}
                    className="hover:bg-slate-50 cursor-pointer transition focus:outline-none focus:bg-blue-50/40"
                  >
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
                    </td>
                    <td className="py-3 px-4">
                      <ModelStatusBadge status={m.status} />
                    </td>
                    <td className="py-3 px-4 text-right font-semibold text-[#111B37]">{m.member_count}</td>
                    <td className="py-3 px-4 text-right text-[#657794]" title={m.updated_at || undefined}>
                      {timeAgo(m.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};
