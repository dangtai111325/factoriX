import React, { useState } from 'react';
import { X, ArrowRightLeft, FolderTree, AlertCircle, CheckCircle2 } from 'lucide-react';
import { ResourceNode } from '../../types';

export interface MoveResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedResource: ResourceNode;
  allResources: ResourceNode[];
  onMoveResource: (targetParentId: string) => void;
}

export const MoveResourceModal: React.FC<MoveResourceModalProps> = ({
  isOpen,
  onClose,
  selectedResource,
  allResources,
  onMoveResource,
}) => {
  // Filter valid potential parents (must not be itself or an invalid level)
  const candidateParents = allResources.filter(
    (r) => r.id !== selectedResource.id && r.type !== 'sensor'
  );

  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    candidateParents[0]?.id || ''
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentParent = allResources.find((r) => r.id === selectedResource.parentId);

  const handleConfirm = () => {
    if (!selectedTargetId) {
      setErrorMsg('Please select a destination parent.');
      return;
    }
    if (selectedTargetId === selectedResource.parentId) {
      setErrorMsg('Target destination is identical to current parent.');
      return;
    }
    onMoveResource(selectedTargetId);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
              <ArrowRightLeft className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Move Resource</h2>
              <p className="text-xs text-slate-500">Reassign hierarchy branch and topology relationships</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 text-sm">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">Selected Resource</span>
            <div className="mt-1 font-bold text-slate-800 text-base flex items-center gap-2">
              <span>{selectedResource.name}</span>
              <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-100 text-slate-600">
                {selectedResource.code}
              </span>
            </div>
          </div>

          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">Current Parent Node</span>
            <div className="mt-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700 flex items-center gap-2">
              <FolderTree className="w-3.5 h-3.5 text-slate-400" />
              <span>{currentParent ? `${currentParent.name} (${currentParent.type})` : 'Root Level / Enterprise'}</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Select New Parent Destination <span className="text-[#EF1B24]">*</span>
            </label>
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {candidateParents.map((cand) => (
                <label
                  key={cand.id}
                  className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all ${
                    selectedTargetId === cand.id
                      ? 'border-[#EF1B24] bg-red-50/40 ring-1 ring-[#EF1B24]'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
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
                    <div>
                      <span className="font-semibold text-xs text-slate-800 block">{cand.name}</span>
                      <span className="text-[10px] text-slate-400 font-mono capitalize">{cand.type} · {cand.code}</span>
                    </div>
                  </div>
                  {cand.id === selectedResource.parentId && (
                    <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                      Current
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>

          <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-lg flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800 leading-relaxed">
              <strong>Impact Preview:</strong> Moving this resource will automatically update parent breadcrumbs,
              connected telemetry paths, and the industrial knowledge graph. Sub-assets will move along with it.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg text-sm font-semibold hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 bg-[#EF1B24] hover:bg-[#D9141D] text-white rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 shadow-sm"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Confirm Move</span>
          </button>
        </div>
      </div>
    </div>
  );
};
