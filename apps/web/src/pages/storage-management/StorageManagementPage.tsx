import React, { useState, useEffect, useCallback, useRef, useId } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { ChevronDown, Database, Layers, LayoutGrid, List, Plus, RefreshCw, Table, Rows3 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { StorageEngineSwitcher, StorageEngine } from './StorageEngineSwitcher';
import { StorageHealthStrip } from './StorageHealthStrip';
import { StorageObjectGraph } from './StorageObjectGraph';
import { ObjectTypeFilter, StorageObjectsTable } from './StorageObjectsTable';
import { StorageObjectDrawer } from './StorageObjectDrawer';
import { PostgresExplorerView } from './PostgresExplorerView';
import { Dialog, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Segmented, TimeCell } from '../historian/hsUi';
import { StorageObjectData, kindOfId, KIND_LABEL } from './objectViews';
import {
  TopologyNode,
  TopologyEdge,
  getTDTopology,
  getStorageStats,
  getStorageObject,
  listStorageDrafts,
  discardStorageDraft,
  StorageDraftItem,
} from '../../lib/storagePhysicalApi';

// ------------------------------------------------------------------ "Create" primary menu (old-nav wording: Create / Add)

interface NewItem {
  key: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  to: string;
}

/** Primary red "Create ▾" with the MenuButton behaviour (Esc / outside click close, arrow keys). */
const NewMenu: React.FC<{ items: NewItem[]; onPick: (to: string) => void }> = ({ items, onPick }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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
        rootRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
    const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
    nodes[e.key === 'ArrowDown' ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length]?.focus();
  };
  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="primary"
        size="lg"
        icon={<Plus className="w-4 h-4" />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Create <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </Button>
      {open && (
        <div id={menuId} role="menu" aria-label="Create" onKeyDown={move} className="absolute right-0 top-full mt-1.5 w-64 max-w-[calc(100vw-24px)] rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-1.5 z-40">
          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(it.to);
              }}
              className={`w-full text-left px-3 py-2 flex items-start gap-2.5 outline-none hover:bg-[#F8FAFC] focus-visible:bg-[#F1F5FA] ${i === items.length - 1 ? 'border-t border-[#F1F5FA] mt-1 pt-2.5' : ''}`}
            >
              <span className="w-4 h-4 mt-0.5 flex items-center justify-center shrink-0" aria-hidden="true">
                {it.icon}
              </span>
              <span>
                <span className="block text-[13px] font-semibold text-[#111B37]">{it.label}</span>
                <span className="block text-[11px] text-[#657794]">{it.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ drafts

const LOCAL_DRAFT_KEYS: { key: string; kind: 'database' | 'stable' | 'subtable' }[] = [
  { key: 'fx_wizard_draft_database', kind: 'database' },
  { key: 'fx_wizard_draft_stable', kind: 'stable' },
  { key: 'fx_wizard_draft_subtable', kind: 'subtable' },
];

interface LocalDraft {
  key: string;
  kind: 'database' | 'stable' | 'subtable';
  name: string;
}

function readLocalDrafts(): LocalDraft[] {
  const out: LocalDraft[] = [];
  for (const d of LOCAL_DRAFT_KEYS) {
    try {
      const raw = sessionStorage.getItem(d.key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { v?: number; data?: { physical_name?: string; display_name?: string }; physical_name?: string; display_name?: string };
      const data = parsed?.v === 2 && parsed.data ? parsed.data : parsed;
      out.push({ ...d, name: data.physical_name || data.display_name || '(no name yet)' });
    } catch {
      // ignore unreadable drafts
    }
  }
  return out;
}

const DraftsDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  local: LocalDraft[];
  server: StorageDraftItem[];
  onResume: (kind: string) => void;
  onDiscard: (key: string) => void;
  onDiscardServer: (d: StorageDraftItem) => void;
  onResumeServer: (d: StorageDraftItem) => void;
}> = ({ open, onClose, local, server, onResume, onDiscard, onDiscardServer, onResumeServer }) => (
  <Dialog open={open} onClose={onClose} title="Drafts" subtitle="Unfinished storage objects" width="md" footer={<Button size="sm" variant="outline" onClick={onClose}>Close</Button>}>
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-[12px] font-bold text-[#111B37]">In this browser tab</h3>
        {local.length === 0 ? (
          <p className="text-[12px] text-[#657794]">No wizard draft saved in this tab. “Save draft” in a wizard keeps its input here until the tab is closed.</p>
        ) : (
          <ul className="divide-y divide-[#E3EAF3] border border-[#E3EAF3] rounded-lg">
            {local.map((d) => (
              <li key={d.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-[11px] font-bold uppercase text-[#657794] w-20">{KIND_LABEL[d.kind]}</span>
                <span className="font-mono text-[13px] text-[#111B37] truncate flex-1 min-w-[120px]">{d.name}</span>
                <Button size="sm" variant="outline" onClick={() => onResume(d.kind)}>
                  Resume
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDiscard(d.key)}>
                  Discard
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {server.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[12px] font-bold text-[#111B37]">Saved on the server</h3>
          <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>State</th>
                  <th>Updated</th>
                  <th className="w-40"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {server.map((d) => (
                  <tr key={d.id}>
                    <td className="font-mono text-[#111B37]">{d.name}</td>
                    <td>{KIND_LABEL[d.object_kind] || d.object_kind}</td>
                    <td>{d.state}</td>
                    <td>
                      <TimeCell iso={d.updated_at} />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="outline" onClick={() => onResumeServer(d)}>
                        Resume
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onDiscardServer(d)}>
                        Discard
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#657794]">Resume opens a server draft in its wizard; Create there publishes it. Failed creations also stay here as drafts.</p>
        </section>
      )}
    </div>
  </Dialog>
);

// ------------------------------------------------------------------ page

export const StorageManagementPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  const { toast, show: showToast, dismiss: dismissToast } = useActionToast();

  const engine: StorageEngine = searchParams.get('engine') === 'postgresql' ? 'postgresql' : 'tdengine';
  const activeTab = searchParams.get('tab') === 'objects' ? 'objects' : 'topology';
  const typeFilter = (['database', 'stable', 'subtable'].includes(searchParams.get('type') || '') ? searchParams.get('type') : 'all') as ObjectTypeFilter;
  const [statusFilter, setStatusFilter] = useState('all');

  const patchParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  const setEngine = (e: StorageEngine) => patchParams({ engine: e === 'postgresql' ? 'postgresql' : null });
  const setActiveTab = (tab: 'topology' | 'objects') => patchParams({ tab: tab === 'objects' ? 'objects' : null });
  const setTypeFilter = (t: ObjectTypeFilter) => patchParams({ type: t === 'all' ? null : t, tab: 'objects' });

  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [topoLoaded, setTopoLoaded] = useState(false);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof getStorageStats>> | null>(null);
  const [statsError, setStatsError] = useState<unknown>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const loadController = useRef<AbortController>();

  const [localDrafts, setLocalDrafts] = useState<LocalDraft[]>(() => readLocalDrafts());
  const [serverDrafts, setServerDrafts] = useState<StorageDraftItem[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);

  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedObjectData, setSelectedObjectData] = useState<StorageObjectData | null>(null);
  const [drawerError, setDrawerError] = useState<unknown>(null);
  const [drawerReload, setDrawerReload] = useState(0);
  const [topoError, setTopoError] = useState<unknown>(null);

  const loadTDengineData = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setTopoError(null);
    setStatsError(null);
    const [statsResult, topologyResult] = await Promise.allSettled([
      getStorageStats(controller.signal),
      activeTab === 'topology' ? getTDTopology({ include_subtable_tags: false }, controller.signal) : Promise.resolve(null),
    ]);
    if (controller.signal.aborted) return;
    if (statsResult.status === 'fulfilled') setStats(statsResult.value);
    else setStatsError(statsResult.reason);
    try {
      if (topologyResult.status === 'rejected') throw topologyResult.reason;
      const topo = topologyResult.value;
      if (!topo) return;
      const safeNodes: TopologyNode[] = Array.isArray(topo?.nodes)
        ? topo.nodes.map((n: any) => {
            const rawType = (n.object_type || n.kind || 'database') as string;
            const objType: 'database' | 'stable' | 'subtable' =
              rawType === 'engine' || rawType === 'database' ? 'database' : rawType === 'stable' ? 'stable' : 'subtable';
            const physName = n.physical_name || n.label || n.name || '';
            // Canonical object ids: db:<name>, stable:<db>.<name>, subtable:<db>.<name>
            let canonicalId = n.node_id || '';
            if (!canonicalId || canonicalId.includes('/')) {
              if (objType === 'database') canonicalId = `db:${physName}`;
              else if (objType === 'stable') {
                const parent = (n.metadata?.database_name as string) || n.parent_id?.replace(/^(db[:/])/, '') || 'default';
                canonicalId = `stable:${parent}.${physName}`;
              } else {
                const parent = (n.metadata?.stable_name as string) || n.parent_id?.replace(/^(stable[:/])/, '') || 'default';
                canonicalId = `subtable:${parent}.${physName}`;
              }
            }
            return { ...n, node_id: canonicalId, object_type: objType, physical_name: physName, display_name: n.display_name || n.label || physName, status: n.status || 'ACTIVE' };
          })
        : [];
      setNodes(safeNodes);
      setEdges(Array.isArray(topo?.edges) ? topo.edges : []);
      setTopoLoaded(true);
    } catch (err: unknown) {
      setTopoError(err);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [activeTab]);

  const loadDrafts = useCallback(() => {
    setLocalDrafts(readLocalDrafts());
    listStorageDrafts()
      .then((r) => setServerDrafts(Array.isArray(r?.items) ? r.items : []))
      .catch(() => setServerDrafts([]));
  }, []);

  const refreshTDengine = () => {
    setRefreshVersion((v) => v + 1);
    loadDrafts();
    void loadTDengineData();
  };

  useEffect(() => {
    if (engine === 'tdengine') void loadTDengineData();
    return () => loadController.current?.abort();
  }, [engine, loadTDengineData]);
  useEffect(() => loadDrafts(), [loadDrafts]);

  useEffect(() => {
    if (!selectedObjectId) {
      setSelectedObjectData(null);
      setDrawerError(null);
      return;
    }
    let active = true;
    setSelectedObjectData(null);
    setDrawerError(null);
    getStorageObject(selectedObjectId)
      .then((obj) => {
        if (active) setSelectedObjectData({ ...obj, object_type: kindOfId(selectedObjectId) } as StorageObjectData);
      })
      .catch((err) => {
        if (active) setDrawerError(err);
      });
    return () => {
      active = false;
    };
  }, [selectedObjectId, drawerReload]);

  const notice = useCallback((message: string, tone: 'info' | 'success' | 'error' = 'info') => showToast({ message, tone }), [showToast]);
  // A confirmation handed over by a page that no longer exists (e.g. "Deleted database …" from its detail page).
  useEffect(() => {
    const msg = (location.state as { notice?: string } | null)?.notice;
    if (!msg) return;
    notice(msg, 'success');
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const newItems: NewItem[] = [
    { key: 'db', label: 'Database', hint: 'Precision and retention', icon: <Database className="w-4 h-4 text-[#111B37]" />, to: '/historian/storage/create?kind=database' },
    { key: 'st', label: 'Supertable', hint: 'Columns and tags for a family of tables', icon: <Layers className="w-4 h-4 text-[#2A82E7]" />, to: '/historian/storage/create?kind=stable' },
    { key: 'sub', label: 'Subtable', hint: 'One table bound to a Data Model field', icon: <Table className="w-4 h-4 text-[#8858EA]" />, to: '/historian/storage/create?kind=subtable' },
    { key: 'bulk', label: 'Subtables from Data Models', hint: 'Machines × fields in one go', icon: <Rows3 className="w-4 h-4 text-[#657794]" />, to: '/historian/storage/bulk' },
  ];
  const draftCount = localDrafts.length + serverDrafts.length;

  return (
    <div className="space-y-4">
      <ActionToast toast={toast} onDismiss={dismissToast} />
      <PageHeader
        title="Storage Management"
        subtitle="TDengine databases, supertables and subtables, and the Data Model fields recorded into them."
        actions={
          <>
            <StorageEngineSwitcher activeEngine={engine} onChange={setEngine} />
            {engine === 'tdengine' && (
              <>
                <Button variant="outline" size="md" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading || catalogLoading ? 'animate-spin' : ''}`} />} onClick={refreshTDengine} disabled={loading || catalogLoading}>
                  Refresh
                </Button>
                <NewMenu items={newItems} onPick={(to) => navigate(to, { state: { from } })} />
              </>
            )}
          </>
        }
      />

      {engine === 'postgresql' ? (
        <PostgresExplorerView />
      ) : (
        <div className="space-y-4">
          {statsError != null ? (
            <ErrorBanner error={statsError} subject="storage totals" onRetry={refreshTDengine} />
          ) : (
            <StorageHealthStrip
              databaseCount={stats?.database_count ?? null}
              stableCount={stats?.stable_count ?? null}
              subtableCount={stats?.subtable_count ?? null}
              recordingActive={stats?.recording_active ?? null}
              recordingPaused={stats?.recording_paused ?? null}
              recordingError={stats?.recording_error ?? null}
              loading={stats == null}
              draftCount={draftCount}
              activeType={activeTab === 'objects' ? typeFilter : undefined}
              onFilterType={setTypeFilter}
              onOpenDrafts={() => {
                loadDrafts();
                setDraftsOpen(true);
              }}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented<'topology' | 'objects'>
              ariaLabel="View"
              value={activeTab}
              onChange={setActiveTab}
              options={[
                { id: 'topology', label: 'Topology', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
                { id: 'objects', label: 'Objects table', icon: <List className="w-3.5 h-3.5" /> },
              ]}
            />
            {stats?.observed_at && (
              <span className="text-[11px] text-[#94A3B8]">
                Observed <TimeCell iso={stats.observed_at} />
              </span>
            )}
          </div>

          {activeTab === 'objects' ? (
            <StorageObjectsTable
              selectedObjectId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onRefresh={refreshTDengine}
              refreshVersion={refreshVersion}
              onLoadingChange={setCatalogLoading}
              typeFilter={typeFilter}
              onTypeFilter={(t) => patchParams({ type: t === 'all' ? null : t })}
              statusFilter={statusFilter}
              onStatusFilter={setStatusFilter}
              onNotice={notice}
            />
          ) : topoError != null ? (
            <ErrorBanner error={topoError} subject="the TDengine topology" onRetry={() => void loadTDengineData()} />
          ) : !topoLoaded && loading ? (
            <div className="bg-white border border-[#CBD5E1] rounded-xl">
              <LoadingBlock label="Loading TDengine topology…" />
            </div>
          ) : topoLoaded && nodes.length === 0 ? (
            <EmptyState
              icon={<Database className="w-6 h-6" />}
              title="No storage objects yet"
              action={
                <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/historian/storage/create?kind=database', { state: { from } })}>
                  Create database
                </Button>
              }
            >
              Start with a TDengine database, then a supertable (columns + tags) and its subtables.
            </EmptyState>
          ) : (
            <StorageObjectGraph
              nodes={nodes}
              edges={edges}
              selectedObjectId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onRefresh={() => void loadTDengineData()}
              loading={loading}
              onShowObjects={() => setActiveTab('objects')}
            />
          )}

          {selectedObjectId && (
            <StorageObjectDrawer
              objectId={selectedObjectId}
              object={selectedObjectData}
              error={drawerError}
              onRetry={() => setDrawerReload((v) => v + 1)}
              onClose={() => setSelectedObjectId(null)}
              onRefresh={refreshTDengine}
              onNotice={(m) => notice(m, 'success')}
            />
          )}
        </div>
      )}

      <DraftsDialog
        open={draftsOpen}
        onClose={() => setDraftsOpen(false)}
        local={localDrafts}
        server={serverDrafts}
        onResume={(kind) => navigate(`/historian/storage/create?kind=${kind}&resume=1`, { state: { from } })}
        onDiscard={(key) => {
          try {
            sessionStorage.removeItem(key);
          } catch {
            // ignore
          }
          setLocalDrafts(readLocalDrafts());
        }}
        onResumeServer={(d) => navigate(`/historian/storage/create?kind=${encodeURIComponent(d.object_kind)}&draft=${encodeURIComponent(d.id)}`, { state: { from, draft: d } })}
        onDiscardServer={(d) => {
          discardStorageDraft(d.id)
            .then(() => {
              notice(`Discarded draft ${d.name}.`, 'success');
              loadDrafts();
            })
            .catch((e: unknown) => {
              const status = (e as { status?: number }).status;
              notice(
                status === 404 || status === 405
                  ? 'This server cannot discard drafts yet (needs the newer Center).'
                  : `Could not discard the draft: ${(e as Error)?.message || 'error'}`,
                'error',
              );
            });
        }}
      />
    </div>
  );
};
