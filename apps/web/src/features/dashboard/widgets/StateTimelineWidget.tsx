/**
 * State timeline body (ECharts custom series): one row per binding, one bar per state interval.
 *
 * - Segments come from consecutive points with the same value (equal values merged, string form, so
 *   booleans compare as `true`/`false`). A null value ends the current segment (hole, not a state).
 * - Colors from `mappings`; an unmapped value gets a neutral color and its raw value as label.
 * - A gap (> 2 × bucket_ms or > 3 × median interval) ends the segment one median interval after its
 *   last point; nothing is drawn across the gap.
 * - The last segment ends at "now" (bounded by the window end) only when the series' latest state is
 *   good/delayed; otherwise it ends at the last point + one median interval and the rest up to now is a
 *   hatched "Stale"/"No data"/"Bad" region — a state is never extended through stale or missing data.
 * - Tooltip: value, start, end, duration, worst point quality. `show_values` labels segments wide enough.
 */
import React, { useMemo } from 'react';
import type { WidgetRendererProps } from '../types';
import { mapValue, STATE_LABEL, valueKey } from '../format';
import { formatDuration, gapThreshold, historyNotes, medianInterval, timeFull, uniqueNotes } from './data';
import { EChart, esc, timeAxis, tooltipBase, type ChartOption } from './EChart';
import { BodyMessage, clamp, fontScale, FOOTNOTE_H, Footnote, hexAlpha, latestState, neutralColor, optBool, optMappings, readableOn, useNow } from './shared';

interface Seg {
  row: number;
  start: number;
  end: number;
  label: string;
  raw: string;
  color: string;
  quality: string | null;
  kind: 'state' | 'tail';
}

