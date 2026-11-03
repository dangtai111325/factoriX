import React from 'react';

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  title: string;
  total: number;
  centerLabel?: string;
  segments: DonutSegment[];
  size?: number;
}

export const DonutChart: React.FC<DonutChartProps> = ({
  title,
  total,
  centerLabel = 'Total',
  segments,
  size = 130,
}) => {
  const strokeWidth = 16;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulatedAngle = 0;

  return (
    <div className="flex flex-col h-full justify-between">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[13px] font-bold text-[#111B37]">{title}</h4>
      </div>

      <div className="flex items-center justify-around gap-4 py-2">
        {/* SVG Donut */}
        <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="transform -rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke="#F1F5FA"
              strokeWidth={strokeWidth}
              fill="transparent"
            />
            {segments.map((seg, idx) => {
              const fraction = total > 0 ? seg.value / total : 0;
              const strokeDasharray = `${fraction * circumference} ${circumference}`;
              const strokeDashoffset = -accumulatedAngle * circumference;
              accumulatedAngle += fraction;

              return (
                <circle
                  key={idx}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={strokeDasharray}
                  strokeDashoffset={strokeDashoffset}
                  fill="transparent"
                  strokeLinecap="round"
                  className="transition-all duration-300"
                />
              );
            })}
          </svg>

          {/* Center text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-[20px] font-extrabold text-[#111B37] leading-none">{total}</span>
            <span className="text-[10px] font-semibold text-[#657794] mt-0.5 uppercase">{centerLabel}</span>
          </div>
        </div>

        {/* Legend */}
        <div className="space-y-1.5">
          {segments.map((seg, idx) => (
            <div key={idx} className="flex items-center gap-2 text-[12px]">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="text-[#657794] min-w-[70px]">{seg.label}</span>
              <span className="font-bold text-[#111B37] tabular-nums">{seg.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
