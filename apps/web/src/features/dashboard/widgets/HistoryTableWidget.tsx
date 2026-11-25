/**
 * Historical data table body: long format (time, series, value, quality) over the already-bounded
 * Historian points of every binding (the runtime caps them with `max_points`; nothing more is fetched).
 *
 * - `order` newest/oldest (ties keep binding order); client pagination with `page_size` over those rows.
 * - Values: numbers formatted with decimals + unit, booleans/strings as-is, null → "—" (never 0).
 * - Quality per point from `q`; missing quality is "Unknown", never Good.
 * - A truncated series shows a notice naming it (only the returned points are listed; narrow the range).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { WidgetRendererProps } from '../types';
import { formatTime, formatValue } from '../format';
import { historyNotes, uniqueNotes, unitOf } from './data';
import { BodyMessage, decimalsOf, FOOTNOTE_H, Footnote, optEnum, optInt, seriesColor, StateDot } from './shared';
import { fitColumns, TableShell, tableScale, tdStyle, thStyle, type Col } from './tableKit';
import type { DataState } from '../types';

interface Row {
  t: number;
  si: number;
  v: unknown;
  q: string | null;
}

function qState(q: string | null): DataState {
  const u = (q || '').toUpperCase();
  return u === 'GOOD' ? 'good' : u === 'BAD' ? 'bad' : u === 'UNCERTAIN' ? 'uncertain' : 'unknown';
}

export function HistoryTableWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  const pageSize = optInt(o, 'page_size', 25, 10, 200);
  const order = optEnum(o, 'order', ['newest', 'oldest'] as const, 'newest');
  const decimals = decimalsOf(o);
  const fs = tableScale(size, theme.font_scale);
  const fontSize = Math.round(12 * fs * 10) / 10;
  const pad = '4px 8px';
  const [page, setPage] = useState(0);

  const { rows, notes, truncated } = useMemo(() => {
    const rows: Row[] = [];
    const notes: string[] = [];
    const truncated: string[] = [];
    data.series.forEach((s, si) => {
      if (s.error) {
        notes.push(`${s.label}: ${s.error.message}`);
        return;
      }
      if (s.history?.truncated) truncated.push(s.label);
      notes.push(...historyNotes(s.history, data.series.length > 1 ? s.label : undefined).filter((n) => !n.includes('truncated')));
      for (const p of s.history?.points ?? []) if (Number.isFinite(p.t)) rows.push({ t: p.t, si, v: p.v, q: p.q ?? null });
    });
    rows.sort((a, b) => (order === 'newest' ? b.t - a.t : a.t - b.t) || a.si - b.si);
    return { rows, notes: uniqueNotes(notes), truncated };
  }, [data.series, order]);

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);
  const cur = Math.min(page, pages - 1);
  const slice = rows.slice(cur * pageSize, cur * pageSize + pageSize);

  if (!data.series.length) return <BodyMessage theme={theme} text="No sources" hint={mode === 'edit' ? 'Bind one or more sources' : null} />;

  const multi = data.series.length > 1;
  const all: Col[] = [{ key: 'time', label: 'Time', priority: 0, minWidth: 150 }];
  if (multi) all.push({ key: 'series', label: 'Series', priority: 1, minWidth: 90 });
  all.push({ key: 'value', label: 'Value', align: 'right', priority: 0, minWidth: 72 });
  all.push({ key: 'quality', label: 'Quality', priority: 2, minWidth: 84 });
  const cols = fitColumns(all, size.width / fs);
  const hasQuality = cols.some((c) => c.key === 'quality');

  const truncNote = truncated.length ? `Truncated (${truncated.join(', ')}): only the points returned are listed — narrow the time range for more` : '';
  const footerH = 26;
  const footer = (
    <div style={{ flex: '0 0 auto', borderTop: `1px solid ${theme.border}`, display: 'flex', flexDirection: 'column' }}>
      {truncNote || notes.length ? (
        <div style={{ color: truncated.length ? theme.warning : theme.text_muted }}>
          <Footnote theme={{ ...theme, text_muted: truncated.length ? theme.warning : theme.text_muted }} items={[truncNote, ...notes]} height={FOOTNOTE_H} />
        </div>
      ) : null}
      <div style={{ height: footerH, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: Math.max(10, fontSize - 1), color: theme.text_muted, padding: '0 2px' }}>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {rows.length ? `${(cur * pageSize + 1).toLocaleString('en-US')}–${(cur * pageSize + slice.length).toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}` : '0 rows'}
        </span>
        <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <PagerButton theme={theme} label="‹" title="Previous page" disabled={cur <= 0} onClick={() => setPage(cur - 1)} />
          <span style={{ minWidth: 44, textAlign: 'center' }}>
            {cur + 1} / {pages}
          </span>
          <PagerButton theme={theme} label="›" title="Next page" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
        </span>
      </div>
    </div>
  );

  if (!rows.length) {
    return (
      <div style={{ width: size.width, height: size.height, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <BodyMessage theme={theme} text="No data in the selected time range" hint={notes.join(' · ') || null} />
        </div>
      </div>
    );
  }

  return (
    <TableShell theme={theme} fontSize={fontSize} footer={footer}>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} style={thStyle(theme, fontSize, pad, c.align)}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {slice.map((r, i) => {
          const s = data.series[r.si];
          const st = qState(r.q);
          return (
            <tr key={`${r.si}-${r.t}-${i}`}>
              {cols.map((c) => {
                let content: React.ReactNode = null;
                if (c.key === 'time') content = <span style={{ color: theme.text_muted }}>{formatTime(r.t)}</span>;
                else if (c.key === 'series')
                  content = (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={s.label}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: seriesColor(s, r.si, theme), flex: '0 0 auto' }} />
                      {s.label}
                    </span>
                  );
                else if (c.key === 'value')
                  content = (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: r.v === null || r.v === undefined ? theme.text_muted : theme.text }}>
                      {formatValue(r.v, { decimals, unit: unitOf(s) })}
                      {!hasQuality && st !== 'good' ? <StateDot state={st} theme={theme} title={st} /> : null}
                    </span>
                  );
                else if (c.key === 'quality')
                  content = (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: st === 'bad' ? theme.bad : st === 'uncertain' ? theme.warning : st === 'good' ? theme.text : theme.text_muted }}>
                      {r.q === null && s.history?.downsampled ? (
                        <span title="Bucket average: no per-sample quality">—</span>
                      ) : (
                        <>
                          <StateDot state={st} theme={theme} />
                          {st === 'unknown' ? 'Unknown' : st.charAt(0).toUpperCase() + st.slice(1)}
                        </>
                      )}
                    </span>
                  );
                return (
                  <td key={c.key} style={tdStyle(theme, pad, c.align)}>
                    {content}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </TableShell>
  );
}

function PagerButton({ theme, label, title, disabled, onClick }: { theme: WidgetRendererProps['theme']; label: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 22,
        height: 20,
        lineHeight: '16px',
        fontSize: 14,
        borderRadius: 5,
        border: `1px solid ${theme.border}`,
        background: theme.surface,
        color: disabled ? theme.border : theme.text,
        cursor: disabled ? 'default' : 'pointer',
        padding: 0,
      }}
    >
      {label}
    </button>
  );
}
