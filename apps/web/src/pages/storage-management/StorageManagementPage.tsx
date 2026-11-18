import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Plus,
  RefreshCw,
  HardDrive,
  Database,
  Layers,
  Table,
  LayoutGrid,
  List,
  ChevronDown,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import { StorageEngineSwitcher, StorageEngine } from './StorageEngineSwitcher';
import { StorageHealthStrip } from './StorageHealthStrip';
import { StorageObjectGraph } from './StorageObjectGraph';
import { StorageObjectsTable } from './StorageObjectsTable';
import { StorageObjectDrawer } from './StorageObjectDrawer';
import { PostgresExplorerView } from './PostgresExplorerView';
import {
  RemoteErrorState,
  RemoteLoadingState,
  RemoteEmptyState,
} from '../../components/common/RemoteResourceState';
import {
  TopologyNode,
  TopologyEdge,
  getTDTopology,
  getStorageStats,
  getStorageObject,
  TDDatabase,
  TDStable,
  TDSubtable,
} from '../../lib/storagePhysicalApi';

export const StorageManagementPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Engine selection: 'tdengine' | 'postgresql'
  const [engine, setEngine] = useState<StorageEngine>('tdengine');

  // TDengine view mode: 'topology' | 'objects'
  const activeTab = searchParams.get('tab') === 'objects' ? 'objects' : 'topology';
  const setActiveTab = (tab: 'topology' | 'objects') => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'objects') next.set('tab', 'objects');
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  // State
  const [loading, setLoading] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof getStorageStats>> | null>(null);
  const [statsError, setStatsError] = useState<unknown>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const loadController = useRef<AbortController>();

  // Selected object for drawer
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedObjectData, setSelectedObjectData] = useState<
    ((TDDatabase | TDStable | TDSubtable) & { object_type: 'database' | 'stable' | 'subtable' }) | null
  >(null);

  const [topoError, setTopoError] = useState<unknown | null>(null);
  const [drawerError, setDrawerError] = useState<unknown | null>(null);

  // Load TDengine data - strictly real data, no synthetic fallbacks
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
    else {
      setStats(null);
      setStatsError(statsResult.reason);
    }
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
            // Standardize canonical object IDs: db:<name>, stable:<db>.<name>, subtable:<db>.<name>
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
            return {
              ...n,
              node_id: canonicalId,
              object_type: objType,
              physical_name: physName,
              display_name: n.display_name || n.label || physName,
              status: n.status || 'ACTIVE',
            };
          })
        : [];
      const safeEdges: TopologyEdge[] = Array.isArray(topo?.edges) ? topo.edges : [];

      setNodes(safeNodes);
      setEdges(safeEdges);
    } catch (err: unknown) {
      console.error('Failed to load TDengine topology:', err);
      setTopoError(err);
      setNodes([]);
      setEdges([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  const refreshTDengine = () => {
    setRefreshVersion((previous) => previous + 1);
    void loadTDengineData();
  };

  useEffect(() => {
    if (engine === 'tdengine') {
      void loadTDengineData();
    }
    return () => loadController.current?.abort();
  }, [engine, loadTDengineData]);

  // Load detailed object for drawer when selected - strictly real data
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
        if (!active) return;
        const isDb = selectedObjectId.startsWith('db:') || selectedObjectId.startsWith('db/');
        const isStable = selectedObjectId.startsWith('stable:') || selectedObjectId.startsWith('stable/');
        const type: 'database' | 'stable' | 'subtable' = isDb ? 'database' : isStable ? 'stable' : 'subtable';
        setSelectedObjectData({ ...obj, object_type: type });
        setDrawerError(null);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load storage object detail:', err);
        setSelectedObjectData(null);
        setDrawerError(err);
      });
    return () => { active = false; };
  }, [selectedObjectId]);

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold text-[#111B37]">Storage Management</h1>
          <p className="text-[13px] text-[#657794]">
            Databases, supertables and subtables in TDengine, and the Data Model fields recorded into them.
          </p>
        </div>

        {/* Header Right Actions */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Engine Switcher */}
          <StorageEngineSwitcher activeEngine={engine} onChange={setEngine} />

          {engine === 'tdengine' && (
            <>
              {/* Refresh button */}
              <button
                type="button"
                onClick={refreshTDengine}
                disabled={loading || catalogLoading}
                className="flex items-center gap-1.5 h-9 px-4 bg-white border border-[#D4DFEC] rounded-lg text-[13px] font-semibold text-[#334568] hover:bg-[#F9FAFD] transition-colors"
                title="Refresh physical metadata"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>

              {/* + New Dropdown */}
              <div
                className="relative"
                onKeyDown={(e) => { if (e.key === 'Escape') setNewMenuOpen(false); }}
                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNewMenuOpen(false); }}
              >
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={newMenuOpen}
                  onClick={() => setNewMenuOpen(!newMenuOpen)}
                  className="flex items-center gap-1.5 h-10 px-5 bg-[#EF1B24] hover:bg-[#D9141D] text-white rounded-lg text-[14px] font-semibold shadow-sm transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span>New</span>
                  <ChevronDown className="w-3.5 h-3.5 ml-0.5" />
                </button>

                {newMenuOpen && (
                  <div
                    className="absolute right-0 top-11 z-30 w-52 bg-white border border-[#E3EAF3] rounded-xl shadow-xl py-1.5 animate-in fade-in zoom-in-95 duration-100"
                    onClick={() => setNewMenuOpen(false)}
                  >
                    <button
                      type="button"
                      onClick={() => navigate('/historian/storage/create?kind=database')}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC]"
                    >
                      <Database className="w-4 h-4 text-[#EF1B24]" />
                      <div>
                        <div>Database</div>
                        <div className="text-[11px] font-normal text-[#657794]">Create TDengine database</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => navigate('/historian/storage/create?kind=stable')}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC]"
                    >
                      <Layers className="w-4 h-4 text-[#2A82E7]" />
                      <div>
                        <div>Supertable (STable)</div>
                        <div className="text-[11px] font-normal text-[#657794]">Define time-series schema</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => navigate('/historian/storage/create?kind=subtable')}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC]"
                    >
                      <Table className="w-4 h-4 text-[#8858EA]" />
                      <div>
                        <div>Subtable</div>
                        <div className="text-[11px] font-normal text-[#657794]">One table bound to a Data Model field</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => navigate('/historian/storage/bulk')}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC] border-t border-[#E3EAF3]"
                    >
                      <Layers className="w-4 h-4 text-[#2A82E7]" />
                      <div>
                        <div>Subtables from Data Models</div>
                        <div className="text-[11px] font-normal text-[#657794]">Machines x fields, in one go</div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main body based on engine */}
      {engine === 'postgresql' ? (
        <PostgresExplorerView />
      ) : (
        <div className="space-y-3">
          {/* KPI Strip & View Mode Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {stats && (
              <StorageHealthStrip
                databaseCount={stats.database_count}
                stableCount={stats.stable_count}
                subtableCount={stats.subtable_count}
                recordingActive={stats.recording_active}
                recordingPaused={stats.recording_paused}
                recordingError={stats.recording_error}
                lastObservedAt={stats.observed_at}
              />
            )}

            {/* View Mode Switcher: Topology / Objects */}
            <div className="flex items-center gap-1 bg-[#EEF2F6] p-1 rounded-lg">
              <button
                type="button"
                onClick={() => setActiveTab('topology')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-semibold transition-all ${
                  activeTab === 'topology'
                    ? 'bg-white text-[#111B37] shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>Topology</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('objects')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-semibold transition-all ${
                  activeTab === 'objects'
                    ? 'bg-white text-[#111B37] shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                <span>Objects Table</span>
              </button>
            </div>
          </div>

          {/* Active view */}
          {statsError != null && <RemoteErrorState error={statsError} subject="Storage totals" onRetry={refreshTDengine} />}
          {activeTab === 'objects' ? (
            <StorageObjectsTable
              selectedObjectId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onRefresh={refreshTDengine}
              refreshVersion={refreshVersion}
              onLoadingChange={setCatalogLoading}
            />
          ) : topoError != null ? (
            <RemoteErrorState
              error={topoError}
              subject="TDengine Storage Topology"
              onRetry={loadTDengineData}
            />
          ) : loading && nodes.length === 0 ? (
            <RemoteLoadingState subject="TDengine storage topology" />
          ) : nodes.length === 0 ? (
            <RemoteEmptyState
              title="No Storage Objects Found"
              description="There are no physical TDengine databases or supertables configured yet. Start by creating your first database."
              actionLabel="Create Database"
              onAction={() => navigate('/historian/storage/create?kind=database')}
              icon={Database}
            />
          ) : (
            <StorageObjectGraph
              nodes={nodes}
              edges={edges}
              selectedObjectId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onRefresh={loadTDengineData}
              loading={loading}
            />
          )}

          {/* Details Drawer for selected object */}
          {selectedObjectData && (
            <StorageObjectDrawer
              object={selectedObjectData}
              onClose={() => setSelectedObjectId(null)}
              onRefresh={refreshTDengine}
            />
          )}

          {/* Drawer Error State */}
          {drawerError != null && selectedObjectId && !selectedObjectData && (
            <div className="fixed inset-y-0 right-0 z-40 w-[420px] bg-white border-l border-[#FAC6C9] shadow-xl p-6 flex flex-col justify-center animate-in slide-in-from-right duration-200">
              <RemoteErrorState
                error={drawerError}
                subject={`Storage Object "${selectedObjectId}"`}
                onRetry={() => {
                  if (selectedObjectId) {
                    const id = selectedObjectId;
                    setSelectedObjectId(null);
                    setTimeout(() => setSelectedObjectId(id), 50);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setSelectedObjectId(null);
                  setDrawerError(null);
                }}
                className="mt-4 px-4 py-2 bg-[#F1F5FA] hover:bg-[#E3EAF3] text-[#111B37] rounded-lg text-[13px] font-semibold"
              >
                Close Drawer
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
