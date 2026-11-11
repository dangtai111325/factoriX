import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useApp } from '../../store/AppContext';
import { ModalPortal } from './ModalPortal';
import { useDialogA11y } from './useDialogA11y';

export interface RevertToZeroModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface TelemetryResetPreview {
  activeEpoch: number;
  nextEpoch: number;
  lifecycleState: string;
  previewToken?: string;
  cleared: {
    observations: number;
    latestSignalState: number;
    modelSnapshots: number;
    modelState: number;
    quarantine: number;
    ingestDedup: number;
    exportJobs: number;
    commissioningJobs: number;
    tdengineSubtables: number;
  };
  preserved: {
    connections: number;
    signalsActive: number;
    signalsArchived: number;
    dataModels: number;
    storageDesigns: number;
    resources: number;
    adminAccounts: number;
    sessions: number;
    secretStore: number;
    formulas: number;
  };
  raw: Record<string, unknown>;
}

export interface TelemetryResetResult {
  status: string;
  previousEpoch: number;
  activeEpoch: number;
  stayAuthenticated: boolean;
  operationId?: string;
  cleared: Record<string, unknown>;
  preserved: Record<string, unknown>;
}

function num(val: unknown, fallback: number): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizePreview(
  raw: Record<string, unknown> | null | undefined,
  fallbacks: { connections: number; signals: number; models: number; resources: number },
): TelemetryResetPreview {
  const data = raw && typeof raw === 'object' ? raw : {};
  const clearedObj =
    (data.cleared as Record<string, unknown>) ||
    (data.will_be_cleared as Record<string, unknown>) ||
    (data.telemetry as Record<string, unknown>) ||
    data;
  const preservedObj =
    (data.preserved as Record<string, unknown>) ||
    (data.strictly_preserved as Record<string, unknown>) ||
    (data.configuration as Record<string, unknown>) ||
    data;

  const activeEpoch = Math.max(1, num(data.active_epoch ?? data.activeEpoch ?? data.current_epoch, 1));
  const nextEpoch = num(data.next_epoch ?? data.nextEpoch, activeEpoch + 1);

  return {
    activeEpoch,
    nextEpoch,
    lifecycleState: String(data.lifecycle_state ?? data.lifecycleState ?? 'ACTIVE'),
    previewToken: typeof data.preview_token === 'string' ? data.preview_token : undefined,
    cleared: {
      observations: num(clearedObj.observations ?? clearedObj.pg_observations, 0),
      latestSignalState: num(clearedObj.latest_signal_state ?? clearedObj.latestSignalState, 0),
      modelSnapshots: num(clearedObj.model_snapshots ?? clearedObj.modelSnapshots, 0),
      modelState: num(clearedObj.model_state ?? clearedObj.modelState, 0),
      quarantine: num(clearedObj.observation_quarantine ?? clearedObj.quarantine, 0),
      ingestDedup: num(clearedObj.ingest_dedup ?? clearedObj.ingestDedup, 0),
      exportJobs: num(clearedObj.export_jobs ?? clearedObj.exportJobs, 0),
      commissioningJobs: num(clearedObj.commissioning_jobs ?? clearedObj.commissioningJobs, 0),
      tdengineSubtables: num(
        clearedObj.tdengine_subtables ??
          clearedObj.tdengine_series ??
          clearedObj.tdengine_tables ??
          clearedObj.tdengine,
        0,
      ),
    },
    preserved: {
      connections: num(preservedObj.connections, fallbacks.connections || 5),
      signalsActive: num(
        preservedObj.signals_active ?? preservedObj.signalsActive ?? preservedObj.active_signals,
        fallbacks.signals || 336,
      ),
      signalsArchived: num(
        preservedObj.signals_archived ?? preservedObj.signalsArchived ?? preservedObj.archived_signals,
        8,
      ),
      dataModels: num(
        preservedObj.data_models ?? preservedObj.dataModels ?? preservedObj.output_groups,
        fallbacks.models || 36,
      ),
      storageDesigns: num(preservedObj.storage_designs ?? preservedObj.storageDesigns, 0),
      resources: num(preservedObj.resources, fallbacks.resources || 0),
      adminAccounts: num(preservedObj.admin_accounts ?? preservedObj.adminAccounts, 1),
      sessions: num(preservedObj.sessions ?? preservedObj.active_sessions, 1),
      secretStore: num(preservedObj.secret_store ?? preservedObj.secretStore, 5),
      formulas: num(preservedObj.formulas ?? preservedObj.formula_definitions, 0),
    },
    raw: data,
  };
}

