import React, { useState } from 'react'
import { Mail, UserRound } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthAlert } from '../components/AuthAlert'
import { AuthField } from '../components/AuthField'
import { AuthShell } from '../components/AuthShell'
import { AuthStatusFooter } from '../components/AuthStatusFooter'
import { BrandLogo } from '../components/BrandLogo'
import { PasswordField } from '../components/PasswordField'
import { mapAuthError, resetPassword } from '../services/authClient'
import {
  validateConfirmPassword,
  validateEmail,
  validateNewPassword,
  validateResetCode,
} from '../schemas/authSchemas'

export const ResetPasswordPage: React.FC = () => {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const [pending, setPending] = useState(false)

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const next = {
      email: validateEmail(email) || '',
      code: validateResetCode(code) || '',
      password: validateNewPassword(password, '') || '',
      confirmPassword: validateConfirmPassword(password, confirmPassword) || '',
    }
    setErrors(Object.fromEntries(Object.entries(next).filter(([, value]) => value)))
    if (Object.values(next).some(Boolean)) return
    setPending(true)
    setServerError('')
    try {
      await resetPassword(email.trim().toLowerCase(), code.trim(), password)
      navigate('/login?reset=success', { replace: true })
    } catch (caught) {
      setServerError(mapAuthError(caught, 'Password reset failed.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell>
      <div className="text-center">
        <div className="flex justify-center">
          <BrandLogo compact />
        </div>
        <h1 className="mt-8 text-[34px] font-extrabold text-[#111B37]">Reset password</h1>
        <p className="mt-2 text-[16px] text-[#657794]">Enter the email, 6-digit code and a new password.</p>
      </div>
      <form className="mt-8 space-y-4" onSubmit={onSubmit} noValidate>
        <AuthField
          id="reset-email"
          label="Work email"
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="email"
          error={errors.email}
          icon={Mail}
          autoFocus
        />
        <AuthField
          id="reset-code"
          label="Reset code"
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          error={errors.code}
          icon={UserRound}
        />
        <div className="fx-auth-two-col">
          <PasswordField
            id="reset-password"
            label="New password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            error={errors.password}
          />
          <PasswordField
            id="reset-confirm"
            label="Confirm password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            error={errors.confirmPassword}
          />
        </div>
        {serverError ? <AuthAlert>{serverError}</AuthAlert> : null}
        <button type="submit" className="fx-auth-button-primary" disabled={pending}>
          {pending ? 'Updating…' : 'Update password'}
        </button>
      </form>
      <Link to="/login" className="mt-5 inline-block text-[14px] font-semibold text-[#EF1B24] no-underline hover:underline">
        Back to sign in
      </Link>
      <AuthStatusFooter />
    </AuthShell>
  )
}
