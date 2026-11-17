import React from 'react';
import { Database, HardDrive } from 'lucide-react';

export type StorageEngine = 'tdengine' | 'postgresql';

interface StorageEngineSwitcherProps {
  activeEngine: StorageEngine;
  onChange: (engine: StorageEngine) => void;
}

export const StorageEngineSwitcher: React.FC<StorageEngineSwitcherProps> = ({
  activeEngine,
  onChange,
}) => {
  return (
    <div className="flex items-center gap-2 p-1 bg-[#EEF2F6] rounded-lg">
      <button
        type="button"
        onClick={() => onChange('tdengine')}
        className={`flex items-center gap-2.5 px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-all ${
          activeEngine === 'tdengine'
            ? 'bg-white text-[#111B37] shadow-sm'
            : 'text-[#657794] hover:text-[#111B37] hover:bg-white/60'
        }`}
        aria-pressed={activeEngine === 'tdengine'}
      >
        <HardDrive className={`w-4 h-4 ${activeEngine === 'tdengine' ? 'text-[#EF1B24]' : 'text-[#657794]'}`} />
        <span>TDengine (Managed)</span>
      </button>

      <button
        type="button"
        onClick={() => onChange('postgresql')}
        className={`flex items-center gap-2.5 px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-all ${
          activeEngine === 'postgresql'
            ? 'bg-white text-[#111B37] shadow-sm'
            : 'text-[#657794] hover:text-[#111B37] hover:bg-white/60'
        }`}
        aria-pressed={activeEngine === 'postgresql'}
      >
        <Database className={`w-4 h-4 ${activeEngine === 'postgresql' ? 'text-[#1976D2]' : 'text-[#657794]'}`} />
        <span>PostgreSQL (Read Only)</span>
      </button>
    </div>
  );
};
