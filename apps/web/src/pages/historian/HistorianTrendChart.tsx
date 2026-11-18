/**
 * Historian trend chart (plain SVG, like the other charts of the app — no chart library).
 *
 * - One Y axis per unit: overlay (axes alternate left/right) or "split by unit" lanes with a shared time axis.
 * - Numbers: line for raw readings, step-after for recorded/reconstructed and integer (state/counter) series,
 *   min/max band for downsampled buckets, dots on recorded rows; lines break at gaps (never bridged).
 * - Text / boolean / JSON: a state band (value per period), never a fake numeric line.
 * - Per-series quality lane (Good / Uncertain / Stale / Bad / no data) and an events lane.
 * - Hover crosshair + tooltip with every series' value and quality; drag to zoom (brush); click a point to inspect.
 * - Compare period: the same series shifted onto this axis, dashed.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChartLayout,
  formatClock,
  formatDateTime,
  formatNumber,
  formatValue,
  Gap,
  HistorianMode,
  Pt,
  qualitySegments,
  Series,
  TZ_LABEL,
  valueAt,
} from './historianModel';

export interface ChartMarker {
  t: number;
  kind: 'reset' | 'quality' | 'gap' | 'storage';
  label: string;
}

interface Props {
  series: Series[];
  compareSeries: Series[];
  compareLabel?: string;
  mode: HistorianMode;
  layout: ChartLayout;
  startMs: number;
  endMs: number;
  markers: ChartMarker[];
  gapsBySeries: Map<string, Gap[]>;
  loading?: boolean;
  onBrush: (startMs: number, endMs: number) => void;
  onPick: (s: Series, p: Pt) => void;
}

export const QUALITY_COLORS: Record<string, string> = {
  GOOD: '#0DBA67',
  UNCERTAIN: '#F59E0B',
  STALE: '#94A3B8',
  BAD: '#EF4444',
  GAP: '#E2E8F0',
};
const QUALITY_NAMES: Record<string, string> = { GOOD: 'Good', UNCERTAIN: 'Uncertain', STALE: 'Stale', BAD: 'Bad', GAP: 'No data' };
const MARKER_COLORS: Record<ChartMarker['kind'], string> = { reset: '#EF1B24', quality: '#F59E0B', gap: '#94A3B8', storage: '#2A82E7' };
const STATE_FILLS = ['#DBEAFE', '#DCFCE7', '#FEF3C7', '#F3E8FF', '#CFFAFE', '#FCE7F3', '#ECFCCB', '#FFE4E6', '#E0E7FF', '#F1F5F9'];

function hashIdx(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

function niceTicks(min: number, max: number, count = 5): { lo: number; hi: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1;
    min -= d;
    max += d;
  }
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { lo, hi, ticks };
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].map((s) => s * 1000);

function timeTicks(start: number, end: number, width: number): { ticks: number[]; step: number } {
  const want = Math.max(3, Math.floor(width / 110));
  const span = Math.max(1, end - start);
  const step = TIME_STEPS.find((s) => span / s <= want) || TIME_STEPS[TIME_STEPS.length - 1];
  const tzOff = new Date(start).getTimezoneOffset() * 60000;
  const first = Math.ceil((start - tzOff) / step) * step + tzOff;
  const ticks: number[] = [];
  for (let t = first; t <= end; t += step) ticks.push(t);
  return { ticks, step };
}

function tickLabel(t: number, step: number, span: number): string {
  const d = new Date(t);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (step >= 86400e3) return md;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const clock = step < 60e3 ? `${hm}:${String(d.getSeconds()).padStart(2, '0')}` : hm;
  if (span > 86400e3 || (d.getHours() === 0 && d.getMinutes() === 0 && step >= 3600e3)) return `${md} ${hm}`;
  return clock;
}

interface Axis {
  unit: string;
  color: string;
  lo: number;
  hi: number;
  ticks: number[];
  side: 'left' | 'right';
  slot: number;
}

interface Lane {
  kind: 'numeric' | 'state';
  top: number;
  height: number;
  axes: Axis[];
  axisOf: Map<string, Axis>;
  series: Series[];
}

export const HistorianTrendChart: React.FC<Props> = ({
  series,
  compareSeries,
  compareLabel,
  mode,
  layout,
  startMs,
  endMs,
  markers,
  gapsBySeries,
  loading,
  onBrush,
  onPick,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number>(0);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setWidth(Math.max(300, Math.floor(el.clientWidth)));
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = width < 640;
  const axisW = narrow ? 42 : 54;
  const numeric = series.filter((s) => !s.discrete);
  const discrete = series.filter((s) => s.discrete);

  const layoutInfo = useMemo(() => {
    // Unit groups (series with the same unit share one axis; never one axis for different units).
    const groups = new Map<string, Series[]>();
    for (const s of numeric) {
      const k = s.unit || '(no unit)';
      groups.set(k, [...(groups.get(k) || []), s]);
    }
    const groupList = Array.from(groups.entries());
    const range = (list: Series[]) => {
      let lo = Infinity;
      let hi = -Infinity;
      const all = [...list, ...compareSeries.filter((c) => list.some((s) => s.token === c.token))];
      for (const s of all)
        for (const p of s.points) {
          if (p.t < startMs || p.t > endMs) continue;
          const a = p.min != null ? p.min : p.v;
          const b = p.max != null ? p.max : p.v;
          if (a != null && a < lo) lo = a;
          if (b != null && b > hi) hi = b;
        }
      return lo === Infinity ? { lo: 0, hi: 1 } : { lo, hi };
    };
    const lanes: Lane[] = [];
    let top = 22;
    let leftSlots = 0;
    let rightSlots = 0;
    if (groupList.length) {
      if (layout === 'overlay' || groupList.length === 1) {
        const h = narrow ? 230 : 300;
        const axes: Axis[] = groupList.map(([unit, list], i) => {
          const r = range(list);
          const nt = niceTicks(r.lo, r.hi, narrow ? 4 : 6);
          const side: Axis['side'] = i % 2 === 0 ? 'left' : 'right';
          const slot = Math.floor(i / 2);
          if (side === 'left') leftSlots = Math.max(leftSlots, slot + 1);
          else rightSlots = Math.max(rightSlots, slot + 1);
          return { unit, color: list[0].color, ...nt, side, slot };
        });
        const axisOf = new Map<string, Axis>();
        groupList.forEach(([, list], i) => list.forEach((s) => axisOf.set(s.token, axes[i])));
        lanes.push({ kind: 'numeric', top, height: h, axes, axisOf, series: numeric });
        top += h + 14;
      } else {
        leftSlots = 1;
        const h = groupList.length <= 2 ? (narrow ? 180 : 210) : narrow ? 140 : 160;
        for (const [unit, list] of groupList) {
          const r = range(list);
          const nt = niceTicks(r.lo, r.hi, 4);
          const ax: Axis = { unit, color: list[0].color, ...nt, side: 'left', slot: 0 };
          lanes.push({ kind: 'numeric', top, height: h, axes: [ax], axisOf: new Map(list.map((s) => [s.token, ax])), series: list });
          top += h + 28;
        }
      }
    }
    for (const s of discrete) {
      lanes.push({ kind: 'state', top: top + 6, height: 30, axes: [], axisOf: new Map(), series: [s] });
      top += 30 + 14;
    }
    if (!leftSlots) leftSlots = discrete.length ? 1 : 0;
    const padLeft = 10 + Math.max(1, leftSlots) * axisW;
    const padRight = 14 + rightSlots * axisW;
    const qualityTop = top + 4;
    const qualityRow = 7;
    const qualityH = series.length * (qualityRow + 3);
    const eventsTop = qualityTop + qualityH + 6;
    const eventsH = 16;
    const xAxisTop = eventsTop + eventsH + 2;
    const height = xAxisTop + 26;
    return { lanes, padLeft, padRight, qualityTop, qualityRow, eventsTop, eventsH, xAxisTop, height };
  }, [numeric, discrete, compareSeries, layout, narrow, axisW, series.length, startMs, endMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const { lanes, padLeft, padRight, qualityTop, qualityRow, eventsTop, eventsH, xAxisTop, height } = layoutInfo;
  const plotW = Math.max(50, width - padLeft - padRight);
  const span = Math.max(1, endMs - startMs);
  const x = (t: number) => padLeft + ((t - startMs) / span) * plotW;
  const tAt = (px: number) => startMs + ((px - padLeft) / plotW) * span;
  const yOf = (lane: Lane, ax: Axis, v: number) => lane.top + lane.height - ((v - ax.lo) / Math.max(1e-12, ax.hi - ax.lo)) * lane.height;
  const plotBottom = lanes.length ? lanes[lanes.length - 1].top + lanes[lanes.length - 1].height : qualityTop;

  const xt = timeTicks(startMs, endMs, plotW);

  const stepFor = (s: Series) => mode !== 'operational' || s.integer || s.token.startsWith('mod:') || s.token.startsWith('subtable:');

  /** Path for one numeric series; breaks at nulls and gaps. */
  const linePath = (lane: Lane, s: Series): { d: string; band: string; dots: [number, number][] } => {
    const ax = lane.axisOf.get(s.token);
    if (!ax) return { d: '', band: '', dots: [] };
    const step = stepFor(s);
    const gaps = gapsBySeries.get(s.token) || [];
    const gapStarts = new Set(gaps.map((g) => g.startMs));
    let d = '';
    let open = false;
    const bandTop: string[] = [];
    const bandBot: string[] = [];
    const dots: [number, number][] = [];
    const pts = s.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.v == null) {
        open = false;
        continue;
      }
      const px = x(p.t);
      const py = yOf(lane, ax, p.v);
      if (!open) {
        d += `M${px.toFixed(1)},${py.toFixed(1)}`;
        open = true;
      } else if (step) {
        d += `H${px.toFixed(1)}V${py.toFixed(1)}`;
      } else d += `L${px.toFixed(1)},${py.toFixed(1)}`;
      if (p.min != null && p.max != null) {
        bandTop.push(`${px.toFixed(1)},${yOf(lane, ax, p.max).toFixed(1)}`);
        bandBot.unshift(`${px.toFixed(1)},${yOf(lane, ax, p.min).toFixed(1)}`);
      }
      if (mode === 'recorded' && pts.length <= 600) dots.push([px, py]);
      const next = pts[i + 1];
      if (gapStarts.has(p.t)) {
        // the source went silent after this row: never bridge the gap
        open = false;
      } else if (step && !next && !s.compare) {
        d += `H${Math.min(x(endMs), plotW + padLeft).toFixed(1)}`;
      }
    }
    const band = bandTop.length > 1 ? `M${bandTop.join('L')}L${bandBot.join('L')}Z` : '';
    return { d, band, dots };
  };

  // ------------------------------------------------------------------ interaction
  const localXY = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).closest('svg')!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const onDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    const { px } = localXY(e);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ x0: px, x1: px });
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const { px, py } = localXY(e);
    setHoverX(Math.max(padLeft, Math.min(padLeft + plotW, px)));
    setHoverY(py);
    if (drag) setDrag({ ...drag, x1: Math.max(padLeft, Math.min(padLeft + plotW, px)) });
  };
  const onUp = (e: React.PointerEvent<SVGRectElement>) => {
    const { px, py } = localXY(e);
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (Math.abs(px - d.x0) > 6) {
      const a = tAt(Math.min(px, d.x0));
      const b = tAt(Math.max(px, d.x0));
      if (b - a >= 1000) onBrush(Math.round(a), Math.round(b));
      return;
    }
    // Click: inspect the nearest point of the lane under the pointer.
    const t = tAt(px);
    const lane = lanes.find((l) => py >= l.top - 6 && py <= l.top + l.height + 6) || lanes[0];
    if (!lane) return;
    let best: { s: Series; p: Pt; dist: number } | null = null;
    for (const s of lane.series) {
      const p = valueAt(s, t, lane.kind === 'state' || stepFor(s));
      if (!p) continue;
      const ax = lane.axisOf.get(s.token);
      const dist = lane.kind === 'state' || !ax || p.v == null ? Math.abs(x(p.t) - px) : Math.hypot(x(p.t) - px, yOf(lane, ax, p.v) - py);
      if (!best || dist < best.dist) best = { s, p, dist };
    }
    if (best) onPick(best.s, best.p);
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setDrag(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drag]);

  const hoverT = hoverX != null ? tAt(hoverX) : null;
  const tooltipRows =
    hoverT != null && !drag
      ? series.map((s) => {
          const p = valueAt(s, hoverT, s.discrete || stepFor(s));
          const c = compareSeries.find((cs) => cs.token === s.token);
          const cp = c ? valueAt(c, hoverT, s.discrete || stepFor(s)) : null;
          return { s, p, cp };
        })
      : [];

  const tipLeft = hoverX != null ? (hoverX > width - 300 ? Math.max(4, hoverX - 290) : hoverX + 14) : 0;
  const svgLabel = `Trend of ${series.length} series from ${formatDateTime(startMs)} to ${formatDateTime(endMs)} (${TZ_LABEL}). Use the Records tab for the values as a table.`;

  return (
    <div ref={wrapRef} className="relative w-full select-none" onPointerLeave={() => setHoverX(null)}>
      <svg width={width} height={height} role="img" aria-label={svgLabel} className="block">
        {/* lanes */}
        {lanes.map((lane, li) => (
          <g key={li}>
            {lane.kind === 'numeric' && (
              <>
                <rect x={padLeft} y={lane.top} width={plotW} height={lane.height} fill="#FFFFFF" stroke="#E3EAF3" />
                {/* grid + axes */}
                {lane.axes.map((ax, ai) => {
                  const ax0 = ax.side === 'left' ? padLeft - ax.slot * axisW : padLeft + plotW + ax.slot * axisW;
                  return (
                    <g key={ai}>
                      {ax.ticks.map((tv) => {
                        const y = yOf(lane, ax, tv);
                        if (y < lane.top - 1 || y > lane.top + lane.height + 1) return null;
                        return (
                          <g key={tv}>
                            {ai === 0 && <line x1={padLeft} x2={padLeft + plotW} y1={y} y2={y} stroke="#F1F5FA" />}
                            <text
                              x={ax.side === 'left' ? ax0 - 6 : ax0 + 6}
                              y={y + 3.5}
                              textAnchor={ax.side === 'left' ? 'end' : 'start'}
                              fontSize={11}
                              fill={lane.axes.length > 1 ? ax.color : '#657794'}
                              className="tabular-nums"
                            >
                              {formatNumber(tv)}
                            </text>
                          </g>
                        );
                      })}
                      <line x1={ax0} x2={ax0} y1={lane.top} y2={lane.top + lane.height} stroke={lane.axes.length > 1 ? ax.color : '#CBD5E1'} strokeOpacity={0.6} />
                      <text
                        x={ax.side === 'left' ? ax0 - 6 : ax0 + 6}
                        y={lane.top - 8}
                        textAnchor={ax.side === 'left' ? 'end' : 'start'}
                        fontSize={10}
                        fontWeight={700}
                        fill={lane.axes.length > 1 ? ax.color : '#657794'}
                      >
                        {ax.unit}
                      </text>
                    </g>
                  );
                })}
                {/* vertical time grid */}
                {xt.ticks.map((t) => (
                  <line key={t} x1={x(t)} x2={x(t)} y1={lane.top} y2={lane.top + lane.height} stroke="#F5F7FA" />
                ))}
                <clipPath id={`clip-${li}`}>
                  <rect x={padLeft} y={lane.top - 2} width={plotW} height={lane.height + 4} />
                </clipPath>
                <g clipPath={`url(#clip-${li})`}>
                  {/* compare period (dashed, behind) */}
                  {compareSeries
                    .filter((c) => lane.axisOf.has(c.token))
                    .map((c) => {
                      const { d } = linePath(lane, c);
                      return d ? <path key={`cmp-${c.token}`} d={d} fill="none" stroke={c.color} strokeWidth={1.4} strokeDasharray="5 4" strokeOpacity={0.55} /> : null;
                    })}
                  {lane.series.map((s) => {
                    const { d, band, dots } = linePath(lane, s);
                    return (
                      <g key={s.token}>
                        {band && <path d={band} fill={s.color} fillOpacity={0.12} stroke="none" />}
                        {d && <path d={d} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" />}
                        {dots.map(([cx, cy], i) => (
                          <circle key={i} cx={cx} cy={cy} r={2.4} fill="#FFFFFF" stroke={s.color} strokeWidth={1.3} />
                        ))}
                      </g>
                    );
                  })}
                </g>
              </>
            )}
            {lane.kind === 'state' &&
              lane.series.map((s) => {
                const pts = s.points;
                // Free text where nearly every row differs (timestamps, ids): colour per value would be noise.
                const distinct = new Set(pts.map((p) => (typeof p.raw === 'object' ? JSON.stringify(p.raw) : String(p.raw)))).size;
                const busy = distinct > 12 && distinct > pts.length * 0.3;
                return (
                  <g key={s.token}>
                    <rect x={padLeft} y={lane.top} width={plotW} height={lane.height} fill="#F8FAFC" stroke="#E3EAF3" />
                    {pts.map((p, i) => {
                      const a = Math.max(padLeft, x(p.t));
                      const nextT = i + 1 < pts.length ? pts[i + 1].t : endMs;
                      const b = Math.min(padLeft + plotW, x(nextT));
                      if (b <= a) return null;
                      const text = p.raw === null || p.raw === undefined ? '—' : typeof p.raw === 'object' ? JSON.stringify(p.raw) : String(p.raw);
                      const fill = p.raw == null ? '#FFFFFF' : busy ? (i % 2 ? '#EEF2F7' : '#F8FAFC') : STATE_FILLS[hashIdx(text, STATE_FILLS.length)];
                      return (
                        <g key={i}>
                          <rect x={a} y={lane.top + 1} width={b - a} height={lane.height - 2} fill={fill} stroke="#FFFFFF" strokeWidth={0.5} />
                          {b - a > (busy ? 120 : 46) && (
                            <text x={a + 4} y={lane.top + lane.height / 2 + 4} fontSize={11} fill="#334568" className="pointer-events-none">
                              {text.length > Math.floor((b - a - 8) / 6.5) ? `${text.slice(0, Math.max(1, Math.floor((b - a - 8) / 6.5) - 1))}…` : text}
                            </text>
                          )}
                        </g>
                      );
                    })}
                    <rect x={padLeft - 4} y={lane.top} width={3} height={lane.height} fill={s.color} />
                    <text x={padLeft - 8} y={lane.top + lane.height / 2 + 4} textAnchor="end" fontSize={10} fill="#657794">
                      {narrow ? '' : 'text'}
                    </text>
                    <text x={padLeft} y={lane.top - 3} fontSize={10} fill="#657794">
                      {`${s.label}${busy ? ` · ${distinct.toLocaleString()} different values (hover or see Records)` : ''}`}
                    </text>
                  </g>
                );
              })}
          </g>
        ))}

        {/* reset markers across the plot */}
        {markers
          .filter((m) => m.kind === 'reset' && m.t >= startMs && m.t <= endMs)
          .map((m, i) => (
            <line key={`rl-${i}`} x1={x(m.t)} x2={x(m.t)} y1={10} y2={plotBottom} stroke={MARKER_COLORS.reset} strokeDasharray="3 3" strokeOpacity={0.7} />
          ))}

        {/* quality lane: one thin row per series */}
        <text x={padLeft - 8} y={qualityTop + 7} textAnchor="end" fontSize={10} fill="#657794">
          {narrow ? 'Q' : 'Quality'}
        </text>
        {series.map((s, i) => {
          const y = qualityTop + i * (qualityRow + 3);
          const segs = qualitySegments(s, startMs, endMs);
          return (
            <g key={`q-${s.token}`}>
              <rect x={padLeft} y={y} width={plotW} height={qualityRow} fill="#F8FAFC" />
              {segs.map((g, k) => {
                const a = Math.max(padLeft, x(g.startMs));
                const b = Math.min(padLeft + plotW, x(g.endMs));
                if (b - a < 0.5) return null;
                return (
                  <rect key={k} x={a} y={y} width={b - a} height={qualityRow} fill={QUALITY_COLORS[g.q]}>
                    <title>{`${s.label}: ${QUALITY_NAMES[g.q]} ${formatClock(g.startMs)}–${formatClock(g.endMs)}`}</title>
                  </rect>
                );
              })}
              <rect x={padLeft - 4} y={y} width={3} height={qualityRow} fill={s.color} />
            </g>
          );
        })}

        {/* events lane */}
        <text x={padLeft - 8} y={eventsTop + 11} textAnchor="end" fontSize={10} fill="#657794">
          {narrow ? 'E' : 'Events'}
        </text>
        <line x1={padLeft} x2={padLeft + plotW} y1={eventsTop + eventsH / 2} y2={eventsTop + eventsH / 2} stroke="#E3EAF3" />
        {markers
          .filter((m) => m.t >= startMs && m.t <= endMs)
          .slice(0, 400)
          .map((m, i) => {
            const cx = x(m.t);
            const cy = eventsTop + eventsH / 2;
            return (
              <path key={`ev-${i}`} d={`M${cx},${cy - 5}L${cx + 5},${cy}L${cx},${cy + 5}L${cx - 5},${cy}Z`} fill={MARKER_COLORS[m.kind]} stroke="#FFFFFF" strokeWidth={1}>
                <title>{`${formatDateTime(m.t)} · ${m.label}`}</title>
              </path>
            );
          })}

        {/* time axis */}
        <line x1={padLeft} x2={padLeft + plotW} y1={xAxisTop} y2={xAxisTop} stroke="#CBD5E1" />
        {xt.ticks.map((t) => (
          <g key={`xt-${t}`}>
            <line x1={x(t)} x2={x(t)} y1={xAxisTop} y2={xAxisTop + 4} stroke="#CBD5E1" />
            <text x={x(t)} y={xAxisTop + 17} textAnchor="middle" fontSize={11} fill="#657794" className="tabular-nums">
              {tickLabel(t, xt.step, span)}
            </text>
          </g>
        ))}

        {/* hover crosshair */}
        {hoverX != null && !drag && <line x1={hoverX} x2={hoverX} y1={8} y2={xAxisTop} stroke="#111B37" strokeOpacity={0.35} strokeDasharray="2 3" />}
        {/* brush */}
        {drag && Math.abs(drag.x1 - drag.x0) > 2 && (
          <rect x={Math.min(drag.x0, drag.x1)} y={8} width={Math.abs(drag.x1 - drag.x0)} height={xAxisTop - 8} fill="#2A82E7" fillOpacity={0.12} stroke="#2A82E7" strokeOpacity={0.6} />
        )}
        {/* interaction surface */}
        <rect
          x={padLeft}
          y={4}
          width={plotW}
          height={Math.max(10, xAxisTop - 4)}
          fill="transparent"
          style={{ cursor: drag ? 'col-resize' : 'crosshair', touchAction: 'pan-y' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)}
        />
      </svg>

      {/* tooltip */}
      {hoverT != null && !drag && tooltipRows.length > 0 && (
        <div
          className="absolute z-10 pointer-events-none w-[280px] rounded-lg border border-[#D4DFEC] bg-white/95 shadow-lg px-3 py-2 text-[11px]"
          style={{ left: tipLeft, top: Math.max(4, Math.min(hoverY - 20, height - 40 - tooltipRows.length * 30)) }}
        >
          <div className="font-semibold text-[#111B37] tabular-nums mb-1">
            {formatDateTime(hoverT, span < 120e3)} <span className="font-normal text-[#94A3B8]">{TZ_LABEL.split(' ')[1] || ''}</span>
          </div>
          <ul className="space-y-1">
            {tooltipRows.map(({ s, p, cp }) => (
              <li key={s.token} className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden="true" />
                  <span className="truncate text-[#334568] flex-1">{s.label}</span>
                  <span className="font-semibold text-[#111B37] tabular-nums whitespace-nowrap">{p ? formatValue(p.raw, s.unit) : '—'}</span>
                </div>
                {(p || cp) && (
                  <div className="pl-3.5 flex flex-wrap gap-x-2 text-[10px] text-[#657794]">
                    {p && p.q && (
                      <span style={{ color: QUALITY_COLORS[p.q] && p.q !== 'GOOD' ? (p.q === 'STALE' ? '#64748B' : QUALITY_COLORS[p.q]) : '#0A9855' }}>{QUALITY_NAMES[p.q] || p.q}</span>
                    )}
                    {p && p.min != null && p.max != null && (
                      <span>
                        avg of {p.count ?? '?'} · {formatNumber(p.min)}–{formatNumber(p.max)}
                      </span>
                    )}
                    {p && <span className="tabular-nums">at {formatClock(p.t, span < 120e3)}</span>}
                    {cp && (
                      <span className="tabular-nums">
                        {compareLabel || 'compare'}: {formatValue(cp.raw, s.unit)}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {loading && <div className="absolute inset-x-0 top-0 h-0.5 bg-[#2A82E7]/60 animate-pulse" aria-hidden="true" />}
    </div>
  );
};
