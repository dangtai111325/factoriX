import React from 'react'

export const AuthAlert: React.FC<{ children: React.ReactNode; tone?: 'error' | 'success' | 'info' }> = ({
  children,
  tone = 'error',
}) => {
  const colors =
    tone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : tone === 'info'
        ? 'border-sky-200 bg-sky-50 text-sky-900'
        : 'border-red-200 bg-red-50 text-red-700'
  return (
    <div role="alert" className={`rounded-lg border px-3 py-2.5 text-[13px] font-medium ${colors}`}>
      {children}
    </div>
  )
}
