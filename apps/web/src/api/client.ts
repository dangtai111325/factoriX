export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function csrfToken(): string {
  const row = document.cookie.split('; ').find((item) => item.startsWith('fx_csrf='))
  return row ? decodeURIComponent(row.slice('fx_csrf='.length)) : ''
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const method = (init.method || 'GET').toUpperCase()
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-CSRF-Token', csrfToken())
  const response = await fetch(path, { ...init, method, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText
    throw new ApiError(response.status, message)
  }
  return body as T
}
