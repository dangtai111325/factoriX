import { expect, test } from '@playwright/test'
import { api, ApiError } from '../src/api/client'

test('API errors retain import row diagnostics for the form without losing CSRF protection', async () => {
  const originalFetch = globalThis.fetch
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let request: RequestInit | undefined
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'fx_csrf=csrf-test' },
  })
  globalThis.fetch = async (_input, init) => {
    request = init
    return new Response(
      JSON.stringify({
        error: {
          code: 'IMPORT_INVALID',
          message: 'Correct the indicated rows.',
          row_errors: [
            { row: 42, code: 'MISSING_PARENT', message: 'Parent not found.', field: 'parent_path' },
          ],
          warnings: [{ row: 2, code: 'EXISTING_VALUES_KEPT', message: 'Existing values retained.' }],
        },
      }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    let caught: unknown
    try {
      await api('/api/v1/resources/import', { method: 'POST', body: JSON.stringify({ rows: [] }) })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiError)
    const error = caught as ApiError
    expect(error.status).toBe(422)
    expect(error.code).toBe('IMPORT_INVALID')
    expect(error.details.row_errors).toEqual([
      { row: 42, code: 'MISSING_PARENT', message: 'Parent not found.', field: 'parent_path' },
    ])
    expect(error.details.warnings).toHaveLength(1)
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf-test')
    expect(request?.credentials).toBe('same-origin')
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('request validation exposes field messages while discarding echoed input values', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        detail: [
          {
            loc: ['body', 'rows'],
            type: 'value_error',
            msg: 'Import rows are limited to 2 MB.',
            input: 'must-not-retain-sensitive-input',
          },
        ],
      }),
      { status: 422, statusText: 'Unprocessable Entity' },
    )
  try {
    let caught: unknown
    try {
      await api('/api/v1/resources/import')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiError)
    const error = caught as ApiError
    expect(error.message).toContain('Import rows are limited to 2 MB.')
    expect(error.code).toBe('VALIDATION')
    expect(error.details.field_errors).toEqual([
      { path: 'body.rows', code: 'value_error', message: 'Import rows are limited to 2 MB.' },
    ])
    expect(JSON.stringify(error.details)).not.toContain('must-not-retain-sensitive-input')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an explicit request deadline aborts a stalled fetch with an actionable timeout error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      })
    })
  try {
    const result = await Promise.race([
      api('/api/v1/resources', { timeoutMs: 5 }).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('fetch was not aborted'), 100)),
    ])
    expect(result).toBeInstanceOf(ApiError)
    expect((result as ApiError).code).toBe('TIMEOUT')
  } finally {
    globalThis.fetch = originalFetch
  }
})
