import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from '@playwright/test'
import { AddResourceModal } from '../src/components/modals/AddResourceModal'
import { MoveResourceModal } from '../src/components/modals/MoveResourceModal'
import { validateResourceName } from '../src/utils/resourceHierarchy'
import { propertyValues } from '../src/features/assets/model'

const catalog = [
  {
    key: 'enterprise',
    name: 'Enterprise',
    category: 'ENTERPRISE',
    is_system: true,
    parent_type_keys: [],
    child_type_keys: ['site'],
  },
  {
    key: 'site',
    name: 'Site',
    category: 'SITE',
    is_system: true,
    parent_type_keys: ['enterprise'],
    child_type_keys: ['area'],
  },
  {
    key: 'area',
    name: 'Area',
    category: 'AREA',
    is_system: true,
    parent_type_keys: ['site'],
    child_type_keys: ['pump'],
  },
  {
    key: 'pump',
    name: 'Process pump',
    category: 'CUSTOM',
    is_system: false,
    parent_type_keys: ['area'],
    child_type_keys: [],
  },
]

test('Site enrollment is an explicit unchecked choice and is disabled for an assigned appliance', () => {
  const common = {
    isOpen: true,
    onClose: () => {},
    resourceTypes: catalog,
    parentId: 'enterprise-a',
    resources: [
      { id: 'enterprise-a', name: 'Enterprise', code: 'E', type: 'enterprise', status: 'idle' as const },
    ],
    onSave: async () => {},
  }
  const available = renderToStaticMarkup(
    <AddResourceModal
      {...common}
      appliance={{ enabled: true, available: true, state: 'AVAILABLE', edge_id: null, site_id: null }}
    />,
  )
  const option = available.match(/<input[^>]*name="useAppliance"[^>]*>/)?.[0]
  expect(option).toBeDefined()
  expect(option).not.toContain('checked')
  expect(option).not.toContain('disabled')
  const assigned = renderToStaticMarkup(
    <AddResourceModal
      {...common}
      appliance={{ enabled: true, available: false, state: 'BOUND', edge_id: 'edge-a', site_id: 'site-a' }}
    />,
  )
  expect(assigned.match(/<input[^>]*name="useAppliance"[^>]*>/)?.[0]).toContain('disabled')
})

test('all catalog types remain available while a recommended type is identified', () => {
  const html = renderToStaticMarkup(
    <AddResourceModal
      isOpen
      onClose={() => {}}
      resourceTypes={catalog}
      parentId="area-a"
      resources={[{ id: 'area-a', name: 'Area A', code: 'A', type: 'area', status: 'idle' }]}
      onSave={async () => {}}
    />,
  )
  expect(html).toContain('Process pump')
  expect(html).toContain('Area')
  expect(html).toContain('Enterprise')
  expect(html).toContain('Recommended')
  expect(html).toContain('Strict hierarchy')
  expect(html).toContain('Display name')
  expect(html).toContain('Resource code')
  expect(html).toMatch(/maxlength="200"/i)
})

test('edit form retains independent code, Unicode name and typed properties', () => {
  const html = renderToStaticMarkup(
    <AddResourceModal
      isOpen
      onClose={() => {}}
      resourceTypes={catalog}
      resources={[]}
      initialResource={{
        id: 'pump-1',
        type: 'pump',
        name: 'Bơm số 1',
        code: '0001',
        description: 'Nước lạnh',
        version: 7,
        parentId: undefined,
        properties: {
          serial: '0007',
          capacity: 0,
          enabled: false,
          calibration: null,
          settings: { mode: 'auto' },
        },
      }}
      onSave={async () => {}}
    />,
  )
  expect(html).toContain('Edit resource')
  expect(html).toContain('Bơm số 1')
  expect(html).toContain('value="0001"')
  expect(html).toContain('Nước lạnh')
  expect(html).toContain('value="0007"')
  expect(html).toContain('value="0"')
  expect(html).toContain('false')
  expect(html).toContain('calibration')
  expect(html).toContain('auto')
})

test('display names have a 200-character limit and do not inherit MQTT topic restrictions', () => {
  expect(validateResourceName('A'.repeat(201))).toBeTruthy()
  expect(validateResourceName('Máy #1 / khu A + B $')).toBeNull()
  expect(validateResourceName('   ')).toBeTruthy()
})

test('Move offers root and nonrecommended parents but never the selected subtree', () => {
  const html = renderToStaticMarkup(
    <MoveResourceModal
      isOpen
      onClose={() => {}}
      resourceTypes={catalog}
      selectedResource={{ id: 'p', type: 'pump', name: 'Pump', code: 'P', status: 'idle', parentId: 'area' }}
      allResources={[
        { id: 'e', type: 'enterprise', name: 'Enterprise One', code: 'E1', status: 'idle' },
        { id: 'area', type: 'area', name: 'Production', code: 'A', status: 'idle', parentId: 'e' },
        { id: 'p', type: 'pump', name: 'Pump', code: 'P', status: 'idle', parentId: 'area' },
        {
          id: 'child',
          type: 'sensor',
          name: 'Forbidden descendant',
          code: 'CH',
          status: 'idle',
          parentId: 'p',
        },
      ]}
      onMoveResource={async () => ({ success: true })}
    />,
  )
  expect(html).toContain('Root level')
  expect(html).toContain('Enterprise One [E1]')
  expect(html).toContain('Recommended')
  expect(html).not.toContain('Forbidden descendant')
})

test('property submission preserves identifiers, zero, false, null and structured values', () => {
  expect(
    propertyValues([
      { key: 'serial', value: '0007', kind: 'string' },
      { key: 'capacity', value: '0', kind: 'number' },
      { key: 'enabled', value: 'false', kind: 'boolean' },
      { key: 'calibration', value: 'null', kind: 'null' },
      { key: 'settings', value: '{"mode":"auto"}', kind: 'json' },
    ]),
  ).toEqual({ serial: '0007', capacity: 0, enabled: false, calibration: null, settings: { mode: 'auto' } })
})

test('invalid and duplicate properties cannot overwrite data silently', () => {
  expect(() => propertyValues([{ key: 'capacity', value: 'NaN', kind: 'number' }])).toThrow()
  expect(() => propertyValues([{ key: 'settings', value: '{invalid', kind: 'json' }])).toThrow()
  expect(() =>
    propertyValues([
      { key: 'same', value: 'one', kind: 'string' },
      { key: ' same ', value: 'two', kind: 'string' },
    ]),
  ).toThrow()
})
