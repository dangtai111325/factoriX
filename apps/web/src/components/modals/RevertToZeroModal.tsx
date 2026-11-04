import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useApp } from '../../store/AppContext';

interface RevertToZeroModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RevertToZeroModal: React.FC<RevertToZeroModalProps> = ({ isOpen, onClose }) => {
  const { revertToZero } = useApp();
  const [inputVal, setInputVal] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (inputVal !== 'REVERT') return;
    setIsSubmitting(true);
    setError(null);
    try {
      await revertToZero('REVERT');
      onClose();
      window.location.assign('/register');
    } catch (err: any) {
      setError(err?.message || 'Failed to revert system. Please try again.');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-white rounded-xl shadow-2xl border border-[#FAC6C9] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revert-modal-title"
      >
        <div className="p-6">
          <div className="flex items-center justify-between pb-3 border-b border-[#FEE2E2]">
            <div className="flex items-center gap-3 text-[#EF1B24]">
              <div className="p-2 rounded-lg bg-[#FEF2F2]">
                <AlertTriangle className="w-5 h-5 text-[#EF1B24]" />
              </div>
              <h3 id="revert-modal-title" className="text-[16px] font-bold text-[#111B37]">
                Revert to Zero
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="text-[#94A3B8] hover:text-[#334568] transition-colors p-1 rounded-md"
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="py-4 space-y-3">
            <p className="text-[13px] text-[#475569] leading-relaxed">
              This action will reset your FactoriX appliance back to its factory initial state. All factory resources, connections, signals, telemetry observations, and administrator accounts will be permanently erased.
            </p>
            <div className="p-3 bg-[#FFF5F5] rounded-lg border border-[#FED7D7] text-[12px] text-[#9B1C1C]">
              <span className="font-semibold block mb-0.5">This action cannot be undone.</span>
              To confirm, type <span className="font-mono font-bold bg-[#FEE2E2] px-1.5 py-0.5 rounded">REVERT</span> in the field below.
            </div>

            <div className="pt-2">
              <label htmlFor="revert-confirmation-input" className="block text-[12px] font-semibold text-[#334568] mb-1">
                Confirmation
              </label>
              <input
                id="revert-confirmation-input"
                type="text"
                autoFocus
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="Type REVERT to confirm"
                className="w-full px-3 py-2 text-[13px] border border-[#CBD5E1] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24] font-mono tracking-wider"
              />
            </div>

            {error && (
              <p className="text-[12px] text-[#EF1B24] font-medium">{error}</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-[#F1F5F9]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-[13px] font-medium text-[#475569] hover:bg-[#F1F5F9] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={inputVal !== 'REVERT' || isSubmitting}
              className={`px-4 py-2 text-[13px] font-semibold rounded-lg transition-all ${
                inputVal === 'REVERT' && !isSubmitting
                  ? 'bg-[#EF1B24] text-white hover:bg-[#D9151E] shadow-sm'
                  : 'bg-[#FEE2E2] text-[#FCA5A5] cursor-not-allowed'
              }`}
            >
              {isSubmitting ? 'Reverting…' : 'Revert to zero'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
