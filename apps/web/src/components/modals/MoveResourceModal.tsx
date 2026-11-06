import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, ArrowRightLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import { ResourceNode } from '../../types';
import { translateApiError } from '../../utils/apiErrors';
import { ResourceTypeIcon, resourceTypeLabel } from '../common/ResourceTypeIcon';
import { useDialogA11y } from './useDialogA11y';
import {
  allowedParentTypes,
  descendantIds,
  isValidParentFor,
} from '../../utils/resourceHierarchy';
import { ModalPortal } from './ModalPortal';

export interface MoveResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedResource: ResourceNode;
  allResources: ResourceNode[];
  onMoveResource: (targetParentId: string) => Promise<{ success: boolean; error?: string } | void>;
}

export const MoveResourceModal: React.FC<MoveResourceModalProps> = ({
  isOpen,
  onClose,
  selectedResource,
  allResources,
  onMoveResource,
}) => {
  const blockedIds = useMemo(
    () => descendantIds(allResources, selectedResource.id),
    [allResources, selectedResource.id],
  );

  const parentTypeKeys = useMemo(
    () => new Set(allowedParentTypes(selectedResource.type)),
    [selectedResource.type],
  );

  const candidateParents = useMemo(
    () =>
      allResources
        .filter(
          (r) =>
            !blockedIds.has(r.id) &&
            parentTypeKeys.has(r.type.toLowerCase()) &&
            isValidParentFor(selectedResource.type, r.type),
        )
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [allResources, blockedIds, parentTypeKeys, selectedResource.type],
  );

  const currentParentId = selectedResource.parentId || '';
  const [selectedTargetId, setSelectedTargetId] = useState(currentParentId);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(isOpen, dialogRef, () => {
    if (!submitting) onClose();
  });

  // Initialise once per opening. The resource list refreshes every few seconds with new object
  // identities; depending on it here used to wipe the user's choice while the dialog was open.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedTargetId(currentParentId);
    setErrorMsg(null);
    setSubmitting(false);
  }, [isOpen, selectedResource.id, currentParentId]);

  if (!isOpen) return null;

  const currentParent = allResources.find((r) => r.id === selectedResource.parentId);
  const unchanged = selectedTargetId === currentParentId || !selectedTargetId;

  const handleConfirm = async () => {
    if (!selectedTargetId) {
      setErrorMsg('Choose the new parent.');
      return;
    }
    if (selectedTargetId === currentParentId) {
      setErrorMsg('This is already the current parent.');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const result = await onMoveResource(selectedTargetId);
      if (result && result.success === false) {
        setErrorMsg(translateApiError(result.error || 'Move failed'));
        return;
      }
      onClose();
    } catch (caught) {
      setErrorMsg(translateApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !submitting) onClose();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="move-resource-title"
          tabIndex={-1}
          className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] outline-none"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
                <ArrowRightLeft className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="move-resource-title" className="text-lg font-bold text-slate-900">
                  Move resource
                </h2>
                <p className="text-xs text-slate-500">
                  Choose a new parent. Everything under this resource moves with it.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4 text-sm overflow-y-auto">
            {errorMsg && (
              <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2 text-red-700 text-xs">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div>
              <span className="text-xs font-semibold text-slate-500 uppercase">Resource</span>
              <div className="mt-1 font-bold text-slate-800 text-base flex items-center gap-2 min-w-0">
                <ResourceTypeIcon type={selectedResource.type} className="text-slate-500" />
                <span className="truncate" title={selectedResource.name}>{selectedResource.name}</span>
                <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-100 text-slate-600 shrink-0">
                  {selectedResource.code}
                </span>
                <span className="px-2 py-0.5 rounded text-[11px] bg-slate-100 text-slate-500 shrink-0">
                  {resourceTypeLabel(selectedResource.type)}
                </span>
              </div>
            </div>

            <div>
              <span className="text-xs font-semibold text-slate-500 uppercase">Current parent</span>
              <div className="mt-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 flex items-center gap-2 min-w-0">
                {currentParent ? (
                  <>
                    <ResourceTypeIcon type={currentParent.type} size={14} className="text-slate-400" />
                    <span className="truncate" title={currentParent.name}>
                      {currentParent.name} · {resourceTypeLabel(currentParent.type)}
                    </span>
                  </>
                ) : (
                  <span>Top level</span>
                )}
              </div>
            </div>

            <div>
              <span id="move-resource-target-label" className="block text-xs font-semibold text-slate-700 mb-1.5">
                New parent <span className="text-[#EF1B24]">*</span>
              </span>
              {candidateParents.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center border border-dashed border-slate-200 rounded-lg">
                  No other resource in the model can contain a {resourceTypeLabel(selectedResource.type).toLowerCase()}.
                </p>
              ) : (
                <div role="radiogroup" aria-labelledby="move-resource-target-label" className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
                  {candidateParents.map((cand) => (
                    <label
                      key={cand.id}
                      className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                        selectedTargetId === cand.id
                          ? 'border-[#EF1B24] bg-red-50/40 ring-1 ring-[#EF1B24]'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <input
                          type="radio"
                          name="destination"
                          value={cand.id}
                          checked={selectedTargetId === cand.id}
                          onChange={() => {
                            setSelectedTargetId(cand.id);
                            setErrorMsg(null);
                          }}
                          className="text-[#EF1B24] focus:ring-[#EF1B24]"
                        />
                        <ResourceTypeIcon type={cand.type} size={14} className="text-slate-400" />
                        <div className="min-w-0">
                          <span className="font-semibold text-xs text-slate-800 block truncate" title={cand.name}>
                            {cand.name}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {resourceTypeLabel(cand.type)} · <span className="font-mono">{cand.code}</span>
                          </span>
                        </div>
                      </div>
                      {cand.id === currentParentId && (
                        <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                          Current
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-lg flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <p className="text-xs text-amber-800 leading-relaxed">
                Moving changes the path of this resource and of everything under it. Signals stay bound;
                their topics and the knowledge graph follow the new location.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg text-sm font-semibold hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={unchanged || submitting || candidateParents.length === 0}
              className="px-4 py-2 bg-[#EF1B24] hover:bg-[#D9141D] text-white rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              <span>{submitting ? 'Moving…' : 'Move'}</span>
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
