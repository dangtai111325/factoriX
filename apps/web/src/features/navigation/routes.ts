export interface NavigationGroup {
  id: string
  label: string
  path?: string
  children?: Array<{ label: string; path: string }>
}
export const navigationGroups: NavigationGroup[] = [
  { id: 'overview', label: 'Overview', path: '/overview' },
  {
    id: 'factory',
    label: 'Factory Model',
    children: [
      { label: 'Hierarchy Structure', path: '/factory/structure' },
      { label: 'Layout Designer', path: '/factory/layout' },
      { label: 'Knowledge Graph', path: '/factory/graph' },
    ],
  },
  {
    id: 'collector',
    label: 'Data Collector',
    children: [
      { label: 'Connections', path: '/collector/connections' },
      { label: 'Signals', path: '/collector/signals' },
      { label: 'Edge Collectors', path: '/collector/edges' },
      { label: 'Diagnostics', path: '/collector/diagnostics' },
    ],
  },
  {
    id: 'models',
    label: 'Data Models',
    children: [
      { label: 'Model Catalog', path: '/models' },
      { label: 'Model Designer', path: '/models/designer' },
      { label: 'Live Preview', path: '/models/live-preview' },
    ],
  },
]
export const plannedModules = [
  {
    id: 'dashboards',
    label: 'Dashboards',
    path: '/dashboards',
    children: [
      { label: 'Dashboard Library', path: '/dashboards/library' },
      { label: 'Dashboard Builder', path: '/dashboards/builder' },
    ],
  },
  {
    id: 'historian',
    label: 'Historian & Storage',
    path: '/historian',
    children: [
      { label: 'Data Explorer', path: '/historian/explorer' },
      { label: 'Storage Policies', path: '/historian/policies' },
      { label: 'Retention & Export', path: '/historian/retention-export' },
    ],
  },
  {
    id: 'alarms',
    label: 'Alarms & Events',
    path: '/alarms',
    children: [
      { label: 'Alarm Rules', path: '/alarms/rules' },
      { label: 'Active Alarms', path: '/alarms/active' },
      { label: 'Event History', path: '/alarms/history' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    path: '/analytics',
    children: [
      { label: 'Analysis Workspace', path: '/analytics/workspace' },
      { label: 'Advanced Analytics', path: '/analytics/advanced' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    path: '/reports',
    children: [
      { label: 'Report Library', path: '/reports/library' },
      { label: 'Report Builder', path: '/reports/builder' },
      { label: 'Schedules', path: '/reports/schedules' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    path: '/administration',
    children: [
      { label: 'General Settings', path: '/administration/settings' },
      { label: 'Users & Roles', path: '/administration/users' },
      { label: 'Integrations', path: '/administration/integrations' },
      { label: 'Audit Log', path: '/administration/audit' },
    ],
  },
]
export const legacyRoutes: Record<string, string> = {
  '/acquisition/connections': '/collector/connections',
  '/acquisition/edges': '/collector/edges',
  '/acquisition/add-data': '/collector/add-data',
  '/signals': '/collector/signals',
  '/signals/calculated': '/models/formulas',
  '/signals/output-groups': '/models/output-groups',
  '/live/monitor': '/collector/signals/live',
  '/live/diagnostics': '/collector/diagnostics',
  '/live/activity': '/collector/diagnostics/activity',
  '/storage': '/historian',
}
export function legacyDestination(pathname: string, search = '', hash = ''): string {
  const studio = /^\/acquisition\/studio\/(opcua|mqtt|http)$/.exec(pathname)
  const query = new URLSearchParams(search)
  if (studio) query.set('protocol', studio[1])
  const target = studio ? '/collector/add-data' : legacyRoutes[pathname] || pathname
  return target + (query.size ? `?${query.toString()}` : '') + hash
}
export function activeNavigationGroup(pathname: string): string | undefined {
  const planned = plannedModules.find((m) => pathname === m.path || pathname.startsWith(`${m.path}/`))
  if (planned) return planned.id
  return navigationGroups.find(
    (g) =>
      g.path === pathname ||
      g.children?.some((c) => pathname === c.path || pathname.startsWith(`${c.path}/`)),
  )?.id
}
