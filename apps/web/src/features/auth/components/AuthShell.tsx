import React from 'react'
import { CircleHelp } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AuthShowcase } from './AuthShowcase'
import '../styles/auth.css'

type AuthShellProps = {
  children: React.ReactNode
  variant?: 'login' | 'register'
}

export const AuthShell: React.FC<AuthShellProps> = ({ children, variant = 'login' }) => {
  return (
    <div className="fx-auth-shell">
      <AuthShowcase variant={variant} />
      <main className="fx-auth-form-host">
        <div className="fx-auth-utilities">
          {/* CR-A12: language selector hidden until locales ship */}
          <Link
            to="/legal/terms"
            className="inline-flex items-center gap-1.5 text-[#334568] hover:text-[#EF1B24] text-[14px] font-semibold no-underline"
          >
            <CircleHelp className="w-4 h-4 text-[#657794]" aria-hidden="true" />
            <span>Help</span>
          </Link>
        </div>
        <div className="fx-auth-card">{children}</div>
      </main>
    </div>
  )
}
