/**
 * Equipment summary tile body (read-only; there are no control buttons).
 *
 * - Header: resource name + path from `data.resource` (fallback: the resolved resource of a binding).
 * - Status: the binding with role `status` mapped through `mappings`; an unmapped value is "Unknown" in a
 *   neutral color (never "Running"); a stale/bad/no-data status takes the state color with a badge. The
 *   tile does not infer machine health from values — the pill shows only the mapped status signal.
 * - Up to 6 value rows (role `value`): label, formatted value + unit, state dot; degraded values dimmed.
 * - Footer: overall data-state summary across bindings ("3 good · 1 stale"), latest sample time
 *   (`show_time`) and the optional detail link (`link_dashboard_id` → onNavigate; inert in edit mode).
 * - `layout` compact (two-column values, smaller type) / standard.
 */
import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { DataState, SeriesData, WidgetRendererProps } from '../types';
import { formatAge, formatTime, formatValue, mapValue, STATE_LABEL, stateColor } from '../format';
import { unitOf } from './data';
import { BodyMessage, decimalsOf, ensureWidgetStyles, fontScale, hexAlpha, isDegraded, latestState, optBool, optEnum, optMappings, StateDot, TABULAR, useNow } from './shared';

const ORDER: DataState[] = ['bad', 'stale', 'no_data', 'uncertain', 'delayed', 'unknown', 'good'];

