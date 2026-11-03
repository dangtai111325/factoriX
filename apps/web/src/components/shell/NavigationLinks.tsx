import React, { useId } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  House,
  Box,
  RadioTower,
  Braces,
  ChevronDown,
  LayoutDashboard,
  Database,
  Bell,
  ChartNoAxesColumn,
  FileText,
  Settings,
} from 'lucide-react'
import { navigationGroups, plannedModules, activeNavigationGroup } from '../../features/navigation/routes'

const icons: Record<string, React.ElementType> = {
  overview: House,
  factory: Box,
  collector: RadioTower,
  models: Braces,
  dashboards: LayoutDashboard,
  historian: Database,
  alarms: Bell,
  analytics: ChartNoAxesColumn,
  reports: FileText,
  admin: Settings,
}
interface Props {
  openGroups: Record<string, boolean>
  onToggle: (id: string) => void
}
export const NavigationLinks: React.FC<Props> = ({ openGroups, onToggle }) => {
  const location = useLocation()
  const prefix = useId()
  const active = activeNavigationGroup(location.pathname)
  return (
    <nav aria-label="Product navigation" className="space-y-1">
      {navigationGroups.map((group) => {
        const Icon = icons[group.id]
        if (group.path)
          return (
            <NavLink
              key={group.id}
              end
              to={group.path}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold ${isActive ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'text-[#334568] hover:bg-[#F9FAFD]'}`
              }
            >
              <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
              <span>{group.label}</span>
            </NavLink>
          )
        const open = Boolean(openGroups[group.id])
        return (
          <div key={group.id}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${prefix}-${group.id}`}
              onClick={() => onToggle(group.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold ${active === group.id ? 'bg-[#FFF0F1]/60 text-[#EF1B24]' : 'text-[#334568] hover:bg-[#F9FAFD]'}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                {group.label}
              </span>
              <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open ? 'rotate-180' : ''}`} />
            </button>
            {open ? (
              <div
                id={`${prefix}-${group.id}`}
                className="ml-5 space-y-0.5 border-l border-[#E2E8F0] py-1 pl-3"
              >
                {group.children?.map((child) => (
                  <NavLink
                    key={child.path}
                    to={child.path}
                    end={child.path === '/models'}
                    className={({ isActive }) =>
                      `block rounded-md px-3 py-2 text-[13px] font-medium ${isActive ? 'bg-[#FFF0F1] font-bold text-[#EF1B24]' : 'text-[#657794] hover:bg-[#F9FAFD] hover:text-[#111B37]'}`
                    }
                  >
                    {child.label}
                  </NavLink>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="pt-4">
        <button
          type="button"
          aria-expanded={Boolean(openGroups.planned)}
          aria-controls={`${prefix}-planned`}
          onClick={() => onToggle('planned')}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-[#657794] hover:bg-[#F9FAFD]"
        >
          <span>
            Planned Modules <span className="ml-1 text-[#94A3B8]">{plannedModules.length}</span>
          </span>
          <ChevronDown aria-hidden="true" className={`h-4 w-4 ${openGroups.planned ? 'rotate-180' : ''}`} />
        </button>
        {openGroups.planned ? (
          <div id={`${prefix}-planned`}>
            {plannedModules.map((module) => {
              const Icon = icons[module.id]
              return (
                <div key={module.path}>
                  <button
                    type="button"
                    aria-expanded={Boolean(openGroups[module.id])}
                    aria-controls={`${prefix}-${module.id}`}
                    onClick={() => onToggle(module.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-[13px] ${active === module.id ? 'bg-[#FFF0F1] font-semibold text-[#EF1B24]' : 'text-[#657794] hover:bg-[#F9FAFD]'}`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      {module.label}
                    </span>
                    <span className="shrink-0 rounded bg-[#F1F5FA] px-1.5 py-0.5 text-[10px] text-[#94A3B8]">
                      Later
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={`h-3 w-3 shrink-0 ${openGroups[module.id] ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {openGroups[module.id] ? (
                    <div id={`${prefix}-${module.id}`} className="ml-5 border-l border-[#E2E8F0] py-1 pl-3">
                      {module.children.map((child) => (
                        <NavLink
                          key={child.path}
                          to={child.path}
                          className={({ isActive }) =>
                            `block rounded-md px-3 py-2 text-[13px] ${isActive ? 'bg-[#FFF0F1] font-bold text-[#EF1B24]' : 'text-[#657794] hover:bg-[#F9FAFD]'}`
                          }
                        >
                          {child.label}
                        </NavLink>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </nav>
  )
}
