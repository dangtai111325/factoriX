import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Database,
  Layers,
  Table,
  Search,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Edit,
  Plus,
  Play,
  Pause,
  Trash2,
  FileCode,
  Shield,
  Activity,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { TDDatabase, TDStable, TDSubtable, StorageObjectStatus } from '../../lib/storagePhysicalApi';

export interface StorageObjectRow {
  id: string;
  physical_name: string;
  display_name?: string | null;
  object_type: 'database' | 'stable' | 'subtable';
  parent_name?: string | null;
  parent_id?: string | null;
  column_count?: number;
  tag_count?: number;
  subtable_count?: number;
  binding_count?: number;
  last_verified_at?: string | null;
  status: StorageObjectStatus;
  write_active?: boolean;
}

interface StorageObjectsTableProps {
  objects: StorageObjectRow[];
  selectedObjectId?: string | null;
  onSelectObject: (objectId: string) => void;
  onRefresh: () => void;
  loading?: boolean;
}

export const StorageObjectsTable: React.FC<StorageObjectsTableProps> = ({
  objects,
  selectedObjectId,
  onSelectObject,
  onRefresh,
  loading = false,
}) => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  // Filter
  const filtered = useMemo(() => {
    return objects.filter((obj) => {
      if (typeFilter !== 'all' && obj.object_type !== typeFilter) return false;
      if (statusFilter !== 'all' && obj.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          obj.physical_name.toLowerCase().includes(q) ||
          (obj.display_name && obj.display_name.toLowerCase().includes(q)) ||
          (obj.parent_name && obj.parent_name.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [objects, typeFilter, statusFilter, search]);

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  const pagedItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page]);

  const getStatusBadge = (status: StorageObjectStatus, writeActive?: boolean) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#E8FAF0] text-[#0DBA67]">
            <CheckCircle2 className="w-3 h-3" />
            <span>Active</span>
          </span>
        );
      case 'DRAFT':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#F1F5F9] text-[#64748B]">
            Draft
          </span>
        );
      case 'OUT_OF_SYNC':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#FFFBEB] text-[#D97706]">
            <AlertCircle className="w-3 h-3" />
            <span>Sync</span>
          </span>
        );
      case 'ERROR':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#FEF2F2] text-[#EF1B24]">
            <AlertCircle className="w-3 h-3" />
            <span>Error</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-[#F1F5F9] text-[#64748B]">
            {status}
          </span>
        );
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'database':
        return <Database className="w-4 h-4 text-[#EF1B24]" />;
      case 'stable':
        return <Layers className="w-4 h-4 text-[#0284C7]" />;
      case 'subtable':
        return <Table className="w-4 h-4 text-[#7C3AED]" />;
      default:
        return <Database className="w-4 h-4 text-[#657794]" />;
    }
  };

  return (
    <div className="bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden">
      {/* Table toolbar */}
      <div className="p-4 border-b border-[#E3EAF3] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search table objects..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-9 pr-3 py-1.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[13px] text-[#111B37] placeholder-[#94A3B8] focus:outline-none focus:border-[#EF1B24] w-64"
            />
          </div>

          {/* Type filter */}
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[13px] font-medium text-[#111B37] focus:outline-none focus:border-[#EF1B24] cursor-pointer"
          >
            <option value="all">All Types</option>
            <option value="database">Databases</option>
            <option value="stable">Supertables</option>
            <option value="subtable">Subtables</option>
          </select>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[13px] font-medium text-[#111B37] focus:outline-none focus:border-[#EF1B24] cursor-pointer"
          >
            <option value="all">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="DRAFT">Draft</option>
            <option value="OUT_OF_SYNC">Out of Sync</option>
            <option value="ERROR">Error</option>
          </select>
        </div>

        <div className="text-[12px] text-[#657794]">
          Showing <span className="font-semibold text-[#111B37]">{filtered.length}</span> objects
        </div>
      </div>

      {/* Table view */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-[#F8FAFC] text-[12px] font-semibold text-[#657794] border-b border-[#E3EAF3]">
              <th className="py-3 px-4">Name</th>
              <th className="py-3 px-3">Type</th>
              <th className="py-3 px-3">Parent</th>
              <th className="py-3 px-3 text-right">Columns</th>
              <th className="py-3 px-3 text-right">Tags</th>
              <th className="py-3 px-3 text-right">Subtables</th>
              <th className="py-3 px-3 text-right">Bindings</th>
              <th className="py-3 px-3">Status</th>
              <th className="py-3 px-3">Last Verified</th>
              <th className="py-3 px-3 text-center w-12">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1F5FA] text-[13px]">
            {pagedItems.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-12 text-center text-[#657794]">
                  No storage objects matching filter.
                </td>
              </tr>
            ) : (
              pagedItems.map((obj) => (
                <tr
                  key={obj.id}
                  onClick={() => onSelectObject(obj.id)}
                  className={`hover:bg-[#F8FAFC] cursor-pointer transition-colors ${
                    selectedObjectId === obj.id ? 'bg-[#FEF2F2]/40' : ''
                  }`}
                >
                  <td className="py-3 px-4 font-semibold text-[#111B37]">
                    <div className="flex items-center gap-2">
                      {getTypeIcon(obj.object_type)}
                      <span className="hover:text-[#EF1B24] transition-colors">{obj.physical_name}</span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-[#657794] capitalize">{obj.object_type}</td>
                  <td className="py-3 px-3 text-[#657794]">{obj.parent_name || '—'}</td>
                  <td className="py-3 px-3 text-right font-medium text-[#111B37]">
                    {obj.column_count != null ? obj.column_count : '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-medium text-[#111B37]">
                    {obj.tag_count != null ? obj.tag_count : '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-medium text-[#111B37]">
                    {obj.subtable_count != null ? obj.subtable_count : '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-medium text-[#111B37]">
                    {obj.binding_count != null ? obj.binding_count : '—'}
                  </td>
                  <td className="py-3 px-3">{getStatusBadge(obj.status, obj.write_active)}</td>
                  <td className="py-3 px-3 text-[12px] text-[#94A3B8]">
                    {obj.last_verified_at ? new Date(obj.last_verified_at).toLocaleTimeString() : '—'}
                  </td>
                  <td
                    className="py-3 px-3 text-center relative"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === obj.id ? null : obj.id);
                    }}
                  >
                    <button
                      type="button"
                      className="p-1.5 rounded-lg text-[#657794] hover:text-[#111B37] hover:bg-[#EEF2F6]"
                      title="More actions"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {/* Context menu dropdown */}
                    {activeMenuId === obj.id && (
                      <div
                        className="absolute right-3 top-10 z-20 w-48 bg-white border border-[#E3EAF3] rounded-lg shadow-lg py-1 text-left"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setActiveMenuId(null);
                            navigate(`/historian/storage/object/${encodeURIComponent(obj.id)}`);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-[#657794]" />
                          <span>View Details</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveMenuId(null);
                            navigate(`/historian/storage/edit/${encodeURIComponent(obj.id)}`);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                        >
                          <Edit className="w-3.5 h-3.5 text-[#657794]" />
                          <span>Edit Schema</span>
                        </button>

                        {obj.object_type === 'database' && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null);
                              navigate(`/historian/storage/create?kind=stable&database=${encodeURIComponent(obj.physical_name)}`);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                          >
                            <Plus className="w-3.5 h-3.5 text-[#0284C7]" />
                            <span>New Supertable</span>
                          </button>
                        )}

                        {obj.object_type === 'stable' && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null);
                              navigate(`/historian/storage/create?kind=subtable&stable=${encodeURIComponent(obj.physical_name)}`);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                          >
                            <Plus className="w-3.5 h-3.5 text-[#7C3AED]" />
                            <span>New Subtable</span>
                          </button>
                        )}

                        <div className="border-t border-[#F1F5FA] my-1" />

                        <button
                          type="button"
                          onClick={() => {
                            setActiveMenuId(null);
                            onSelectObject(obj.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#DC2626] hover:bg-[#FEF2F2]"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Retire / Purge</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="p-3 border-t border-[#E3EAF3] flex items-center justify-between text-[12px] text-[#657794]">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1 rounded border border-[#E3EAF3] hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-1 rounded border border-[#E3EAF3] hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
