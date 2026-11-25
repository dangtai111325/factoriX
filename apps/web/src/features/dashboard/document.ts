/**
 * Pure document helpers for schema v1 (contract §1–§3): defaults, ids, widget creation, per-breakpoint
 * layouts (md/sm derived from lg until edited), source keys and client-side binding checks.
 * No I/O, no React.
 */
import { BREAKPOINT_COLUMNS } from './types';
import type {
  Binding,
  Breakpoint,
  DashboardDocument,
  DashboardSettings,
  DashboardWidget,
  GridRect,
  SourceRef,
  WidgetTypeDef,
} from './types';

export const BREAKPOINTS: Breakpoint[] = ['lg', 'md', 'sm'];
export const BREAKPOINT_LABEL: Record<Breakpoint, string> = { lg: 'Desktop', md: 'Tablet', sm: 'Mobile' };
/** Canvas width thresholds (px): wider than lg → lg, wider than md → md, else sm (react-grid-layout semantics). */
export const BREAKPOINT_WIDTHS: Record<Breakpoint, number> = { lg: 900, md: 520, sm: 0 };
/** Logical canvas width of each breakpoint in the Studio preview. */
export const STUDIO_WIDTHS: Record<Breakpoint, number> = { lg: 1280, md: 768, sm: 390 };
export const MAX_ROWS_PER_WIDGET = 40;
/** Largest grid row a widget may start on (contract §2). */
export const MAX_Y = 2000;

export function breakpointForWidth(width: number): Breakpoint {
  if (width > BREAKPOINT_WIDTHS.lg) return 'lg';
  if (width > BREAKPOINT_WIDTHS.md) return 'md';
  return 'sm';
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  theme: { preset: 'factorix_light', accent: null, canvas: null, surface: null, text: null, radius: 12, gap: 12, font_scale: 1 },
  time_range: { kind: 'relative', last: '1h' },
  refresh: 'live',
  row_height: 40,
};

export function emptyDocument(): DashboardDocument {
  return { schema_version: 1, settings: structuredCloneSafe(DEFAULT_SETTINGS), variables: [], widgets: [] };
}

export function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Fill anything a (legacy or partial) document lacks so the UI can rely on the full shape. */
export function normalizeDocument(raw: unknown): DashboardDocument {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<DashboardDocument>;
  const s = (d.settings || {}) as Partial<DashboardSettings>;
  const theme = { ...DEFAULT_SETTINGS.theme, ...(s.theme || {}) };
  return {
    schema_version: 1,
    settings: {
      theme,
      time_range: s.time_range && (s.time_range.kind === 'relative' || s.time_range.kind === 'absolute') ? s.time_range : DEFAULT_SETTINGS.time_range,
      refresh: s.refresh || DEFAULT_SETTINGS.refresh,
      row_height: Number.isFinite(s.row_height) ? (s.row_height as number) : DEFAULT_SETTINGS.row_height,
    },
    variables: Array.isArray(d.variables) ? d.variables : [],
    widgets: Array.isArray(d.widgets)
      ? d.widgets.map((w) => ({
          ...w,
          layout: { lg: w.layout?.lg || { x: 0, y: 0, w: 3, h: 3 }, md: w.layout?.md ?? null, sm: w.layout?.sm ?? null },
          hidden: { lg: !!w.hidden?.lg, md: !!w.hidden?.md, sm: !!w.hidden?.sm },
          time: w.time && w.time.mode === 'custom' ? w.time : { mode: 'dashboard' as const },
          bindings: Array.isArray(w.bindings) ? w.bindings : [],
          options: w.options && typeof w.options === 'object' ? w.options : {},
        }))
      : [],
  };
}

// ------------------------------------------------------------------ ids

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomSuffix(n = 6): string {
  let out = '';
  const buf = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < n; i++) out += ID_CHARS[buf[i] % ID_CHARS.length];
  return out;
}

export function newWidgetId(doc: DashboardDocument): string {
  const used = new Set(doc.widgets.map((w) => w.id));
  for (;;) {
    const id = `w_${randomSuffix()}`;
    if (!used.has(id)) return id;
  }
}

export function newBindingId(widget: DashboardWidget): string {
  const used = new Set(widget.bindings.map((b) => b.id));
  for (let i = 1; ; i++) if (!used.has(`b_${i}`)) return `b_${i}`;
}

export const VARIABLE_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;

// ------------------------------------------------------------------ layout

export function minSize(def: WidgetTypeDef | undefined, bp: Breakpoint): { w: number; h: number } {
  const cols = BREAKPOINT_COLUMNS[bp];
  const w = Math.max(1, Math.min(def?.min_size.w ?? 1, cols));
  const h = Math.max(1, def?.min_size.h ?? 1);
  return { w, h };
}

