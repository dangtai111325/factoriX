export interface ApiFieldError {
  path: string
  code: string
  message?: string
}

export interface ApiItemError extends ApiFieldError {
  index: number
  signal_id?: string
}

export class ApiError extends Error {
  status: number
  code: string
  /** The server's `error` object as returned (field_errors, item_errors, missing_keys, signal_id, …). */
  details: Record<string, unknown>

  constructor(status: number, message: string, code = '', details: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }

  /** `error.field_errors`: [{path, code, message}] (e.g. path "address_patch.node_id"). */
  get fieldErrors(): ApiFieldError[] {
    return Array.isArray(this.details.field_errors) ? (this.details.field_errors as ApiFieldError[]) : []
  }

  /** `error.item_errors` of bulk endpoints: [{index, signal_id, path, code, message}]. */
  get itemErrors(): ApiItemError[] {
    return Array.isArray(this.details.item_errors) ? (this.details.item_errors as ApiItemError[]) : []
  }

  /** `error.missing_keys` (e.g. model duplicate / template apply). */
  get missingKeys(): string[] {
    return Array.isArray(this.details.missing_keys) ? (this.details.missing_keys as string[]) : []
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
    const errorObj: Record<string, unknown> =
      body && typeof body.error === 'object' && body.error !== null ? (body.error as Record<string, unknown>) : body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const message = (errorObj.message as string) || body?.message || response.statusText
    const code = (errorObj.code as string) || body?.code || ''
    throw new ApiError(response.status, message, code, errorObj)
  }
  return body as T
}
