import React, { useState } from 'react';
import { X, ArrowRightLeft, FolderTree, AlertCircle } from 'lucide-react';

export interface MoveResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  resourceName?: string;
  currentPath?: string;
  onMoveResource?: (resourceName: string, newParentPath: string) => void;
}

export const MoveResourceModal: React.FC<MoveResourceModalProps> = ({
  isOpen,
  onClose,
  resourceName = 'CNC-01',
  currentPath = 'East Manufacturing > Plant 01 - Assembly > Zone A-Body > Line 01',
  onMoveResource,
}) => {
  const [selectedDestination, setSelectedDestination] = useState(
    'East Manufacturing > Plant 01 - Assembly > Zone A-Body > Line 02'
  );

  if (!isOpen) return null;

  const destinationOptions = [
    'East Manufacturing > Plant 01 - Assembly > Zone A-Body > Line 02',
    'East Manufacturing > Plant 01 - Assembly > Zone A-Body > Line 03',
    'East Manufacturing > Plant 01 - Assembly > Zone B-Paint > Line 01',
    'East Manufacturing > Plant 02 - Machining > Zone A > Line 01',
    'West Manufacturing > Plant 01 > Zone Packaging > Line 01',
  ];

  const handleConfirm = () => {
    onMoveResource?.(resourceName, selectedDestination);
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
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">Selected Resource</span>
            <div className="mt-1 font-bold text-slate-800 text-base">{resourceName}</div>
          </div>

          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">Current Location</span>
            <div className="mt-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700">
              {currentPath}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Select Target Destination (Parent Node) <span className="text-[#EF1B24]">*</span>
            </label>
            <div className="space-y-2">
              {destinationOptions.map((dest) => (
                <label
                  key={dest}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    selectedDestination === dest
                      ? 'border-[#EF1B24] bg-red-50/30 ring-1 ring-[#EF1B24]'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="destination"
                    value={dest}
                    checked={selectedDestination === dest}
                    onChange={(e) => setSelectedDestination(e.target.value)}
                    className="text-[#EF1B24] focus:ring-[#EF1B24]"
                  />
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-800">
                    <FolderTree className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <span>{dest}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-xs text-amber-800">
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <strong>Note:</strong> Moving this resource will update its Unified Namespace path and linked signal topic subscriptions while preserving historical records.
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-5 py-2 text-xs font-semibold text-white bg-[#EF1B24] hover:bg-[#d0171f] rounded-lg shadow-sm transition-all flex items-center gap-1.5"
          >
            <ArrowRightLeft className="w-4 h-4" /> Apply Move
          </button>
        </div>
      </div>
    </div>
  );
};
