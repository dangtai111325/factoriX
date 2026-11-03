import React from 'react'

interface DataPoint {
  time: string
  value: number
  at?: number
}

interface LineChartProps {
  data: DataPoint[]
  height?: number
  strokeColor?: string
  fillColor?: string
  unit?: string
}

export const LineChart: React.FC<LineChartProps> = ({
  data,
  height = 140,
  strokeColor = '#EF1B24',
  fillColor = 'rgba(239, 27, 36, 0.08)',
  unit = 'msg/s',
}) => {
  const pointsToPlot = data.filter((point) => Number.isFinite(point.value))
  if (pointsToPlot.length === 0) return null

  const width = 600
  const paddingX = 40
  const paddingY = 20

  const values = pointsToPlot.map((d) => d.value)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const margin = high === low ? Math.max(Math.abs(low) * 0.05, 1) : (high - low) * 0.05
  const minVal = low - margin
  const maxVal = high + margin
  const usesTime = pointsToPlot.every(point => typeof point.at === 'number' && Number.isFinite(point.at))
  const times = usesTime ? pointsToPlot.map(point => point.at as number) : []
  const firstAt = usesTime ? Math.min(...times) : 0
  const lastAt = usesTime ? Math.max(...times) : 0

  const getX = (index: number) =>
    pointsToPlot.length === 1
      ? width / 2
      : usesTime
        ? lastAt === firstAt ? width / 2 : paddingX + ((times[index] - firstAt) / (lastAt - firstAt)) * (width - paddingX * 2)
      : paddingX + (index / (pointsToPlot.length - 1)) * (width - paddingX * 2)

  const getY = (val: number) =>
    height - paddingY - ((val - minVal) / (maxVal - minVal)) * (height - paddingY * 2)

  const points = pointsToPlot.map((d, i) => `${getX(i)},${getY(d.value)}`).join(' ')

  const areaPoints = `${getX(0)},${height - paddingY} ${points} ${getX(
    pointsToPlot.length - 1,
  )},${height - paddingY}`

  return (
    <div className="w-full">
      <svg
        role="img"
        aria-label={`Observed values${unit ? ` (${unit})` : ''}`}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto overflow-visible"
        preserveAspectRatio="none"
      >
        {/* Horizontal gridlines */}
        {[0, 0.5, 1].map((pct, idx) => {
          const y = height - paddingY - pct * (height - paddingY * 2)
          const labelVal = (minVal + pct * (maxVal - minVal)).toFixed(1)
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
          )
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
        {pointsToPlot.map((d, i) => (
          <circle
            key={i}
            cx={getX(i)}
            cy={getY(d.value)}
            r="3.5"
            fill="white"
            stroke={strokeColor}
            strokeWidth="2"
          />
        ))}

        {/* X Axis Time Labels */}
        {pointsToPlot.map(
          (d, i) =>
            (i === 0 ||
              i === pointsToPlot.length - 1 ||
              i % Math.max(1, Math.ceil(pointsToPlot.length / 4)) === 0) && (
              <text
                key={i}
                x={getX(i)}
                y={height - 4}
                textAnchor="middle"
                className="text-[10px] fill-[#94A3B8] font-mono"
              >
                {d.time}
              </text>
            ),
        )}
      </svg>
    </div>
  )
}
