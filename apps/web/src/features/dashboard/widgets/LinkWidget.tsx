/**
 * Navigation link body: `style` button/card/text, `target_type` dashboard (`dashboard_id`) or page
 * (`page`), `label`, `carry_variables`. Clicking calls `onNavigate` (internal navigation only, no writes).
 * In edit mode clicking never navigates and a hint says so; an unset target is shown disabled.
 */
import React from 'react';
import { ArrowUpRight, ChevronRight, LayoutDashboard, PanelsTopLeft } from 'lucide-react';
import type { NavTarget, WidgetRendererProps } from '../types';
import { clamp, ensureWidgetStyles, fontScale, hexAlpha, optBool, optColor, optEnum, optStr, readableOn } from './shared';

const PAGES: Record<string, string> = {
  overview: 'Overview',
  factory_structure: 'Factory structure',
  factory_graph: 'Factory graph',
  connections: 'Connections',
  signals: 'Signals',
  models: 'Data models',
  storage: 'Storage',
  historian: 'Historian',
};

export function LinkWidget({ options: o, theme, size, mode, onNavigate }: WidgetRendererProps) {
  ensureWidgetStyles();
  const targetType = optEnum(o, 'target_type', ['dashboard', 'page'] as const, 'dashboard');
  const dashboardId = typeof o.dashboard_id === 'string' && o.dashboard_id ? o.dashboard_id : null;
  const page = optEnum(o, 'page', Object.keys(PAGES), 'overview');
  const label = optStr(o, 'label', 'Open').trim() || 'Open';
  const carry = optBool(o, 'carry_variables', true);
  const style = optEnum(o, 'style', ['button', 'card', 'text'] as const, 'button');
  const accent = optColor(o, 'accent_color') ?? theme.accent;
  const fs = fontScale(size, theme);
  const edit = mode === 'edit';

  const target: NavTarget | null =
    targetType === 'dashboard' ? (dashboardId ? { kind: 'dashboard', dashboard_id: dashboardId, carry_variables: carry } : null) : { kind: 'page', page };
  const disabled = !target;
  const sub = targetType === 'dashboard' ? (dashboardId ? (carry ? 'Dashboard · keeps variables' : 'Dashboard') : 'No target dashboard') : PAGES[page];
  const hint = edit ? (disabled ? 'Choose a target in the inspector' : 'Links are disabled while editing') : disabled ? 'No target configured' : undefined;
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (edit || !target) return;
    onNavigate(target);
  };
  const Icon = targetType === 'dashboard' ? LayoutDashboard : PanelsTopLeft;
  const px = Math.round(clamp(13 * fs, 11, 18));
  const common: React.CSSProperties = {
    cursor: edit || disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    maxWidth: '100%',
    minWidth: 0,
    ['--fx-w-focus' as string]: accent,
  };
  const wrap: React.CSSProperties = {
    width: size.width,
    height: size.height,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexDirection: 'column',
    gap: 2,
  };
  const showHint = !!hint && size.height >= 56 && style !== 'card';
  const hintEl = showHint ? (
    <div style={{ fontSize: Math.max(10, px - 3), color: theme.text_muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{hint}</div>
  ) : null;

  if (style === 'text') {
    return (
      <div style={wrap}>
        <button
          type="button"
          className="fx-w-link"
          onClick={click}
          disabled={disabled}
          title={hint}
          style={{
            ...common,
            border: 'none',
            background: 'transparent',
            padding: 2,
            color: disabled ? theme.text_muted : accent,
            fontSize: px,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            textDecoration: disabled ? 'none' : 'underline',
            textUnderlineOffset: 3,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <ArrowUpRight size={px} style={{ flex: '0 0 auto' }} />
        </button>
        {hintEl}
      </div>
    );
  }

  if (style === 'card') {
    const compact = size.height < 64;
    return (
      <button
        type="button"
        className="fx-w-link"
        onClick={click}
        disabled={disabled}
        title={hint}
        style={{
          ...common,
          width: size.width,
          height: size.height,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: compact ? '4px 10px' : '8px 12px',
          borderRadius: Math.max(6, theme.radius - 4),
          border: `1px solid ${theme.border}`,
          background: theme.surface_alt,
          color: theme.text,
          textAlign: 'left',
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <span
          style={{
            width: compact ? 24 : 32,
            height: compact ? 24 : 32,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexAlpha(accent, 0.12),
            color: accent,
            flex: '0 0 auto',
          }}
        >
          <Icon size={compact ? 14 : 17} />
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: px, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          {!compact ? (
            <span style={{ fontSize: Math.max(10, px - 2), color: theme.text_muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{edit ? hint : sub}</span>
          ) : null}
        </span>
        <ChevronRight size={16} color={theme.text_muted} style={{ flex: '0 0 auto' }} />
      </button>
    );
  }

  const h = Math.round(clamp(size.height * (showHint ? 0.5 : 0.62), 24, 40));
  return (
    <div style={wrap}>
      <button
        type="button"
        className="fx-w-link"
        onClick={click}
        disabled={disabled}
        title={hint}
        style={{
          ...common,
          height: h,
          padding: `0 ${Math.round(h * 0.5)}px`,
          borderRadius: Math.min(10, Math.max(6, theme.radius - 4)),
          border: 'none',
          background: disabled ? theme.surface_alt : accent,
          color: disabled ? theme.text_muted : readableOn(accent),
          fontSize: px,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          boxShadow: disabled ? `inset 0 0 0 1px ${theme.border}` : `0 1px 2px ${hexAlpha('#0F172A', 0.12)}`,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <ChevronRight size={px + 1} style={{ flex: '0 0 auto' }} />
      </button>
      {hintEl}
    </div>
  );
}
