import React, { useState } from 'react';
import { Copy, Check, RefreshCw, KeyRound, Server } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';

export const EdgesPage: React.FC = () => {
  const { edges, resources, refresh, issueEnrollmentToken, queueApplianceEnroll } = useApp();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{
    edgeId: string;
    token: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const siteName = (siteId: string) =>
    resources.find((r) => r.id === siteId || r.attributes?.siteId === siteId)?.name || siteId || '—';

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
    try {
      await queueApplianceEnroll(edgeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Appliance enroll queue failed');
    } finally {
      setBusyId(null);
    }
  };

  const healthBadge = (health: string, enrollment: string) => {
    if (enrollment !== 'ENROLLED') return <Badge variant="warning">NOT ENROLLED</Badge>;
    const h = health.toUpperCase();
    if (h === 'HEALTHY' || h === 'NORMAL') return <Badge variant="good">{h}</Badge>;
    if (h === 'DEGRADED') return <Badge variant="warning">{h}</Badge>;
    if (h === 'OFFLINE') return <Badge variant="error">{h}</Badge>;
    return <Badge variant="neutral">{h || 'UNKNOWN'}</Badge>;
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Edge Collectors</h1>
          <p className="fx-page-subtitle">
            Enrollment status, heartbeat, and tokens for site collectors. Handshake stays blocked until an Edge is
            enrolled.
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

      {error && <p className="text-[12px] text-[#F2343B]">{error}</p>}

      {tokenInfo && (
        <Card className="p-4 border-[#BED7F7] bg-[#EEF5FF]/50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-[#111B37] mb-1">Enrollment token</p>
              <p className="text-[11px] text-[#657794] mb-2">
                Expires at {tokenInfo.expiresAt || '—'}. Paste into the Edge agent or queue appliance enroll on this
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
              Create a Site in Factory Structure — the appliance creates an Edge for that site automatically.
            </p>
          </div>
        ) : (
          <table className="fx-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Site</th>
                <th>Enrollment</th>
                <th>Health</th>
                <th>Heartbeat</th>
                <th>Revision</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => (
                <tr key={edge.id}>
                  <td className="font-semibold text-[#111B37]">{edge.name}</td>
                  <td className="text-[12px] text-[#657794]">{siteName(edge.siteId)}</td>
                  <td>
                    <Badge variant={edge.enrollmentStatus === 'ENROLLED' ? 'good' : 'warning'}>
                      {edge.enrollmentStatus || 'UNKNOWN'}
                    </Badge>
                  </td>
                  <td>{healthBadge(edge.health, edge.enrollmentStatus)}</td>
                  <td className="font-mono text-[11px] text-[#657794]">{edge.lastHeartbeat || '—'}</td>
                  <td className="font-mono text-[11px]">
                    {edge.activeRevision}/{edge.desiredRevision}
                  </td>
                  <td className="text-right">
                    <div className="inline-flex gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<KeyRound className="w-3.5 h-3.5" />}
                        loading={busyId === edge.id}
                        onClick={() => void issueToken(edge.id)}
                      >
                        Issue enrollment token
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyId === edge.id}
                        onClick={() => void queueAppliance(edge.id)}
                        title="Writes enrollment token for the on-box collector"
                      >
                        Queue appliance enroll
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};
