/**
 * Status indicator body: led, pill, tile, text.
 *
 * - The value is mapped through `mappings` (value mappings by string form, `true`/`false` for booleans;
 *   ranges for numbers). A value without a mapping shows `unknown_label` in `unknown_color` with the raw
 *   value — an unknown value is never shown as a known state (e.g. never "Running").
 *   Without any mapping configured the raw value is the label, in the neutral unknown color.
 * - BAD/STALE/no-data override: the indicator takes the state color (never the healthy mapped color), the
 *   last label stays visible but dimmed, and a badge says e.g. "Stale · 3m ago" (`show_quality`).
 * - `show_raw` adds the raw value, `show_time` the sample time and age, `blink` slow animates the
 *   indicator (only for a current value; disabled under prefers-reduced-motion).
 */
import React from 'react';
import type { WidgetRendererProps } from '../types';
import { formatAge, formatTime, formatValue, mapValue, valueKey } from '../format';
import {
  BodyMessage,
  clamp,
  decimalsOf,
  ensureWidgetStyles,
  fontScale,
  hexAlpha,
  isDegraded,
  isHexColor,
  latestState,
  optBool,
  optEnum,
  optMappings,
  optStr,
  QualityBadge,
  readableOn,
  useNow,
} from './shared';

export function StatusWidget({ options: o, data, theme, size, mode }: WidgetRendererProps) {
  ensureWidgetStyles();
  const now = useNow();
  const s = data.series[0];
  const variant = optEnum(o, 'variant', ['led', 'pill', 'tile', 'text'] as const, 'pill');
  const mappings = optMappings(o);
  const showRaw = optBool(o, 'show_raw', false);
  const showTime = optBool(o, 'show_time', true);
  const showQuality = optBool(o, 'show_quality', true);
  const unknownLabel = optStr(o, 'unknown_label', 'Unknown') || 'Unknown';
  const unknownColor = isHexColor(o.unknown_color) ? (o.unknown_color as string) : '#94A3B8';
  const blink = optEnum(o, 'blink', ['off', 'slow'] as const, 'off');
  const decimals = decimalsOf(o);
  const fs = fontScale(size, theme);

  if (!s) return <BodyMessage theme={theme} text="No source" hint={mode === 'edit' ? 'Bind a status signal or model field' : null} />;

  const raw = s.latest?.value;
  const state = latestState(s);
  const hasValue = raw !== null && raw !== undefined && !(typeof raw === 'number' && !Number.isFinite(raw));
  const mapped = hasValue ? mapValue(raw, mappings) : null;
  const rawText = hasValue ? formatValue(raw, { decimals }) : '';
  let label: string;
  let color: string;
  let unmapped = false;
  if (!hasValue) {
    label = 'No data';
    color = theme.stale;
  } else if (mapped) {
    label = mapped.label;
    color = mapped.color;
  } else if (mappings.length) {
    label = unknownLabel;
    color = unknownColor;
    unmapped = true;
  } else {
    label = rawText || valueKey(raw);
    color = unknownColor;
  }
  const degraded = isDegraded(state) && hasValue;
  if (degraded) color = state === 'bad' ? theme.bad : theme.stale;
  const W = size.width;
  const H = size.height;
  const tiny = H < 44 || W < 100;
  const doBlink = blink === 'slow' && hasValue && !isDegraded(state);
  const blinkCls = doBlink ? 'fx-w-blink' : undefined;

  const secondary: string[] = [];
  if (hasValue && (showRaw || unmapped) && rawText !== label) secondary.push(unmapped ? `Raw: ${rawText}` : rawText);
  if (showTime && s.latest?.ts) secondary.push(`${formatTime(s.latest.ts)} · ${formatAge(s.latest.ts, now)}`);
  const small = Math.max(10, Math.round(11 * fs));
  const labelOpacity = degraded ? 0.6 : 1;

  const meta = !tiny ? (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 0, maxWidth: '100%' }}>
      {secondary.map((t, i) => (
        <div key={i} style={{ fontSize: small, color: variant === 'tile' && !degraded ? hexAlpha(readableOn(color), 0.8) : theme.text_muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
          {t}
        </div>
      ))}
      {showQuality && hasValue ? (
        <QualityBadge
          state={state}
          ts={s.latest?.ts}
          theme={theme}
          now={now}
          fontSize={small}
          style={variant === 'tile' && !degraded && state !== 'no_data' ? { color: readableOn(color) } : undefined}
        />
      ) : null}
    </div>
  ) : null;

  const box: React.CSSProperties = { width: W, height: H, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 };

  if (variant === 'tile') {
    const bg = degraded || !hasValue ? (theme.dark ? hexAlpha(color, 0.25) : hexAlpha(color, 0.18)) : color;
    const fg = degraded || !hasValue ? theme.text_muted : readableOn(color);
    const px = clamp(Math.min(H * 0.3, (W - 16) / Math.max(4, label.length * 0.62)), 12, 44 * fs);
    return (
      <div style={{ ...box }}>
        <div
          className={blinkCls}
          style={{
            width: '100%',
            flex: 1,
            minHeight: 0,
            borderRadius: Math.max(4, theme.radius - 4),
            background: bg,
            color: fg,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            padding: 6,
            transition: 'background-color 200ms ease',
            boxShadow: degraded ? `inset 0 0 0 1.5px ${hexAlpha(color, 0.6)}` : undefined,
          }}
        >
          <div style={{ fontSize: px, fontWeight: 700, opacity: labelOpacity, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', letterSpacing: '0.01em' }}>{label}</div>
          {meta}
        </div>
      </div>
    );
  }

  if (variant === 'text') {
    const px = clamp(Math.min(H * 0.36, (W - 8) / Math.max(4, label.length * 0.6)), 12, 46 * fs);
    return (
      <div style={box}>
        <div className={blinkCls} style={{ fontSize: px, fontWeight: 700, color: degraded ? theme.text_muted : color, opacity: labelOpacity, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
          {label}
        </div>
        {meta}
      </div>
    );
  }

  if (variant === 'led') {
    const d = Math.round(clamp(Math.min(H * 0.34, W * 0.2), 10, 44));
    const px = clamp(Math.min(H * 0.26, (W - d - 20) / Math.max(4, label.length * 0.6)), 11, 30 * fs);
    const lit = hasValue && !degraded;
    return (
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', gap: Math.round(d * 0.45), maxWidth: '100%', minWidth: 0 }}>
          <span
            className={blinkCls}
            style={{
              width: d,
              height: d,
              borderRadius: '50%',
              flex: '0 0 auto',
              background: lit ? `radial-gradient(circle at 35% 30%, ${hexAlpha('#FFFFFF', 0.55)}, ${color} 55%)` : hexAlpha(color, 0.35),
              boxShadow: lit ? `0 0 ${Math.round(d * 0.6)}px ${hexAlpha(color, 0.55)}, inset 0 0 0 1px ${hexAlpha('#000000', 0.08)}` : `inset 0 0 0 1.5px ${hexAlpha(color, 0.7)}`,
            }}
          />
          <span style={{ fontSize: px, fontWeight: 650, color: degraded ? theme.text_muted : theme.text, opacity: labelOpacity, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label}</span>
        </div>
        {meta}
      </div>
    );
  }

  // pill
  const px = clamp(Math.min(H * 0.24, (W - 40) / Math.max(4, label.length * 0.62)), 11, 26 * fs);
  return (
    <div style={box}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: Math.round(px * 0.5),
          padding: `${Math.round(px * 0.35)}px ${Math.round(px * 0.85)}px`,
          borderRadius: 999,
          background: hexAlpha(color, theme.dark ? 0.22 : 0.13),
          boxShadow: `inset 0 0 0 1px ${hexAlpha(color, degraded ? 0.55 : 0.35)}`,
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <span className={blinkCls} style={{ width: Math.round(px * 0.55), height: Math.round(px * 0.55), borderRadius: '50%', background: color, flex: '0 0 auto' }} />
        <span style={{ fontSize: px, fontWeight: 650, color: degraded ? theme.text_muted : theme.text, opacity: labelOpacity, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label}</span>
      </div>
      {meta}
    </div>
  );
}
