import { expect, test } from '@playwright/test'
import { createAsset } from '../src/features/assets/api'

async function withApi(
  run: (calls: Array<{ url: string; body: Record<string, unknown> }>) => Promise<void>,
  rejectEnroll = false,
) {
  const originalFetch = globalThis.fetch
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'fx_csrf=test-only' },
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} })
    if (url === '/api/v1/resources')
      return new Response(
        JSON.stringify({
          id: 'site-resource',
          site_id: 'site-scope',
          edge: { id: 'edge-a', name: 'Site Edge' },
        }),
        { status: 201 },
      )
    return new Response(
      JSON.stringify(
        rejectEnroll
          ? { error: { code: 'APPLIANCE_ASSIGNED', message: 'Appliance already assigned.' } }
          : { status: 'pending' },
      ),
      { status: rejectEnroll ? 409 : 201 },
    )
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
}

const resource = {
  type: 'site',
  name: 'Site',
  code: 'S',
  description: '',
  properties: {},
  timezone: 'Asia/Ho_Chi_Minh',
  hierarchyMode: 'guided' as const,
}

test('creating a Site and Edge alone never requests local appliance enrollment', async () => {
  await withApi(async (calls) => {
    const result = await createAsset(resource)
    expect(result.id).toBe('site-resource')
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/resources'])
    expect(calls[0].body.create_edge).toBe(true)
    expect(result.enrollmentStatus).toBeUndefined()
  })
})

test('explicit opt-in requests enrollment only after the Site has been acknowledged', async () => {
  await withApi(async (calls) => {
    const result = await createAsset({ ...resource, useAppliance: true })
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/resources', '/api/v1/edges/edge-a/appliance'])
    expect(result.enrollmentStatus).toBe('pending')
    expect(result.enrollmentError).toBeUndefined()
  })
})

test('enrollment denial reports the created Site truthfully so retry cannot recreate it', async () => {
  await withApi(async (calls) => {
    const result = await createAsset({ ...resource, useAppliance: true })
    expect(result.id).toBe('site-resource')
    expect(result.enrollmentError).toBe('Appliance already assigned.')
    expect(calls.filter((call) => call.url === '/api/v1/resources')).toHaveLength(1)
    expect(result.enrollmentStatus).toBeUndefined()
  }, true)
})

test('a selected parent missing from the cached model is still validated by the server, never silently replaced with root', async () => {
  await withApi(async (calls) => {
    await createAsset({ ...resource, parentId: 'selected-parent' })
    expect(calls[0].body.parent_id).toBe('selected-parent')
  })
})
