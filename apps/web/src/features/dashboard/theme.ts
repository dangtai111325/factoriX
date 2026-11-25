/**
 * Theme tokens of a rendered dashboard = preset tokens (`GET /dashboards/themes`) + the document's
 * overrides (accent, canvas, surface, text, radius, gap, font scale). Tokens become CSS variables on the
 * canvas element; renderers receive the resolved `ThemeTokens` object.
 *
 * The built-in values below are only used while the presets have not loaded (or failed to load) so a
 * dashboard never renders unstyled; they are design constants, not data.
 */
import type React from 'react';
import type { ThemePreset, ThemePresetId, ThemeSettings, ThemeTokens } from './types';

// Mirror of the server presets (application/dashboards/registry.py THEMES): `accent` = palette[0] is the
// default data fill and never a status color; good/warning/bad/stale are reserved for status.
const PALETTE_LIGHT = ['#2A82E7', '#21B5AE', '#8858EA', '#FFAA23', '#0DBA67', '#D9468F', '#334568', '#94A3B8'];

export const BUILTIN_TOKENS: Record<ThemePresetId, ThemeTokens> = {
  factorix_light: {
    canvas: '#F6F8FC',
    surface: '#FFFFFF',
    surface_alt: '#F9FAFD',
    text: '#111B37',
    text_muted: '#657794',
    border: '#E3EAF3',
    accent: '#2A82E7',
    good: '#0DBA67',
    warning: '#FFAA23',
    bad: '#F2343B',
    stale: '#94A3B8',
    palette: PALETTE_LIGHT,
    chart_grid: '#E3EAF3',
    chart_axis: '#657794',
    radius: 12,
    gap: 12,
    font_scale: 1,
    dark: false,
  },
  control_room_dark: {
    canvas: '#0B1220',
    surface: '#111A2E',
    surface_alt: '#18233B',
    text: '#E6ECF5',
    text_muted: '#8FA0BC',
    border: '#24314D',
    accent: '#3B9EFF',
    good: '#22C55E',
    warning: '#F5B638',
    bad: '#F25560',
    stale: '#64748B',
    palette: ['#3B9EFF', '#2DD4BF', '#A78BFA', '#F5B638', '#22C55E', '#F472B6', '#F97316', '#94A3B8'],
    chart_grid: '#1F2A44',
    chart_axis: '#8FA0BC',
    radius: 10,
    gap: 10,
    font_scale: 1,
    dark: true,
  },
  industrial_neutral: {
    canvas: '#EEF0F2',
    surface: '#FFFFFF',
    surface_alt: '#F5F6F7',
    text: '#1F2933',
    text_muted: '#616E7C',
    border: '#D9DEE3',
    accent: '#1F6FB2',
    good: '#2F9E44',
    warning: '#E8A317',
    bad: '#D64545',
    stale: '#9AA5B1',
    palette: ['#1F6FB2', '#2F9E44', '#E8A317', '#7B5EA7', '#0F9D9A', '#D64545', '#52606D', '#B07A3F'],
    chart_grid: '#E4E7EB',
    chart_axis: '#616E7C',
    radius: 6,
    gap: 8,
    font_scale: 1,
    dark: false,
  },
};

export const THEME_PRESET_LABEL: Record<ThemePresetId, string> = {
  factorix_light: 'FactoriX Light',
  control_room_dark: 'Control Room Dark',
  industrial_neutral: 'Industrial Neutral',
};

const HEX = /^#[0-9A-Fa-f]{6}$/;
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix `a` toward `b` by `t` (0..1). */
export function mixHex(a: string, b: string, t: number): string {
  if (!isHexColor(a) || !isHexColor(b)) return a;
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`.toUpperCase();
}

/** Relative luminance (WCAG); used to pick readable text on custom colours. */
export function luminance(hex: string): number {
  if (!isHexColor(hex)) return 1;
  const ch = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function readableOn(bg: string): string {
  return luminance(bg) > 0.45 ? '#111B37' : '#FFFFFF';
}

export function presetTokens(presetId: string, presets: ThemePreset[]): ThemeTokens {
  const server = presets.find((p) => p.id === presetId)?.tokens;
  const builtin = BUILTIN_TOKENS[presetId as ThemePresetId] || BUILTIN_TOKENS.factorix_light;
  if (!server) return builtin;
  return { ...builtin, ...server, palette: server.palette?.length ? server.palette : builtin.palette };
}

/** Preset + document overrides. Surface/text overrides also derive their muted/alt neighbours. */
export function resolveTheme(settings: ThemeSettings | undefined, presets: ThemePreset[]): ThemeTokens {
  const base = presetTokens(settings?.preset || 'factorix_light', presets);
  if (!settings) return base;
  const t: ThemeTokens = { ...base };
  if (isHexColor(settings.accent)) t.accent = settings.accent;
  if (isHexColor(settings.canvas)) t.canvas = settings.canvas;
  if (isHexColor(settings.surface)) {
    t.surface = settings.surface;
    t.surface_alt = mixHex(settings.surface, base.dark ? '#FFFFFF' : '#0B1220', 0.04);
    t.border = mixHex(settings.surface, base.dark ? '#FFFFFF' : '#0B1220', 0.12);
  }
  if (isHexColor(settings.text)) {
    t.text = settings.text;
    t.text_muted = mixHex(settings.text, t.surface, 0.4);
  }
  if (Number.isFinite(settings.radius)) t.radius = Math.min(24, Math.max(0, settings.radius));
  if (Number.isFinite(settings.gap)) t.gap = Math.min(32, Math.max(4, settings.gap));
  if (Number.isFinite(settings.font_scale)) t.font_scale = Math.min(1.4, Math.max(0.8, settings.font_scale));
  return t;
}

/** CSS custom properties applied on the canvas root; widget chrome uses only these. */
export function themeStyle(t: ThemeTokens): React.CSSProperties {
  return {
    ['--dash-canvas' as string]: t.canvas,
    ['--dash-surface' as string]: t.surface,
    ['--dash-surface-alt' as string]: t.surface_alt,
    ['--dash-text' as string]: t.text,
    ['--dash-text-muted' as string]: t.text_muted,
    ['--dash-border' as string]: t.border,
    ['--dash-accent' as string]: t.accent,
    ['--dash-good' as string]: t.good,
    ['--dash-warning' as string]: t.warning,
    ['--dash-bad' as string]: t.bad,
    ['--dash-stale' as string]: t.stale,
    ['--dash-grid' as string]: t.chart_grid,
    ['--dash-radius' as string]: `${t.radius}px`,
    ['--dash-gap' as string]: `${t.gap}px`,
    ['--dash-font-scale' as string]: String(t.font_scale),
    background: t.canvas,
    color: t.text,
    fontSize: `${13 * t.font_scale}px`,
    colorScheme: t.dark ? 'dark' : 'light',
  };
}

export function paletteColor(t: ThemeTokens, index: number): string {
  const p = t.palette.length ? t.palette : PALETTE_LIGHT;
  return p[((index % p.length) + p.length) % p.length];
}
