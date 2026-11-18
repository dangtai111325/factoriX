import React, { useEffect, useState } from 'react';
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
import { getTDStorageCatalog, StorageCatalogRow, StorageObjectStatus } from '../../lib/storagePhysicalApi';
import { StorageLifecycleDialog, LifecycleTarget, lifecycleTargetOf, isProtectedTarget } from './StorageLifecycleDialog';
import { RemoteErrorState, RemoteLoadingState } from '../../components/common/RemoteResourceState';

const PAGE_SIZE = 15;

interface StorageObjectsTableProps {
  selectedObjectId?: string | null;
  onSelectObject: (objectId: string) => void;
  onRefresh: () => void;
  refreshVersion: number;
  onLoadingChange: (loading: boolean) => void;
}

export const StorageObjectsTable: React.FC<StorageObjectsTableProps> = ({
  selectedObjectId,
  onSelectObject,
  onRefresh,
  refreshVersion,
  onLoadingChange,
}) => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<StorageCatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Row menus close on outside click and Escape (R1-23).
  useEffect(() => {
    if (!activeMenuId) return;
    const close = () => setActiveMenuId(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); };
  }, [activeMenuId]);

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

  const getStatusBadge = (status: StorageObjectStatus) => {
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
        return <Layers className="w-4 h-4 text-[#657794]" />;
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
              maxLength={200}
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
            aria-label="Object type"
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
            aria-label="Object status"
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

        {!loading && !error && (
          <div className="text-[12px] text-[#657794]" role="status">
            <span className="font-semibold text-[#111B37]">{total}</span> matching objects
          </div>
        )}
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
            {loading || error || items.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-12 text-center text-[#657794]">
                  {loading ? <RemoteLoadingState subject="storage objects" /> : error ? (
                    <RemoteErrorState error={error} subject="Storage objects" onRetry={onRefresh} />
                  ) : 'No storage objects match these filters.'}
                </td>
              </tr>
            ) : (
              items.map((obj) => (
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
                      <span className="hover:text-[#EF1B24] transition-colors" title={obj.physical_name}>
                        {obj.display_name || obj.physical_name}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-[#657794] capitalize">
                    {obj.object_type === 'stable' ? 'Supertable' : obj.object_type}
                  </td>
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
                  <td className="py-3 px-3">{getStatusBadge(obj.status)}</td>
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

                        {!isProtectedTarget(lifecycleTargetOf(obj.id)) && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null);
                              navigate(`/historian/storage/edit/${encodeURIComponent(obj.id)}`);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                          >
                            <Edit className="w-3.5 h-3.5 text-[#657794]" />
                            <span>Edit details</span>
                          </button>
                        )}

                        {obj.object_type === 'subtable' && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null);
                              navigate(`/historian/historian?source_id=${encodeURIComponent(obj.id)}&kind=subtable&range=24h`);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                          >
                            <Activity className="w-3.5 h-3.5 text-[#657794]" />
                            <span>Open in Historian</span>
                          </button>
                        )}

                        {obj.object_type === 'database' && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveMenuId(null);
                              navigate(`/historian/storage/create?kind=stable&database=${encodeURIComponent(obj.physical_name)}`);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                          >
                            <Plus className="w-3.5 h-3.5 text-[#657794]" />
                            <span>New Supertable</span>
                          </button>
                        )}

                        {obj.object_type === 'stable' && !isProtectedTarget(lifecycleTargetOf(obj.id)) && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveMenuId(null);
                                navigate(`/historian/storage/create?kind=subtable&stable=${encodeURIComponent(obj.id.replace(/^stable:/, ''))}`);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                            >
                              <Plus className="w-3.5 h-3.5 text-[#657794]" />
                              <span>New Subtable</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveMenuId(null);
                                navigate(`/historian/storage/bulk?stable=${encodeURIComponent(obj.id.replace(/^stable:/, ''))}`);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#111B37] hover:bg-[#F8FAFC]"
                            >
                              <Plus className="w-3.5 h-3.5 text-[#657794]" />
                              <span>Subtables from Data Models</span>
                            </button>
                          </>
                        )}

                        <div className="border-t border-[#F1F5FA] my-1" />

                        <button
                          type="button"
                          onClick={() => {
                            setActiveMenuId(null);
                            setLifecycle(lifecycleTargetOf(obj.id, obj.status));
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#F2343B] hover:bg-[#FFF0F1]"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>{isProtectedTarget(lifecycleTargetOf(obj.id)) ? 'System object (read-only)' : 'Pause / Retire / Delete'}</span>
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
      {!loading && !error && totalPages > 1 && (
        <div className="p-3 border-t border-[#E3EAF3] flex items-center justify-between text-[12px] text-[#657794]">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1 rounded border border-[#E3EAF3] hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Next page"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-1 rounded border border-[#E3EAF3] hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div role="status" className="mt-2 px-3 py-2 rounded-lg border border-[#E3EAF3] bg-white text-[12px] text-[#334568] flex justify-between">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-[#657794]">Dismiss</button>
        </div>
      )}
      {lifecycle && (
        <StorageLifecycleDialog
          target={lifecycle}
          onClose={() => setLifecycle(null)}
          onDone={(msg) => { setLifecycle(null); setNotice(msg); onRefresh(); }}
        />
      )}
    </div>
  );
};
