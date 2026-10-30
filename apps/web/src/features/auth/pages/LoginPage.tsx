import React, { useState } from 'react'
import { ArrowRight, ChevronRight, UserRound } from 'lucide-react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthAlert } from '../components/AuthAlert'
import { AuthField } from '../components/AuthField'
import { AuthShell } from '../components/AuthShell'
import { AuthStatusFooter } from '../components/AuthStatusFooter'
import { PasswordField } from '../components/PasswordField'
import { useAuth } from '../context/AuthProvider'
import { mapAuthError } from '../services/authClient'
import { validateLoginIdentity, validatePasswordRequired } from '../schemas/authSchemas'

export const LoginPage: React.FC = () => {
  const { isAuthenticated, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [rememberDevice, setRememberDevice] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState('')
  const [pending, setPending] = useState(false)

  if (isAuthenticated) return <Navigate to="/overview" replace />

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const next = {
      login: validateLoginIdentity(login) || '',
      password: validatePasswordRequired(password) || '',
    }
    setErrors(Object.fromEntries(Object.entries(next).filter(([, value]) => value)))
    if (next.login || next.password) return
    setPending(true)
    setServerError('')
    try {
      await signIn(login.trim(), password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from.startsWith('/') ? from : '/overview', { replace: true })
    } catch (error) {
      setServerError(mapAuthError(error, 'Sign in failed.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell variant="login">
      <div className="text-center">
        <h1 className="text-[32px] sm:text-[36px] font-extrabold text-[#111B37] tracking-tight">
          Sign in to FactoriX
        </h1>
        <p className="mt-2 text-[15px] sm:text-[16px] text-[#657794] max-w-[480px] mx-auto leading-normal">
          Access the IIoT platform to manage Data Collection, Signals, and real-time operations.
        </p>
      </div>

      {params.get('created') === '1' && (
        <div className="mt-6">
          <AuthAlert tone="success">Administrator created. Sign in with your username and password.</AuthAlert>
        </div>
      )}
      {params.get('reset') === 'success' && (
        <div className="mt-6">
          <AuthAlert tone="success">Password updated. Sign in with your new password.</AuthAlert>
        </div>
      )}

      <form className="mt-7 space-y-5" onSubmit={onSubmit} noValidate>
        <AuthField
          id="login-identity"
          label="Email or username"
          value={login}
          onChange={setLogin}
          autoComplete="username"
          placeholder="Enter your email or username"
          error={errors.login}
          icon={UserRound}
          autoFocus
        />
        <PasswordField
          id="login-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          placeholder="Enter your password"
          error={errors.password}
        />
        <div className="flex items-center justify-between text-[14px] pt-0.5">
          <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[#334568]">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(e) => setRememberDevice(e.target.checked)}
              className="w-4 h-4 rounded border-[#D4DFEC] text-[#EF1B24] accent-[#EF1B24] focus:ring-[#EF1B24] cursor-pointer"
            />
            <span className="text-[14px] text-[#334568]">Remember this device</span>
          </label>
          <Link to="/forgot-password" className="font-semibold text-[#EF1B24] no-underline hover:underline">
            Forgot password?
          </Link>
        </div>
        {serverError ? <AuthAlert>{serverError}</AuthAlert> : null}
        <button type="submit" className="fx-auth-button-primary mt-2" disabled={pending} aria-busy={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
          {!pending && <ArrowRight className="w-5 h-5 ml-1" aria-hidden="true" />}
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-[#94A3B8] text-[13px]">
        <div className="h-px flex-1 bg-[#E3EAF3]" />
        or
        <div className="h-px flex-1 bg-[#E3EAF3]" />
      </div>

      <Link
        to="/register"
        className="w-full min-h-[50px] rounded-[10px] border border-[#E3EAF3] bg-white hover:bg-[#F9FAFC] transition-colors flex items-center justify-center gap-1.5 text-[15px] text-[#334568] no-underline shadow-sm font-normal"
      >
        <span>Don’t have an account?</span>
        <span className="font-bold text-[#EF1B24] inline-flex items-center gap-0.5">
          Sign up now
          <ChevronRight className="w-4 h-4" />
        </span>
      </Link>

      <AuthStatusFooter variant="login" />
    </AuthShell>
  )
}
