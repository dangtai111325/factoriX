import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Archive, Layers, X } from 'lucide-react';
import { ResourceNode } from '../../types';
import { translateApiError } from '../../utils/apiErrors';
import { resourceTypeLabel } from '../common/ResourceTypeIcon';
import { useDialogA11y } from './useDialogA11y';
import { ModalPortal } from './ModalPortal';
import { ArchiveImpact, ImpactModel, fetchArchiveImpact, modelStatusLabel } from '../../lib/impactApi';
import { useSubmit } from '../../lib/useSubmit';

export interface ArchiveResourceModalProps {
  isOpen: boolean;
  resource: ResourceNode | null;
  /** Active resources directly under this one. The server refuses to archive while any exist. */
  childCount: number;
  /** Active signals bound directly to this resource; they stop collecting when it is archived. */
  signalCount: number;
  onClose: () => void;
  /**
   * Archive the resource. `archiveModels`: the user ticked "Archive the models too"; `models` are the
   * affected models listed in the dialog.
   */
  onConfirm: (options: { archiveModels: boolean; models: ImpactModel[] }) => Promise<{ success: boolean; error?: string }>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

type ImpactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; impact: ArchiveImpact };

export const ArchiveResourceModal: React.FC<ArchiveResourceModalProps> = ({
  isOpen,
  resource,
  childCount,
  signalCount,
  onClose,
  onConfirm,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactState>({ status: 'loading' });
  const [archiveModels, setArchiveModels] = useState(false);
  const impactPromiseRef = useRef<Promise<ArchiveImpact | null> | null>(null);
  // In-flight guard: one archive request however often the button is pressed.
  const archive = useSubmit((options: { archiveModels: boolean; models: ImpactModel[] }) => onConfirm(options));
  const submitting = archive.pending;
  const resourceId = resource?.id || '';

  useDialogA11y(isOpen && Boolean(resource), dialogRef, () => {
    if (!archive.isRunning()) onClose();
  });

  const loadImpact = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    setImpact({ status: 'loading' });
    const p = fetchArchiveImpact(id)
      .then((next) => {
        if (isActive()) setImpact({ status: 'ready', impact: next });
        return next;
      })
      .catch((caught) => {
        if (isActive()) setImpact({ status: 'error', message: translateApiError(caught) });
        return null;
      });
    impactPromiseRef.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (!isOpen || !resourceId) return;
    setError(null);
    setArchiveModels(false);
    let active = true;
    // Nothing to look up while archiving is blocked by child resources.
    if (childCount > 0) {
      setImpact({ status: 'ready', impact: { models: [], signalCount: null } });
    } else {
      void loadImpact(resourceId, () => active);
    }
    return () => {
      active = false;
    };
    // Re-read once per opening; parent refreshes must not reload the impact list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, resourceId]);

  if (!isOpen || !resource) return null;

  const blocked = childCount > 0;
  const typeLabel = resourceTypeLabel(resource.type).toLowerCase();
  const models = impact.status === 'ready' ? impact.impact.models : [];
  const runningCount = models.filter((model) => model.status === 'RUNNING').length;
  const signalsStopping = impact.status === 'ready' && impact.impact.signalCount != null ? impact.impact.signalCount : signalCount;

  const handleConfirm = async () => {
    if (archive.isRunning()) return;
    setError(null);
    let resolvedModels = models;
    if (impact.status === 'loading' && impactPromiseRef.current) {
      const res = await impactPromiseRef.current;
      if (res) resolvedModels = res.models;
    }
    try {
      const result = await archive.run({ archiveModels: archiveModels && resolvedModels.length > 0, models: resolvedModels });
      if (!result) return;
      if (!result.success) {
        setError(translateApiError(result.error || 'The resource could not be archived.'));
        return;
      }
      onClose();
    } catch (caught) {
      setError(translateApiError(caught));
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !archive.isRunning()) onClose();
        }}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="archive-resource-title"
          aria-describedby="archive-resource-impact"
          tabIndex={-1}
          onKeyDown={(event) => {
            // Archiving is destructive: focus starts on Cancel, so Enter right after opening cancels.
            // Enter archives only on the Archive button itself (native). When archiving is blocked,
            // Enter anywhere closes the dialog.
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || !blocked) return;
            const target = event.target as HTMLElement;
            if (target.closest('button, a, textarea, select')) return;
            event.preventDefault();
            onClose();
          }}
          className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col outline-none"
        >
          <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3 shrink-0">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-red-50 text-[#DB2028] flex items-center justify-center shrink-0">
                <Archive className="w-[18px] h-[18px]" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 id="archive-resource-title" className="text-[15px] font-bold text-slate-900 break-words">
                  Archive {resource.name}?
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {resourceTypeLabel(resource.type)} · <span className="font-mono">{resource.code}</span>
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div
            id="archive-resource-impact"
            tabIndex={-1}
            className="px-5 py-4 space-y-3 text-[13px] text-slate-700 overflow-y-auto min-h-0 outline-none"
          >
            {error && (
              <div role="alert" className="p-2.5 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-red-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            {blocked ? (
              <p>
                This {typeLabel} still contains {plural(childCount, 'resource', 'resources')}. Archive or move them first,
                then archive this {typeLabel}.
              </p>
            ) : (
              <>
                <p>What happens when you archive it:</p>
                <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
                  {signalsStopping > 0 ? (
                    <li>
                      <span className="font-semibold text-slate-800">{plural(signalsStopping, 'signal stops', 'signals stop')}</span>{' '}
                      collecting. The collector receives an updated configuration.
                    </li>
                  ) : (
                    <li>No signals are bound to this {typeLabel}, so no data collection stops.</li>
                  )}
                  <li>It disappears from the hierarchy and the knowledge graph. Stored history is kept.</li>
                  <li>You can restore it later with “Show archived” in the hierarchy tree.</li>
                </ul>

                {/* R3-HS-01: data models defined on this resource. */}
                <section aria-labelledby="archive-resource-models" className="rounded-lg border border-slate-200 bg-slate-50/60">
                  <h3
                    id="archive-resource-models"
                    className="px-3 py-2 text-[12px] font-semibold text-slate-800 flex items-center gap-1.5 border-b border-slate-200"
                  >
                    <Layers className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    Data models on this {typeLabel}
                  </h3>
                  <div className="px-3 py-2 text-[12px]" aria-live="polite">
                    {impact.status === 'loading' ? (
                      <p className="text-slate-500">Checking which data models use it…</p>
                    ) : impact.status === 'error' ? (
                      <p className="text-red-700">
                        The affected data models could not be checked: {impact.message}{' '}
                        <button
                          type="button"
                          className="font-semibold underline hover:no-underline"
                          onClick={() => void loadImpact(resource.id)}
                        >
                          Try again
                        </button>
                      </p>
                    ) : models.length === 0 ? (
                      <p className="text-slate-500">No data model uses it.</p>
                    ) : (
                      <>
                        <p className="text-slate-700">
                          {plural(models.length, 'data model uses', 'data models use')} it
                          {runningCount > 0 ? ` (${runningCount} running)` : ''}. Unless you archive them too, they
                          keep {runningCount > 0 ? 'running' : 'their definition'}, but the fields that read this {typeLabel} output null.
                        </p>
                        <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
                          {models.map((model) => (
                            <li key={model.id} className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                              <span className="truncate text-slate-800" title={model.displayName}>
                                {model.displayName}
                              </span>
                              <span
                                className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                  model.status === 'RUNNING' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {modelStatusLabel(model.status)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <label className="mt-2.5 flex items-start gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={archiveModels}
                            disabled={submitting}
                            onChange={(event) => setArchiveModels(event.target.checked)}
                            className="mt-0.5 rounded border-slate-300 text-[#EF1B24] focus:ring-[#EF1B24]/30"
                          />
                          <span>
                            <span className="font-semibold text-slate-800">Archive the models too</span>
                            <span className="block text-[11px] text-slate-500">
                              They stop sampling and leave the Model Catalog. Restoring the {typeLabel} does not bring them back.
                            </span>
                          </span>
                        </label>
                      </>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5 shrink-0">
            <button
              type="button"
              data-autofocus
              onClick={onClose}
              disabled={submitting}
              className="h-8 px-3 border border-slate-200 bg-white text-slate-700 rounded-lg text-[12px] font-semibold hover:bg-slate-100 transition-colors"
            >
              {blocked ? 'Close' : 'Cancel'}
            </button>
            {!blocked && (
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={submitting}
                className="h-8 px-3 bg-[#DB2028] hover:bg-[#C21A21] text-white rounded-lg text-[12px] font-semibold transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                {submitting ? 'Archiving…' : archiveModels && models.length > 0 ? `Archive with ${plural(models.length, 'model', 'models')}` : 'Archive'}
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
