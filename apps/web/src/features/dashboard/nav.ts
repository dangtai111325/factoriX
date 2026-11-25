/**
 * Navigation from widgets (link widget, equipment drill-down, table rows) through an allowlist only:
 * internal dashboards (optionally carrying the current variables) and the listed application pages.
 * Widgets never build URLs themselves and never reach an external address.
 */
import type { NavTarget } from './types';

export const PAGE_ROUTES: Record<string, { path: string; label: string }> = {
  overview: { path: '/overview', label: 'Overview' },
  factory_structure: { path: '/factory/structure', label: 'Hierarchy Structure' },
  factory_graph: { path: '/factory/graph', label: 'Knowledge Graph' },
  connections: { path: '/collector/connections', label: 'Connections' },
  signals: { path: '/collector/signals', label: 'Signals' },
  models: { path: '/models', label: 'Data Models' },
  storage: { path: '/historian/storage', label: 'Storage Management' },
  historian: { path: '/historian/historian', label: 'Historian' },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** In-app URL of a navigation target, or null when the target is not allowed. */
export function navUrl(
  target: NavTarget,
  ctx: { variables: Record<string, string | null>; range?: URLSearchParams | null },
): string | null {
  switch (target.kind) {
    case 'dashboard': {
      if (!isUuid(target.dashboard_id)) return null;
      const p = new URLSearchParams();
      if (target.carry_variables) {
        for (const [k, v] of Object.entries(ctx.variables)) if (v && isUuid(v)) p.set(`var-${k}`, v);
        ctx.range?.forEach((value, key) => {
          if (key === 'range' || key === 'from' || key === 'to') p.set(key, value);
        });
      }
      const qs = p.toString();
      return `/dashboards/${target.dashboard_id}${qs ? `?${qs}` : ''}`;
    }
    case 'page':
      return PAGE_ROUTES[target.page]?.path ?? null;
    case 'signal':
      return isUuid(target.signal_id) ? `/collector/signals?signalId=${target.signal_id}` : null;
    case 'resource':
      return isUuid(target.resource_id) ? `/factory/structure?resourceId=${target.resource_id}` : null;
    default:
      return null;
  }
}
