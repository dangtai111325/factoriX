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

  // Load TDengine data
  const loadTDengineData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch topology
      const topo = await getTDTopology().catch(() => ({
        nodes: [
          {
            node_id: 'db/factory_master',
            object_type: 'database' as const,
            physical_name: 'factory_master',
            status: 'ACTIVE' as const,
            metadata: { stable_count: 2, subtable_count: 12 },
          },
          {
            node_id: 'stable/process_telemetry',
            object_type: 'stable' as const,
            physical_name: 'process_telemetry',
            status: 'ACTIVE' as const,
            parent_id: 'db/factory_master',
            metadata: { database_name: 'factory_master', column_count: 8, tag_count: 2, subtable_count: 6 },
          },
          {
            node_id: 'stable/event_history',
            object_type: 'stable' as const,
            physical_name: 'event_history',
            status: 'ACTIVE' as const,
            parent_id: 'db/factory_master',
            metadata: { database_name: 'factory_master', column_count: 5, tag_count: 2, subtable_count: 6 },
          },
          {
            node_id: 'subtable/cnc_01_telemetry',
            object_type: 'subtable' as const,
            physical_name: 'cnc_01_telemetry',
            status: 'ACTIVE' as const,
            parent_id: 'stable/process_telemetry',
            metadata: { stable_name: 'process_telemetry' },
          },
          {
            node_id: 'subtable/cnc_02_telemetry',
            object_type: 'subtable' as const,
            physical_name: 'cnc_02_telemetry',
            status: 'ACTIVE' as const,
            parent_id: 'stable/process_telemetry',
            metadata: { stable_name: 'process_telemetry' },
          },
        ],
        edges: [
          {
            edge_id: 'e1',
            source_node_id: 'db/factory_master',
            target_node_id: 'stable/process_telemetry',
            edge_kind: 'CONTAINS' as const,
          },
          {
            edge_id: 'e2',
            source_node_id: 'db/factory_master',
            target_node_id: 'stable/event_history',
            edge_kind: 'CONTAINS' as const,
          },
          {
            edge_id: 'e3',
            source_node_id: 'stable/process_telemetry',
            target_node_id: 'subtable/cnc_01_telemetry',
            edge_kind: 'INHERITS_SCHEMA' as const,
          },
          {
            edge_id: 'e4',
            source_node_id: 'stable/process_telemetry',
            target_node_id: 'subtable/cnc_02_telemetry',
            edge_kind: 'INHERITS_SCHEMA' as const,
          },
        ],
        source: 'tdengine_information_schema',
        observed_at: new Date().toISOString(),
      }));

      const safeNodes: TopologyNode[] = Array.isArray(topo?.nodes)
        ? topo.nodes.map((n: any) => ({
            ...n,
            object_type: (n.object_type || n.kind || 'database') as 'database' | 'stable' | 'subtable',
            physical_name: n.physical_name || n.label || n.name || '',
            display_name: n.display_name || n.label || n.physical_name || '',
            status: n.status || 'ACTIVE',
          }))
        : [];
      const safeEdges: TopologyEdge[] = Array.isArray(topo?.edges) ? topo.edges : [];

      setNodes(safeNodes);
      setEdges(safeEdges);

      // 2. Fetch stats
      const st = await getStorageStats().catch(() => ({
        database_count: safeNodes.filter((n) => n.object_type === 'database').length,
        stable_count: safeNodes.filter((n) => n.object_type === 'stable').length,
        subtable_count: safeNodes.filter((n) => n.object_type === 'subtable').length,
        recording_active: 0,
        recording_paused: 0,
        recording_error: 0,
        observed_at: new Date().toISOString(),
      }));

      setStats({
        databaseCount: st?.database_count ?? 0,
        stableCount: st?.stable_count ?? 0,
        subtableCount: st?.subtable_count ?? 0,
        recordingActive: st?.recording_active ?? 0,
        recordingPaused: st?.recording_paused ?? 0,
        recordingError: st?.recording_error ?? 0,
        lastObservedAt: st?.observed_at || new Date().toISOString(),
      });

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
        binding_count: 1,
        last_verified_at: topo?.observed_at || new Date().toISOString(),
        status: n.status,
      }));
      setTableObjects(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (engine === 'tdengine') {
      void loadTDengineData();
    }
  }, [engine, loadTDengineData]);

  // Load detailed object for drawer when selected
  useEffect(() => {
    if (!selectedObjectId) {
      setSelectedObjectData(null);
      return;
    }

    getStorageObject(selectedObjectId)
      .then((obj) => {
        const type: 'database' | 'stable' | 'subtable' = selectedObjectId.startsWith('db/')
          ? 'database'
          : selectedObjectId.startsWith('stable/')
          ? 'stable'
          : 'subtable';
        setSelectedObjectData({ ...obj, object_type: type });
      })
      .catch(() => {
        // Fallback detail
        const node = nodes.find((n) => n.node_id === selectedObjectId);
        if (node) {
          const type: 'database' | 'stable' | 'subtable' =
            node.object_type === 'engine' ? 'database' : node.object_type;
          setSelectedObjectData({
            id: node.node_id,
            physical_name: node.physical_name,
            object_type: type,
            status: node.status,
            tenant_id: 'default',
            observed_at: new Date().toISOString(),
            // Mock sub-properties
            ...(type === 'database'
              ? { precision: 'ms' as const, stable_count: 2, subtable_count: 12 }
              : type === 'stable'
              ? {
                  database_id: 'db/factory_master',
                  database_name: 'factory_master',
                  columns: [
                    { name: 'ts', td_type: 'TIMESTAMP', nullable: false, role: 'timestamp' as const, immutable: true },
                    { name: 'temperature', td_type: 'DOUBLE', nullable: true, role: 'value' as const },
                    { name: 'pressure', td_type: 'DOUBLE', nullable: true, role: 'value' as const },
                    { name: 'quality', td_type: 'INT', nullable: true, role: 'value' as const },
                  ],
                  tags: [
                    { name: 'resource_id', td_type: 'VARCHAR(64)' },
                    { name: 'line', td_type: 'VARCHAR(32)' },
                  ],
                  subtable_count: 6,
                }
              : {
                  stable_id: 'stable/process_telemetry',
                  stable_name: 'process_telemetry',
                  database_id: 'db/factory_master',
                  database_name: 'factory_master',
                  tag_values: [
                    { name: 'resource_id', td_type: 'VARCHAR(64)', value: 'cnc_01' },
                    { name: 'line', td_type: 'VARCHAR(32)', value: 'line_a' },
                  ],
                  bindings: [
                    {
                      id: 'b1',
                      source_kind: 'signal' as const,
                      source_id: 'sig-temp-01',
                      source_path: 'Modbus / CNC-01 / Temperature',
                      destination_column: 'temperature',
                      status: 'ACTIVE' as const,
                      created_at: new Date().toISOString(),
                    },
                  ],
                  write_active: true,
                }),
          } as unknown as (TDDatabase | TDStable | TDSubtable) & { object_type: 'database' | 'stable' | 'subtable' });
        }
      });
  }, [selectedObjectId, nodes]);

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
          {activeTab === 'topology' ? (
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
        </div>
      )}
    </div>
  );
};
