/**
 * Divider body: `orientation` horizontal/vertical, `thickness` 1..8 px, `line_style` solid/dashed,
 * `color` (null = theme border), optional centered `label`. Always centered in its box.
 */
import React from 'react';
import type { WidgetRendererProps } from '../types';
import { clamp, optColor, optEnum, optInt, optStr } from './shared';

export function DividerWidget({ options: o, theme, size }: WidgetRendererProps) {
  const orientation = optEnum(o, 'orientation', ['horizontal', 'vertical'] as const, 'horizontal');
  const thickness = optInt(o, 'thickness', 1, 1, 8);
  const lineStyle = optEnum(o, 'line_style', ['solid', 'dashed'] as const, 'solid');
  const color = optColor(o, 'color') ?? theme.border;
  const label = optStr(o, 'label', '').trim();
  const horizontal = orientation === 'horizontal';
  const line: React.CSSProperties = horizontal
    ? { flex: 1, minWidth: 8, borderTop: `${thickness}px ${lineStyle} ${color}` }
    : { flex: 1, minHeight: 8, borderLeft: `${thickness}px ${lineStyle} ${color}` };
  const fontSize = clamp(11 * (theme.font_scale || 1), 9, 15);
  const showLabel = !!label && (horizontal ? size.width >= 80 : size.height >= 60);
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label || undefined}
      style={{
        width: size.width,
        height: size.height,
        display: 'flex',
        flexDirection: horizontal ? 'row' : 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        overflow: 'hidden',
      }}
    >
      <span style={line} />
      {showLabel ? (
        <span
          style={{
            fontSize,
            fontWeight: 600,
            color: theme.text_muted,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: horizontal ? '70%' : undefined,
            maxHeight: horizontal ? undefined : '70%',
            writingMode: horizontal ? undefined : 'vertical-rl',
          }}
        >
          {label}
        </span>
      ) : null}
      {showLabel ? <span style={line} /> : null}
    </div>
  );
}