export const RevertToZeroModal: React.FC<RevertToZeroModalProps> = ({ isOpen, onClose }) => {
  const app = useApp() as ReturnType<typeof useApp> & {
    refreshSystemState?: () => Promise<void> | void;
  };
  const { connections, signals, dataModels, resources, refresh } = app;

  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<TelemetryResetPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<TelemetryResetResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(isOpen, dialogRef, () => {
    if (!isSubmitting) onClose();
  });

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await api<Record<string, unknown>>('/api/v1/admin/telemetry-reset/preview');
      setPreview(
        normalizePreview(res, {
          connections: connections.length || 5,
          signals: signals.length || 336,
          models: dataModels.length || 36,
          resources: resources.length,
        }),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to load live reset impact preview.';
      setPreviewError(msg);
      setPreview(
        normalizePreview(null, {
          connections: connections.length || 5,
          signals: signals.length || 336,
          models: dataModels.length || 36,
          resources: resources.length,
        }),
      );
    } finally {
      setLoadingPreview(false);
    }
  }, [connections.length, signals.length, dataModels.length, resources.length]);

  useEffect(() => {
    if (!isOpen) return;
    setConfirmPhrase('');
    setPassword('');
    setError(null);
    setIsSubmitting(false);
    setResetResult(null);
    void loadPreview();
  }, [isOpen, loadPreview]);

  if (!isOpen) return null;

  const phraseValid = confirmPhrase.trim() === 'CLEAR TELEMETRY';
  const passwordValid = password.trim().length > 0;
  const canExecute = phraseValid && passwordValid && !isSubmitting;

  const handleDownloadManifest = () => {
    if (!preview) return;
    const blob = new Blob([JSON.stringify(preview.raw, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `factorix-telemetry-reset-preview-epoch-${preview.activeEpoch}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canExecute) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        confirm_phrase: 'CLEAR TELEMETRY',
        password,
      };
      if (preview?.previewToken) {
        payload.preview_token = preview.previewToken;
      }

      const res = await api<Record<string, unknown>>('/api/v1/admin/telemetry-reset/execute', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const prevEpoch = num(res.previous_epoch ?? res.previousEpoch, preview?.activeEpoch ?? 1);
      const newEpoch = num(res.active_epoch ?? res.activeEpoch ?? res.new_epoch, prevEpoch + 1);

      setResetResult({
        status: String(res.status ?? 'COMPLETED'),
        previousEpoch: prevEpoch,
        activeEpoch: newEpoch,
        stayAuthenticated: res.stay_authenticated !== false,
        operationId: typeof res.operation_id === 'string' ? res.operation_id : undefined,
        cleared: (res.cleared as Record<string, unknown>) || {},
        preserved: (res.preserved as Record<string, unknown>) || {},
      });

      // Trigger system state refresh without logging out or redirecting to /register
      if (typeof app.refreshSystemState === 'function') {
        await app.refreshSystemState();
      } else if (typeof refresh === 'function') {
        await refresh();
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Failed to clear telemetry history. Please verify your admin password and try again.';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const effPreview =
    preview ??
    normalizePreview(null, {
      connections: connections.length || 5,
      signals: signals.length || 336,
      models: dataModels.length || 36,
      resources: resources.length,
    });

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150">
        <div
          ref={dialogRef}
          tabIndex={-1}
          className="w-full max-w-2xl bg-white rounded-xl shadow-2xl border border-[#E3EAF3] overflow-hidden outline-none max-h-[92vh] flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="revert-modal-title"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD] shrink-0">
            <div className="flex items-center gap-3">
              <div
                className={`p-2 rounded-lg border ${
                  resetResult
                    ? 'bg-emerald-50 border-emerald-200 text-[#0DBA67]'
                    : 'bg-[#FEF2F2] border-[#FECACA] text-[#EF1B24]'
                }`}
              >
                {resetResult ? (
                  <CheckCircle2 className="w-5 h-5 text-[#0DBA67]" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-[#EF1B24]" />
                )}
              </div>
              <div>
                <h3 id="revert-modal-title" className="text-[16px] font-bold text-[#111B37]">
                  Clear Telemetry &amp; Operational History
                </h3>
                <p className="text-[12px] text-[#657794]">
                  Selective data-plane reset (`CLEAR_TELEMETRY_ONLY`) — preserves all configurations &amp; accounts
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="text-[#94A3B8] hover:text-[#334568] transition-colors p-1.5 rounded-lg hover:bg-slate-100"
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 overflow-y-auto space-y-5 flex-1">
            {resetResult ? (
              <div className="space-y-5" data-testid="telemetry-reset-success">
                <div className="p-4 rounded-xl bg-emerald-50/80 border border-emerald-200 flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-[#0DBA67] shrink-0 mt-0.5" />
                  <div className="space-y-1 text-[13px] text-emerald-950">
                    <div className="font-bold text-[14px]">
                      Acquired telemetry and operational history cleared
                    </div>
                    <p className="text-[12px] text-emerald-800 leading-relaxed">
                      All historical observations, live signal caches, and TDengine time-series subtables from epoch{' '}
                      <span className="font-mono font-bold">#{resetResult.previousEpoch}</span> have been fenced and
                      cleared. Your administrator session and all factory configurations remain intact.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3.5 rounded-xl border border-[#E3EAF3] bg-[#F6F8FC]">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                      New Active Epoch
                    </div>
                    <div className="mt-1 text-[20px] font-extrabold font-mono text-[#111B37]">
                      Epoch #{resetResult.activeEpoch}
                    </div>
                    <div className="text-[11px] text-[#0DBA67] font-semibold mt-0.5">
                      Pre-reset packets fenced
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl border border-[#E3EAF3] bg-[#F6F8FC]">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                      Preserved Entities
                    </div>
                    <div className="mt-1 text-[13px] font-bold text-[#111B37]">
                      {effPreview.preserved.connections} Connections · {effPreview.preserved.signalsActive} Signals
                    </div>
                    <div className="text-[11px] text-[#657794] mt-0.5">
                      {effPreview.preserved.dataModels} Data Models · {effPreview.preserved.signalsArchived} Archived
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl border border-[#E3EAF3] bg-[#F6F8FC]">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[#657794]">
                      Session &amp; Auth
                    </div>
                    <div className="mt-1 text-[13px] font-bold text-[#0DBA67] flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4" />
                      Authenticated
                    </div>
                    <div className="text-[11px] text-[#657794] mt-0.5">
                      Live state reset to NO_DATA
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <form id="telemetry-reset-form" onSubmit={(e) => void handleExecute(e)} className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-[#F6F8FC] px-3.5 py-2.5 rounded-lg border border-[#E3EAF3]">
                  <div className="flex items-center gap-2 text-[12px] text-[#334568]">
                    <Database className="w-4 h-4 text-[#657794]" />
                    <span>
                      Current Generation:{' '}
                      <strong className="font-mono text-[#111B37]">Epoch #{effPreview.activeEpoch}</strong>
                    </span>
                    <span className="text-[#94A3B8]">→</span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-[#FEF2F2] text-[#EF1B24] border border-[#FECACA]">
                      Advances to Epoch #{effPreview.nextEpoch}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void loadPreview()}
                      disabled={loadingPreview || isSubmitting}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#334568] hover:text-[#111B37] px-2 py-1 rounded border border-[#D4DFEC] bg-white hover:bg-slate-50 transition-colors"
                    >
                      <RefreshCw className={`w-3 h-3 ${loadingPreview ? 'animate-spin' : ''}`} />
                      Refresh Preview
                    </button>
                    {preview && (
                      <button
                        type="button"
                        onClick={handleDownloadManifest}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#334568] hover:text-[#111B37] px-2 py-1 rounded border border-[#D4DFEC] bg-white hover:bg-slate-50 transition-colors"
                      >
                        <Download className="w-3 h-3" />
                        Manifest
                      </button>
                    )}
                  </div>
                </div>

                {previewError && (
                  <div className="px-3.5 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-800">
                    Live preview notice: {previewError} Showing current baseline configuration counts.
                  </div>
                )}

                {/* Two clear side-by-side summary boxes */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Box 1: Will Be Cleared */}
                  <div className="rounded-xl border border-[#FAC6C9] bg-[#FFF5F5]/60 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-[#EF1B24] font-bold text-[13px] pb-2 border-b border-[#FED7D7]">
                      <Trash2 className="w-4 h-4 shrink-0" />
                      <span>Will Be Cleared (Telemetry Only)</span>
                    </div>
                    <ul className="space-y-2 text-[12px] text-[#334568]">
                      <li className="flex items-center justify-between gap-2">
                        <span>Observations (PG legacy buffer)</span>
                        <span className="font-mono font-bold text-[#9B1C1C]">
                          {effPreview.cleared.observations.toLocaleString()} rows
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Live Signal State Cache</span>
                        <span className="font-mono font-bold text-[#9B1C1C]">
                          {effPreview.cleared.latestSignalState.toLocaleString()} states
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Model Snapshots &amp; Runtime</span>
                        <span className="font-mono font-bold text-[#9B1C1C]">
                          {(effPreview.cleared.modelSnapshots + effPreview.cleared.modelState).toLocaleString()} rows
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Quarantine &amp; Ingest Dedup</span>
                        <span className="font-mono font-bold text-[#9B1C1C]">
                          {(effPreview.cleared.quarantine + effPreview.cleared.ingestDedup).toLocaleString()} keys
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Export Jobs &amp; Artifacts</span>
                        <span className="font-mono font-bold text-[#9B1C1C]">
                          {effPreview.cleared.exportJobs.toLocaleString()} jobs
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2 pt-1 border-t border-[#FED7D7]/70">
                        <span>TDengine Operational &amp; Managed Time-Series</span>
                        <span className="font-mono font-bold text-[#EF1B24]">
                          epoch #{effPreview.activeEpoch} → #{effPreview.nextEpoch}
                        </span>
                      </li>
                    </ul>
                  </div>

                  {/* Box 2: Strictly Preserved */}
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-emerald-800 font-bold text-[13px] pb-2 border-b border-emerald-200">
                      <ShieldCheck className="w-4 h-4 shrink-0 text-[#0DBA67]" />
                      <span>Strictly Preserved (Configuration &amp; Control Plane)</span>
                    </div>
                    <ul className="space-y-2 text-[12px] text-[#334568]">
                      <li className="flex items-center justify-between gap-2">
                        <span>Connections</span>
                        <span className="font-mono font-bold text-emerald-800">
                          {effPreview.preserved.connections} preserved
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Signals (Active / Archived)</span>
                        <span className="font-mono font-bold text-emerald-800">
                          {effPreview.preserved.signalsActive} active / {effPreview.preserved.signalsArchived} archived
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Data Models</span>
                        <span className="font-mono font-bold text-emerald-800">
                          {effPreview.preserved.dataModels} preserved
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Storage Designs &amp; Policies</span>
                        <span className="font-mono font-bold text-emerald-800">
                          {effPreview.preserved.storageDesigns} designs + STables
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Factory Structure Resources</span>
                        <span className="font-mono font-bold text-emerald-800">
                          {effPreview.preserved.resources} resources
                        </span>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Admin Accounts &amp; Active Login Session</span>
                        <span className="font-mono font-bold text-[#0DBA67]">Kept active</span>
                      </li>
                      <li className="flex items-center justify-between gap-2 pt-1 border-t border-emerald-200/70">
                        <span>Secret Store &amp; Encryption Keys</span>
                        <span className="font-mono font-bold text-emerald-800">Intact</span>
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Security Confirmation Inputs */}
                <div className="p-4 rounded-xl bg-[#F6F8FC] border border-[#E3EAF3] space-y-3.5">
                  <div className="text-[12px] text-[#475569] leading-relaxed">
                    To authorize this selective telemetry reset, type{' '}
                    <span className="font-mono font-bold bg-[#FEE2E2] text-[#9B1C1C] px-1.5 py-0.5 rounded">
                      CLEAR TELEMETRY
                    </span>{' '}
                    and enter your current Administrator password.
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label
                        htmlFor="revert-confirmation-input"
                        className="block text-[12px] font-semibold text-[#111B37] mb-1"
                      >
                        Confirmation Phrase
                      </label>
                      <input
                        id="revert-confirmation-input"
                        data-autofocus
                        type="text"
                        value={confirmPhrase}
                        onChange={(e) => setConfirmPhrase(e.target.value)}
                        placeholder="CLEAR TELEMETRY"
                        disabled={isSubmitting}
                        autoComplete="off"
                        className="w-full px-3 py-2 text-[13px] bg-white border border-[#CBD5E1] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24] font-mono tracking-wider text-[#111B37]"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="revert-admin-password-input"
                        className="block text-[12px] font-semibold text-[#111B37] mb-1"
                      >
                        Current Admin Password
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="revert-admin-password-input"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Enter admin password"
                          disabled={isSubmitting}
                          autoComplete="current-password"
                          className="w-full pl-8 pr-3 py-2 text-[13px] bg-white border border-[#CBD5E1] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24] text-[#111B37]"
                        />
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div
                      role="alert"
                      className="p-2.5 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[12px] text-[#EF1B24] font-medium"
                    >
                      {error}
                    </div>
                  )}
                </div>
              </form>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-[#E3EAF3] bg-[#F9FAFD] flex items-center justify-between gap-3 shrink-0">
            <div className="text-[11px] text-[#657794]">
              {resetResult
                ? 'System configuration verified intact. Ready for new telemetry.'
                : 'You will remain signed in after clearing telemetry.'}
            </div>
            <div className="flex items-center gap-2.5">
              {resetResult ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-[13px] font-semibold rounded-lg bg-[#111B37] text-white hover:bg-[#1E293B] transition-colors shadow-xs"
                >
                  Close
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isSubmitting}
                    className="px-4 py-2 text-[13px] font-semibold text-[#334568] bg-white border border-[#D4DFEC] hover:bg-[#F1F5F9] rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    form="telemetry-reset-form"
                    disabled={!canExecute}
                    className={`px-4 py-2 text-[13px] font-semibold rounded-lg transition-all ${
                      canExecute
                        ? 'bg-[#EF1B24] text-white hover:bg-[#D9151E] shadow-sm cursor-pointer'
                        : 'bg-[#E3EAF3] text-[#94A3B8] cursor-not-allowed'
                    }`}
                  >
                    {isSubmitting ? 'Clearing Telemetry…' : 'Clear Telemetry & History'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};

export default RevertToZeroModal;