export function EquipmentWidget({ options: o, data, theme, size, mode, onNavigate }: WidgetRendererProps) {
  ensureWidgetStyles();
  const now = useNow();
  const mappings = optMappings(o);
  const showTime = optBool(o, 'show_time', true);
  const showQuality = optBool(o, 'show_quality', true);
  const layout = optEnum(o, 'layout', ['compact', 'standard'] as const, 'standard');
  const linkId = typeof o.link_dashboard_id === 'string' && o.link_dashboard_id ? o.link_dashboard_id : null;
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme) * (layout === 'compact' ? 0.92 : 1);
  const W = size.width;
  const H = size.height;

  const role = (s: SeriesData) => s.role ?? s.binding?.role ?? 'value';
  const statusS = data.series.find((s) => role(s) === 'status');
  const values = data.series.filter((s) => role(s) !== 'status').slice(0, 6);
  const resName = data.resource?.name ?? data.series.find((s) => s.resolved?.resource?.name)?.resolved?.resource?.name ?? null;
  const path = data.resource?.path ?? [];

  if (!resName && !data.series.length) {
    return <BodyMessage theme={theme} text="No equipment selected" hint={mode === 'edit' ? 'Choose a resource and bind its status and values' : null} />;
  }

  // status
  let statusLabel: string | null = null;
  let statusColor = theme.stale;
  const statusState = statusS ? latestState(statusS) : null;
  if (statusS) {
    const v = statusS.latest?.value;
    if (v === null || v === undefined) {
      statusLabel = 'No data';
    } else {
      const m = mapValue(v, mappings);
      statusLabel = m ? m.label : 'Unknown';
      statusColor = m ? m.color : theme.stale;
    }
    if (statusState && isDegraded(statusState)) statusColor = statusState === 'bad' ? theme.bad : theme.stale;
  }

  // summary
  const counts = new Map<DataState, number>();
  let lastTs: number | null = null;
  for (const s of data.series) {
    const st = latestState(s);
    counts.set(st, (counts.get(st) ?? 0) + 1);
    const ts = s.latest?.ts;
    if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
  }
  const summary = ORDER.filter((k) => counts.get(k)).map((k) => ({ k, n: counts.get(k) as number }));
  const worst = summary[0]?.k ?? 'no_data';

  const base = Math.round(12.5 * fs * 10) / 10;
  const small = Math.max(10, Math.round(11 * fs));
  const compact = layout === 'compact';
  const twoCol = compact && W >= 260 && values.length > 2;
  const rowH = compact ? base * 1.7 : base * 2.1;
  const headerH = base * 1.5 + (path.length && !compact ? small * 1.4 : 0) + 6;
  const footerH = small * 1.8;
  const fitRows = Math.max(0, Math.floor((H - headerH - footerH - 6) / rowH) * (twoCol ? 2 : 1));
  const shown = values.slice(0, fitRows);
  const hidden = values.length - shown.length;
  const canNav = !!linkId && mode !== 'edit';

  return (
    <div style={{ width: W, height: H, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: base * 1.12, fontWeight: 650, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={resName ?? undefined}>
            {resName ?? 'Unknown resource'}
            {data.resource?.code && !compact ? <span style={{ marginLeft: 6, fontSize: small, fontWeight: 500, color: theme.text_muted }}>{data.resource.code}</span> : null}
          </div>
          {path.length && !compact ? (
            <div style={{ fontSize: small, color: theme.text_muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={path.join(' › ')}>
              {path.join(' › ')}
            </div>
          ) : null}
        </div>
        {statusS ? (
          <span
            title={statusState && statusState !== 'good' ? STATE_LABEL[statusState] : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flex: '0 0 auto',
              maxWidth: '55%',
              padding: '3px 9px',
              borderRadius: 999,
              fontSize: small,
              fontWeight: 650,
              background: hexAlpha(statusColor, theme.dark ? 0.22 : 0.13),
              boxShadow: `inset 0 0 0 1px ${hexAlpha(statusColor, 0.35)}`,
              color: statusState && isDegraded(statusState) ? theme.text_muted : theme.text,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flex: '0 0 auto' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: statusState && isDegraded(statusState) ? 0.7 : 1 }}>
              {statusLabel}
              {statusState && isDegraded(statusState) && statusLabel !== 'No data' ? ` · ${STATE_LABEL[statusState]}` : ''}
            </span>
          </span>
        ) : null}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: twoCol ? '1fr 1fr' : '1fr',
          columnGap: 14,
          alignContent: 'start',
          borderTop: `1px solid ${theme.border}`,
          paddingTop: 2,
        }}
      >
        {shown.map((s, i) => {
          const st = latestState(s);
          const dg = isDegraded(st);
          const v = s.latest?.value;
          const m = mapValue(v, mappings);
          return (
            <div key={s.binding?.id ?? i} style={{ height: rowH, display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${hexAlpha(theme.border, 0.6)}`, minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: base, color: theme.text_muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.label}>
                {s.label}
              </span>
              <span style={{ fontSize: base * 1.05, fontWeight: 650, color: dg ? theme.text_muted : theme.text, opacity: dg ? 0.6 : 1, whiteSpace: 'nowrap', ...TABULAR }} title={s.error?.message}>
                {s.error ? 'Error' : m ? m.label : formatValue(v, { decimals, showUnit: false })}
                {!m && unitOf(s) && v !== null && v !== undefined && typeof v === 'number' ? <span style={{ fontSize: small, fontWeight: 500, color: theme.text_muted, marginLeft: 3 }}>{unitOf(s)}</span> : null}
              </span>
              {showQuality ? <StateDot state={st} theme={theme} title={STATE_LABEL[st]} /> : null}
            </div>
          );
        })}
        {hidden > 0 ? <div style={{ fontSize: small, color: theme.text_muted, paddingTop: 3 }}>+{hidden} more</div> : null}
        {!values.length && mode === 'edit' ? <div style={{ fontSize: small, color: theme.text_muted, paddingTop: 6 }}>Bind up to 6 values</div> : null}
      </div>

      <div style={{ height: footerH, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0, fontSize: small, color: theme.text_muted }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {showQuality && summary.length ? (
            <>
              <StateDot state={worst} theme={theme} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: worst === 'good' ? theme.text_muted : stateColor(worst, theme) }}>
                {summary.length === 1 && summary[0].k === 'good' ? 'All data good' : summary.map((x) => `${x.n} ${STATE_LABEL[x.k].toLowerCase()}`).join(' · ')}
              </span>
            </>
          ) : null}
          {showTime && lastTs ? <span title={formatTime(lastTs)}>{showQuality && summary.length ? '· ' : ''}{formatAge(lastTs, now)}</span> : null}
        </span>
        {linkId ? (
          <button
            type="button"
            className="fx-w-link"
            title={mode === 'edit' ? 'Links are disabled while editing' : 'Open details dashboard'}
            onClick={(e) => {
              e.stopPropagation();
              if (canNav) onNavigate({ kind: 'dashboard', dashboard_id: linkId, carry_variables: true });
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              flex: '0 0 auto',
              border: 'none',
              background: 'transparent',
              padding: '2px 0',
              fontSize: small,
              fontWeight: 600,
              color: theme.accent,
              cursor: canNav ? 'pointer' : 'default',
              opacity: canNav ? 1 : 0.6,
              ['--fx-w-focus' as string]: theme.accent,
            }}
          >
            Details
            <ChevronRight size={small + 2} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
