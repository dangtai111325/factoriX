import React, { useState } from 'react'
import { CircleHelp, Globe2 } from 'lucide-react'
import { AuthShowcase } from './AuthShowcase'
import '../styles/auth.css'

type AuthShellProps = {
  children: React.ReactNode
  variant?: 'login' | 'register'
}

export const AuthShell: React.FC<AuthShellProps> = ({ children, variant = 'login' }) => {
  const [langNoteOpen, setLangNoteOpen] = useState(false)

  return (
    <div className="fx-auth-shell">
      <AuthShowcase variant={variant} />
      <main className="fx-auth-form-host">
        <div className="fx-auth-utilities">
          <div className="relative">
            <button
              type="button"
              onClick={() => setLangNoteOpen((open) => !open)}
              className="inline-flex items-center gap-1.5 text-[#334568] hover:text-[#111B37] text-[14px] font-semibold bg-transparent border-0 p-0 cursor-pointer"
              aria-expanded={langNoteOpen}
            >
              <Globe2 className="w-4 h-4 text-[#657794]" aria-hidden="true" />
              <span>English</span>
            </button>
            {langNoteOpen ? (
              <div className="absolute right-0 top-full mt-2 z-10 w-[220px] rounded-lg border border-[#E3EAF3] bg-white px-3 py-2 text-[12px] text-[#657794] shadow-sm">
                English only in this build.
              </div>
            ) : null}
          </div>
          <span className="text-[#D4DFEC]" aria-hidden="true">|</span>
          <button
            type="button"
            onClick={() => {
              window.alert('Contact your appliance administrator for help with this FactoriX installation.')
            }}
            className="inline-flex items-center gap-1.5 text-[#334568] hover:text-[#EF1B24] text-[14px] font-semibold bg-transparent border-0 p-0 cursor-pointer"
          >
            <CircleHelp className="w-4 h-4 text-[#657794]" aria-hidden="true" />
            <span>Help</span>
          </button>
        </div>
        <div className="fx-auth-card">{children}</div>
      </main>
    </div>
  )
}
