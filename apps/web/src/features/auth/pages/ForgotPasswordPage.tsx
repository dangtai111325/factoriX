import React, { useEffect, useState } from 'react'
import { Mail } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AuthAlert } from '../components/AuthAlert'
import { AuthField } from '../components/AuthField'
import { AuthShell } from '../components/AuthShell'
import { AuthStatusFooter } from '../components/AuthStatusFooter'
import { BrandLogo } from '../components/BrandLogo'
import { forgotPassword, getAuthStatus, mapAuthError } from '../services/authClient'
import { validateEmail } from '../schemas/authSchemas'

export const ForgotPasswordPage: React.FC = () => {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [serverError, setServerError] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [pending, setPending] = useState(false)
  const [recoveryEnabled, setRecoveryEnabled] = useState(true)

  useEffect(() => {
    void getAuthStatus()
      .then((status) => {
        setRecoveryEnabled(Boolean(status.password_recovery_enabled ?? status.smtp_configured ?? true))
      })
      .catch(() => setRecoveryEnabled(true))
  }, [])

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const invalid = validateEmail(email)
    setError(invalid || '')
    if (invalid) return
    setPending(true)
    setServerError('')
    try {
      await forgotPassword(email.trim().toLowerCase())
      setAccepted(true)
    } catch (caught) {
      setServerError(mapAuthError(caught, 'Request failed.'))
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
        <h1 className="mt-8 text-[34px] font-extrabold text-[#111B37]">Forgot password</h1>
        <p className="mt-2 text-[16px] text-[#657794]">
          Enter the email on the account. If it matches, a reset code is sent. It expires in 10 minutes.
        </p>
      </div>
      {!recoveryEnabled && (
        <div className="mt-6">
          <AuthAlert tone="info">
            Password recovery is disabled until email is set up on this appliance.
          </AuthAlert>
        </div>
      )}
      <form className="mt-8 space-y-5" onSubmit={onSubmit} noValidate>
        <AuthField
          id="forgot-email"
          label="Email"
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="email"
          error={error}
          icon={Mail}
          autoFocus
        />
        {accepted ? (
          <AuthAlert tone="info">
            If an account matches this email, we&apos;ve sent a 6-digit reset code. It expires in 10 minutes.
          </AuthAlert>
        ) : null}
        {serverError ? <AuthAlert>{serverError}</AuthAlert> : null}
        <button
          type="submit"
          className="fx-auth-button-primary"
          disabled={pending || accepted || !recoveryEnabled}
        >
          {pending ? 'Sending…' : 'Send reset instructions'}
        </button>
      </form>
      <div className="mt-5 flex justify-between text-[14px] font-semibold">
        <Link to="/login" className="text-[#EF1B24] no-underline hover:underline">
          Back to sign in
        </Link>
        <Link to="/reset-password" className="text-[#334568] no-underline hover:underline">
          Have a code?
        </Link>
      </div>
      <AuthStatusFooter />
    </AuthShell>
  )
}
