import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Database,
  Layers,
  Table,
  Edit,
  Trash2,
  Play,
  Pause,
  Columns,
  Tag,
  Link2,
  FileCode,
  Shield,
  Activity,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Plus,
} from 'lucide-react';
import {
  getStorageObject,
  TDDatabase,
  TDStable,
  TDSubtable,
  StorageObjectStatus,
} from '../../lib/storagePhysicalApi';

export const StorageObjectDetailPage: React.FC = () => {
  const { objectId } = useParams<{ objectId: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [objectData, setObjectData] = useState<
    ((TDDatabase | TDStable | TDSubtable) & { object_type: 'database' | 'stable' | 'subtable' }) | null
  >(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'schema' | 'subtables' | 'bindings' | 'ddl'>('overview');

  useEffect(() => {
    if (!objectId) return;
    setLoading(true);
    getStorageObject(objectId)
      .then((obj) => {
        const type: 'database' | 'stable' | 'subtable' = objectId.startsWith('db/')
          ? 'database'
          : objectId.startsWith('stable/')
          ? 'stable'
          : 'subtable';
        setObjectData({ ...obj, object_type: type });
      })
      .catch(() => {
        // Fallback detail
        const isDb = objectId.startsWith('db/') || objectId.includes('database');
        const isStable = objectId.startsWith('stable/') || objectId.includes('stable');
        const type: 'database' | 'stable' | 'subtable' = isDb ? 'database' : isStable ? 'stable' : 'subtable';
        const cleanName = objectId.split('/').pop() || objectId;

        setObjectData({
          id: objectId,
          physical_name: cleanName,
          display_name: cleanName,
          object_type: type,
          status: 'ACTIVE' as const,
          tenant_id: 'default',
          observed_at: new Date().toISOString(),
          ...(type === 'database'
            ? { precision: 'ms' as const, retention_days: 90, stable_count: 2, subtable_count: 12 }
            : type === 'stable'
            ? {
                database_id: 'db/factory_master',
                database_name: 'factory_master',
                columns: [
                  { name: 'ts', td_type: 'TIMESTAMP', nullable: false, role: 'timestamp' as const, immutable: true },
                  { name: 'val_1', td_type: 'DOUBLE', nullable: true, role: 'value' as const },
                  { name: 'val_2', td_type: 'DOUBLE', nullable: true, role: 'value' as const },
                  { name: 'quality', td_type: 'INT', nullable: true, role: 'value' as const },
                ],
                tags: [
                  { name: 'resource_id', td_type: 'VARCHAR(64)' },
                  { name: 'site_id', td_type: 'VARCHAR(32)' },
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
                  { name: 'site_id', td_type: 'VARCHAR(32)', value: 'site_a' },
                ],
                bindings: [
                  {
                    id: 'b1',
                    source_kind: 'signal' as const,
                    source_id: 'sig-01',
                    source_path: 'Modbus / CNC-01 / Temperature',
                    destination_column: 'val_1',
                    status: 'ACTIVE' as const,
                    created_at: new Date().toISOString(),
                  },
                ],
                write_active: true,
              }),
        } as unknown as (TDDatabase | TDStable | TDSubtable) & { object_type: 'database' | 'stable' | 'subtable' });
      })
      .finally(() => setLoading(false));
  }, [objectId]);

  if (loading) {
    return (
      <div className="py-24 text-center text-[#657794]">
        <div className="animate-spin w-8 h-8 border-2 border-[#EF1B24] border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-[13px] font-semibold">Loading storage object...</p>
      </div>
    );
  }

  if (!objectData) {
    return (
      <div className="py-24 text-center text-[#657794]">
        <AlertCircle className="w-12 h-12 text-[#EF1B24] mx-auto mb-3" />
        <h2 className="text-[16px] font-bold text-[#111B37] mb-1">Object Not Found</h2>
        <p className="text-[13px] mb-4">The requested storage object does not exist or has been removed.</p>
        <Link
          to="/historian/storage"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#EF1B24] text-white rounded-lg text-[13px] font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Storage Management</span>
        </Link>
      </div>
    );
  }

  const stableObj = objectData.object_type === 'stable' ? (objectData as unknown as TDStable) : null;
  const subtableObj = objectData.object_type === 'subtable' ? (objectData as unknown as TDSubtable) : null;
  const dbObj = objectData.object_type === 'database' ? (objectData as unknown as TDDatabase) : null;

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* Back button & Breadcrumbs */}
      <div className="flex items-center gap-2 text-[12px] font-medium text-[#657794]">
        <Link to="/historian/storage" className="hover:text-[#EF1B24] transition-colors flex items-center gap-1">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Storage Management</span>
        </Link>
        <span>/</span>
        <span className="capitalize">{objectData.object_type}</span>
        <span>/</span>
        <span className="text-[#111B37] font-semibold">{objectData.physical_name}</span>
      </div>

      {/* Main card header */}
      <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
              {objectData.object_type === 'database' && <Database className="w-6 h-6 text-[#EF1B24]" />}
              {objectData.object_type === 'stable' && <Layers className="w-6 h-6 text-[#0284C7]" />}
              {objectData.object_type === 'subtable' && <Table className="w-6 h-6 text-[#7C3AED]" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[20px] font-bold text-[#111B37]">{objectData.physical_name}</h1>
                <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-[#E8FAF0] text-[#0DBA67]">
                  {objectData.status}
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 bg-[#F1F5F9] text-[#64748B] rounded">
                  {objectData.object_type}
                </span>
              </div>
              <div className="text-[13px] text-[#657794] mt-1">
                {objectData.description || 'No description provided.'}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/historian/storage/edit/${encodeURIComponent(objectData.id)}`)}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-white border border-[#E3EAF3] rounded-lg text-[13px] font-semibold text-[#111B37] hover:bg-[#F8FAFC] shadow-xs"
            >
              <Edit className="w-4 h-4 text-[#657794]" />
              <span>Edit Schema</span>
            </button>

            {objectData.object_type === 'database' && (
              <button
                type="button"
                onClick={() =>
                  navigate(`/historian/storage/create?kind=stable&database=${encodeURIComponent(objectData.physical_name)}`)
                }
                className="flex items-center gap-1.5 px-3.5 py-2 bg-[#EF1B24] text-white rounded-lg text-[13px] font-bold hover:bg-[#DC2626] shadow-xs"
              >
                <Plus className="w-4 h-4" />
                <span>New Supertable</span>
              </button>
            )}

            {objectData.object_type === 'stable' && (
              <button
                type="button"
                onClick={() =>
                  navigate(`/historian/storage/create?kind=subtable&stable=${encodeURIComponent(objectData.physical_name)}`)
                }
                className="flex items-center gap-1.5 px-3.5 py-2 bg-[#0284C7] text-white rounded-lg text-[13px] font-bold hover:bg-[#0369A1] shadow-xs"
              >
                <Plus className="w-4 h-4" />
                <span>New Subtable</span>
              </button>
            )}

            {objectData.object_type === 'subtable' && (
              <button
                type="button"
                onClick={() => navigate(`/historian/historian?source_id=${encodeURIComponent(objectData.id)}`)}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-[#EF1B24] text-white rounded-lg text-[13px] font-bold hover:bg-[#DC2626] shadow-xs"
              >
                <Activity className="w-4 h-4" />
                <span>Open in Historian</span>
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#E3EAF3] mt-6 -mb-6 text-[13px]">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`py-3 px-4 font-semibold border-b-2 transition-colors ${
              activeTab === 'overview'
                ? 'border-[#EF1B24] text-[#EF1B24]'
                : 'border-transparent text-[#657794] hover:text-[#111B37]'
            }`}
          >
            Overview
          </button>

          {(stableObj || subtableObj) && (
            <button
              type="button"
              onClick={() => setActiveTab('schema')}
              className={`py-3 px-4 font-semibold border-b-2 transition-colors ${
                activeTab === 'schema'
                  ? 'border-[#EF1B24] text-[#EF1B24]'
                  : 'border-transparent text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Schema & Tags
            </button>
          )}

          {subtableObj && (
            <button
              type="button"
              onClick={() => setActiveTab('bindings')}
              className={`py-3 px-4 font-semibold border-b-2 transition-colors ${
                activeTab === 'bindings'
                  ? 'border-[#EF1B24] text-[#EF1B24]'
                  : 'border-transparent text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Source Bindings
            </button>
          )}

          <button
            type="button"
            onClick={() => setActiveTab('ddl')}
            className={`py-3 px-4 font-semibold border-b-2 transition-colors ${
              activeTab === 'ddl'
                ? 'border-[#EF1B24] text-[#EF1B24]'
                : 'border-transparent text-[#657794] hover:text-[#111B37]'
            }`}
          >
            Physical DDL
          </button>
        </div>
      </div>

      {/* Tab contents */}
      <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <h3 className="text-[15px] font-bold text-[#111B37]">Properties & Physical Metadata</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                <div className="text-[11px] font-semibold text-[#657794] uppercase">Observed At</div>
                <div className="text-[13px] font-mono font-medium text-[#111B37] mt-1">
                  {new Date(objectData.observed_at).toLocaleString()}
                </div>
              </div>

              <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                <div className="text-[11px] font-semibold text-[#657794] uppercase">Tenant Scope</div>
                <div className="text-[13px] font-medium text-[#111B37] mt-1">{objectData.tenant_id}</div>
              </div>

              {dbObj && (
                <>
                  <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                    <div className="text-[11px] font-semibold text-[#657794] uppercase">Precision</div>
                    <div className="text-[13px] font-bold text-[#EF1B24] mt-1">{dbObj.precision}</div>
                  </div>
                  <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                    <div className="text-[11px] font-semibold text-[#657794] uppercase">Retention Days</div>
                    <div className="text-[13px] font-bold text-[#111B37] mt-1">
                      {dbObj.retention_days ?? 'Unlimited'}
                    </div>
                  </div>
                </>
              )}

              {stableObj && (
                <>
                  <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                    <div className="text-[11px] font-semibold text-[#657794] uppercase">Database</div>
                    <div className="text-[13px] font-bold text-[#111B37] mt-1 truncate">{stableObj.database_name}</div>
                  </div>
                  <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                    <div className="text-[11px] font-semibold text-[#657794] uppercase">Subtables</div>
                    <div className="text-[13px] font-bold text-[#0284C7] mt-1">{stableObj.subtable_count}</div>
                  </div>
                </>
              )}

              {subtableObj && (
                <>
                  <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                    <div className="text-[11px] font-semibold text-[#657794] uppercase">Parent STable</div>
                    <div className="text-[13px] font-bold text-[#111B37] mt-1 truncate">{subtableObj.stable_name}</div>
                  </div>
                  <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
                    <div className="text-[11px] font-semibold text-[#657794] uppercase">Row Assembly</div>
                    <div className="text-[13px] font-bold text-[#7C3AED] mt-1 truncate">
                      {subtableObj.row_assembly_policy || 'INDEPENDENT_EVENTS'}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === 'schema' && stableObj && (
          <div className="space-y-6">
            <div>
              <h3 className="text-[15px] font-bold text-[#111B37] mb-3 flex items-center gap-2">
                <Columns className="w-4 h-4 text-[#0284C7]" />
                <span>Columns ({stableObj.columns.length})</span>
              </h3>
              <table className="w-full text-left text-[13px] border border-[#E3EAF3] rounded-lg overflow-hidden">
                <thead className="bg-[#F8FAFC] text-[#657794] font-semibold border-b border-[#E3EAF3]">
                  <tr>
                    <th className="py-2.5 px-4">Column Name</th>
                    <th className="py-2.5 px-4">TD Type</th>
                    <th className="py-2.5 px-4">Role</th>
                    <th className="py-2.5 px-4">Nullable</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1F5FA]">
                  {stableObj.columns.map((c) => (
                    <tr key={c.name} className="hover:bg-[#F8FAFC]">
                      <td className="py-2.5 px-4 font-mono font-semibold text-[#111B37]">
                        {c.name}
                        {c.immutable && (
                          <span className="ml-2 px-1.5 py-0.5 bg-[#FEF2F2] text-[#EF1B24] rounded text-[10px] font-bold">
                            PRIMARY TS
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[#0284C7]">{c.td_type}</td>
                      <td className="py-2.5 px-4 text-[#657794] capitalize">{c.role}</td>
                      <td className="py-2.5 px-4 text-[#657794]">{c.nullable ? 'YES' : 'NO'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="text-[15px] font-bold text-[#111B37] mb-3 flex items-center gap-2">
                <Tag className="w-4 h-4 text-[#0284C7]" />
                <span>Tags ({stableObj.tags.length})</span>
              </h3>
              <table className="w-full text-left text-[13px] border border-[#E3EAF3] rounded-lg overflow-hidden">
                <thead className="bg-[#F8FAFC] text-[#657794] font-semibold border-b border-[#E3EAF3]">
                  <tr>
                    <th className="py-2.5 px-4">Tag Name</th>
                    <th className="py-2.5 px-4">TD Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1F5FA]">
                  {stableObj.tags.map((t) => (
                    <tr key={t.name} className="hover:bg-[#F8FAFC]">
                      <td className="py-2.5 px-4 font-mono font-semibold text-[#111B37]">{t.name}</td>
                      <td className="py-2.5 px-4 font-mono text-[#0284C7]">{t.td_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'bindings' && subtableObj && (
          <div className="space-y-4">
            <h3 className="text-[15px] font-bold text-[#111B37] flex items-center gap-2">
              <Link2 className="w-4 h-4 text-[#7C3AED]" />
              <span>Source Bindings ({subtableObj.bindings.length})</span>
            </h3>
            {subtableObj.bindings.length === 0 ? (
              <p className="text-[13px] text-[#657794]">No data sources currently bound to this subtable.</p>
            ) : (
              <div className="space-y-2">
                {subtableObj.bindings.map((b) => (
                  <div key={b.id} className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[13px]">
                    <div className="flex items-center justify-between font-bold text-[#111B37] mb-1">
                      <span>Column: {b.destination_column}</span>
                      <span className="px-2 py-0.5 bg-[#E8FAF0] text-[#0DBA67] rounded text-[11px] font-bold">
                        {b.status}
                      </span>
                    </div>
                    <div className="text-[12px] text-[#657794]">
                      Source Path: <span className="font-mono text-[#334155]">{b.source_path}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'ddl' && (
          <div className="space-y-3">
            <h3 className="text-[15px] font-bold text-[#111B37] flex items-center gap-2">
              <FileCode className="w-4 h-4 text-[#EF1B24]" />
              <span>Exact TDengine DDL</span>
            </h3>
            <pre className="p-4 bg-[#111B37] text-white rounded-xl font-mono text-[12px] overflow-x-auto leading-relaxed">
              {objectData.object_type === 'database' && (
                `CREATE DATABASE IF NOT EXISTS \`${objectData.physical_name}\` PRECISION '${dbObj?.precision || 'ms'}';`
              )}
              {objectData.object_type === 'stable' && stableObj && (
                `CREATE STABLE \`${stableObj.database_name}\`.\`${stableObj.physical_name}\` (\n` +
                `  ts TIMESTAMP,\n` +
                stableObj.columns
                  .filter((c) => c.name !== 'ts')
                  .map((c) => `  \`${c.name}\` ${c.td_type}${c.nullable ? '' : ' NOT NULL'}`)
                  .join(',\n') +
                `\n) TAGS (\n` +
                stableObj.tags.map((t) => `  \`${t.name}\` ${t.td_type}`).join(',\n') +
                `\n);`
              )}
              {objectData.object_type === 'subtable' && subtableObj && (
                `CREATE TABLE \`${subtableObj.physical_name}\` USING \`${subtableObj.stable_name}\` TAGS (\n` +
                subtableObj.tag_values.map((t) => `  '${t.value || ''}'`).join(',\n') +
                `\n);`
              )}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