export function clampRect(r: GridRect, bp: Breakpoint, def: WidgetTypeDef | undefined): GridRect {
  const cols = BREAKPOINT_COLUMNS[bp];
  const min = minSize(def, bp);
  const w = Math.max(min.w, Math.min(cols, Math.round(r.w) || min.w));
  const h = Math.max(min.h, Math.min(MAX_ROWS_PER_WIDGET, Math.round(r.h) || min.h));
  const x = Math.max(0, Math.min(cols - w, Math.round(r.x) || 0));
  const y = Math.min(MAX_Y, Math.max(0, Math.round(r.y) || 0));
  return { x, y, w, h };
}

function byPosition(a: GridRect, b: GridRect): number {
  return a.y - b.y || a.x - b.x;
}

/**
 * Rectangles of every widget at a breakpoint. Explicit layouts are used as stored; a null md layout is
 * derived from lg (x/w halved), a null sm layout stacks the widgets in lg reading order.
 */
export function rectsFor(widgets: DashboardWidget[], defs: Map<string, WidgetTypeDef>, bp: Breakpoint): Map<string, GridRect> {
  const out = new Map<string, GridRect>();
  if (bp === 'lg') {
    for (const w of widgets) out.set(w.id, clampRect(w.layout.lg, 'lg', defs.get(w.type)));
    return out;
  }
  if (bp === 'md') {
    // Explicit tablet rects as stored; the others flow in Desktop reading order, half width, row by row
    // (widgets of one Desktop row stay side by side while they fit in 6 columns).
    let bottom = 0;
    for (const w of widgets) {
      if (!w.layout.md) continue;
      const r = clampRect(w.layout.md, 'md', defs.get(w.type));
      out.set(w.id, r);
      bottom = Math.max(bottom, r.y + r.h);
    }
    const rest = widgets.filter((w) => !w.layout.md).sort((a, b) => byPosition(a.layout.lg, b.layout.lg));
    let cx = 0;
    let cy = bottom;
    let rowH = 0;
    for (const w of rest) {
      const def = defs.get(w.type);
      const min = minSize(def, 'md');
      const width = Math.max(min.w, Math.min(6, Math.ceil(w.layout.lg.w / 2)));
      const h = Math.max(min.h, w.layout.lg.h);
      if (cx + width > 6) {
        cy += rowH;
        cx = 0;
        rowH = 0;
      }
      out.set(w.id, { x: cx, y: cy, w: width, h });
      cx += width;
      rowH = Math.max(rowH, h);
    }
    return out;
  }
  let bottom = 0;
  for (const w of widgets) {
    if (!w.layout.sm) continue;
    const r = clampRect(w.layout.sm, 'sm', defs.get(w.type));
    out.set(w.id, r);
    bottom = Math.max(bottom, r.y + r.h);
  }
  const rest = widgets.filter((w) => !w.layout.sm).sort((a, b) => byPosition(a.layout.lg, b.layout.lg));
  for (const w of rest) {
    const def = defs.get(w.type);
    const h = Math.max(minSize(def, 'sm').h, w.layout.lg.h);
    out.set(w.id, { x: 0, y: bottom, w: 1, h });
    bottom += h;
  }
  return out;
}

export function isBreakpointCustomized(doc: DashboardDocument, bp: Breakpoint): boolean {
  if (bp === 'lg') return true;
  return doc.widgets.some((w) => w.layout[bp] !== null);
}

/** First free row below every widget of the lg layout. */
export function bottomOf(doc: DashboardDocument, bp: Breakpoint, defs: Map<string, WidgetTypeDef>): number {
  let bottom = 0;
  rectsFor(doc.widgets, defs, bp).forEach((r) => {
    bottom = Math.max(bottom, r.y + r.h);
  });
  return bottom;
}

export function createWidget(def: WidgetTypeDef, doc: DashboardDocument, defs: Map<string, WidgetTypeDef>, at?: { bp: Breakpoint; x: number; y: number }): DashboardWidget {
  const size = def.default_size;
  const lg = clampRect({ x: at?.bp === 'lg' ? at.x : 0, y: at?.bp === 'lg' ? at.y : bottomOf(doc, 'lg', defs), w: size.w, h: size.h }, 'lg', def);
  const w: DashboardWidget = {
    id: newWidgetId(doc),
    type: def.type,
    version: def.version,
    title: def.data.max_bindings > 0 ? def.label : def.type === 'text' || def.type === 'divider' || def.type === 'image' ? '' : def.label,
    layout: { lg, md: null, sm: null },
    hidden: { lg: false, md: false, sm: false },
    time: { mode: 'dashboard' },
    bindings: [],
    options: {},
  };
  // Customized tablet/mobile layouts get an explicit place too, so the new widget lands where it was dropped.
  for (const bp of ['md', 'sm'] as const) {
    if (!isBreakpointCustomized(doc, bp)) continue;
    const pos = at?.bp === bp ? { x: at.x, y: at.y } : { x: 0, y: bottomOf(doc, bp, defs) };
    w.layout[bp] = clampRect({ x: pos.x, y: pos.y, w: bp === 'sm' ? 1 : Math.min(6, Math.ceil(size.w / 2)), h: size.h }, bp, def);
  }
  return w;
}

