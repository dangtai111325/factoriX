import React from 'react'
import { Headset, LockKeyhole, ShieldCheck, Zap } from 'lucide-react'

type AuthStatusFooterProps = {
  variant?: 'login' | 'register'
}

export const AuthStatusFooter: React.FC<AuthStatusFooterProps> = ({ variant = 'login' }) => {
  if (variant === 'register') {
    return (
      <div className="mt-6 rounded-xl bg-[#F6FBF9] border border-[#E5ECE9] px-3.5 py-3 grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#E5ECE9] items-center text-center gap-2 sm:gap-0">
        <div className="flex items-center justify-center gap-2.5 px-2 py-1 sm:py-0">
          <Zap className="w-5 h-5 text-[#0DBA67] shrink-0" aria-hidden="true" />
          <div className="text-left leading-tight">
            <div className="text-[12px] font-bold text-[#111B37]">Fast onboarding</div>
            <div className="text-[11px] text-[#657794]">Get started in minutes</div>
          </div>
        </div>
        <div className="flex items-center justify-center gap-2.5 px-2 py-1 sm:py-0">
          <Headset className="w-5 h-5 text-[#EF1B24] shrink-0" aria-hidden="true" />
          <div className="text-left leading-tight">
            <div className="text-[12px] font-bold text-[#111B37]">24/7 support</div>
            <div className="text-[11px] text-[#657794]">Our team is always ready</div>
          </div>
        </div>
        <div className="flex items-center justify-center gap-2.5 px-2 py-1 sm:py-0">
          <ShieldCheck className="w-5 h-5 text-[#0DBA67] shrink-0" aria-hidden="true" />
          <div className="text-left leading-tight">
            <div className="text-[12px] font-bold text-[#111B37]">Enterprise security</div>
            <div className="text-[11px] text-[#657794]">TLS 1.3 & data protection</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-8 rounded-xl bg-[#F6FBF9] border border-[#E5ECE9] px-3.5 py-3 grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#E5ECE9] items-center text-center gap-2 sm:gap-0">
      <div className="flex items-center justify-center gap-2.5 px-2 py-1 sm:py-0">
        <ShieldCheck className="w-5 h-5 text-[#0DBA67] shrink-0" aria-hidden="true" />
        <div className="text-left leading-tight">
          <div className="text-[12px] font-bold text-[#111B37]">Data Collector</div>
          <div className="text-[11px] text-[#657794]">v2.4.0</div>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 px-2 py-1 sm:py-0">
        <LockKeyhole className="w-4 h-4 text-[#00A389] shrink-0" aria-hidden="true" />
        <span className="text-[12px] font-medium text-[#334568]">TLS 1.3 secured</span>
      </div>
      <div className="flex items-center justify-center gap-2.5 px-2 py-1 sm:py-0">
        <Headset className="w-5 h-5 text-[#EF1B24] shrink-0" aria-hidden="true" />
        <div className="text-left leading-tight">
          <div className="text-[12px] font-bold text-[#111B37]">24/7 technical</div>
          <div className="text-[11px] text-[#657794]">support</div>
        </div>
      </div>
    </div>
  )
}
