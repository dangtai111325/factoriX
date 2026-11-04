import React from 'react';
import { X, Info, ShieldCheck } from 'lucide-react';

interface AboutFactorixModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutFactorixModal: React.FC<AboutFactorixModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className="w-full max-w-md bg-white rounded-xl shadow-2xl border border-[#D4DFEC] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
      >
        <div className="p-6">
          <div className="flex items-center justify-between pb-3 border-b border-[#E3EAF3]">
            <div className="flex items-center gap-2.5 text-[#111B37]">
              <div className="p-2 rounded-lg bg-[#EEF5FF] text-[#0B2545]">
                <Info className="w-5 h-5" />
              </div>
              <h3 id="about-modal-title" className="text-[16px] font-bold">
                About FactoriX
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-[#94A3B8] hover:text-[#334568] transition-colors p-1 rounded-md"
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="py-5 text-center space-y-4">
            <div className="flex justify-center">
              <img src="/factorix-logo.png" alt="FactoriX" className="h-10 w-auto object-contain" />
            </div>
            <div>
              <h4 className="text-[17px] font-bold text-[#111B37]">FactoriX Industrial IoT</h4>
              <p className="text-[13px] text-[#657794] mt-0.5">Unified Namespace Data Collection Appliance</p>
            </div>

            <div className="p-3 bg-[#F8FAFC] rounded-lg border border-[#E2E8F0] inline-block w-full text-left space-y-2 text-[12px]">
              <div className="flex justify-between">
                <span className="text-[#64748B]">Version</span>
                <span className="font-mono font-semibold text-[#0F172A]">1.0.0</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#64748B]">Platform</span>
                <span className="text-[#0F172A]">Enterprise Edge Appliance</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#64748B]">Publisher</span>
                <span className="text-[#0F172A]">Avenue Industrial Automation</span>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-[#F1F5F9]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-semibold bg-[#0B2545] text-white hover:bg-[#134074] rounded-lg shadow-sm transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
