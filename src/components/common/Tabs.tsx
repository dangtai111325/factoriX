import React from 'react';

export interface TabItem {
  id: string;
  label: string;
  count?: number | string;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (id: string) => void;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({ tabs, activeTab, onChange, className = '' }) => {
  return (
    <div className={`flex items-center gap-6 border-b border-[#E3EAF3] ${className}`}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`pb-3 text-[13px] font-semibold flex items-center gap-2 border-b-2 transition-all cursor-pointer ${
              isActive
                ? 'border-[#EF1B24] text-[#EF1B24]'
                : 'border-transparent text-[#657794] hover:text-[#111B37]'
            }`}
          >
            {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span
                className={`px-1.5 py-0.2 rounded-full text-[11px] font-bold ${
                  isActive ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'bg-[#F1F5FA] text-[#657794]'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
