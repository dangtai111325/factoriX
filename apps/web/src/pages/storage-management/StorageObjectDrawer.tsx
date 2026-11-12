import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  ExternalLink,
  Edit,
  Database,
  Layers,
  Table,
  Columns,
  Tag,
  Link2,
  Clock,
  Play,
  Pause,
  Trash2,
  CheckCircle2,
  AlertCircle,
  FileCode,
  Shield,
  Activity,
  Layers2,
} from 'lucide-react';
import { TDDatabase, TDStable, TDSubtable, StorageObjectStatus } from '../../lib/storagePhysicalApi';

interface StorageObjectDrawerProps {
  object: (TDDatabase | TDStable | TDSubtable) & { object_type: 'database' | 'stable' | 'subtable' };
  onClose: () => void;
  onRefresh?: () => void;
}

export const StorageObjectDrawer: React.FC<StorageObjectDrawerProps> = ({
  object,
  onClose,
  onRefresh,
}) => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'overview' | 'columns' | 'bindings' | 'preview'>('overview');

  const stableObj = object.object_type === 'stable' ? (object as unknown as TDStable) : null;
  const subtableObj = object.object_type === 'subtable' ? (object as unknown as TDSubtable) : null;
  const dbObj = object.object_type === 'database' ? (object as unknown as TDDatabase) : null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[420px] bg-white border-l border-[#E3EAF3] shadow-xl flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="p-4 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F8FAFC]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 bg-white border border-[#E3EAF3] rounded-lg shadow-xs">
            {object.object_type === 'database' && <Database className="w-4 h-4 text-[#EF1B24]" />}
            {object.object_type === 'stable' && <Layers className="w-4 h-4 text-[#0284C7]" />}
            {object.object_type === 'subtable' && <Table className="w-4 h-4 text-[#7C3AED]" />}
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
              {object.object_type}
            </div>
            <div className="text-[14px] font-bold text-[#111B37] truncate" title={object.physical_name}>
              {object.physical_name}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate(`/historian/storage/object/${encodeURIComponent(object.id)}`)}
            className="p-1.5 text-[#657794] hover:text-[#111B37] hover:bg-white rounded-lg transition-colors"
            title="Open full detail view"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-[#657794] hover:text-[#111B37] hover:bg-white rounded-lg transition-colors"
            title="Close drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#E3EAF3] bg-white px-4 text-[13px]">
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`py-2.5 px-3 font-semibold border-b-2 transition-colors ${
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
            onClick={() => setActiveTab('columns')}
            className={`py-2.5 px-3 font-semibold border-b-2 transition-colors ${
              activeTab === 'columns'
                ? 'border-[#EF1B24] text-[#EF1B24]'
                : 'border-transparent text-[#657794] hover:text-[#111B37]'
            }`}
          >
            Columns & Tags
          </button>
        )}

        {subtableObj && (
          <button
            type="button"
            onClick={() => setActiveTab('bindings')}
            className={`py-2.5 px-3 font-semibold border-b-2 transition-colors ${
              activeTab === 'bindings'
                ? 'border-[#EF1B24] text-[#EF1B24]'
                : 'border-transparent text-[#657794] hover:text-[#111B37]'
            }`}
          >
            Bindings
          </button>
        )}

        <button
          type="button"
          onClick={() => setActiveTab('preview')}
          className={`py-2.5 px-3 font-semibold border-b-2 transition-colors ${
            activeTab === 'preview'
              ? 'border-[#EF1B24] text-[#EF1B24]'
              : 'border-transparent text-[#657794] hover:text-[#111B37]'
          }`}
        >
          Preview
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            {/* Status box */}
            <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg">
              <div className="text-[11px] font-semibold text-[#657794] uppercase mb-1">Status</div>
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-[#0DBA67]">
                  <CheckCircle2 className="w-4 h-4 text-[#0DBA67]" />
                  <span>{object.status}</span>
                </span>
                <span className="text-[11px] text-[#94A3B8]">
                  Observed {new Date(object.observed_at).toLocaleTimeString()}
                </span>
              </div>
            </div>

            {/* Properties grid */}
            <div className="grid grid-cols-2 gap-3 text-[12px]">
              {dbObj && (
                <>
                  <div className="p-2.5 bg-white border border-[#E3EAF3] rounded-lg">
                    <div className="text-[#657794] text-[11px]">Precision</div>
                    <div className="font-semibold text-[#111B37] mt-0.5">{dbObj.precision}</div>
                  </div>
                  <div className="p-2.5 bg-white border border-[#E3EAF3] rounded-lg">
                    <div className="text-[#657794] text-[11px]">Retention</div>
                    <div className="font-semibold text-[#111B37] mt-0.5">
                      {dbObj.retention_days ? `${dbObj.retention_days} days` : 'Unlimited'}
                    </div>
                  </div>
                </>
              )}

              {stableObj && (
                <>
                  <div className="p-2.5 bg-white border border-[#E3EAF3] rounded-lg">
                    <div className="text-[#657794] text-[11px]">Database</div>
                    <div className="font-semibold text-[#111B37] mt-0.5 truncate">{stableObj.database_name}</div>
                  </div>
                  <div className="p-2.5 bg-white border border-[#E3EAF3] rounded-lg">
                    <div className="text-[#657794] text-[11px]">Subtables</div>
                    <div className="font-semibold text-[#0284C7] mt-0.5">{stableObj.subtable_count}</div>
                  </div>
                </>
              )}

              {subtableObj && (
                <>
                  <div className="p-2.5 bg-white border border-[#E3EAF3] rounded-lg">
                    <div className="text-[#657794] text-[11px]">Parent Supertable</div>
                    <div className="font-semibold text-[#111B37] mt-0.5 truncate">{subtableObj.stable_name}</div>
                  </div>
                  <div className="p-2.5 bg-white border border-[#E3EAF3] rounded-lg">
                    <div className="text-[#657794] text-[11px]">Row Assembly</div>
                    <div className="font-semibold text-[#7C3AED] mt-0.5 truncate">
                      {subtableObj.row_assembly_policy || 'INDEPENDENT_EVENTS'}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Description */}
            {object.description && (
              <div className="p-3 bg-white border border-[#E3EAF3] rounded-lg">
                <div className="text-[11px] font-semibold text-[#657794] uppercase mb-1">Description</div>
                <div className="text-[12px] text-[#334155]">{object.description}</div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'columns' && stableObj && (
          <div className="space-y-4">
            <div>
              <div className="text-[12px] font-bold text-[#111B37] mb-2 flex items-center gap-1.5">
                <Columns className="w-3.5 h-3.5 text-[#0284C7]" />
                <span>Columns ({stableObj.columns?.length || 0})</span>
              </div>
              <div className="border border-[#E3EAF3] rounded-lg divide-y divide-[#F1F5FA] overflow-hidden text-[12px]">
                {stableObj.columns?.map((col) => (
                  <div key={col.name} className="px-3 py-2 flex items-center justify-between">
                    <div>
                      <span className="font-semibold text-[#111B37]">{col.name}</span>
                      {col.immutable && (
                        <span className="ml-1.5 px-1 py-0.2 bg-[#FEF2F2] text-[#EF1B24] rounded text-[9px] font-bold">
                          PRIMARY TS
                        </span>
                      )}
                    </div>
                    <span className="text-[#657794] font-mono text-[11px]">{col.td_type}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-[12px] font-bold text-[#111B37] mb-2 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-[#0284C7]" />
                <span>Tags ({stableObj.tags?.length || 0})</span>
              </div>
              <div className="border border-[#E3EAF3] rounded-lg divide-y divide-[#F1F5FA] overflow-hidden text-[12px]">
                {stableObj.tags?.map((tag) => (
                  <div key={tag.name} className="px-3 py-2 flex items-center justify-between">
                    <span className="font-semibold text-[#111B37]">{tag.name}</span>
                    <span className="text-[#657794] font-mono text-[11px]">{tag.td_type}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'bindings' && subtableObj && (
          <div className="space-y-2">
            <div className="text-[12px] font-bold text-[#111B37] mb-2 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-[#7C3AED]" />
              <span>Source Bindings ({subtableObj.bindings?.length || 0})</span>
            </div>
            {subtableObj.bindings?.length === 0 ? (
              <div className="p-4 text-center text-[12px] text-[#657794] border border-[#E3EAF3] rounded-lg">
                No active source bindings configured.
              </div>
            ) : (
              subtableObj.bindings?.map((binding) => (
                <div key={binding.id} className="p-2.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[12px]">
                  <div className="flex items-center justify-between font-semibold text-[#111B37] mb-1">
                    <span>{binding.destination_column}</span>
                    <span className="text-[10px] px-1.5 py-0.2 bg-[#E8FAF0] text-[#0DBA67] rounded font-bold">
                      {binding.status}
                    </span>
                  </div>
                  <div className="text-[#657794] text-[11px] truncate">
                    Source: <span className="font-mono text-[#334155]">{binding.source_path}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'preview' && (
          <div className="p-3 bg-[#111B37] text-white rounded-lg font-mono text-[11px] overflow-x-auto">
            {object.object_type === 'database' && (
              <div>CREATE DATABASE IF NOT EXISTS `{object.physical_name}` PRECISION 'ms';</div>
            )}
            {object.object_type === 'stable' && stableObj && (
              <div>
                CREATE STABLE `{stableObj.database_name}`.`{stableObj.physical_name}` (
                <br />
                &nbsp;&nbsp;ts TIMESTAMP,
                <br />
                {stableObj.columns
                  ?.filter((c) => c.name !== 'ts')
                  .map((c) => `  ${c.name} ${c.td_type}`)
                  .join(',\n')}
                <br />) TAGS (
                <br />
                {stableObj.tags?.map((t) => `  ${t.name} ${t.td_type}`).join(',\n')}
                <br />);
              </div>
            )}
            {object.object_type === 'subtable' && subtableObj && (
              <div>
                CREATE TABLE `{subtableObj.physical_name}` USING `{subtableObj.stable_name}` TAGS (
                {subtableObj.tag_values?.map((t) => `'${t.value || ''}'`).join(', ')});
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="p-3 border-t border-[#E3EAF3] bg-[#F8FAFC] flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(`/historian/storage/edit/${encodeURIComponent(object.id)}`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E3EAF3] bg-white text-[12px] font-semibold text-[#111B37] hover:bg-[#F1F5FA] shadow-xs"
        >
          <Edit className="w-3.5 h-3.5 text-[#657794]" />
          <span>Edit Schema</span>
        </button>

        {object.object_type === 'subtable' && (
          <button
            type="button"
            onClick={() => navigate(`/historian/historian?source_id=${encodeURIComponent(object.id)}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EF1B24] text-white text-[12px] font-semibold hover:bg-[#DC2626] shadow-xs"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Open in Historian</span>
          </button>
        )}
      </div>
    </div>
  );
};