export function duplicateWidgetIn(doc: DashboardDocument, widget: DashboardWidget, defs: Map<string, WidgetTypeDef>): DashboardWidget {
  const copy = structuredCloneSafe(widget);
  copy.id = newWidgetId(doc);
  copy.title = widget.title ? `${widget.title} (copy)`.slice(0, 120) : widget.title;
  for (const bp of BREAKPOINTS) {
    const rect = widget.layout[bp];
    if (!rect) continue;
    copy.layout[bp] = { ...rect, y: bottomOf(doc, bp, defs) };
  }
  return copy;
}

/** Store the grid result of a drag/resize at one breakpoint (every visible widget gets an explicit rect). */
export function applyGridLayout(
  doc: DashboardDocument,
  bp: Breakpoint,
  items: Array<{ i: string; x: number; y: number; w: number; h: number }>,
  defs: Map<string, WidgetTypeDef>,
): DashboardDocument {
  const byId = new Map(items.map((it) => [it.i, it]));
  let changed = false;
  const widgets = doc.widgets.map((w) => {
    const it = byId.get(w.id);
    if (!it) return w;
    const rect = clampRect({ x: it.x, y: it.y, w: it.w, h: it.h }, bp, defs.get(w.type));
    const cur = w.layout[bp];
    if (cur && cur.x === rect.x && cur.y === rect.y && cur.w === rect.w && cur.h === rect.h) return w;
    changed = true;
    return { ...w, layout: { ...w.layout, [bp]: rect } };
  });
  return changed ? { ...doc, widgets } : doc;
}

export function resetBreakpoint(doc: DashboardDocument, bp: 'md' | 'sm'): DashboardDocument {
  return { ...doc, widgets: doc.widgets.map((w) => ({ ...w, layout: { ...w.layout, [bp]: null } })) };
}

// ------------------------------------------------------------------ sources

export function sourceKey(s: SourceRef): string {
  switch (s.kind) {
    case 'signal':
      return `signal:${s.signal_id}`;
    case 'model_field':
      return `model_field:${s.model_id}:${s.field_path}`;
    case 'signal_key':
      return `signal_key:${s.variable}:${s.key}`;
    case 'role':
      return `role:${s.role}`;
    default:
      return 'invalid';
  }
}

export function sourceFromToken(token: string, kind: 'signal' | 'model_field'): SourceRef | null {
  if (kind === 'signal') return token ? { kind: 'signal', signal_id: token } : null;
  const m = /^mod:([^:]+):(.+)$/.exec(token);
  return m ? { kind: 'model_field', model_id: m[1], field_path: m[2] } : null;
}

export function newBinding(widget: DashboardWidget, source: SourceRef, role?: string): Binding {
  const b: Binding = { id: newBindingId(widget), source, label: null, color: null, unit: null, scale: 1, offset: 0 };
  if (role) b.role = role;
  return b;
}

// ------------------------------------------------------------------ client-side checks (the server validates too)

export interface LocalIssue {
  severity: 'error' | 'warning';
  message: string;
}

export function bindingIssues(widget: DashboardWidget, def: WidgetTypeDef | undefined): LocalIssue[] {
  if (!def) return [{ severity: 'error', message: `Widget type “${widget.type}” is not available on this server.` }];
  const out: LocalIssue[] = [];
  const { min_bindings: min, max_bindings: max, roles } = def.data;
  const n = widget.bindings.length;
  if (max === 0) return out;
  if (n < min) out.push({ severity: 'error', message: min === 1 ? 'Choose a data source.' : `Choose at least ${min} data sources.` });
  if (n > max) out.push({ severity: 'error', message: `This widget takes at most ${max} data source${max === 1 ? '' : 's'}; remove ${n - max}.` });
  if (roles?.length) {
    for (const r of roles) {
      const count = widget.bindings.filter((b) => b.role === r.id).length;
      if (r.required && count === 0) out.push({ severity: 'error', message: `“${r.label}” needs a data source.` });
      if (r.max !== undefined && count > r.max) out.push({ severity: 'error', message: `“${r.label}” takes at most ${r.max} source${r.max === 1 ? '' : 's'}.` });
    }
    const unknown = widget.bindings.filter((b) => !b.role || !roles.some((r) => r.id === b.role));
    if (unknown.length) out.push({ severity: 'error', message: `${unknown.length} source${unknown.length === 1 ? ' has' : 's have'} no role; pick one.` });
  }
  if (widget.bindings.some((b) => b.source.kind === 'role')) out.push({ severity: 'error', message: 'A template role is not mapped to a source yet.' });
  return out;
}

export function documentBytes(doc: DashboardDocument): number {
  try {
    return new Blob([JSON.stringify(doc)]).size;
  } catch {
    return JSON.stringify(doc).length;
  }
}
