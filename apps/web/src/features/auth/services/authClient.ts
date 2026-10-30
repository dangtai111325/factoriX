import { readCookie } from './csrf'

const API_BASE = '/api/v1'

export type AuthApiError = {
  status: number
  code: string
  message: string
  fieldErrors: Array<{ path?: string; code?: string; message?: string }>
  correlationId: string | null
  retryable: boolean
  retryAfter: string | null
}

export type AuthUser = {
  admin_id: string
  tenant_id: string
  login: string
  email: string
  full_name?: string
  locale: string
  timezone: string
  role: 'admin'
}

export type AuthStatus = {
  admin_exists: boolean
  bootstrap_enabled: boolean
  setup_code_required: boolean
  appliance: boolean
}

async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = readCookie('fx_csrf')
    if (token) headers.set('X-CSRF-Token', token)
  }
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', headers })
  } catch {
    const offline: AuthApiError = {
      status: 0,
      code: 'NETWORK',
      message: "We couldn't reach FactoriX. Check your connection and try again.",
      fieldErrors: [],
      correlationId: null,
      retryable: true,
      retryAfter: null,
    }
    throw offline
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (payload?.error || {}) as Record<string, unknown>
    const mapped: AuthApiError = {
      status: response.status,
      code: String(error.code || 'HTTP_ERROR'),
      message: String(error.message || 'Request failed'),
      fieldErrors: Array.isArray(error.field_errors) ? (error.field_errors as AuthApiError['fieldErrors']) : [],
      correlationId: error.correlation_id ? String(error.correlation_id) : null,
      retryable: Boolean(error.retryable),
      retryAfter: response.headers.get('Retry-After'),
    }
    throw mapped
  }
  return payload as T
}

export const getAuthStatus = () => authFetch<AuthStatus>('/auth/status')
export const currentUser = () => authFetch<AuthUser>('/auth/me')
export const login = (loginName: string, password: string) =>
  authFetch<{ status: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: loginName, password }),
  })
export const logout = () => authFetch<{ status: string }>('/auth/logout', { method: 'POST' })
export const bootstrap = (body: {
  login: string
  email: string
  password: string
  full_name: string
  setupCode?: string
}) => {
  const headers: HeadersInit = {}
  if (body.setupCode) headers['X-Bootstrap-Token'] = body.setupCode
  return authFetch('/auth/bootstrap', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      login: body.login,
      email: body.email,
      password: body.password,
      full_name: body.full_name,
      display_name: 'My Workspace',
      locale: 'en',
      timezone: 'Asia/Ho_Chi_Minh',
    }),
  })
}
export const forgotPassword = (email: string) =>
  authFetch<{ status: string }>('/auth/forgot', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
export const resetPassword = (email: string, code: string, newPassword: string) =>
  authFetch<{ status: string }>('/auth/reset', {
    method: 'POST',
    body: JSON.stringify({ email, code, new_password: newPassword }),
  })

export function mapAuthError(error: unknown, fallback: string): string {
  const item = error as AuthApiError
  if (!item || typeof item !== 'object') return fallback
  if (item.code === 'INVALID_CREDENTIALS' || item.status === 401) {
    return 'The email/username or password is incorrect.'
  }
  if (item.code === 'LOCKED' || item.status === 429) {
    return item.retryAfter
      ? `Too many attempts. Please try again in ${item.retryAfter} seconds.`
      : 'Too many attempts. Please try again later.'
  }
  if (item.code === 'ADMIN_EXISTS' || item.status === 409) {
    return 'Initial setup has already been completed. Sign in instead.'
  }
  if (item.code === 'NETWORK' || item.status === 0) return item.message
  if (item.status >= 500) return 'Something went wrong. Your account was not changed.'
  return item.message || fallback
}
