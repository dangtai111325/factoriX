import React, { useMemo, useState } from 'react'
import { ArrowRight, Check, ChevronRight, Mail, UserRound } from 'lucide-react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { AuthAlert } from '../components/AuthAlert'
import { AuthField } from '../components/AuthField'
import { AuthShell } from '../components/AuthShell'
import { AuthStatusFooter } from '../components/AuthStatusFooter'
import { PasswordField } from '../components/PasswordField'
import { useAuth } from '../context/AuthProvider'
import { mapAuthError } from '../services/authClient'
import {
  passwordChecks,
  validateConfirmPassword,
  validateEmail,
  validateFullName,
  validateNewPassword,
  validateUsername,
} from '../schemas/authSchemas'

export const RegisterPage: React.FC = () => {
  const { isAuthenticated, setupCodeRequired, signUp } = useAuth()
  const navigate = useNavigate()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [agreeTerms, setAgreeTerms] = useState(true)
  const [showHints, setShowHints] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const [pending, setPending] = useState(false)

  const checks = useMemo(() => passwordChecks(password, username), [password, username])

  if (isAuthenticated) return <Navigate to="/overview" replace />

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const next = {
      fullName: validateFullName(fullName) || '',
      email: validateEmail(email) || '',
      username: validateUsername(username) || '',
      password: validateNewPassword(password, username) || '',
      confirmPassword: validateConfirmPassword(password, confirmPassword) || '',
      setupCode: setupCodeRequired && !setupCode.trim() ? 'Enter the setup code provided for this appliance.' : '',
      terms: !agreeTerms ? 'You must agree to the Terms of Use and Privacy Policy.' : '',
    }
    setErrors(Object.fromEntries(Object.entries(next).filter(([, value]) => value)))
    if (Object.values(next).some(Boolean)) return
    setPending(true)
    setServerError('')
    try {
      await signUp({
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        username: username.trim(),
        password,
        setupCode: setupCode.trim() || undefined,
      })
      navigate('/login?created=1', { replace: true })
    } catch (error) {
      setServerError(mapAuthError(error, 'Account creation failed.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell variant="register">
      <div className="text-center">
        <h1 className="text-[30px] sm:text-[34px] font-extrabold text-[#111B37] tracking-tight">
          Create your FactoriX account
        </h1>
        <p className="mt-2 text-[15px] sm:text-[16px] text-[#657794] max-w-[520px] mx-auto leading-normal">
          Create your account to start using the FactoriX IIoT platform for industrial data collection, signal monitoring, and plant operations.
        </p>
      </div>

      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <AuthField
          id="register-name"
          label="Full name"
          value={fullName}
          onChange={setFullName}
          autoComplete="name"
          placeholder="Enter your full name"
          error={errors.fullName}
          icon={UserRound}
          autoFocus
        />
        <AuthField
          id="register-email"
          label="Work email"
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="email"
          placeholder="Enter your work email"
          error={errors.email}
          icon={Mail}
        />
        <AuthField
          id="register-username"
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          placeholder="Enter your username"
          error={errors.username}
          icon={UserRound}
        />
        <div className="fx-auth-two-col">
          <PasswordField
            id="register-password"
            label="Password"
            value={password}
            onChange={setPassword}
            onFocus={() => setShowHints(true)}
            autoComplete="new-password"
            placeholder="Enter your password"
            error={errors.password}
          />
          <PasswordField
            id="register-confirm"
            label="Confirm password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            placeholder="Confirm your password"
            error={errors.confirmPassword}
          />
        </div>

        {showHints && (
          <div className="rounded-xl border border-[#E3EAF3] bg-[#F9FAFD] p-3 space-y-1.5 text-[13px]">
            {[
              { ok: checks.length, label: 'At least 12 characters' },
              { ok: checks.classes, label: 'At least 3 character groups' },
              { ok: checks.noUsername, label: 'Does not contain your username' },
            ].map((item) => (
              <div key={item.label} className={`flex items-center gap-2 ${item.ok ? 'text-emerald-700 font-medium' : 'text-[#657794]'}`}>
                <Check className={`w-4 h-4 ${item.ok ? 'text-emerald-600' : 'text-[#94A3B8]'}`} aria-hidden="true" />
                {item.label}
              </div>
            ))}
          </div>
        )}

        {setupCodeRequired && (
          <AuthField
            id="register-setup"
            label="Setup code"
            value={setupCode}
            onChange={setSetupCode}
            autoComplete="one-time-code"
            placeholder="Enter setup code"
            error={errors.setupCode}
            icon={UserRound}
          />
        )}

        <div className="pt-1">
          <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[14px] text-[#334568]">
            <input
              type="checkbox"
              checked={agreeTerms}
              onChange={(e) => setAgreeTerms(e.target.checked)}
              className="w-4 h-4 rounded border-[#D4DFEC] text-[#EF1B24] accent-[#EF1B24] focus:ring-[#EF1B24] cursor-pointer"
            />
            <span>
              I agree to the <span className="font-semibold text-[#EF1B24]">Terms of Use</span> and{' '}
              <span className="font-semibold text-[#EF1B24]">Privacy Policy</span>
            </span>
          </label>
          {errors.terms && (
            <p className="mt-1 text-[13px] font-medium text-[#F2343B] text-left">{errors.terms}</p>
          )}
        </div>

        {serverError ? <AuthAlert>{serverError}</AuthAlert> : null}

        <button type="submit" className="fx-auth-button-primary mt-2" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating account…' : 'Create account'}
          {!pending && <ArrowRight className="w-5 h-5 ml-1" aria-hidden="true" />}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 text-[#94A3B8] text-[13px]">
        <div className="h-px flex-1 bg-[#E3EAF3]" />
        or
        <div className="h-px flex-1 bg-[#E3EAF3]" />
      </div>

      <Link
        to="/login"
        className="w-full min-h-[50px] rounded-[10px] border border-[#E3EAF3] bg-white hover:bg-[#F9FAFC] transition-colors flex items-center justify-center gap-1.5 text-[15px] text-[#334568] no-underline shadow-sm font-normal"
      >
        <span>Already have an account?</span>
        <span className="font-bold text-[#EF1B24] inline-flex items-center gap-0.5">
          Sign in now
          <ChevronRight className="w-4 h-4" />
        </span>
      </Link>

      <AuthStatusFooter variant="register" />
    </AuthShell>
  )
}
