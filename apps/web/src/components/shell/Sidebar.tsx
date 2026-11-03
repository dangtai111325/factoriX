import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Menu, RotateCcw } from 'lucide-react'
import { useApp } from '../../store/AppContext'
import { useAuth } from '../../features/auth'
import { Dialog } from '../common/Dialog'
import { NavigationLinks } from './NavigationLinks'
import { activeNavigationGroup, plannedModules } from '../../features/navigation/routes'

export const Sidebar: React.FC = () => {
  const location = useLocation()
  const { revertToZero } = useApp()
  const { signOut } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    factory: true,
    collector: true,
    models: true,
    planned: false,
  })
  useEffect(() => {
    const active = activeNavigationGroup(location.pathname)
    if (active)
      setOpenGroups((previous) => ({
        ...previous,
        [active]: true,
        ...(plannedModules.some((module) => module.id === active) ? { planned: true } : {}),
      }))
    setMobileOpen(false)
  }, [location.pathname])
  const toggle = (id: string) => setOpenGroups((previous) => ({ ...previous, [id]: !previous[id] }))
  const footer = (
    <div className="space-y-2 border-t border-[#E3EAF3] bg-[#F9FAFD]/60 p-3">
      <button
        type="button"
        onClick={() => {
          const confirmText = window.prompt(
            'Revert to zero deletes every user, model and sample. Type REVERT to continue.',
          )
          if (confirmText === 'REVERT') void revertToZero('REVERT')
        }}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#FAC6C9] px-3 py-1.5 text-xs font-medium text-[#F2343B] hover:bg-white"
        title="Deletes the installation, including the administrator."
      >
        <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
        Revert To Zero
      </button>
      <button
        type="button"
        onClick={() => void signOut().then(() => window.location.assign('/login'))}
        className="w-full text-xs text-[#657794] hover:text-[#111B37]"
      >
        Sign out
      </button>
    </div>
  )
  return (
    <>
      <aside className="fx-sidebar select-none" aria-label="Workspace">
        <div className="flex h-[62px] shrink-0 items-center border-b border-[#E3EAF3] px-5">
          <img src="/factorix-logo.png" alt="FactoriX" className="h-7 w-auto object-contain" />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <NavigationLinks openGroups={openGroups} onToggle={toggle} />
        </div>
        {footer}
      </aside>
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(true)}
        className="fx-mobile-navigation rounded-lg border border-[var(--fx-border)] bg-white p-2 text-[var(--fx-ink)]"
      >
        <Menu aria-hidden="true" className="h-5 w-5" />
      </button>
      <Dialog title="Navigation" isOpen={mobileOpen} onClose={() => setMobileOpen(false)}>
        <div
          className="max-h-[65dvh] overflow-y-auto p-3"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setMobileOpen(false)
          }}
        >
          <NavigationLinks openGroups={openGroups} onToggle={toggle} />
        </div>
        {footer}
      </Dialog>
    </>
  )
}
