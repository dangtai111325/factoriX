import React, { useState, useMemo } from 'react';
import {
  Server,
  RefreshCw,
  MoreVertical,
  KeyRound,
  Edit2,
  Trash2,
  AlertTriangle,
  Copy,
  Check,
  ShieldAlert,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { StatusBadge } from '../../components/common/StatusBadge';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { api, ApiError } from '../../api/client';

function timeAgo(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 0 || isNaN(diffSec)) return 'just now';
  if (diffSec < 60) return `${diffSec} s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;
  return `${Math.floor(diffHour / 24)} d ago`;
}

function formatShortTime(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const EdgesPage: React.FC = () => {
  const { edges, resources, connections, refresh } = useApp();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modals & Dialog state
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  const [tokenModal, setTokenModal] = useState<{
    edgeName: string;
    token: string;
    expiresAt: string;
  } | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const [reEnrollConfirmTarget, setReEnrollConfirmTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<{ id: string; name: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Helper to find real site name
  const siteName = (siteId?: string) => {
    if (!siteId) return '—';
    const directSite = resources.find((r) => r.id === siteId || (r.type === 'site' && r.attributes?.siteId === siteId));
    if (directSite) return directSite.name;
    const byId = resources.find((r) => r.id === siteId);
    return byId?.name || siteId || '—';
  };

  const handleRefresh = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      await refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to refresh edges');
    } finally {
      setLoading(false);
    }
  };

  // Rename
  const handleStartRename = (edge: { id: string; name: string }) => {
    setRenameTarget(edge);
    setRenameValue(edge.name);
    setActiveMenuId(null);
  };

  const handleSaveRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setRenameSaving(true);
    try {
      await api(`/api/v1/edges/${renameTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      await refresh();
      setRenameTarget(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not rename edge');
    } finally {
      setRenameSaving(false);
    }
  };

  // Token Issuance / Reveal
  const handleShowToken = async (edge: { id: string; name: string }) => {
    setActiveMenuId(null);
    try {
      const res = await api<{
        enrollment_token: string;
        expires_at: string;
        expires_in_seconds: number;
        edge_id: string;
      }>(`/api/v1/edges/${edge.id}/enrollment-token`, { method: 'POST' });
      setTokenModal({
        edgeName: edge.name,
        token: res.enrollment_token,
        expiresAt: res.expires_at,
      });
      setTokenCopied(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not issue enrollment token');
    }
  };

  // Re-enroll
  const handleReEnroll = async () => {
    if (!reEnrollConfirmTarget) return;
    const target = reEnrollConfirmTarget;
    setReEnrollConfirmTarget(null);
    try {
      const res = await api<{
        enrollment_token: string;
        expires_at: string;
        expires_in_seconds: number;
        edge_id: string;
      }>(`/api/v1/edges/${target.id}/enrollment-token`, { method: 'POST' });
      await refresh();
      setTokenModal({
        edgeName: target.name,
        token: res.enrollment_token,
        expiresAt: res.expires_at,
      });
      setTokenCopied(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not re-enroll edge');
    }
  };

  // Delete Edge
  const handleDeleteEdge = async () => {
    if (!deleteConfirmTarget) return;
    const target = deleteConfirmTarget;
    setDeleteConfirmTarget(null);
    try {
      await api(`/api/v1/edges/${target.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      if (apiErr.code === 'EDGE_IN_USE' || apiErr.status === 409) {
        const edgeConns = connections.filter((c) => c.edgeId === target.id);
        const count = edgeConns.length > 0 ? edgeConns.length : 1;
        setActionError(`Move or archive its ${count} connection${count > 1 ? 's' : ''} first.`);
      } else {
        setActionError(apiErr.message || 'Could not delete edge');
      }
    }
  };

  // Offline banner calculation (TC-UI-ED-03)
  const offlineEdge = useMemo(() => {
    return edges.find((e) => {
      const isEnrolled = e.enrollment_status === 'ENROLLED' || (!e.enrollment_status && e.health);
      const isDown = (e.health || '').toUpperCase() === 'OFFLINE';
      return isEnrolled && isDown;
    });
  }, [edges]);

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-[#111B37]">Edge Collectors</h1>
          <p className="text-[13px] text-[#657794]">
            Manage on-premises edge collector nodes running at your sites
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Offline Alert Banner (TC-UI-ED-03) */}
      {offlineEdge && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-[13px] font-bold text-red-900">
              Data collection for {siteName(offlineEdge.site_id)} is offline since {formatShortTime(offlineEdge.last_heartbeat) || 'recently'}
            </h4>
            <p className="text-[12px] text-red-700 mt-0.5">
              Heartbeats from {offlineEdge.name} ceased over 30 seconds ago. Check power and appliance network connectivity.
            </p>
          </div>
        </div>
      )}

      {/* Action Error Banner */}
      {actionError && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-[13px] text-amber-800 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="font-semibold text-amber-900 ml-4 hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Table Card */}
      <Card className="border border-[#CBD5E1] bg-white overflow-visible">
        {edges.length === 0 ? (
          <div className="p-12 text-center text-[#657794]">
            <Server className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <h3 className="text-[14px] font-semibold text-[#111B37]">No edge collectors</h3>
            <p className="text-[12px] text-[#657794] mt-1">
              Edges are created automatically when you add a site.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50 text-[#657794] font-semibold">
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">Site</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Last seen</th>
                  <th className="py-3 px-4">Config</th>
                  <th className="py-3 px-4">Version</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {edges.map((edge) => {
                  const isNotEnrolled = edge.enrollment_status === 'PENDING' || edge.enrollment_status === 'NOT_ENROLLED';
                  const healthUpper = (edge.health || '').toUpperCase();
                  const isOnline = !isNotEnrolled && (healthUpper === 'ONLINE' || healthUpper === 'HEALTHY' || healthUpper === 'ACTIVE');
                  const isDegraded = !isNotEnrolled && healthUpper === 'DEGRADED';
                  const isOffline = !isNotEnrolled && !isOnline && !isDegraded;

                  const configStatus =
                    edge.desired_revision === edge.active_revision
                      ? 'Up to date'
                      : edge.desired_revision && !edge.active_revision
                      ? 'Update pending'
                      : 'Update pending';

                  const versionLabel = edge.software_version || (edge.active_revision ? `r${edge.active_revision}` : 'r1');

                  return (
                    <tr key={edge.id} className="hover:bg-slate-50 transition">
                      <td className="py-3.5 px-4 font-semibold text-[#111B37] flex items-center gap-2">
                        <Server className="w-4 h-4 text-slate-400" />
                        <span>{edge.name}</span>
                      </td>
                      <td className="py-3.5 px-4 font-medium text-[#111B37]">
                        {siteName(edge.site_id)}
                      </td>
                      <td className="py-3.5 px-4">
                        {isNotEnrolled ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700">
                            Not enrolled
                          </span>
                        ) : isOnline ? (
                          <StatusBadge status="ONLINE" label="Online" />
                        ) : isDegraded ? (
                          <StatusBadge status="DEGRADED" label="Degraded" />
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-red-100 text-red-800">
                            Offline since {formatShortTime(edge.last_heartbeat) || 'recently'}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-[#657794]">
                        {timeAgo(edge.last_heartbeat)}
                      </td>
                      <td className="py-3.5 px-4">
                        <span
                          className={`inline-flex items-center text-[11px] font-medium ${
                            configStatus === 'Up to date' ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {configStatus}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-[#657794] font-mono text-[11px]">
                        {versionLabel}
                      </td>
                      <td className="py-3.5 px-4 text-right relative">
                        <button
                          onClick={() => setActiveMenuId(activeMenuId === edge.id ? null : edge.id)}
                          className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                          aria-label="Actions"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {/* Dropdown Menu */}
                        {activeMenuId === edge.id && (
                          <div
                            className="absolute right-4 mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-30 text-left"
                            onMouseLeave={() => setActiveMenuId(null)}
                          >
                            <button
                              onClick={() => handleStartRename(edge)}
                              className="w-full px-3 py-2 text-[12px] text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <Edit2 className="w-3.5 h-3.5 text-slate-400" />
                              Rename
                            </button>

                            {isNotEnrolled && (
                              <button
                                onClick={() => void handleShowToken(edge)}
                                className="w-full px-3 py-2 text-[12px] text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                              >
                                <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                                Show enrollment token
                              </button>
                            )}

                            {!isNotEnrolled && (
                              <button
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setReEnrollConfirmTarget(edge);
                                }}
                                className="w-full px-3 py-2 text-[12px] text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                              >
                                <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
                                Re-enroll
                              </button>
                            )}

                            <button
                              onClick={() => {
                                setActiveMenuId(null);
                                const hasConns = connections.some((c) => c.edgeId === edge.id && (c.status || '').toUpperCase() !== 'ARCHIVED');
                                if (hasConns) {
                                  const count = connections.filter((c) => c.edgeId === edge.id && (c.status || '').toUpperCase() !== 'ARCHIVED').length;
                                  setActionError(`Move or archive its ${count} connection${count > 1 ? 's' : ''} first.`);
                                  return;
                                }
                                setDeleteConfirmTarget(edge);
                              }}
                              className="w-full px-3 py-2 text-[12px] text-red-600 hover:bg-red-50 flex items-center gap-2 border-t border-slate-100"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-red-500" />
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-sm p-5 bg-white border border-slate-300 shadow-xl space-y-4">
            <h3 className="text-[14px] font-bold text-[#111B37]">Rename Edge Collector</h3>
            <div>
              <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                Name
              </label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveRename}
                disabled={renameSaving || !renameValue.trim()}
              >
                Save
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Enrollment Token Modal (TC-UI-ED-07) */}
      {tokenModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md p-5 bg-white border border-slate-300 shadow-xl space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-[14px] font-bold text-[#111B37]">Enrollment Token</h3>
                <p className="text-[12px] text-[#657794] mt-0.5">
                  Use this token to enroll {tokenModal.edgeName}
                </p>
              </div>
              <span className="text-[11px] font-semibold px-2 py-0.5 bg-blue-50 text-blue-700 rounded">
                Expires in 30 min
              </span>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded font-mono text-[11px] break-all text-slate-800 select-all">
              {tokenModal.token}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-100">
              <span className="text-[11px] text-[#657794]">
                Keep this token safe. It is only shown once.
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(tokenModal.token);
                    setTokenCopied(true);
                    setTimeout(() => setTokenCopied(false), 2000);
                  }}
                >
                  {tokenCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 mr-1" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 mr-1" />
                      Copy token
                    </>
                  )}
                </Button>
                <Button variant="primary" size="sm" onClick={() => setTokenModal(null)}>
                  Done
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Re-enroll Warning Modal (TC-UI-ED-08) */}
      <ConfirmDialog
        isOpen={Boolean(reEnrollConfirmTarget)}
        title={`Re-enroll "${reEnrollConfirmTarget?.name}"?`}
        message="The edge will stop collecting until it enrolls again. Are you sure you want to generate a new enrollment token?"
        confirmLabel="Re-enroll"
        variant="warning"
        onConfirm={handleReEnroll}
        onCancel={() => setReEnrollConfirmTarget(null)}
      />

      {/* Delete Edge Modal */}
      <ConfirmDialog
        isOpen={Boolean(deleteConfirmTarget)}
        title={`Delete "${deleteConfirmTarget?.name}"?`}
        message="This edge collector and its deployment events will be removed. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteEdge}
        onCancel={() => setDeleteConfirmTarget(null)}
      />
    </div>
  );
};
