import React from 'react'
import { ChevronDown, CircleHelp, Globe2 } from 'lucide-react'
import { AuthShowcase } from './AuthShowcase'
import '../styles/auth.css'

type AuthShellProps = {
  children: React.ReactNode
  variant?: 'login' | 'register'
}

export const AuthShell: React.FC<AuthShellProps> = ({ children, variant = 'login' }) => (
  <div className="fx-auth-shell">
    <AuthShowcase variant={variant} />
    <main className="fx-auth-form-host">
      <div className="fx-auth-utilities">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[#334568] hover:text-[#111B37] text-[14px] font-semibold bg-transparent border-0 p-0 cursor-pointer"
        >
          <Globe2 className="w-4 h-4 text-[#657794]" aria-hidden="true" />
          <span>English</span>
          <ChevronDown className="w-3.5 h-3.5 text-[#657794]" aria-hidden="true" />
        </button>
        <span className="text-[#D4DFEC]" aria-hidden="true">|</span>
        <a
          href="mailto:support@factorix.local"
          className="inline-flex items-center gap-1.5 text-[#334568] no-underline hover:text-[#EF1B24] text-[14px] font-semibold"
        >
          <CircleHelp className="w-4 h-4 text-[#657794]" aria-hidden="true" />
          <span>Help Center</span>
        </a>
      </div>
      <div className="fx-auth-card">{children}</div>
    </main>
  </div>
)
