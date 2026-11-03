import React from 'react'
import { LucideIcon } from 'lucide-react'

type AuthFieldProps = {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  type?: string
  autoComplete?: string
  placeholder?: string
  error?: string
  icon: LucideIcon
  autoFocus?: boolean
}

export const AuthField: React.FC<AuthFieldProps> = ({
  id,
  label,
  value,
  onChange,
  onBlur,
  type = 'text',
  autoComplete,
  placeholder,
  error,
  icon: Icon,
  autoFocus,
}) => (
  <div className="block">
    <label className="block text-[15px] font-semibold text-[#111B37] text-left" htmlFor={id}>
      {label}
    </label>
    <div className="fx-auth-input-wrap mt-2">
      <Icon className="fx-auth-input-icon w-5 h-5 text-[#657794]" aria-hidden="true" />
      <input
        id={id}
        className="fx-auth-input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        autoFocus={autoFocus}
        required
      />
    </div>
    {error ? (
      <p id={`${id}-error`} className="mt-1.5 text-[13px] font-medium text-[#F2343B] text-left" role="alert">
        {error}
      </p>
    ) : null}
  </div>
)
