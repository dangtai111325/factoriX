export class ApiError extends Error {
  status: number
  code: string
  details: Record<string, unknown>

  constructor(status: number, message: string, code = '', details: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

function csrfToken(): string {
  const row = document.cookie.split('; ').find((item) => item.startsWith('fx_csrf='))
  return row ? decodeURIComponent(row.slice('fx_csrf='.length)) : ''
}

export async function api<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs, ...request } = init
  const headers = new Headers(request.headers)
  const method = (request.method || 'GET').toUpperCase()
  if (request.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-CSRF-Token', csrfToken())
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
    throw new RangeError('Request timeout must be positive.')
  const deadline = timeoutMs === undefined ? null : new AbortController()
  const forwardAbort = () => deadline?.abort()
  if (deadline && request.signal?.aborted) deadline.abort()
  if (deadline) request.signal?.addEventListener('abort', forwardAbort, { once: true })
  let timedOut = false
  const timer = deadline
    ? setTimeout(() => {
        timedOut = true
        deadline.abort()
      }, timeoutMs)
    : undefined
  try {
    const response = await fetch(path, {
      ...request,
      method,
      headers,
      credentials: 'same-origin',
      signal: deadline?.signal || request.signal,
    })
    if (timedOut) throw new ApiError(0, 'The request timed out.', 'TIMEOUT')
    if (response.status === 204) return undefined as T
    const body = await response.json().catch(() => null)
    if (timedOut) throw new ApiError(0, 'The request timed out.', 'TIMEOUT')
    if (!response.ok) {
      const validation = Array.isArray(body?.detail)
        ? body.detail
            .filter((item: unknown) => item && typeof item === 'object')
            .map((item: { loc?: unknown[]; type?: unknown; msg?: unknown }) => ({
              path: Array.isArray(item.loc) ? item.loc.map(String).join('.') : '',
              code: String(item.type || 'INVALID'),
              message: String(item.msg || 'Invalid request.'),
            }))
        : []
      const message =
        body?.error?.message ||
        body?.message ||
        (typeof body?.detail === 'string'
          ? body.detail
          : validation.map((item: { message: string }) => item.message).join('; ')) ||
        response.statusText
      const code = body?.error?.code || body?.code || (validation.length ? 'VALIDATION' : '')
      throw new ApiError(
        response.status,
        message,
        code,
        body?.error && typeof body.error === 'object' ? body.error : { field_errors: validation },
      )
    }
    return body as T
  } catch (error) {
    if (timedOut) throw new ApiError(0, 'The request timed out.', 'TIMEOUT')
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (deadline) request.signal?.removeEventListener('abort', forwardAbort)
  }
}
