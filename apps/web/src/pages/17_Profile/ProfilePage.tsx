import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '../../components/common/Button'
import { Card } from '../../components/common/Card'
import { useAuth } from '../../features/auth'
import { api } from '../../api/client'
import { absoluteUtc7, relativeAge } from '../../utils/relativeTime'

type SessionRow = {
  id: string
  created_at: string
  expires_at: string
  current?: boolean
}

export const ProfilePage: React.FC = () => {
  const { state } = useAuth()
  const [params] = useSearchParams()
  const user = state.status === 'authenticated' ? state.user : null
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const showPassword = params.get('tab') === 'password'

  const loadSessions = async () => {
    const data = await api<{ items?: SessionRow[] }>('/api/v1/auth/sessions')
    setSessions(data.items || [])
  }

  useEffect(() => {
    void loadSessions().catch(() => setSessions([]))
  }, [])

  const changePassword = async () => {
    setPending(true)
    setError('')
    setMessage('')
    try {
      await api('/api/v1/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      })
      setMessage('Password updated. Sign in again on other devices.')
      setCurrentPassword('')
      setNewPassword('')
      await loadSessions().catch(() => undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change password')
    } finally {
      setPending(false)
    }
  }

  const revokeSession = async (sessionId: string) => {
    setPending(true)
    setError('')
    setMessage('')
    try {
      await api(`/api/v1/auth/sessions/${sessionId}/revoke`, { method: 'POST' })
      setMessage('Session revoked.')
      await loadSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke session')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200 max-w-xl">
      <div>
        <h1 className="fx-page-title">Profile</h1>
        <p className="fx-page-subtitle">Administrator account on this appliance.</p>
      </div>

      <Card title="Account">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-[#657794]">Name</dt>
            <dd className="font-semibold text-[#111B37]">{user?.full_name || '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[#657794]">Username</dt>
            <dd className="font-mono text-[#111B37]">{user?.login || '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[#657794]">Email</dt>
            <dd className="text-[#111B37]">{user?.email || '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[#657794]">Role</dt>
            <dd className="font-semibold text-[#111B37]">Administrator</dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] text-[#94A3B8]">
          Roles Engineer / Operator / Viewer and TOTP are not available in this appliance build yet.
        </p>
      </Card>

      <Card title={showPassword ? 'Change password' : 'Security'}>
        {!showPassword && (
          <p className="text-[12px] text-[#657794] mb-3">
            Changing password revokes other sessions for this administrator.
          </p>
        )}
        <div className="space-y-3">
          <label className="block text-[12px] font-semibold text-[#334568]">
            Current password
            <input
              type="password"
              className="mt-1 w-full fx-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label className="block text-[12px] font-semibold text-[#334568]">
            New password
            <input
              type="password"
              className="mt-1 w-full fx-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 12 characters"
            />
          </label>
          {error && <p className="text-[12px] text-[#F2343B]">{error}</p>}
          {message && <p className="text-[12px] text-[#0DBA67]">{message}</p>}
          <Button
            variant="primary"
            loading={pending}
            onClick={() => void changePassword()}
            disabled={!currentPassword || newPassword.length < 12}
          >
            Change password
          </Button>
        </div>
      </Card>

      <Card title="Sessions">
        <p className="text-[12px] text-[#657794] mb-3">
          Active sign-ins for this administrator. Revoke ends other devices without signing you out here.
        </p>
        {!sessions.length ? (
          <p className="text-[12px] text-[#94A3B8]">No active sessions listed.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[#E3EAF3] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-[#111B37]">
                    {row.current ? 'This device' : 'Other session'}
                  </p>
                  <p className="text-[11px] text-[#657794] font-mono truncate" title={absoluteUtc7(row.created_at)}>
                    Started {relativeAge(row.created_at)} · expires {relativeAge(row.expires_at)}
                  </p>
                </div>
                {!row.current && (
                  <Button size="sm" variant="secondary" loading={pending} onClick={() => void revokeSession(row.id)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
