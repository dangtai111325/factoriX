/**
 * Dashboards (/dashboards): every dashboard of the tenant as cards with search, status filter and sort;
 * New dashboard (blank or template), Import, and per-card Open / Edit / Duplicate / Export / Archive;
 * archived cards offer Unarchive and Delete permanently (typed-name confirmation).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  EllipsisVertical,
  Eye,
  LayoutDashboard,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { Dialog, IconMenu, Skeleton, timeAgo, useNow } from '../13_DataModels/ui';
import { ErrorBanner, FilterBar, PageHeader, SearchInput, selectCls } from '../historian/hsUi';
import { archiveDashboard, deleteDashboard, downloadJson, duplicateDashboard, errorLine, exportDashboard, listDashboards, safeFileName, unarchiveDashboard } from '../../features/dashboard/api';
import { DashboardStatusChip } from '../../features/dashboard/components/controls';
import { THEME_PRESET_LABEL } from '../../features/dashboard/theme';
import type { DashboardSummary, ThemePresetId } from '../../features/dashboard/types';
import { NewDashboardDialog } from './NewDashboardDialog';
import { ImportDashboardDialog } from './ImportDashboardDialog';

type StatusFilter = 'all' | 'draft' | 'published' | 'changes' | 'archived';
type SortKey = 'updated' | 'name';

export const DashboardListPage: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<DashboardSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('updated');
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dup, setDup] = useState<DashboardSummary | null>(null);
  const [toArchive, setToArchive] = useState<DashboardSummary | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<DashboardSummary | null>(null);
  const [deleteTyped, setDeleteTyped] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { toast, show, dismiss } = useActionToast();
  const now = useNow(30000);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDashboards({ includeArchived: true });
      setItems(res.items || []);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const active = items.filter((d) => !d.archived_at);
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    const out = items.filter((d) => {
      if (status === 'archived') {
        if (!d.archived_at) return false;
      } else if (d.archived_at) return false;
      if (status === 'draft' && d.published_revision) return false;
      if (status === 'published' && !d.published_revision) return false;
      if (status === 'changes' && !(d.published_revision && d.has_unpublished_changes)) return false;
      return !needle || d.name.toLowerCase().includes(needle) || (d.description || '').toLowerCase().includes(needle);
    });
    out.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
    return out;
  }, [items, status, needle, sort]);
  const filtersActive = Boolean(needle) || status !== 'all';
  const archivedCount = items.length - active.length;

  const replace = (d: { id: string } & Partial<DashboardSummary>) => setItems((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...pickSummary(d) } : x)));

  const doExport = async (d: DashboardSummary) => {
    try {
      const data = await exportDashboard(d.id);
      downloadJson(data, `${safeFileName(d.name)}.dashboard.json`);
      show({ message: `Exported “${d.name}”.`, tone: 'success' });
    } catch (e) {
      show({ message: errorLine(e, 'Could not export the dashboard.'), tone: 'error' });
    }
  };

  const doUnarchive = async (d: DashboardSummary) => {
    try {
      const res = await unarchiveDashboard(d.id, d.version);
      replace(res);
      show({ message: `Restored “${d.name}” from the archive.`, tone: 'success' });
    } catch (e) {
      show({ message: errorLine(e, 'Could not unarchive the dashboard.'), tone: 'error' });
      void load();
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboards"
        subtitle="Read-only views of your signals and Data Model fields: live values, trends and status for operators."
        actions={
          <>
            <Button variant="outline" icon={<Upload className="w-4 h-4" />} onClick={() => setImportOpen(true)}>
              Import
            </Button>
            <Button variant="primary" size="lg" icon={<Plus className="w-4 h-4" />} onClick={() => setNewOpen(true)}>
              New dashboard
            </Button>
          </>
        }
      />

      {error ? <ErrorBanner error={error} subject="the dashboards" onRetry={() => void load()} /> : null}

      {(items.length > 0 || filtersActive) && (
        <FilterBar>
          <SearchInput value={q} onChange={setQ} placeholder="Search by name or description" ariaLabel="Search dashboards" className="flex-1 min-w-[220px]" />
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={selectCls} aria-label="Filter by status">
            <option value="all">All dashboards</option>
            <option value="draft">Draft (never published)</option>
            <option value="published">Published</option>
            <option value="changes">Unpublished changes</option>
            <option value="archived">Archived{archivedCount ? ` (${archivedCount})` : ''}</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectCls} aria-label="Sort">
            <option value="updated">Last updated</option>
            <option value="name">Name</option>
          </select>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={() => { setQ(''); setStatus('all'); }}>
              Clear
            </Button>
          )}
          <span className="ml-auto text-[11px] text-[#657794]" aria-live="polite">
            {filtersActive ? `${filtered.length} of ${status === 'archived' ? archivedCount : active.length}` : active.length} dashboard{active.length === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="Reload" title="Reload" className="p-1.5 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </FilterBar>
      )}

      {!loaded && loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading dashboards">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white border border-[#E2E8F0] rounded-xl p-4 space-y-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      ) : loaded && active.length === 0 && !filtersActive ? (
        <ListEmptyState onCreate={() => setNewOpen(true)} onImport={() => setImportOpen(true)} archived={archivedCount} onShowArchived={() => setStatus('archived')} />
      ) : loaded && filtered.length === 0 ? (
        <div className="bg-white border border-dashed border-[#CBD5E1] rounded-xl py-12 text-center text-[13px] text-[#657794]">
          {status === 'archived' ? 'No archived dashboard.' : 'No dashboard matches the filters.'}
        </div>
      ) : (
        <div role="list" aria-label="Dashboards" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((d) => (
            <DashboardCard
              key={d.id}
              d={d}
              now={now}
              onOpen={() => navigate(`/dashboards/${d.id}`)}
              onEdit={() => navigate(`/dashboards/${d.id}/edit`)}
              onDuplicate={() => setDup(d)}
              onExport={() => void doExport(d)}
              onArchive={() => {
                setArchiveError(null);
                setToArchive(d);
              }}
              onUnarchive={() => void doUnarchive(d)}
              onDelete={() => {
                setDeleteError(null);
                setDeleteTyped('');
                setToDelete(d);
              }}
            />
          ))}
        </div>
      )}

      <NewDashboardDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(d, warnings) => {
          setNewOpen(false);
          // The list unmounts on navigation: the Studio shows the creation notes.
          navigate(`/dashboards/${d.id}/edit`, { state: warnings.length ? { createdWarnings: warnings } : undefined });
        }}
      />
      <ImportDashboardDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(d) => {
          setItems((prev) => [{ ...emptySummary(), ...pickSummary(d) } as DashboardSummary, ...prev.filter((x) => x.id !== d.id)]);
          void load();
        }}
        onOpen={(id) => navigate(`/dashboards/${id}/edit`)}
      />
      <DuplicateDialog
        source={dup}
        onClose={() => setDup(null)}
        onDone={(id, name) => {
          setDup(null);
          void load();
          show({ message: `Created “${name}”.`, tone: 'success', action: { label: 'Edit', run: () => navigate(`/dashboards/${id}/edit`) } });
        }}
      />
      <ConfirmDialog
        isOpen={!!toArchive}
        title={`Archive “${toArchive?.name ?? ''}”?`}
        message="Archived dashboards disappear from the list and their links stop opening. Nothing is deleted: you can unarchive it from the Archived filter."
        confirmLabel="Archive"
        busyLabel="Archiving…"
        variant="warning"
        error={archiveError}
        onCancel={() => setToArchive(null)}
        onConfirm={async () => {
          if (!toArchive) return;
          try {
            const res = await archiveDashboard(toArchive.id, toArchive.version);
            replace({ ...res, archived_at: res.archived_at || new Date().toISOString() });
            const name = toArchive.name;
            const archived = { ...toArchive, version: res.version };
            setToArchive(null);
            show({ message: `Archived “${name}”.`, tone: 'success', action: { label: 'Undo', run: () => doUnarchive(archived) } });
          } catch (e) {
            setArchiveError(errorLine(e, 'Could not archive the dashboard.'));
          }
        }}
      />
      <ConfirmDialog
        isOpen={!!toDelete}
        title={`Delete “${toDelete?.name ?? ''}” permanently?`}
        message="The dashboard, its draft and every published revision are deleted. This cannot be undone. Links to it from other dashboards stop working."
        confirmLabel="Delete permanently"
        busyLabel="Deleting…"
        variant="danger"
        confirmDisabled={!toDelete || deleteTyped.trim() !== toDelete.name.trim()}
        error={deleteError}
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete || deleteTyped.trim() !== toDelete.name.trim()) return;
          try {
            await deleteDashboard(toDelete.id);
            const { id, name } = toDelete;
            setItems((prev) => prev.filter((x) => x.id !== id));
            setToDelete(null);
            show({ message: `Deleted “${name}” permanently.`, tone: 'success' });
          } catch (e) {
            setDeleteError(errorLine(e, 'Could not delete the dashboard.'));
          }
        }}
      >
        <label htmlFor="dash-delete-name" className="block text-[12px] font-semibold text-[#334568] mb-1">
          Type the dashboard name to confirm
        </label>
        <input
          id="dash-delete-name"
          className="fx-input"
          value={deleteTyped}
          autoComplete="off"
          spellCheck={false}
          placeholder={toDelete?.name}
          onChange={(e) => setDeleteTyped(e.target.value)}
        />
      </ConfirmDialog>
      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
};

function pickSummary(d: Partial<DashboardSummary> & { document?: { widgets?: unknown[]; settings?: { theme?: { preset?: string } } } }): Partial<DashboardSummary> {
  const out: Partial<DashboardSummary> = {};
  const keys: Array<keyof DashboardSummary> = [
    'id', 'name', 'description', 'status', 'draft_revision', 'published_revision', 'published_at', 'has_unpublished_changes', 'widget_count', 'theme_preset', 'version', 'updated_at', 'archived_at',
  ];
  for (const k of keys) if (d[k] !== undefined) (out as Record<string, unknown>)[k] = d[k];
  if (out.widget_count === undefined && Array.isArray(d.document?.widgets)) out.widget_count = d.document!.widgets!.length;
  if (out.theme_preset === undefined && d.document?.settings?.theme?.preset) out.theme_preset = d.document.settings.theme.preset;
  return out;
}

function emptySummary(): DashboardSummary {
  return {
    id: '',
    name: '',
    description: '',
    status: 'DRAFT',
    draft_revision: 1,
    published_revision: null,
    published_at: null,
    has_unpublished_changes: false,
    widget_count: 0,
    theme_preset: 'factorix_light',
    version: 1,
    updated_at: new Date().toISOString(),
    archived_at: null,
  };
}

const DashboardCard: React.FC<{
  d: DashboardSummary;
  now: number;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}> = ({ d, now, onOpen, onEdit, onDuplicate, onExport, onArchive, onUnarchive, onDelete }) => {
  const archived = !!d.archived_at;
  const items = [
    { key: 'open', label: 'Open', icon: <Eye className="w-3.5 h-3.5" />, onSelect: onOpen, disabled: archived },
    { key: 'edit', label: 'Edit', icon: <Pencil className="w-3.5 h-3.5" />, onSelect: onEdit, disabled: archived },
    { key: 'dup', label: 'Duplicate…', icon: <Copy className="w-3.5 h-3.5" />, onSelect: onDuplicate, separator: true },
    { key: 'export', label: 'Export JSON', icon: <Download className="w-3.5 h-3.5" />, onSelect: onExport },
    ...(archived
      ? [
          { key: 'unarchive', label: 'Unarchive', icon: <ArchiveRestore className="w-3.5 h-3.5" />, onSelect: onUnarchive, separator: true },
          { key: 'delete', label: 'Delete permanently…', icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: onDelete, danger: true },
        ]
      : [{ key: 'archive', label: 'Archive…', icon: <Archive className="w-3.5 h-3.5" />, onSelect: onArchive, separator: true }]),
  ];
  const themeLabel = THEME_PRESET_LABEL[d.theme_preset as ThemePresetId] || d.theme_preset || '—';
  return (
    <div role="listitem" className={`group flex flex-col bg-white border rounded-xl shadow-sm hover:shadow-md transition focus-within:ring-2 focus-within:ring-blue-300 border-[#CBD5E1] hover:border-[#9FB4D1] ${archived ? 'opacity-75' : ''}`}>
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <span className="mt-0.5 w-8 h-8 rounded-lg bg-[#EEF5FF] text-[#134074] flex items-center justify-center shrink-0" aria-hidden="true">
          <LayoutDashboard className="w-4 h-4" />
        </span>
        {/* The title opens (or edits) an active dashboard; on an archived card it is plain text: a click must never mutate. */}
        {archived ? (
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-bold text-[#111B37] truncate" title={d.name}>
              {d.name}
            </h3>
            <p className="text-[12px] text-[#657794] line-clamp-2 min-h-[32px]" title={d.description}>
              {d.description || <span className="text-[#94A3B8]">No description</span>}
            </p>
          </div>
        ) : (
          <button type="button" onClick={d.published_revision ? onOpen : onEdit} className="min-w-0 flex-1 text-left outline-none" aria-label={`${d.published_revision ? 'Open' : 'Edit'} ${d.name}`}>
            <h3 className="text-[14px] font-bold text-[#111B37] truncate group-hover:text-[#134074]" title={d.name}>
              {d.name}
            </h3>
            <p className="text-[12px] text-[#657794] line-clamp-2 min-h-[32px]" title={d.description}>
              {d.description || <span className="text-[#94A3B8]">No description</span>}
            </p>
          </button>
        )}
        <IconMenu label={`Actions for ${d.name}`} icon={<EllipsisVertical className="w-4 h-4" />} items={items} />
      </div>
      <div className="px-4 mt-2">
        <DashboardStatusChip published_revision={d.published_revision} has_unpublished_changes={d.has_unpublished_changes} archived_at={d.archived_at} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 mt-2.5 text-[11px] text-[#334568]">
        <span>
          {d.widget_count} widget{d.widget_count === 1 ? '' : 's'}
        </span>
        <span className="inline-flex items-center gap-1" title="Theme">
          <Palette className="w-3 h-3 text-slate-400" aria-hidden="true" /> {themeLabel}
        </span>
        <span className="text-[#657794]" title={new Date(d.updated_at).toLocaleString()}>
          Updated {timeAgo(d.updated_at, now)}
        </span>
      </div>
      <div className="mt-auto flex items-center gap-2 px-4 py-3 border-t border-[#F1F5F9] mt-3">
        {archived ? (
          <>
            <Button size="sm" variant="outline" icon={<ArchiveRestore className="w-3.5 h-3.5" />} onClick={onUnarchive}>
              Unarchive
            </Button>
            <Button size="sm" variant="danger" className="ml-auto" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete}>
              Delete permanently
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" icon={<Eye className="w-3.5 h-3.5" />} onClick={onOpen} disabled={!d.published_revision} title={d.published_revision ? undefined : 'Publish the dashboard first'}>
              Open
            </Button>
            <Button size="sm" variant="outline" icon={<Pencil className="w-3.5 h-3.5" />} onClick={onEdit}>
              Edit
            </Button>
          </>
        )}
        {d.published_at && !archived && (
          <span className="ml-auto text-[10px] text-[#94A3B8]" title={new Date(d.published_at).toLocaleString()}>
            Published {timeAgo(d.published_at, now)}
          </span>
        )}
      </div>
    </div>
  );
};

