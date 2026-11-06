import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Archive, X } from 'lucide-react';
import { ResourceNode } from '../../types';
import { translateApiError } from '../../utils/apiErrors';
import { resourceTypeLabel } from '../common/ResourceTypeIcon';
import { useDialogA11y } from './useDialogA11y';

export interface ArchiveResourceModalProps {
  isOpen: boolean;
  resource: ResourceNode | null;
  /** Active resources directly under this one. The server refuses to archive while any exist. */
  childCount: number;
  /** Active signals bound directly to this resource; they stop collecting when it is archived. */
  signalCount: number;
  onClose: () => void;
  onConfirm: () => Promise<{ success: boolean; error?: string }>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const ArchiveResourceModal: React.FC<ArchiveResourceModalProps> = ({
  isOpen,
  resource,
  childCount,
  signalCount,
  onClose,
  onConfirm,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogA11y(isOpen && Boolean(resource), dialogRef, () => {
    if (!submitting) onClose();
  });

  useEffect(() => {
    if (!isOpen) return;
    setSubmitting(false);
    setError(null);
  }, [isOpen]);

  if (!isOpen || !resource) return null;

  const blocked = childCount > 0;
  const typeLabel = resourceTypeLabel(resource.type).toLowerCase();

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await onConfirm();
      if (!result.success) {
        setError(translateApiError(result.error || 'The resource could not be archived.'));
        return;
      }
      onClose();
    } catch (caught) {
      setError(translateApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-resource-title"
        aria-describedby="archive-resource-impact"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden flex flex-col outline-none"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
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

        <div id="archive-resource-impact" className="px-5 py-4 space-y-3 text-[13px] text-slate-700">
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
                {signalCount > 0 ? (
                  <>
                    <li>
                      <span className="font-semibold text-slate-800">{plural(signalCount, 'signal stops', 'signals stop')}</span>{' '}
                      collecting. The collector receives an updated configuration.
                    </li>
                    <li>Data models that use these signals stop receiving new values from them.</li>
                  </>
                ) : (
                  <li>No signals are bound to this {typeLabel}, so no data collection stops.</li>
                )}
                <li>It disappears from the hierarchy and the knowledge graph. Stored history is kept.</li>
                <li>You can restore it later with “Show archived” in the hierarchy tree.</li>
              </ul>
            </>
          )}
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
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
              {submitting ? 'Archiving…' : 'Archive'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
