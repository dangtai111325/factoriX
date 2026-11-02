import React, { useMemo, useState } from 'react';
import { Copy, Check, RefreshCw, KeyRound, Server, MoreHorizontal } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';

function relativeAge(iso?: string): string {
  if (!iso || iso === '—') return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

export const EdgesPage: React.FC = () => {
  const { edges, siteNameById, refresh, issueEnrollmentToken, queueApplianceEnroll } = useApp();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{
    edgeId: string;
    token: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

  // CR-E01: map edge.site_id → sites table name (e.g. DongNai), never machine names.
  const siteName = useMemo(
    () => (siteId: string) => {
      if (!siteId) return '—';
      return siteNameById[siteId] || siteId;
    },
    [siteNameById],
  );

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh edges');
    } finally {
      setLoading(false);
    }
  };

  const issueToken = async (edgeId: string) => {
    setBusyId(edgeId);
    setError('');
    setMenuId(null);
    try {
      const result = await issueEnrollmentToken(edgeId);
      setTokenInfo({
        edgeId,
        token: result.enrollment_token,
        expiresAt: result.expires_at,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue enrollment token');
    } finally {
      setBusyId(null);
    }
  };

  const queueAppliance = async (edgeId: string) => {
    setBusyId(edgeId);
    setError('');
    setMenuId(null);
    try {
      await queueApplianceEnroll(edgeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Appliance enroll queue failed');
    } finally {
      setBusyId(null);
    }
  };

  const healthBadge = (edge: { health: string; enrollmentStatus: string; lastHeartbeat: string }) => {
    if (edge.enrollmentStatus !== 'ENROLLED') return <Badge variant="warning">Not enrolled</Badge>;
    const h = edge.health.toUpperCase();
    if (h === 'HEALTHY' || h === 'NORMAL' || h === 'ACTIVE' || h === 'CONFIG_VALIDATED') {
      return <Badge variant="good">Online</Badge>;
    }
    if (h === 'DEGRADED') return <Badge variant="warning">Degraded</Badge>;
    if (h === 'OFFLINE') {
      const since = edge.lastHeartbeat ? relativeAge(edge.lastHeartbeat) : 'never';
      return <Badge variant="error">Offline since {since}</Badge>;
    }
    return <Badge variant="neutral">{h || 'Unknown'}</Badge>;
  };

  const configLabel = (edge: { activeRevision: number; desiredRevision: number; enrollmentStatus: string }) => {
    if (edge.enrollmentStatus !== 'ENROLLED') return '—';
    if (edge.activeRevision >= edge.desiredRevision && edge.desiredRevision > 0) {
      return 'Config up to date';
    }
    if (edge.desiredRevision === 0) return 'No config yet';
    return `Pending r${edge.desiredRevision}`;
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Edges</h1>
          <p className="fx-page-subtitle">
            Enrollment, heartbeat, and config for site collectors. Handshake stays blocked until an edge is enrolled.
          </p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw className="w-4 h-4" />}
          onClick={() => void reload()}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      <Card className="p-4 border-[#BED7F7] bg-[#EEF5FF]/40">
        <p className="text-[13px] font-bold text-[#111B37] mb-1">Edge install guidance</p>
        <ol className="text-[12px] text-[#334568] list-decimal list-inside space-y-1">
          <li>Create a site in Factory Structure — an edge is created for that site.</li>
          <li>Issue an enrollment token (or queue appliance enroll on this host).</li>
          <li>Start the edge agent with the token; heartbeat should turn Online.</li>
          <li>Publish a connection config so active revision matches desired.</li>
        </ol>
      </Card>

      {error && <p className="text-[12px] text-[#F2343B]">{error}</p>}

      {tokenInfo && (
        <Card className="p-4 border-[#BED7F7] bg-[#EEF5FF]/50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-[#111B37] mb-1">Enrollment token</p>
              <p className="text-[11px] text-[#657794] mb-2">
                Expires at {tokenInfo.expiresAt || '—'}. Paste into the edge agent or queue appliance enroll on this
                host.
              </p>
              <code className="block font-mono text-[12px] break-all bg-white border border-[#E3EAF3] rounded-lg p-2">
                {tokenInfo.token}
              </code>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={copied ? <Check className="w-3.5 h-3.5 text-[#0DBA67]" /> : <Copy className="w-3.5 h-3.5" />}
              onClick={() => {
                void navigator.clipboard.writeText(tokenInfo.token);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-0 overflow-hidden">
        {!edges.length ? (
          <div className="p-10 text-center">
            <Server className="w-8 h-8 text-[#94A3B8] mx-auto mb-2" />
            <p className="text-[14px] font-semibold text-[#111B37]">No edges yet</p>
            <p className="text-[12px] text-[#657794] mt-1">
              Create a site in Factory Structure — the appliance creates an edge for that site automatically.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th>Config</th>
                  <th>Revision</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((edge) => {
                  const enrolled = edge.enrollmentStatus === 'ENROLLED';
                  return (
                    <tr key={edge.id}>
                      <td className="font-semibold text-[#111B37]">{edge.name}</td>
                      <td className="text-[12px] text-[#334568]">{siteName(edge.siteId)}</td>
                      <td>{healthBadge(edge)}</td>
                      <td className="font-mono text-[11px] text-[#657794]" title={edge.lastHeartbeat || undefined}>
                        {enrolled
                          ? edge.lastHeartbeat
                            ? relativeAge(edge.lastHeartbeat)
                            : 'Never'
                          : 'Not enrolled'}
                      </td>
                      <td className="text-[12px] text-[#657794]">{configLabel(edge)}</td>
                      <td className="font-mono text-[11px]">
                        {edge.activeRevision}/{edge.desiredRevision}
                      </td>
                      <td className="text-right relative">
                        {!enrolled ? (
                          <div className="inline-flex gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<KeyRound className="w-3.5 h-3.5" />}
                              loading={busyId === edge.id}
                              onClick={() => void issueToken(edge.id)}
                            >
                              Issue token
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={busyId === edge.id}
                              onClick={() => void queueAppliance(edge.id)}
                              title="Writes an enrollment token for this edge"
                            >
                              Queue appliance enroll
                            </Button>
                          </div>
                        ) : (
                          <div className="inline-flex justify-end">
                            <button
                              type="button"
                              className="p-2 rounded-lg border border-[#E3EAF3] hover:bg-[#F9FAFD]"
                              aria-label="Edge actions"
                              onClick={() => setMenuId(menuId === edge.id ? null : edge.id)}
                            >
                              <MoreHorizontal className="w-4 h-4 text-[#657794]" />
                            </button>
                            {menuId === edge.id && (
                              <div className="absolute right-3 top-10 z-20 w-44 rounded-lg border border-[#E3EAF3] bg-white shadow-lg py-1 text-left">
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-[12px] text-left hover:bg-[#F9FAFD]"
                                  onClick={() => void issueToken(edge.id)}
                                >
                                  Re-enroll
                                </button>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-[12px] text-left hover:bg-[#F9FAFD]"
                                  onClick={() => void queueAppliance(edge.id)}
                                >
                                  Queue appliance enroll
                                </button>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-[12px] text-left text-[#94A3B8] cursor-not-allowed"
                                  disabled
                                  title="Coming soon"
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-[12px] text-left text-[#94A3B8] cursor-not-allowed"
                                  disabled
                                  title="Coming soon"
                                >
                                  Revoke
                                </button>
                              </div>
                            )}
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
    </div>
  );
};