const ListEmptyState: React.FC<{ onCreate: () => void; onImport: () => void; archived: number; onShowArchived: () => void }> = ({ onCreate, onImport, archived, onShowArchived }) => (
  <div className="bg-white border border-[#CBD5E1] rounded-xl p-8 md:p-10">
    <div className="max-w-3xl mx-auto">
      <div className="w-11 h-11 rounded-xl bg-[#EEF5FF] text-[#134074] flex items-center justify-center mb-4">
        <LayoutDashboard className="w-6 h-6" aria-hidden="true" />
      </div>
      <h2 className="text-[18px] font-bold text-[#111B37]">Build your first dashboard</h2>
      <p className="mt-2 text-[13px] text-[#334568] leading-relaxed">
        A dashboard shows data FactoriX already collects — Data Collector signals and Data Model fields — as values, gauges, trends, tables and equipment
        cards. It only reads data: it never writes to a device.
      </p>
      <ol className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] text-[#334568]">
        <li className="rounded-lg border border-[#E3EAF3] bg-[#F9FAFD] p-3">
          <strong className="block text-[#111B37] mb-0.5">1. Create</strong>
          Start blank or from a template; a template asks you to map its data roles to your own sources.
        </li>
        <li className="rounded-lg border border-[#E3EAF3] bg-[#F9FAFD] p-3">
          <strong className="block text-[#111B37] mb-0.5">2. Design</strong>
          In the Studio, drag widgets onto the grid and choose their data from the Factory Model tree.
        </li>
        <li className="rounded-lg border border-[#E3EAF3] bg-[#F9FAFD] p-3">
          <strong className="block text-[#111B37] mb-0.5">3. Publish</strong>
          Validate and publish: operators open the published revision; your next edits stay a draft until you publish again.
        </li>
      </ol>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onCreate} icon={<Plus className="w-4 h-4" />}>
          New dashboard
        </Button>
        <Button variant="outline" onClick={onImport} icon={<Upload className="w-4 h-4" />}>
          Import JSON
        </Button>
        {archived > 0 && (
          <Button variant="ghost" onClick={onShowArchived}>
            Show {archived} archived
          </Button>
        )}
      </div>
    </div>
  </div>
);

export const DuplicateDialog: React.FC<{ source: { id: string; name: string } | null; onClose: () => void; onDone: (id: string, name: string) => void }> = ({ source, onClose, onDone }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (source) {
      setName(`Copy of ${source.name}`.slice(0, 160));
      setError(null);
    }
  }, [source]);
  const submit = async () => {
    if (!source || !name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await duplicateDashboard(source.id, name.trim());
      onDone(res.id, res.name);
    } catch (e) {
      setError(errorLine(e, 'Could not duplicate the dashboard.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!source}
      onClose={onClose}
      busy={busy}
      title="Duplicate dashboard"
      subtitle="The copy is a new draft; it is not published."
      width="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!name.trim()}>
            Duplicate
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="dash-dup-name" className="block text-[12px] font-semibold text-[#334568] mb-1">
          Name
        </label>
        <input id="dash-dup-name" className="fx-input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-red-700">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
};
