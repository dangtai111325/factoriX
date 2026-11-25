import React, { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, ChevronLeft, ChevronRight, Copy, Edit, ExternalLink, MoreVertical, Pause, Play, Plus, Settings2 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import type { MenuItem } from '../../components/common/MenuButton';
import {
  getTDStorageCatalog,
  pauseStorageObject,
  resumeStorageObject,
  StorageCatalogRow,
} from '../../lib/storagePhysicalApi';
import { StorageLifecycleDialog, LifecycleTarget, lifecycleTargetOf, isProtectedTarget } from './StorageLifecycleDialog';
import { EmptyState, ErrorBanner, FilterBar, LoadingBlock, SearchInput, TimeCell, selectCls } from '../historian/hsUi';
import { StorageStatusBadge, StorageTypeIcon, historianLinkFor } from './objectViews';

const PAGE_SIZE = 25;

export type ObjectTypeFilter = 'all' | 'database' | 'stable' | 'subtable';

interface StorageObjectsTableProps {
  selectedObjectId?: string | null;
  onSelectObject: (objectId: string) => void;
  onRefresh: () => void;
  refreshVersion: number;
  onLoadingChange: (loading: boolean) => void;
  typeFilter: ObjectTypeFilter;
  onTypeFilter: (t: ObjectTypeFilter) => void;
  statusFilter: string;
  onStatusFilter: (s: string) => void;
  onNotice: (message: string, tone?: 'info' | 'success' | 'error') => void;
}

/** Icon-only "⋮" row menu with the MenuButton behaviour (outside click / Esc close, arrow keys). */
const RowMenu: React.FC<{ items: MenuItem[]; label: string }> = ({ items, label }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') || []);
    if (!nodes.length) return;
    const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
    nodes[e.key === 'ArrowDown' ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length].focus();
  };
  return (
    <div className="relative inline-block" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title="More actions"
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded-lg text-[#657794] hover:text-[#111B37] hover:bg-[#EEF2F6]"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} onKeyDown={move} className="absolute right-0 top-full mt-1 min-w-[220px] rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-1.5 z-30 text-left">
          {items.map((item) =>
            item.key.startsWith('sep') ? (
              <div key={item.key} className="my-1 border-t border-[#F1F5FA]" role="separator" />
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px] outline-none disabled:opacity-45 disabled:cursor-not-allowed focus-visible:bg-[#F1F5FA] ${
                  item.danger ? 'text-[#DB2028] hover:bg-[#FFF5F5]' : 'text-[#334568] hover:bg-[#F8FAFC]'
                }`}
              >
                {item.icon && <span className="w-4 h-4 flex items-center justify-center shrink-0" aria-hidden="true">{item.icon}</span>}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
};

const TYPE_LABEL: Record<string, string> = { database: 'Database', stable: 'Supertable', subtable: 'Subtable' };

export const StorageObjectsTable: React.FC<StorageObjectsTableProps> = ({
  selectedObjectId,
  onSelectObject,
  onRefresh,
  refreshVersion,
  onLoadingChange,
  typeFilter,
  onTypeFilter,
  statusFilter,
  onStatusFilter,
  onNotice,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  // ?q= prefills the search (e.g. the bulk wizard's "Open in Objects table" for its name prefix).
  const [search, setSearch] = useState(() => (new URLSearchParams(location.search).get('q') || '').slice(0, 200));
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<StorageCatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  const [selection, setSelection] = useState<Map<string, StorageCatalogRow>>(new Map());
  const [bulkBusy, setBulkBusy] = useState<{ action: 'pause' | 'resume'; done: number; total: number } | null>(null);

  useEffect(() => setPage(1), [typeFilter, statusFilter]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE), search });
    if (typeFilter !== 'all') params.set('object_type', typeFilter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    setLoading(true);
    setError(null);
    onLoadingChange(true);
    const timer = window.setTimeout(() => {
      getTDStorageCatalog(params, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
          if (page > lastPage) setPage(lastPage);
          setItems(result.items);
          setTotal(result.total);
          setLoaded(true);
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(err);
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          setLoading(false);
          onLoadingChange(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      onLoadingChange(false);
    };
  }, [search, typeFilter, statusFilter, page, refreshVersion, onLoadingChange]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive = Boolean(search || typeFilter !== 'all' || statusFilter !== 'all');
  // Only user subtables can be paused/resumed in bulk; system objects are read-only.
  const selectable = (r: StorageCatalogRow) => r.object_type === 'subtable' && !isProtectedTarget(lifecycleTargetOf(r.id));
  const selectableShown = items.filter(selectable);
  const allShownSelected = selectableShown.length > 0 && selectableShown.every((r) => selection.has(r.id));
  const selected = Array.from(selection.values());

  const toggle = (r: StorageCatalogRow) => {
    const next = new Map(selection);
    if (next.has(r.id)) next.delete(r.id);
    else next.set(r.id, r);
    setSelection(next);
  };

  const runBulk = async (action: 'pause' | 'resume') => {
    const targets = selected.filter((r) => (action === 'pause' ? r.status === 'ACTIVE' : r.status !== 'ACTIVE'));
    if (!targets.length) {
      onNotice(action === 'pause' ? 'None of the selected subtables is recording.' : 'All selected subtables are already recording.');
      return;
    }
    setBulkBusy({ action, done: 0, total: targets.length });
    let ok = 0;
    const failed: string[] = [];
    for (const r of targets) {
      try {
        if (action === 'pause') await pauseStorageObject(r.id);
        else await resumeStorageObject(r.id);
        ok += 1;
      } catch {
        failed.push(r.physical_name);
      }
      setBulkBusy({ action, done: ok + failed.length, total: targets.length });
    }
    setBulkBusy(null);
    setSelection(new Map());
    onNotice(
      `${action === 'pause' ? 'Recording paused' : 'Recording started'} for ${ok} of ${targets.length} subtable${targets.length === 1 ? '' : 's'}${
        failed.length ? `. Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}` : ''
      }`,
      failed.length ? 'error' : 'success',
    );
    onRefresh();
  };

  const menuItems = (obj: StorageCatalogRow): MenuItem[] => {
    const target = lifecycleTargetOf(obj.id, obj.status);
    const locked = isProtectedTarget(target);
    const ref = obj.id.replace(/^(stable|subtable):/, '');
    const list: MenuItem[] = [
      { key: 'view', label: 'View details', icon: <ExternalLink className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/object/${encodeURIComponent(obj.id)}`, { state: { from } }) },
    ];
    if (!locked) list.push({ key: 'edit', label: 'Edit', icon: <Edit className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/edit/${encodeURIComponent(obj.id)}`, { state: { from } }) });
    if (obj.object_type === 'subtable') {
      list.push({ key: 'hist', label: 'Open in Historian', icon: <Activity className="w-3.5 h-3.5" />, onSelect: () => navigate(historianLinkFor(obj.id)) });
      if (!locked) list.push({ key: 'dup', label: 'Duplicate', icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/create?kind=subtable&duplicate=${encodeURIComponent(obj.id)}`, { state: { from } }) });
    }
    if (obj.object_type === 'database') {
      list.push({ key: 'newst', label: 'Create supertable here', icon: <Plus className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/create?kind=stable&database=${encodeURIComponent(obj.physical_name)}`, { state: { from } }) });
    }
    if (obj.object_type === 'stable' && !locked) {
      list.push(
        { key: 'newsub', label: 'Create subtable here', icon: <Plus className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/create?kind=subtable&stable=${encodeURIComponent(ref)}`, { state: { from } }) },
        { key: 'bulk', label: 'Subtables from Data Models', icon: <Plus className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/bulk?stable=${encodeURIComponent(ref)}`, { state: { from } }) },
        { key: 'dupst', label: 'Duplicate', icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => navigate(`/historian/storage/create?kind=stable&duplicate=${encodeURIComponent(obj.id)}`, { state: { from } }) },
      );
    }
    list.push({ key: 'sep1', label: '', onSelect: () => undefined });
    list.push({
      key: 'life',
      label: locked ? 'System object (read-only)' : 'Pause / Retire / Delete…',
      icon: <Settings2 className="w-3.5 h-3.5" />,
      danger: !locked,
      onSelect: () => setLifecycle(target),
    });
    return list;
  };

  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <FilterBar>
        <SearchInput
          className="flex-1 min-w-[200px]"
          value={search}
          onChange={(v) => {
            setSearch(v.slice(0, 200));
            setPage(1);
          }}
          placeholder="Search by name, e.g. state_aa10_01"
          ariaLabel="Search storage objects"
        />
        <select aria-label="Filter by type" value={typeFilter} onChange={(e) => onTypeFilter(e.target.value as ObjectTypeFilter)} className={selectCls}>
          <option value="all">All types</option>
          <option value="database">Databases</option>
          <option value="stable">Supertables</option>
          <option value="subtable">Subtables</option>
        </select>
        <select aria-label="Filter by status" value={statusFilter} onChange={(e) => onStatusFilter(e.target.value)} className={selectCls}>
          <option value="all">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PAUSED">Paused</option>
          <option value="RETIRED">Retired</option>
          <option value="DRAFT">Draft</option>
          <option value="OUT_OF_SYNC">Out of sync</option>
          <option value="ERROR">Error (write errors)</option>
        </select>
        {filtersActive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearch('');
              onTypeFilter('all');
              onStatusFilter('all');
            }}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto text-[11px] text-[#657794]" aria-live="polite">
          {loaded ? `${total.toLocaleString()} object${total === 1 ? '' : 's'}${filtersActive ? ' match' : ''}` : ''}
        </span>
      </FilterBar>

      {(selection.size > 0 || selectableShown.length > 0) && (
        <div
          role="toolbar"
          aria-label="Selection"
          className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[12px] ${selection.size ? 'bg-blue-50/70 border border-blue-100' : ''}`}
        >
          <label className="inline-flex items-center gap-2 font-semibold text-[#334568] cursor-pointer">
            <input
              type="checkbox"
              checked={allShownSelected}
              disabled={selectableShown.length === 0}
              onChange={() => {
                const next = new Map(selection);
                selectableShown.forEach((r) => (allShownSelected ? next.delete(r.id) : next.set(r.id, r)));
                setSelection(next);
              }}
              aria-label="Select all user subtables shown"
            />
            {selection.size ? `${selection.size} selected` : 'Select subtables'}
          </label>
          {selection.size > 0 && (
            <>
              <Button size="sm" variant="outline" icon={<Pause className="w-3.5 h-3.5" />} disabled={!!bulkBusy} onClick={() => void runBulk('pause')}>
                {bulkBusy?.action === 'pause' ? `Pausing ${bulkBusy.done}/${bulkBusy.total}…` : 'Pause recording'}
              </Button>
              <Button size="sm" variant="outline" icon={<Play className="w-3.5 h-3.5" />} disabled={!!bulkBusy} onClick={() => void runBulk('resume')}>
                {bulkBusy?.action === 'resume' ? `Starting ${bulkBusy.done}/${bulkBusy.total}…` : 'Start recording'}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!bulkBusy} onClick={() => setSelection(new Map())}>
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {error ? (
        <ErrorBanner error={error} subject="storage objects" onRetry={onRefresh} />
      ) : !loaded && loading ? (
        <div className="bg-white border border-[#CBD5E1] rounded-xl">
          <LoadingBlock label="Loading storage objects…" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState dashed title={filtersActive ? 'No storage object matches the filters' : 'No storage objects yet'}>
          {filtersActive ? 'Change the search or clear the filters.' : 'Create a database, then a supertable and its subtables.'}
        </EmptyState>
      ) : (
        <div className={`bg-white border border-[#E3EAF3] rounded-xl overflow-hidden ${loading ? 'opacity-70' : ''}`} aria-busy={loading}>
          <div className="overflow-x-auto">
            <table className="fx-table">
              <thead>
                <tr>
                  <th className="w-8" aria-label="Select" />
                  <th>Name</th>
                  <th>Type</th>
                  <th>Parent</th>
                  <th className="text-right">Columns</th>
                  <th className="text-right">Tags</th>
                  <th className="text-right">Subtables</th>
                  <th className="text-right">Bindings</th>
                  <th>Status</th>
                  <th>Verified</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((obj) => {
                  const canSelect = selectable(obj);
                  return (
                    <tr
                      key={obj.id}
                      tabIndex={0}
                      data-selected={selectedObjectId === obj.id || selection.has(obj.id) ? 'true' : undefined}
                      onClick={() => onSelectObject(obj.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.target === e.currentTarget) onSelectObject(obj.id);
                      }}
                      className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2A82E7] focus-visible:-outline-offset-2"
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        {canSelect && <input type="checkbox" checked={selection.has(obj.id)} onChange={() => toggle(obj)} aria-label={`Select ${obj.physical_name}`} />}
                      </td>
                      <td className="max-w-[320px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <StorageTypeIcon kind={obj.object_type} />
                          <span className="font-semibold text-[#111B37] truncate" title={obj.physical_name}>
                            {obj.display_name || obj.physical_name}
                          </span>
                        </div>
                        {obj.display_name && obj.display_name !== obj.physical_name && (
                          <div className="font-mono text-[11px] text-[#657794] truncate pl-6" title={obj.physical_name}>
                            {obj.physical_name}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap">{TYPE_LABEL[obj.object_type] || obj.object_type}</td>
                      <td className="max-w-[200px]">
                        <span className="block truncate" title={obj.parent_name || ''}>
                          {obj.parent_name || '—'}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">{obj.column_count ?? '—'}</td>
                      <td className="text-right tabular-nums">{obj.tag_count ?? '—'}</td>
                      <td className="text-right tabular-nums">{obj.subtable_count ?? '—'}</td>
                      <td className="text-right tabular-nums">{obj.binding_count ?? '—'}</td>
                      <td className="whitespace-nowrap">
                        <StorageStatusBadge status={obj.status} />
                        {obj.recording_error && (
                          <span className="ml-1.5 text-[11px] font-semibold text-[#DB2028]" title="The writer could not store some rows into this subtable">
                            Write errors
                          </span>
                        )}
                      </td>
                      <td className="text-[12px] text-[#657794]">
                        <TimeCell iso={obj.last_verified_at} />
                      </td>
                      <td className="text-right">
                        <RowMenu items={menuItems(obj)} label={`Actions for ${obj.physical_name}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2.5 border-t border-[#E3EAF3] flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#657794]">
            <span>
              {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <span className="px-1 tabular-nums">
                  Page {page} of {totalPages}
                </span>
                <Button size="sm" variant="outline" aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {lifecycle && (
        <StorageLifecycleDialog
          target={lifecycle}
          onClose={() => setLifecycle(null)}
          onDone={(msg) => {
            setLifecycle(null);
            onNotice(msg, 'success');
            onRefresh();
          }}
        />
      )}
    </div>
  );
};
