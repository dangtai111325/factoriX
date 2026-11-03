import React from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { SignalsCatalogPage } from '../08_SignalsCatalog/SignalsCatalogPage'
import { LiveOperationsPage } from '../10_LiveOperations/LiveOperationsPage'
import { DiagnosticsPage } from '../11_Diagnostics/DiagnosticsPage'
import { ActivityLogPage } from '../12_ActivityLog/ActivityLogPage'

interface Link {
  label: string
  path: string
  end?: boolean
}
const WorkspaceTabs: React.FC<{ label: string; links: Link[] }> = ({ label, links }) => {
  const location = useLocation()
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-[var(--fx-border)] pb-2">
      {links.map((link) => (
        <NavLink
          key={link.path}
          end={link.end}
          to={{ pathname: link.path, search: location.search, hash: location.hash }}
          className={({ isActive }) =>
            `rounded-lg px-4 py-2 text-sm font-semibold ${isActive ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'text-[#657794] hover:bg-[#F9FAFD]'}`
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  )
}
export const CollectorSignalsPage: React.FC = () => {
  const live = useLocation().pathname.endsWith('/live')
  return (
    <div className="space-y-4">
      <WorkspaceTabs
        label="Signals views"
        links={[
          { label: 'Catalog', path: '/collector/signals', end: true },
          { label: 'Live Monitor', path: '/collector/signals/live' },
        ]}
      />
      {live ? <LiveOperationsPage /> : <SignalsCatalogPage />}
    </div>
  )
}
export const CollectorDiagnosticsPage: React.FC = () => {
  const activity = useLocation().pathname.endsWith('/activity')
  return (
    <div className="space-y-4">
      <WorkspaceTabs
        label="Diagnostics views"
        links={[
          { label: 'Source Diagnostics', path: '/collector/diagnostics', end: true },
          { label: 'Activity', path: '/collector/diagnostics/activity' },
        ]}
      />
      {activity ? <ActivityLogPage /> : <DiagnosticsPage />}
    </div>
  )
}
