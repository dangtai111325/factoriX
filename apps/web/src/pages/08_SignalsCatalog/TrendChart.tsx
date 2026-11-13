import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SignalItem } from '../../types';

interface ObservationPoint {
  source_time: string;
  received_time: string;
  value: number | string | boolean | null;
  quality: string;
}

interface TrendSeries {
  signal: SignalItem;
  color: string;
  points: { time: number; value: number }[];
}

const SERIES_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B'];

interface TrendChartProps {
  selectedSignals: SignalItem[];
  timeframe: '15m' | '1h' | '6h';
  onTimeframeChange: (tf: '15m' | '1h' | '6h') => void;
}

export const TrendChart: React.FC<TrendChartProps> = ({
  selectedSignals,
  timeframe,
  onTimeframeChange,
}) => {
  const [seriesData, setSeriesData] = useState<TrendSeries[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selectedSignals.length === 0) {
      setSeriesData([]);
      return;
    }

    let isMounted = true;
    setLoading(true);

    const loadAll = async () => {
      try {
        const results = await Promise.all(
          selectedSignals.map(async (sig, idx) => {
            const color = SERIES_COLORS[idx % SERIES_COLORS.length];
            try {
              const res = await api<{ items: ObservationPoint[] }>(
                `/api/v1/observations/history?signal_id=${sig.id}&from=now-${timeframe}&limit=120`
              );
              const points = (res.items || [])
                .filter((pt) => typeof pt.value === 'number')
                .map((pt) => ({
                  time: new Date(pt.source_time || pt.received_time).getTime(),
                  value: Number(pt.value),
                }))
                .sort((a, b) => a.time - b.time);

              return { signal: sig, color, points };
            } catch {
              return { signal: sig, color, points: [] };
            }
          })
        );
        if (isMounted) {
          setSeriesData(results);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void loadAll();
    const interval = setInterval(loadAll, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [selectedSignals, timeframe]);

  if (selectedSignals.length === 0) {
    return (
      <div className="p-8 text-center bg-slate-50 border border-slate-200 rounded-xl text-[13px] text-[#657794]">
        Select up to 4 signals below to compare live trend data.
      </div>
    );
  }

  // Calculate bounds
  const allPoints = seriesData.flatMap((s) => s.points);
  const width = 800;
  const height = 220;
  const paddingLeft = 50;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;

  const minTime =
    allPoints.length > 0 ? Math.min(...allPoints.map((p) => p.time)) : Date.now() - 15 * 60 * 1000;
  const maxTime = allPoints.length > 0 ? Math.max(...allPoints.map((p) => p.time)) : Date.now();
  const timeSpan = Math.max(maxTime - minTime, 1000);

  const minVal = allPoints.length > 0 ? Math.min(...allPoints.map((p) => p.value)) : 0;
  const maxVal = allPoints.length > 0 ? Math.max(...allPoints.map((p) => p.value)) : 100;
  const valSpan = Math.max(maxVal - minVal, 1);

  const getX = (t: number) =>
    paddingLeft + ((t - minTime) / timeSpan) * (width - paddingLeft - paddingRight);
  const getY = (v: number) =>
    height - paddingBottom - ((v - minVal) / valSpan) * (height - paddingTop - paddingBottom);

  return (
    <div className="bg-white border border-[#CBD5E1] rounded-xl p-4 shadow-xs space-y-4">
      {/* Chart Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[13px] font-bold text-[#111B37]">Signal Trends</span>
          <div className="flex flex-wrap items-center gap-3">
            {seriesData.map(({ signal, color }) => (
              <div key={signal.id} className="flex items-center gap-1.5 text-[12px]">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                <span className="font-semibold text-[#111B37]">
                  {signal.displayName || signal.name || signal.key}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Timeframe selector */}
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
          {(['15m', '1h', '6h'] as const).map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeframeChange(tf)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded transition ${
                timeframe === tf ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* SVG Chart or Empty */}
      {allPoints.length === 0 ? (
        <div className="h-44 flex items-center justify-center text-[12px] text-[#657794]">
          {loading ? 'Loading historical trends…' : 'No recorded values in this timeframe.'}
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto min-w-[500px]"
            preserveAspectRatio="none"
          >
            {/* Gridlines */}
            {[0, 0.5, 1].map((pct, idx) => {
              const y = height - paddingBottom - pct * (height - paddingTop - paddingBottom);
              const val = (minVal + pct * valSpan).toFixed(1);
              return (
                <g key={idx}>
                  <line
                    x1={paddingLeft}
                    y1={y}
                    x2={width - paddingRight}
                    y2={y}
                    stroke="#E2E8F0"
                    strokeDasharray="4 4"
                  />
                  <text
                    x={paddingLeft - 8}
                    y={y + 3}
                    textAnchor="end"
                    fill="#94A3B8"
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    {val}
                  </text>
                </g>
              );
            })}

            {/* Time labels */}
            {[0, 0.5, 1].map((pct, idx) => {
              const t = new Date(minTime + pct * timeSpan);
              const x = paddingLeft + pct * (width - paddingLeft - paddingRight);
              const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return (
                <text
                  key={idx}
                  x={x}
                  y={height - 10}
                  textAnchor={idx === 0 ? 'start' : idx === 1 ? 'middle' : 'end'}
                  fill="#94A3B8"
                  fontSize="10"
                >
                  {timeStr}
                </text>
              );
            })}

            {/* Series Paths */}
            {seriesData.map(({ signal, color, points }) => {
              if (points.length === 0) return null;
              const pathD = points.length >= 2
                ? points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(pt.time)} ${getY(pt.value)}`).join(' ')
                : `M ${paddingLeft} ${getY(points[0].value)} L ${getX(points[0].time)} ${getY(points[0].value)}`;

              return (
                <g key={signal.id}>
                  <path
                    d={pathD}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {points.map((pt, i) => (
                    <circle
                      key={i}
                      cx={getX(pt.time)}
                      cy={getY(pt.value)}
                      r={points.length < 20 ? 3 : 1.5}
                      fill={color}
                    />
                  ))}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
};
