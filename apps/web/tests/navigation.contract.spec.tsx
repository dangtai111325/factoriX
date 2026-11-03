import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server.js'
import { expect, test } from '@playwright/test'
import { navigationGroups, plannedModules, legacyDestination } from '../src/features/navigation/routes'
import { NavigationLinks } from '../src/components/shell/NavigationLinks'

test('navigation follows the approved four-module structure and six future modules', () => {
  expect(navigationGroups.map((g) => g.label)).toEqual([
    'Overview',
    'Factory Model',
    'Data Collector',
    'Data Models',
  ])
  expect(navigationGroups[1].children?.map((c) => c.label)).toEqual([
    'Hierarchy Structure',
    'Layout Designer',
    'Knowledge Graph',
  ])
  expect(navigationGroups[2].children?.map((c) => c.label)).toEqual([
    'Connections',
    'Signals',
    'Edge Collectors',
    'Diagnostics',
  ])
  expect(navigationGroups[3].children?.map((c) => c.label)).toEqual([
    'Model Catalog',
    'Model Designer',
    'Live Preview',
  ])
  expect(plannedModules.map((m) => m.label)).toEqual([
    'Dashboards',
    'Historian & Storage',
    'Alarms & Events',
    'Analytics',
    'Reports',
    'Administration',
  ])
  expect(plannedModules.reduce((count, module) => count + module.children.length, 0)).toBe(17)
  expect(plannedModules[5].children.map((child) => child.label)).toEqual([
    'General Settings',
    'Users & Roles',
    'Integrations',
    'Audit Log',
  ])
})

test('legacy links preserve selected context, query and hash while moving to canonical routes', () => {
  expect(legacyDestination('/signals', '?signalId=s1&resourceId=r1', '#details')).toBe(
    '/collector/signals?signalId=s1&resourceId=r1#details',
  )
  expect(legacyDestination('/live/monitor', '?signalId=s1', '')).toBe('/collector/signals/live?signalId=s1')
  expect(legacyDestination('/acquisition/connections', '?connectionId=c1&modal=test', '')).toBe(
    '/collector/connections?connectionId=c1&modal=test',
  )
  expect(legacyDestination('/acquisition/studio/opcua', '?resourceId=r1', '')).toBe(
    '/collector/add-data?resourceId=r1&protocol=opcua',
  )
  expect(legacyDestination('/signals/output-groups', '?groupId=g1', '')).toBe(
    '/models/output-groups?groupId=g1',
  )
  expect(legacyDestination('/storage', '?scope=s1', '')).toBe('/historian?scope=s1')
})

test('sidebar links show the real active module and collapsed planned section', () => {
  const html = renderToStaticMarkup(
    <StaticRouter location="/collector/signals/live">
      <NavigationLinks openGroups={{ factory: true, collector: true, models: true }} onToggle={() => {}} />
    </StaticRouter>,
  )
  expect(html).toContain('aria-current="page"')
  expect(html).toContain('Data Collector')
  expect(html).toContain('Model Catalog')
  expect(html).not.toContain('Protocol Studio')
  expect(html).not.toContain('Live Operations')
  expect(html).not.toContain('href="/collector/add-data"')
  expect(html).toContain('aria-expanded="false"')
})
