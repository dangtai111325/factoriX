import React, { useState } from 'react'
import { Eye, EyeOff, LockKeyhole } from 'lucide-react'

type PasswordFieldProps = {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onFocus?: () => void
  autoComplete?: string
  error?: string
  placeholder?: string
}

export const PasswordField: React.FC<PasswordFieldProps> = ({
  id,
  label,
  value,
  onChange,
  onBlur,
  onFocus,
  autoComplete,
  error,
  placeholder = 'Enter your password',
}) => {
  const [visible, setVisible] = useState(false)
  return (
    <div className="block">
      <label className="block text-[15px] font-semibold text-[#111B37] text-left" htmlFor={id}>
        {label}
      </label>
      <div className="fx-auth-input-wrap mt-2">
        <LockKeyhole className="fx-auth-input-icon w-5 h-5 text-[#657794]" aria-hidden="true" />
        <input
          id={id}
          className="fx-auth-input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onFocus={onFocus}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          required
        />
        <button
          type="button"
          className="fx-auth-input-action"
          aria-label={visible ? 'Hide password' : 'Show password'}
          onClick={() => setVisible((current) => !current)}
          tabIndex={-1}
        >
          {visible ? <EyeOff className="w-5 h-5 text-[#657794]" /> : <Eye className="w-5 h-5 text-[#657794]" />}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] font-medium text-[#F2343B] text-left" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
