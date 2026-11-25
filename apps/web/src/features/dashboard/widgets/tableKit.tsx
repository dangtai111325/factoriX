/**
 * Table primitives shared by latest_table and history_table: sticky header, scroll container, density,
 * tabular numbers, theme colors. Column dropping for narrow boxes is decided by each table.
 */
import React from 'react';
import type { ThemeTokens } from '../types';
import { ensureWidgetStyles, hexAlpha, TABULAR } from './shared';

export interface Col {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** narrower boxes drop higher numbers first */
  priority: number;
  minWidth: number;
}

/** Keeps the columns that fit `width`, dropping the highest `priority` first. */
export function fitColumns(cols: Col[], width: number): Col[] {
  const kept = [...cols];
  const total = () => kept.reduce((a, c) => a + c.minWidth, 0);
  while (kept.length > 2 && total() > width) {
    let idx = 0;
    kept.forEach((c, i) => {
      if (c.priority > kept[idx].priority) idx = i;
    });
    kept.splice(idx, 1);
  }
  return kept;
}

export function TableShell({ theme, fontSize, children, footer }: { theme: ThemeTokens; fontSize: number; children: React.ReactNode; footer?: React.ReactNode }) {
  ensureWidgetStyles();
  const vars = { '--fx-w-hover': hexAlpha(theme.accent, theme.dark ? 0.08 : 0.04), '--fx-w-thumb': theme.border } as React.CSSProperties;
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', ...vars }}>
      <div className="fx-w-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table className="fx-w-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize, color: theme.text, ...TABULAR }}>
          {children}
        </table>
      </div>
      {footer}
    </div>
  );
}

export function thStyle(theme: ThemeTokens, fontSize: number, pad: string, align: Col['align'] = 'left'): React.CSSProperties {
  return {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: theme.surface,
    color: theme.text_muted,
    fontWeight: 600,
    fontSize: Math.max(9.5, fontSize - 1.5),
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    textAlign: align,
    padding: pad,
    borderBottom: `1px solid ${theme.border}`,
    whiteSpace: 'nowrap',
  };
}

export function tdStyle(theme: ThemeTokens, pad: string, align: Col['align'] = 'left'): React.CSSProperties {
  return {
    padding: pad,
    textAlign: align,
    borderBottom: `1px solid ${hexAlpha(theme.border, 0.7)}`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 260,
    verticalAlign: 'middle',
  };
}

/** Table font multiplier: dashboard font scale, shrinking (never growing) in small boxes. */
export function tableScale(size: { width: number; height: number }, fontScale: number): number {
  const fs = Number.isFinite(fontScale) ? Math.min(1.4, Math.max(0.8, fontScale)) : 1;
  return fs * Math.min(1, Math.max(0.85, Math.min(size.width / 320, size.height / 140)));
}
