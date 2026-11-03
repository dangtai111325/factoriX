import React from 'react'
import { useLocation, Link } from 'react-router-dom'
import { LayoutDashboard, Database, Bell, ChartNoAxesColumn, FileText, Settings, Braces } from 'lucide-react'
import { Card } from '../../components/common/Card'
import { plannedModules } from '../../features/navigation/routes'

const modules: Record<
  string,
  { title: string; description: string; icon: React.ElementType; features: string[] }
> = {
  '/dashboards': {
    title: 'Dashboards',
    icon: LayoutDashboard,
    description: 'Build visual workspaces using collected signals and structured model outputs.',
    features: [
      'Dashboard library and templates',
      'Responsive widget builder',
      'Factory and resource views',
      'Workspace sharing and display settings',
    ],
  },
  '/historian': {
    title: 'Historian & Storage',
    icon: Database,
    description:
      'Choose which raw, canonical or model-output values to retain, with explicit storage and retention policies.',
    features: [
      'Storage destinations and policies',
      'Historical queries and trends',
      'Downsampling and retention',
      'Backup and restore',
    ],
  },
  '/alarms': {
    title: 'Alarms & Events',
    icon: Bell,
    description: 'Define industrial alarm rules, review events and manage operator responses.',
    features: [
      'Alarm rules and priorities',
      'Acknowledgment and shelving',
      'Notification routing',
      'Event history and analysis',
    ],
  },
  '/analytics': {
    title: 'Analytics',
    icon: ChartNoAxesColumn,
    description: 'Explore production, equipment and energy data through reusable analyses.',
    features: [
      'Analysis workspaces',
      'KPI definitions and calculations',
      'Production and energy comparisons',
      'Reusable analysis templates',
    ],
  },
  '/reports': {
    title: 'Reports',
    icon: FileText,
    description: 'Create and export summaries from selected signals, models and reporting periods.',
    features: [
      'Report templates and builder',
      'Reporting schedules',
      'Export and delivery settings',
      'Report library',
    ],
  },
  '/administration': {
    title: 'Administration',
    icon: Settings,
    description: 'Manage users, access, appliance settings and administrative audit records.',
    features: [
      'Users and roles',
      'Security and sessions',
      'Appliance and email settings',
      'Administrative audit and integrations',
    ],
  },
  '/models/formulas': {
    title: 'Formula Editor',
    icon: Braces,
    description: 'Create derived signals and model calculations with a shared, validated formula editor.',
    features: [
      'Signal bindings and units',
      'Formula validation and preview',
      'Dependency and cycle checks',
      'Explicit activation and revisions',
    ],
  },
}
export const ComingSoonPage: React.FC = () => {
  const location = useLocation()
  const module = plannedModules.find(
    (module) => location.pathname === module.path || location.pathname.startsWith(`${module.path}/`),
  )
  const section = module?.children.find((child) => child.path === location.pathname)
  const meta = modules[module?.path || location.pathname]
  if (!meta) return <p>Module unavailable.</p>
  const Icon = meta.icon
  return (
    <div className="mx-auto max-w-4xl space-y-6 py-4">
      <div className="space-y-3">
        <Icon aria-hidden="true" className="h-8 w-8 text-[var(--fx-muted)]" />
        <span className="inline-block rounded bg-[#F1F5FA] px-2 py-1 text-xs font-semibold text-[var(--fx-muted)]">
          Coming soon
        </span>
        <h1 className="fx-page-title">{section?.label || meta.title}</h1>
        <p className="fx-page-subtitle">{meta.description}</p>
      </div>
      {module ? (
        <nav aria-label={`${module.label} sections`} className="flex flex-wrap gap-2">
          {module.children.map((child) => (
            <Link
              key={child.path}
              aria-current={section?.path === child.path ? 'page' : undefined}
              className={`rounded-lg border border-[var(--fx-border)] px-3 py-2 text-sm ${section?.path === child.path ? 'bg-[#FFF0F1] text-[#EF1B24]' : ''}`}
              to={child.path}
            >
              {child.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-bold">Planned capabilities</h2>
        <ul className="grid list-inside list-disc gap-3 text-sm text-[var(--fx-muted)] sm:grid-cols-2">
          {meta.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </Card>
      <div className="flex flex-wrap gap-3">
        <Link
          className="rounded-lg border border-[var(--fx-border)] px-4 py-2 text-sm font-semibold"
          to="/overview"
        >
          Overview
        </Link>
        <Link
          className="rounded-lg border border-[var(--fx-border)] px-4 py-2 text-sm font-semibold"
          to="/collector/signals/live"
        >
          Live Monitor
        </Link>
      </div>
    </div>
  )
}
