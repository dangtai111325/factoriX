import React from 'react';

interface KPICardProps {
  title: string;
  value: string | number;
  total?: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  icon: React.ReactNode;
  iconBg?: string;
  unit?: string;
}

export const KPICard: React.FC<KPICardProps> = ({
  title,
  value,
  total,
  change,
  changeType = 'neutral',
  icon,
  iconBg = 'bg-[#FFF0F1] text-[#EF1B24]',
  unit,
}) => {
  return (
    <div className="fx-card p-4 flex items-center justify-between">
      <div>
        <span className="text-[12px] font-semibold text-[#657794] uppercase tracking-wider block mb-1">
          {title}
        </span>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[26px] font-extrabold text-[#111B37] tracking-tight tabular-nums">
            {value}
          </span>
          {unit && <span className="text-[13px] font-bold text-[#657794]">{unit}</span>}
          {total && <span className="text-[13px] font-medium text-[#94A3B8]">/ {total}</span>}
        </div>
        {change && (
          <p
            className={`text-[11px] font-semibold mt-1 flex items-center gap-1 ${
              changeType === 'positive'
                ? 'text-[#0DBA67]'
                : changeType === 'negative'
                ? 'text-[#F2343B]'
                : 'text-[#657794]'
            }`}
          >
            {change}
          </p>
        )}
      </div>
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}
      >
        {icon}
      </div>
    </div>
  );
};
