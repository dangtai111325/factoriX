import React, { useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitCommit,
  Info,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { StatusBadge } from '../../components/common/StatusBadge';
import { formatTimestamp, formatValue } from '../../lib/format';
import {
  HistorianEventItem,
  HistorianMode,
  HistorianPoint,
  HistorianSeriesData,
  QualitySegment,
} from './types';

interface HistorianTrendChartProps {
  seriesList: HistorianSeriesData[];
  events: HistorianEventItem[];
  mode: HistorianMode;
  startMs: number;
  endMs: number;
  loading: boolean;
  hiddenSignalIds: Set<string>;
  onToggleSeriesVisibility: (signalId: string) => void;
  onSelectPoint?: (pt: HistorianPoint) => void;
}

const QUALITY_BAR_COLOR: Record<QualitySegment['quality'], string> = {
  GOOD: '#0DBA67',
  UNCERTAIN: '#F59E0B',
  STALE: '#64748B',
  BAD: '#EF4444',
};

export const HistorianTrendChart: React.FC<HistorianTrendChartProps> = ({
  seriesList,
  events,
  mode,
  startMs,
  endMs,
  loading,
  hiddenSignalIds,
  onToggleSeriesVisibility,
  onSelectPoint,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverTimeMs, setHoverTimeMs] = useState<number | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<HistorianEventItem | null>(null);

  const visibleSeries = useMemo(
    () => seriesList.filter((s) => !hiddenSignalIds.has(s.signal.id)),
    [seriesList, hiddenSignalIds],
  );

  const width = 920;
  const height = 280;
  const padLeft = 58;
  const padRight = 54;
  const padTop = 22;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const effStartMs = useMemo(() => {
    const allPts = seriesList.flatMap((s) => s.points);
    if (allPts.length === 0) return startMs;
    return Math.min(startMs, ...allPts.map((p) => p.timestampMs));
  }, [seriesList, startMs]);

  const effEndMs = useMemo(() => {
    const allPts = seriesList.flatMap((s) => s.points);
    if (allPts.length === 0) return endMs;
    return Math.max(endMs, ...allPts.map((p) => p.timestampMs));
  }, [seriesList, endMs]);

  const timeSpan = Math.max(1000, effEndMs - effStartMs);

  const getX = (ms: number) => {
    const clamped = Math.max(effStartMs, Math.min(effEndMs, ms));
    return padLeft + ((clamped - effStartMs) / timeSpan) * plotWidth;
  };

  // Multi-axis scaling by unit group so series with different units don't distort each other
  const unitAxes = useMemo(() => {
    const map = new Map<
      string,
      { unit: string; min: number; max: number; span: number; isDiscrete: boolean; discreteLabels: string[] }
    >();

    for (const s of visibleSeries) {
      const unitKey = s.isDiscrete ? `__discrete_${s.signal.id}` : (s.signal.unit || 'default');
      if (s.isDiscrete) {
        const distinct = Array.from(
          new Set(
            s.points
              .filter((p) => p.value !== null && p.value !== undefined)
              .map((p) => String(p.value)),
          ),
        );
        if (distinct.length === 0) distinct.push('false', 'true');
        map.set(unitKey, {
          unit: s.signal.unit || 'state',
          min: 0,
          max: Math.max(1, distinct.length - 1),
          span: Math.max(1, distinct.length - 1),
          isDiscrete: true,
          discreteLabels: distinct,
        });
      } else {
        const nums = s.points
          .filter((p) => p.numericValue !== null && Number.isFinite(p.numericValue))
          .map((p) => p.numericValue as number);
        if (nums.length === 0) continue;
        const sMin = Math.min(...nums);
        const sMax = Math.max(...nums);
        const existing = map.get(unitKey);
        if (!existing) {
          const pad = sMax === sMin ? Math.max(1, Math.abs(sMin) * 0.1) : (sMax - sMin) * 0.08;
          const min = sMin - pad;
          const max = sMax + pad;
          map.set(unitKey, {
            unit: s.signal.unit || '',
            min,
            max,
            span: Math.max(1e-6, max - min),
            isDiscrete: false,
            discreteLabels: [],
          });
        } else {
          const rawMin = Math.min(existing.min, sMin);
          const rawMax = Math.max(existing.max, sMax);
          const span = Math.max(1e-6, rawMax - rawMin);
          map.set(unitKey, {
            ...existing,
            min: rawMin,
            max: rawMax,
            span,
          });
        }
      }
    }
    return map;
  }, [visibleSeries]);

  const primaryAxis = useMemo(() => {
    for (const ax of unitAxes.values()) {
      if (!ax.isDiscrete) return ax;
    }
    const first = unitAxes.values().next().value;
    return (
      first || {
        unit: '',
        min: 0,
        max: 100,
        span: 100,
        isDiscrete: false,
        discreteLabels: [],
      }
    );
  }, [unitAxes]);

  const secondaryAxis = useMemo(() => {
    let count = 0;
    for (const ax of unitAxes.values()) {
      if (!ax.isDiscrete) {
        count += 1;
        if (count === 2) return ax;
      }
    }
    return null;
  }, [unitAxes]);

  const getPointY = (s: HistorianSeriesData, pt: HistorianPoint): number | null => {
    if (pt.value === null || pt.value === undefined) return null;
    const unitKey = s.isDiscrete ? `__discrete_${s.signal.id}` : (s.signal.unit || 'default');
    const axis = unitAxes.get(unitKey) || primaryAxis;
    if (s.isDiscrete) {
      const idx = Math.max(0, axis.discreteLabels.indexOf(String(pt.value)));
      const norm = axis.discreteLabels.length <= 1 ? 0.5 : idx / (axis.discreteLabels.length - 1);
      return padTop + plotHeight - norm * plotHeight;
    }
    if (pt.numericValue === null || !Number.isFinite(pt.numericValue)) return null;
    const norm = (pt.numericValue - axis.min) / axis.span;
    return padTop + plotHeight - Math.max(0, Math.min(1, norm)) * plotHeight;
  };

  // Build SVG path per series with truthful gap handling and step-after for discrete / reconstructed
  const renderedPaths = useMemo(() => {
    return visibleSeries.map((s) => {
      const sorted = [...s.points].sort((a, b) => a.timestampMs - b.timestampMs);
      const useStep = s.isDiscrete || mode === 'reconstructed';
      const segments: string[] = [];
      const circles: Array<{
        pt: HistorianPoint;
        x: number;
        y: number;
      }> = [];

      let prevX: number | null = null;
      let prevY: number | null = null;

      for (const pt of sorted) {
        const upperQ = (pt.quality || 'GOOD').toUpperCase();
        const isGap =
          pt.value === null ||
          pt.value === undefined ||
          upperQ === 'STALE' ||
          upperQ === 'BAD' ||
          pt.recordKind === 'gap_marker';

        if (isGap) {
          // If step-hold reconstructed transitions into a gap, extend horizontal hold up to gap timestamp, then break!
          if (useStep && prevX !== null && prevY !== null) {
            const gapX = getX(pt.timestampMs);
            segments.push(`L ${gapX.toFixed(1)} ${prevY.toFixed(1)}`);
          }
          prevX = null;
          prevY = null;
          continue;
        }

        const y = getPointY(s, pt);
        if (y === null) {
          prevX = null;
          prevY = null;
          continue;
        }
        const x = getX(pt.timestampMs);
        if (prevX === null || prevY === null) {
          segments.push(`M ${x.toFixed(1)} ${y.toFixed(1)}`);
        } else if (useStep) {
          segments.push(`L ${x.toFixed(1)} ${prevY.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`);
        } else {
          segments.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`);
        }
        prevX = x;
        prevY = y;
        circles.push({ pt, x, y });
      }

      return {
        series: s,
        pathD: segments.join(' '),
        circles,
        useStep,
      };
    });
  }, [visibleSeries, mode, effStartMs, effEndMs, unitAxes]);

  // Nearest point per visible series at hoverTimeMs
  const hoverDetails = useMemo(() => {
    if (hoverTimeMs === null) return [];
    return visibleSeries.map((s) => {
      if (s.points.length === 0) return { series: s, point: null };
      let best = s.points[0];
      let bestDist = Math.abs(best.timestampMs - hoverTimeMs);
      for (const pt of s.points) {
        const dist = Math.abs(pt.timestampMs - hoverTimeMs);
        if (dist < bestDist) {
          best = pt;
          bestDist = dist;
        }
      }
      return { series: s, point: best };
    });
  }, [hoverTimeMs, visibleSeries]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    if (relX < padLeft || relX > width - padRight) {
      setHoverX(null);
      setHoverTimeMs(null);
      return;
    }
    setHoverX(relX);
    const ratio = (relX - padLeft) / plotWidth;
    setHoverTimeMs(Math.round(effStartMs + ratio * timeSpan));
  };

  const handleMouseLeave = () => {
    setHoverX(null);
    setHoverTimeMs(null);
  };

  // Shaded BAD / STALE gap bands across the chart
  const gapBands = useMemo(() => {
    const bands: Array<{ startX: number; width: number; quality: 'STALE' | 'BAD' }> = [];
    for (const s of visibleSeries) {
      for (const seg of s.qualitySegments) {
        if (seg.quality === 'STALE' || seg.quality === 'BAD') {
          const x1 = getX(seg.startMs);
          const x2 = getX(seg.endMs);
          if (x2 - x1 >= 2) {
            bands.push({ startX: x1, width: x2 - x1, quality: seg.quality });
          }
        }
      }
    }
    return bands.slice(0, 40);
  }, [visibleSeries, effStartMs, effEndMs]);

  return (
    <div className="space-y-3">
      {/* Main Multi-Series Trend Chart Card */}
      <div className="bg-white border border-[#E3EAF3] rounded-xl p-4 shadow-xs space-y-3">
        {/* Legend & Series Toggles */}
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[#E3EAF3]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-bold text-[#111B37] mr-1">Multi-Series Trend</span>
            {seriesList.map((s) => {
              const hidden = hiddenSignalIds.has(s.signal.id);
              const sigLabel = s.signal.displayName || s.signal.name || s.signal.key || s.signal.id;
              return (
                <button
                  key={s.signal.id}
                  type="button"
                  onClick={() => onToggleSeriesVisibility(s.signal.id)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${
                    hidden
                      ? 'bg-slate-50 text-[#94A3B8] border-slate-200 line-through'
                      : 'bg-[#F6F8FC] text-[#111B37] border-[#D4DFEC] hover:border-[#94A3B8]'
                  }`}
                  title={hidden ? `Show ${sigLabel}` : `Hide ${sigLabel}`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: hidden ? '#CBD5E1' : s.color }}
                  />
                  <span className="truncate max-w-[160px]">{sigLabel}</span>
                  <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-white border border-[#E3EAF3] text-[#657794]">
                    {s.isDiscrete ? 'STEP' : mode === 'reconstructed' ? 'STEP-HOLD' : 'LINE'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-[#657794]">
            {secondaryAxis && (
              <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                Multi-Axis ({primaryAxis.unit || 'num'} / {secondaryAxis.unit || 'num'})
              </span>
            )}
            <span className="font-mono">
              {new Date(effStartMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              {' – '}
              {new Date(effEndMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
        </div>

        {/* SVG Canvas */}
        {seriesList.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 bg-[#F6F8FC] rounded-lg border border-dashed border-[#D4DFEC]">
            <Activity className="w-8 h-8 text-[#94A3B8] mb-2" />
            <div className="text-[13px] font-bold text-[#111B37]">No Series Selected</div>
            <p className="text-[12px] text-[#657794] max-w-md mt-1">
              Select up to 8 signals or a published storage dataset from the left picker to inspect historical trends,
              quality lanes, and state transitions.
            </p>
          </div>
        ) : (
          <div className="relative">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-[270px] select-none cursor-crosshair overflow-visible"
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              {/* Shaded STALE / BAD intervals (HIS-02: never fabricate continuous GOOD across gaps) */}
              {gapBands.map((band, idx) => (
                <rect
                  key={idx}
                  x={band.startX}
                  y={padTop}
                  width={band.width}
                  height={plotHeight}
                  fill={band.quality === 'BAD' ? 'rgba(239, 68, 68, 0.08)' : 'rgba(100, 116, 139, 0.08)'}
                />
              ))}

              {/* Horizontal Gridlines & Primary Y-Axis Labels */}
              {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
                const y = padTop + plotHeight - pct * plotHeight;
                const label = primaryAxis.isDiscrete
                  ? primaryAxis.discreteLabels[Math.round(pct * (primaryAxis.discreteLabels.length - 1))] || ''
                  : (primaryAxis.min + pct * primaryAxis.span).toFixed(1);
                const rightLabel = secondaryAxis
                  ? (secondaryAxis.min + pct * secondaryAxis.span).toFixed(1)
                  : null;

                return (
                  <g key={idx}>
                    <line
                      x1={padLeft}
                      y1={y}
                      x2={width - padRight}
                      y2={y}
                      stroke="#E3EAF3"
                      strokeDasharray={idx === 0 || idx === 4 ? undefined : '4 4'}
                    />
                    <text
                      x={padLeft - 8}
                      y={y + 3}
                      textAnchor="end"
                      fill="#657794"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      {label}
                    </text>
                    {rightLabel && (
                      <text
                        x={width - padRight + 8}
                        y={y + 3}
                        textAnchor="start"
                        fill="#657794"
                        fontSize="10"
                        fontFamily="monospace"
                      >
                        {rightLabel}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* X-Axis Time Labels */}
              {[0, 0.25, 0.5, 0.75, 1].map((pct, idx) => {
                const tMs = effStartMs + pct * timeSpan;
                const x = padLeft + pct * plotWidth;
                const label = new Date(tMs).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
                return (
                  <text
                    key={idx}
                    x={x}
                    y={height - 8}
                    textAnchor={idx === 0 ? 'start' : idx === 4 ? 'end' : 'middle'}
                    fill="#657794"
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    {label}
                  </text>
                );
              })}

              {/* Series Paths & Points */}
              {renderedPaths.map(({ series, pathD, circles }) => (
                <g key={series.signal.id}>
                  {pathD && (
                    <path
                      d={pathD}
                      fill="none"
                      stroke={series.color}
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                  {circles.map(({ pt, x, y }, i) => (
                    <circle
                      key={pt.id || i}
                      cx={x}
                      cy={y}
                      r={pt.virtual ? 3.5 : circles.length < 40 ? 3 : 1.75}
                      fill={pt.virtual ? '#FFFFFF' : series.color}
                      stroke={series.color}
                      strokeWidth={pt.virtual ? '2' : '1'}
                      className="cursor-pointer"
                      onClick={() => onSelectPoint?.(pt)}
                    />
                  ))}
                </g>
              ))}

              {/* Crosshair Line */}
              {hoverX !== null && (
                <line
                  x1={hoverX}
                  y1={padTop}
                  x2={hoverX}
                  y2={height - padBottom}
                  stroke="#111B37"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
              )}
            </svg>

            {loading && (
              <div className="absolute inset-0 bg-white/65 backdrop-blur-[1px] flex items-center justify-center rounded-lg">
                <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white border border-[#E3EAF3] shadow-sm text-[12px] font-semibold text-[#111B37]">
                  <span className="w-3.5 h-3.5 border-2 border-[#EF1B24] border-t-transparent rounded-full animate-spin" />
                  Querying TDengine time-series…
                </div>
              </div>
            )}

            {/* Interactive Crosshair Tooltip */}
            {hoverTimeMs !== null && hoverDetails.some((d) => d.point !== null) && (
              <div
                data-testid="historian-crosshair-tooltip"
                className="mt-2 p-3 rounded-xl bg-[#111B37] text-white shadow-lg border border-slate-700 text-[11px] space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5 border-b border-slate-700">
                  <div className="flex items-center gap-1.5 font-mono text-slate-200">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    <span>Cursor: {formatTimestamp(new Date(hoverTimeMs).toISOString())}</span>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-semibold">
                    Mode: {mode}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {hoverDetails.map(({ series, point }) => {
                    if (!point) return null;
                    const name =
                      series.signal.displayName || series.signal.name || series.signal.key || series.signal.id;
                    return (
                      <div
                        key={series.signal.id}
                        className="p-2 rounded-lg bg-slate-800/90 border border-slate-700 flex flex-col gap-1"
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: series.color }}
                            />
                            <span className="font-bold truncate text-white">{name}</span>
                          </div>
                          <StatusBadge status={point.quality} />
                        </div>
                        <div className="flex items-baseline justify-between gap-2 mt-0.5">
                          <span className="font-mono text-[13px] font-extrabold text-white">
                            {formatValue(point.value)}
                          </span>
                          {point.virtual && (
                            <span className="text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-indigo-500/30 text-indigo-200 border border-indigo-400/40">
                              virtual step-hold
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400 truncate">
                          acq: {formatTimestamp(point.acquiredAt)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Synchronized Quality & Freshness Lane */}
      <div
        data-testid="quality-freshness-lane"
        className="bg-white border border-[#E3EAF3] rounded-xl p-3.5 shadow-xs space-y-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#334568]" />
            <span className="text-[12px] font-bold text-[#111B37]">
              Synchronized Quality &amp; Freshness Lane
            </span>
            <span className="text-[11px] text-[#657794]">
              Truthful signal validity timeline (`canonical_stale_after_ms` gap detection)
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] font-semibold">
            <span className="inline-flex items-center gap-1 text-emerald-800">
              <span className="w-2.5 h-2.5 rounded-xs bg-[#0DBA67]" /> GOOD
            </span>
            <span className="inline-flex items-center gap-1 text-amber-800">
              <span className="w-2.5 h-2.5 rounded-xs bg-[#F59E0B]" /> UNCERTAIN
            </span>
            <span className="inline-flex items-center gap-1 text-slate-700">
              <span className="w-2.5 h-2.5 rounded-xs bg-[#64748B]" /> STALE
            </span>
            <span className="inline-flex items-center gap-1 text-red-800">
              <span className="w-2.5 h-2.5 rounded-xs bg-[#EF4444]" /> BAD
            </span>
          </div>
        </div>

        {visibleSeries.length === 0 ? (
          <div className="text-[11px] text-[#657794] py-1">Select a signal to view quality timeline segments.</div>
        ) : (
          <div className="space-y-1.5">
            {visibleSeries.map((s) => {
              const name = s.signal.displayName || s.signal.name || s.signal.key || s.signal.id;
              return (
                <div key={s.signal.id} className="flex items-center gap-3">
                  <div className="w-36 shrink-0 flex items-center gap-1.5 text-[11px] font-semibold text-[#334568] truncate">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                    <span className="truncate" title={name}>
                      {name}
                    </span>
                  </div>
                  <div className="flex-1 h-4 bg-slate-100 rounded-md overflow-hidden relative border border-[#E3EAF3]">
                    {s.qualitySegments.length === 0 ? (
                      <div className="w-full h-full flex items-center justify-center text-[9px] font-mono text-[#94A3B8]">
                        NO SAMPLES IN WINDOW
                      </div>
                    ) : (
                      s.qualitySegments.map((seg, i) => {
                        const leftPct = Math.max(0, Math.min(100, ((seg.startMs - effStartMs) / timeSpan) * 100));
                        const widthPct = Math.max(
                          0.5,
                          Math.min(100 - leftPct, ((seg.endMs - seg.startMs) / timeSpan) * 100),
                        );
                        return (
                          <div
                            key={i}
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              backgroundColor: QUALITY_BAR_COLOR[seg.quality],
                            }}
                            title={`${seg.quality}${seg.reasonCode ? ` (${seg.reasonCode})` : ''}: ${new Date(
                              seg.startMs,
                            ).toLocaleTimeString()} – ${new Date(seg.endMs).toLocaleTimeString()}`}
                            className="absolute top-0 bottom-0 transition-opacity hover:opacity-85"
                          />
                        );
                      })
                    )}
                  </div>
                  <div className="w-16 shrink-0 text-right font-mono text-[11px] font-bold text-[#111B37]">
                    {s.stats.goodPct.toFixed(0)}% Good
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Synchronized Events & Operations Lane */}
      <div
        data-testid="events-operations-lane"
        className="bg-white border border-[#E3EAF3] rounded-xl p-3.5 shadow-xs space-y-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitCommit className="w-4 h-4 text-[#334568]" />
            <span className="text-[12px] font-bold text-[#111B37]">
              Synchronized Events &amp; Operations Lane
            </span>
            <span className="text-[11px] text-[#657794]">
              Quality transitions, storage publish/pause operations, and telemetry epoch reset markers
            </span>
          </div>
          <span className="text-[11px] font-mono font-semibold text-[#657794]">
            {events.length} event{events.length === 1 ? '' : 's'} in range
          </span>
        </div>

        {/* Timeline Marker Strip */}
        <div className="relative h-7 bg-[#F6F8FC] border border-[#E3EAF3] rounded-lg overflow-hidden">
          {events.length === 0 ? (
            <div className="w-full h-full flex items-center justify-center text-[11px] text-[#94A3B8]">
              No quality transitions, storage operations, or epoch boundary events in this window
            </div>
          ) : (
            events.map((ev) => {
              const leftPct = Math.max(2, Math.min(98, ((ev.timestampMs - effStartMs) / timeSpan) * 100));
              const isReset = ev.kind === 'EPOCH_RESET' || ev.summary.toUpperCase().includes('EPOCH');
              const isBad = ev.toQuality === 'BAD' || ev.toQuality === 'STALE';
              const markerColor = isReset ? '#EF1B24' : isBad ? '#F59E0B' : '#0DBA67';
              return (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => setSelectedEvent(selectedEvent?.id === ev.id ? null : ev)}
                  style={{ left: `${leftPct}%` }}
                  title={`${formatTimestamp(ev.timestamp)} — ${ev.summary}`}
                  className="absolute top-1 bottom-1 -translate-x-1/2 px-1.5 rounded flex items-center gap-1 text-[10px] font-bold text-white shadow-xs cursor-pointer transition-transform hover:scale-105"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full border border-white shadow-xs"
                    style={{ backgroundColor: markerColor }}
                  />
                </button>
              );
            })
          )}
        </div>

        {/* Event Pills / Details */}
        {events.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 max-h-24 overflow-y-auto pt-0.5">
            {events.slice(0, 12).map((ev) => {
              const isReset = ev.kind === 'EPOCH_RESET';
              const isOp = ev.kind === 'STORAGE_OPERATION';
              return (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => setSelectedEvent(selectedEvent?.id === ev.id ? null : ev)}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition-colors ${
                    selectedEvent?.id === ev.id
                      ? 'bg-[#111B37] text-white border-[#111B37]'
                      : isReset
                        ? 'bg-[#FEF2F2] text-[#9B1C1C] border-[#FECACA]'
                        : isOp
                          ? 'bg-blue-50 text-blue-800 border-blue-200'
                          : 'bg-[#F6F8FC] text-[#334568] border-[#E3EAF3] hover:bg-slate-100'
                  }`}
                >
                  {isReset ? (
                    <ShieldAlert className="w-3 h-3 text-[#EF1B24] shrink-0" />
                  ) : isOp ? (
                    <Info className="w-3 h-3 text-blue-600 shrink-0" />
                  ) : ev.toQuality === 'GOOD' ? (
                    <CheckCircle2 className="w-3 h-3 text-[#0DBA67] shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                  )}
                  <span className="font-mono text-[10px] opacity-80">
                    {new Date(ev.timestampMs).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span className="font-semibold truncate max-w-[240px]">{ev.summary}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