export function StateTimelineWidget({ options: o, data, theme, size, timeRange, mode }: WidgetRendererProps) {
  const mappings = useMemo(() => optMappings(o), [o.mappings]);
  const showValues = optBool(o, 'show_values', true);
  const fs = fontScale(size, theme);
  const now = useNow(30000);

  const built = useMemo(() => {
    const segs: Seg[] = [];
    const notes: string[] = [];
    const rows: string[] = [];
    const neutral = neutralColor(theme);
    data.series.forEach((s, row) => {
      rows.push(s.label);
      if (s.error) {
        notes.push(`${s.label}: ${s.error.message}`);
        return;
      }
      notes.push(...historyNotes(s.history, data.series.length > 1 ? s.label : undefined));
      const pts = (s.history?.points ?? []).filter((p) => Number.isFinite(p.t));
      const ts = pts.map((p) => p.t);
      const med = medianInterval(ts) ?? (s.history?.bucket_ms || null);
      const thr = gapThreshold(ts, s.history?.bucket_ms);
      let cur: Seg | null = null;
      const close = (end: number) => {
        if (cur) {
          cur.end = Math.max(cur.start, end);
          segs.push(cur);
          cur = null;
        }
      };
      const worse = (a: string | null, b: string | null) => {
        const rank = (q: string | null) => (q === 'BAD' ? 3 : q === 'UNCERTAIN' ? 2 : q === 'GOOD' ? 0 : 1);
        return rank(b) > rank(a) ? b : a;
      };
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const prevT = i > 0 ? pts[i - 1].t : null;
        if (cur && prevT !== null && thr !== null && p.t - prevT > thr) close(prevT + (med ?? 0));
        const isVal = p.v !== null && p.v !== undefined && !(typeof p.v === 'number' && !Number.isFinite(p.v));
        if (!isVal) {
          close(p.t);
          continue;
        }
        const key = valueKey(p.v);
        const q = p.q ? p.q.toUpperCase() : null;
        const c = cur as Seg | null;
        if (c && c.raw === key) {
          c.quality = worse(c.quality, q);
          continue;
        }
        close(p.t);
        const m = mapValue(p.v, mappings);
        cur = { row, start: p.t, end: p.t, label: m ? m.label : key, raw: key, color: m ? m.color : neutral, quality: q, kind: 'state' };
      }
      const last = pts.length ? pts[pts.length - 1].t : null;
      const st = latestState(s);
      const live = st === 'good' || st === 'delayed';
      const horizon = Math.min(now, timeRange.end);
      if (cur && last !== null) {
        const cutoff = live ? Math.max(last, horizon) : last + (med ?? 0);
        close(Math.min(cutoff, Math.max(timeRange.end, last)));
        if (!live && cutoff < horizon) {
          segs.push({ row, start: cutoff, end: horizon, label: STATE_LABEL[st], raw: '', color: st === 'bad' ? theme.bad : theme.stale, quality: null, kind: 'tail' });
        }
      }
    });
    return { segs, rows, notes: uniqueNotes(notes) };
  }, [data.series, mappings, theme, timeRange.end, now]);

  const { segs, rows, notes } = built;
  const W = size.width;
  const H = size.height;
  const showFooter = notes.length > 0 && H >= 110;
  const chartH = Math.max(40, H - (showFooter ? FOOTNOTE_H : 0));
  const labelW = Math.round(clamp(W * 0.24, 56, 150));

  const option = useMemo<ChartOption>(() => {
    const bandH = (chartH - 30) / Math.max(1, rows.length);
    const barFrac = rows.length === 1 ? 0.62 : 0.7;
    const fontPx = Math.round(clamp(Math.min(bandH * barFrac * 0.55, 11.5 * fs), 9, 13));
    return {
      animation: false,
      grid: { left: labelW, right: 10, top: 6, bottom: 24 },
      tooltip: {
        trigger: 'item',
        ...tooltipBase(theme, fs),
        formatter: (p: any) => {
          const sg = segs[p.value?.[3]];
          if (!sg) return '';
          const head = `<div style="font-weight:600;margin-bottom:4px">${esc(rows[sg.row])}</div>`;
          if (sg.kind === 'tail') return `${head}<div style="color:${sg.color}">${esc(sg.label)} since ${esc(timeFull(sg.start))}</div><div style="color:${theme.text_muted}">The state is not extended through ${esc(sg.label.toLowerCase())} data</div>`;
          const raw = sg.raw !== sg.label ? ` <span style="color:${theme.text_muted}">(${esc(sg.raw)})</span>` : '';
          const q = sg.quality && sg.quality !== 'GOOD' ? `<div style="color:${sg.quality === 'BAD' ? theme.bad : sg.quality === 'UNCERTAIN' ? theme.warning : theme.text_muted}">Quality: ${esc(sg.quality.toLowerCase())}</div>` : !sg.quality ? `<div style="color:${theme.text_muted}">Quality unknown</div>` : '';
          return (
            `${head}<div style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:${esc(sg.color)}"></span><b>${esc(sg.label)}</b>${raw}</div>` +
            `<div style="color:${theme.text_muted};margin-top:2px">${esc(timeFull(sg.start))} → ${esc(timeFull(sg.end))}</div><div>Duration <b>${esc(formatDuration(sg.end - sg.start))}</b></div>${q}`
          );
        },
      },
      xAxis: { ...timeAxis(theme, fs, timeRange, W - labelW), splitLine: { show: true, lineStyle: { color: theme.chart_grid } } },
      yAxis: {
        type: 'category',
        data: rows,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: theme.text, fontSize: Math.round(11 * fs), width: labelW - 12, overflow: 'truncate' },
      },
      series: [
        {
          type: 'custom',
          encode: { x: [1, 2], y: 0 },
          data: segs.map((s, i) => [s.row, s.start, s.end, i]),
          renderItem: (params: any, api: any) => {
            const sg = segs[api.value(3)];
            if (!sg) return null;
            const a = api.coord([api.value(1), api.value(0)]);
            const b = api.coord([api.value(2), api.value(0)]);
            const h = api.size([0, 1])[1] * barFrac;
            const cs = params.coordSys;
            const x0 = Math.max(a[0], cs.x);
            const x1 = Math.min(b[0], cs.x + cs.width);
            if (x1 - x0 < 0.5 && !(x1 >= x0 && sg.kind === 'state')) return null;
            const w = Math.max(1, x1 - x0);
            const tail = sg.kind === 'tail';
            const text = showValues && w > sg.label.length * fontPx * 0.62 + 10 && h >= fontPx + 2 ? sg.label : '';
            return {
              type: 'rect',
              shape: { x: x0, y: a[1] - h / 2, width: w, height: h, r: Math.min(3, w / 2) },
              style: tail
                ? { fill: hexAlpha(sg.color, theme.dark ? 0.18 : 0.14), stroke: hexAlpha(sg.color, 0.7), lineWidth: 1, lineDash: [3, 3] }
                : { fill: sg.color, stroke: theme.surface, lineWidth: w > 3 ? 1 : 0 },
              textContent: text ? { style: { text, fill: tail ? theme.text_muted : readableOn(sg.color), fontSize: fontPx, fontWeight: 600, fontFamily: 'Inter, system-ui, sans-serif' } } : undefined,
              textConfig: text ? { position: 'inside' } : undefined,
            };
          },
        },
      ],
    };
  }, [segs, rows, theme, fs, labelW, chartH, showValues, timeRange, W]);

  if (!data.series.length) return <BodyMessage theme={theme} text="No series" hint={mode === 'edit' ? 'Bind boolean or enum sources' : null} />;
  const empty = !segs.some((s) => s.kind === 'state');
  return (
    <div style={{ width: W, height: H, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <EChart option={option} width={W} height={chartH} theme={theme} ariaLabel="State timeline" />
      {empty ? (
        <div style={{ position: 'absolute', left: labelW, right: 10, top: 6, height: Math.max(20, chartH - 30), display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ fontSize: 12, color: theme.text_muted, background: hexAlpha(theme.surface, 0.85), padding: '3px 10px', borderRadius: 6 }}>No state data in the selected time range</span>
        </div>
      ) : null}
      {showFooter ? <Footnote theme={theme} items={notes} height={FOOTNOTE_H} /> : null}
    </div>
  );
}
