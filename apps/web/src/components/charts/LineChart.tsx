import React from 'react';

interface DataPoint {
  time: string;
  value: number;
}

interface LineChartProps {
  data: DataPoint[];
  height?: number;
  strokeColor?: string;
  fillColor?: string;
  unit?: string;
}

export const LineChart: React.FC<LineChartProps> = ({
  data,
  height = 140,
  strokeColor = '#EF1B24',
  fillColor = 'rgba(239, 27, 36, 0.08)',
  unit = 'msg/s',
}) => {
  if (!data || data.length === 0) return null;

  const width = 600;
  const paddingX = 40;
  const paddingY = 20;

  const values = data.map((d) => d.value);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05 || 1;

  const getX = (index: number) =>
    paddingX + (index / (data.length - 1)) * (width - paddingX * 2);

  const getY = (val: number) =>
    height - paddingY - ((val - minVal) / (maxVal - minVal)) * (height - paddingY * 2);

  const points = data.map((d, i) => `${getX(i)},${getY(d.value)}`).join(' ');

  const areaPoints = `${getX(0)},${height - paddingY} ${points} ${getX(
    data.length - 1
  )},${height - paddingY}`;

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto overflow-visible"
        preserveAspectRatio="none"
      >
        {/* Horizontal gridlines */}
        {[0, 0.5, 1].map((pct, idx) => {
          const y = height - paddingY - pct * (height - paddingY * 2);
          const labelVal = (minVal + pct * (maxVal - minVal)).toFixed(1);
          return (
            <g key={idx}>
              <line
                x1={paddingX}
                y1={y}
                x2={width - paddingX}
                y2={y}
                stroke="#EAF0F6"
                strokeDasharray="3 3"
              />
              <text
                x={paddingX - 6}
                y={y + 3}
                textAnchor="end"
                className="text-[10px] fill-[#94A3B8] font-mono"
              >
                {labelVal}
              </text>
            </g>
          );
        })}

        {/* Gradient fill */}
        <polygon points={areaPoints} fill={fillColor} />

        {/* Line stroke */}
        <polyline
          fill="none"
          stroke={strokeColor}
          strokeWidth="2.5"
          points={points}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {data.map((d, i) => (
          <circle
            key={i}
            cx={getX(i)}
            cy={getY(d.value)}
            r="3.5"
            className="fill-white stroke-[#EF1B24] stroke-[2]"
          />
        ))}

        {/* X Axis Time Labels */}
        {data.map((d, i) => (
          <text
            key={i}
            x={getX(i)}
            y={height - 4}
            textAnchor="middle"
            className="text-[10px] fill-[#94A3B8] font-mono"
          >
            {d.time}
          </text>
        ))}
      </svg>
    </div>
  );
};
