import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import { StorageObjectsTable, StorageObjectRow } from './StorageObjectsTable';
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
  listDatabases,
  listStables,
  listSubtables,
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
  const [stats, setStats] = useState({
    databaseCount: 0,
    stableCount: 0,
    subtableCount: 0,
    recordingActive: 0,
    recordingPaused: 0,
    recordingError: 0,
    lastObservedAt: '',
  });

  // Flat objects for table view
  const [tableObjects, setTableObjects] = useState<StorageObjectRow[]>([]);

  // Selected object for drawer
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedObjectData, setSelectedObjectData] = useState<
    ((TDDatabase | TDStable | TDSubtable) & { object_type: 'database' | 'stable' | 'subtable' }) | null
  >(null);

  const [topoError, setTopoError] = useState<unknown | null>(null);
  const [drawerError, setDrawerError] = useState<unknown | null>(null);

  // Load TDengine data - strictly real data, no synthetic fallbacks
  const loadTDengineData = useCallback(async () => {
    setLoading(true);
    setTopoError(null);
    try {
      // 1. Fetch topology from TDengine
      const topo = await getTDTopology();

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

      // 2. Fetch real stats independent of pagination
      try {
        const st = await getStorageStats();
        setStats({
          databaseCount: st?.database_count ?? 0,
          stableCount: st?.stable_count ?? 0,
          subtableCount: st?.subtable_count ?? 0,
          recordingActive: st?.recording_active ?? 0,
          recordingPaused: st?.recording_paused ?? 0,
          recordingError: st?.recording_error ?? 0,
          lastObservedAt: st?.observed_at || topo?.observed_at || new Date().toISOString(),
        });
      } catch (stErr) {
        console.warn('Real stats endpoint failed, using counted topology values', stErr);
        setStats({
          databaseCount: safeNodes.filter((n) => n.object_type === 'database').length,
          stableCount: safeNodes.filter((n) => n.object_type === 'stable').length,
          subtableCount: safeNodes.filter((n) => n.object_type === 'subtable').length,
          recordingActive: 0,
          recordingPaused: 0,
          recordingError: 0,
          lastObservedAt: topo?.observed_at || new Date().toISOString(),
        });
      }

      // 3. Flatten objects for table view
      const rows: StorageObjectRow[] = safeNodes.map((n) => ({
        id: n.node_id,
        physical_name: n.physical_name,
        display_name: n.display_name || null,
        object_type: (n.object_type === 'engine' ? 'database' : n.object_type) as 'database' | 'stable' | 'subtable',
        parent_name: (n.metadata?.database_name as string) || (n.metadata?.stable_name as string) || null,
        parent_id: n.parent_id,
        column_count: n.metadata?.column_count as number | undefined,
        tag_count: n.metadata?.tag_count as number | undefined,
        subtable_count: (n.metadata?.subtable_count as number | undefined) || (n.metadata?.stable_count as number | undefined),
        binding_count: (n.metadata?.binding_count as number | undefined) || 0,
        last_verified_at: topo?.observed_at || new Date().toISOString(),
        status: n.status,
      }));
      setTableObjects(rows);
    } catch (err: unknown) {
      console.error('Failed to load TDengine topology:', err);
      setTopoError(err);
      setNodes([]);
      setEdges([]);
      setTableObjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (engine === 'tdengine') {
      void loadTDengineData();
    }
  }, [engine, loadTDengineData]);

  // Load detailed object for drawer when selected - strictly real data
  useEffect(() => {
    if (!selectedObjectId) {
      setSelectedObjectData(null);
      setDrawerError(null);
      return;
    }

    getStorageObject(selectedObjectId)
      .then((obj) => {
        const isDb = selectedObjectId.startsWith('db:') || selectedObjectId.startsWith('db/');
        const isStable = selectedObjectId.startsWith('stable:') || selectedObjectId.startsWith('stable/');
        const type: 'database' | 'stable' | 'subtable' = isDb ? 'database' : isStable ? 'stable' : 'subtable';
        setSelectedObjectData({ ...obj, object_type: type });
        setDrawerError(null);
      })
      .catch((err) => {
        console.error('Failed to load storage object detail:', err);
        setSelectedObjectData(null);
        setDrawerError(err);
      });
  }, [selectedObjectId]);

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-[#E3EAF3]">
        <div>
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#657794] mb-0.5">
            <span>Historian & Storage</span>
            <span>/</span>
            <span className="text-[#111B37] font-semibold">Storage Management</span>
          </div>
          <h1 className="text-[20px] font-bold text-[#111B37] leading-tight">Storage Management</h1>
          <p className="text-[13px] text-[#657794] mt-0.5">
            Manage physical TDengine databases, supertables, subtables, and their source bindings.
          </p>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-2.5">
          {/* Engine Switcher */}
          <StorageEngineSwitcher activeEngine={engine} onChange={setEngine} />

          {engine === 'tdengine' && (
            <>
              {/* Refresh button */}
              <button
                type="button"
                onClick={loadTDengineData}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#E3EAF3] rounded-lg text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC] shadow-xs transition-colors"
                title="Refresh physical metadata"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[#EF1B24]' : 'text-[#657794]'}`} />
                <span>Refresh</span>
              </button>

              {/* + New Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setNewMenuOpen(!newMenuOpen)}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 bg-[#EF1B24] hover:bg-[#DC2626] text-white rounded-lg text-[13px] font-bold shadow-xs transition-colors"
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
                      <Layers className="w-4 h-4 text-[#0284C7]" />
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
                      <Table className="w-4 h-4 text-[#7C3AED]" />
                      <div>
                        <div>Subtable</div>
                        <div className="text-[11px] font-normal text-[#657794]">Bind data sources to table</div>
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
            <StorageHealthStrip
              databaseCount={stats.databaseCount}
              stableCount={stats.stableCount}
              subtableCount={stats.subtableCount}
              recordingActive={stats.recordingActive}
              recordingPaused={stats.recordingPaused}
              recordingError={stats.recordingError}
              lastObservedAt={stats.lastObservedAt}
            />

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
          {topoError != null ? (
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
          ) : activeTab === 'topology' ? (
            <StorageObjectGraph
              nodes={nodes}
              edges={edges}
              selectedObjectId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onRefresh={loadTDengineData}
              loading={loading}
            />
          ) : (
            <StorageObjectsTable
              objects={tableObjects}
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
              onRefresh={loadTDengineData}
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
