/**
 * Latest values table body: one row per binding.
 *
 * - Columns: resource (`show_resource`), label, value, unit (`show_unit`), quality (`show_quality`, server
 *   state → badge; missing quality = unknown, never good), freshness (`show_freshness`, server freshness +
 *   age), time (`show_time`). Narrow boxes drop time → resource → freshness → unit → quality (the unit is
 *   then appended to the value).
 * - Value: `mappings` first (label + color dot), else numbers formatted with decimals and colored by
 *   `thresholds`; booleans/strings shown as-is; null → "—". Stale/bad/no-data values are dimmed and never
 *   threshold-colored. Resolution errors are shown in the value cell.
 * - `sort` none/label (A→Z)/value (high→low, non-numeric and empty last), `density`, sticky header, scroll.
 */
import React, { useMemo } from 'react';
import type { SeriesData, WidgetRendererProps } from '../types';
import { formatAge, formatTime, formatValue, isNumber, mapValue, thresholdColor } from '../format';
import { unitOf } from './data';
import { BodyMessage, decimalsOf, isDegraded, latestState, optBool, optEnum, optMappings, optThresholds, QualityBadge, useNow } from './shared';
import { fitColumns, TableShell, tableScale, tdStyle, thStyle, type Col } from './tableKit';

function freshnessLabel(f: string | null | undefined): string {
  if (!f) return 'Unknown';
  const u = f.toUpperCase();
  return u === 'NO_DATA' ? 'No data' : u.charAt(0) + u.slice(1).toLowerCase();
}

export function LatestTableWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  const now = useNow();
  const showResource = optBool(o, 'show_resource', true);
  const showUnit = optBool(o, 'show_unit', true);
  const showQuality = optBool(o, 'show_quality', true);
  const showFreshness = optBool(o, 'show_freshness', true);
  const showTime = optBool(o, 'show_time', true);
  const sort = optEnum(o, 'sort', ['none', 'label', 'value'] as const, 'none');
  const density = optEnum(o, 'density', ['compact', 'normal'] as const, 'normal');
  const thresholds = useMemo(() => optThresholds(o), [o.thresholds]);
  const mappings = useMemo(() => optMappings(o), [o.mappings]);
  const decimals = decimalsOf(o);
  const fs = tableScale(size, theme.font_scale);
  const fontSize = Math.round((density === 'compact' ? 11.5 : 12.5) * fs * 10) / 10;
  const pad = density === 'compact' ? '3px 8px' : '7px 10px';

  const rows = useMemo(() => {
    const list = [...data.series];
    if (sort === 'label') list.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
    if (sort === 'value') {
      list.sort((a, b) => {
        const va = a.latest?.value;
        const vb = b.latest?.value;
        const na = isNumber(va);
        const nb = isNumber(vb);
        if (na && nb) return (vb as number) - (va as number);
        if (na) return -1;
        if (nb) return 1;
        return 0;
      });
    }
    return list;
  }, [data.series, sort]);

  if (!data.series.length) return <BodyMessage theme={theme} text="No sources" hint={mode === 'edit' ? 'Bind one or more sources' : null} />;

  const all: Col[] = [];
  if (showResource) all.push({ key: 'resource', label: 'Resource', priority: 4, minWidth: 110 });
  all.push({ key: 'label', label: 'Name', priority: 0, minWidth: 110 });
  all.push({ key: 'value', label: 'Value', align: 'right', priority: 0, minWidth: 84 });
  if (showUnit) all.push({ key: 'unit', label: 'Unit', priority: 2, minWidth: 52 });
  if (showQuality) all.push({ key: 'quality', label: 'Quality', priority: 1, minWidth: 96 });
  if (showFreshness) all.push({ key: 'freshness', label: 'Freshness', priority: 3, minWidth: 130 });
  if (showTime) all.push({ key: 'time', label: 'Time', priority: 5, minWidth: 160 });
  const cols = fitColumns(all, size.width / fs);
  const has = (k: string) => cols.some((c) => c.key === k);
  const unitInValue = showUnit && !has('unit');

  const cell = (s: SeriesData, key: string): React.ReactNode => {
    const l = s.latest;
    const state = latestState(s);
    const degraded = isDegraded(state);
    switch (key) {
      case 'resource':
        return <span style={{ color: theme.text_muted }}>{s.resolved?.resource?.name ?? '—'}</span>;
      case 'label':
        return <span style={{ fontWeight: 500 }} title={s.label}>{s.label}</span>;
      case 'value': {
        if (s.error) return <span style={{ color: theme.bad }} title={s.error.message}>{s.error.code || 'Error'}</span>;
        const v = l?.value;
        const m = mapValue(v, mappings);
        const unit = unitInValue ? unitOf(s) : null;
        const style: React.CSSProperties = { fontWeight: 600, opacity: degraded ? 0.55 : 1 };
        if (m) {
          return (
            <span style={{ ...style, display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: degraded ? theme.stale : m.color }} />
              {m.label}
            </span>
          );
        }
        const color = degraded ? theme.text_muted : isNumber(v) ? thresholdColor(v, thresholds, theme.text) : theme.text;
        return <span style={{ ...style, color }}>{formatValue(v, { decimals, unit })}</span>;
      }
      case 'unit':
        return <span style={{ color: theme.text_muted }}>{unitOf(s) ?? ''}</span>;
      case 'quality':
        return <QualityBadge state={state} theme={theme} now={now} always fontSize={Math.max(10, fontSize - 1)} />;
      case 'freshness': {
        const f = l?.freshness;
        const u = (f || '').toUpperCase();
        const color = u === 'FRESH' ? theme.text : u === 'DELAYED' ? theme.warning : u === 'STALE' ? theme.stale : theme.text_muted;
        return (
          <span style={{ color }}>
            {freshnessLabel(f)}
            {l?.ts ? <span style={{ color: theme.text_muted }}> · {formatAge(l.ts, now)}</span> : null}
          </span>
        );
      }
      case 'time':
        return <span style={{ color: theme.text_muted }}>{l?.ts ? formatTime(l.ts) : '—'}</span>;
      default:
        return null;
    }
  };

  return (
    <TableShell theme={theme} fontSize={fontSize}>
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
        {rows.map((s, i) => (
          <tr key={s.binding?.id ?? i}>
            {cols.map((c) => (
              <td key={c.key} style={{ ...tdStyle(theme, pad, c.align), maxWidth: c.key === 'label' ? 220 : 180 }}>
                {cell(s, c.key)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}
