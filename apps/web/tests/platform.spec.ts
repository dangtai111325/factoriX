import { expect, test } from '@playwright/test'

const BASE = process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080'
const PASSWORD = 'Plant-Model-2026!'

async function ensureSignedIn(page: import('@playwright/test').Page) {
  const status = await page.request.get(`${BASE}/api/v1/auth/status`)
  const body = await status.json()
  if (!body.admin_exists) {
    await page.goto(`${BASE}/register`)
    await page.getByLabel('Full name').fill('Plant Lead')
    await page.getByLabel('Work email').fill('plantlead@example.com')
    await page.getByLabel('Username').fill('plantlead')
    await page.locator('#register-password').fill(PASSWORD)
    await page.locator('#register-confirm').fill(PASSWORD)
    await page.getByRole('button', { name: /Create account|Sign up/i }).click()
    await expect(page).toHaveURL(/created=1|login/)
  }
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Email or username').fill('plantlead')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(page.getByText('Operations Overview')).toBeVisible({ timeout: 30000 })
}

test.describe('FactoriX platform sync', () => {
  test('P-001 overview shell and honest streaming badge', async ({ page }) => {
    await ensureSignedIn(page)
    await expect(page.getByText('Operations Overview')).toBeVisible()
    await expect(page.getByText('LIVE REFRESH').or(page.getByText('PAUSED'))).toBeVisible()
    await expect(page.getByRole('button', { name: 'Revert To Zero' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  })

  test('P-002 factory structure create enterprise from empty model', async ({ page }) => {
    await ensureSignedIn(page)
    await page.goto(`${BASE}/factory/structure`)
    await expect(page.getByRole('heading', { name: 'Factory Structure' })).toBeVisible()

    const createEnterprise = page.getByRole('button', { name: 'Create enterprise' })
    const addResource = page.getByRole('button', { name: 'Add Resource' })
    if (await createEnterprise.isVisible().catch(() => false)) {
      await createEnterprise.click()
    } else {
      await addResource.click()
    }

    await expect(page.getByRole('heading', { name: 'Add Factory Resource' })).toBeVisible()
    const nameInput = page.getByPlaceholder(/CNC-03|Resource Name|e\.g\./i)
    await nameInput.fill('E2E Enterprise')
    await page.getByRole('button', { name: 'Create Resource' }).click()
    await expect(page.getByRole('heading', { name: 'E2E Enterprise' })).toBeVisible({ timeout: 15000 })
  })

  test('P-003 protocol studio and calculated are coming-soon, not fake saves', async ({ page }) => {
    await ensureSignedIn(page)
    await page.goto(`${BASE}/acquisition/studio/opcua`)
    await expect(page.getByText(/Protocol Studio|Coming next|not active/i).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Data Wizard' })).toBeVisible()

    await page.goto(`${BASE}/signals/calculated`)
    await expect(page.getByText(/Calculated Signals|not persisted|Coming next/i).first()).toBeVisible()
  })

  test('P-004 add data wizard opens and connections import is disabled', async ({ page }) => {
    await ensureSignedIn(page)
    await page.goto(`${BASE}/acquisition/add-data`)
    await expect(page.getByText(/Add Data|Protocol|Wizard/i).first()).toBeVisible()

    await page.goto(`${BASE}/acquisition/connections`)
    await expect(page.getByRole('button', { name: 'Import Template' })).toBeDisabled()
    await page.getByRole('button', { name: 'New Connection' }).click()
    await expect(page).toHaveURL(/add-data/)
  })

  test('P-005 search opens and diagnostics dead actions disabled', async ({ page }) => {
    await ensureSignedIn(page)
    await page.goto(`${BASE}/overview`)
    await page.getByRole('button', { name: /Search signals, tags, assets/i }).click()
    await expect(page.getByPlaceholder(/Search resources, tags, signals/i)).toBeVisible()
    await page.keyboard.press('Escape')

    await page.goto(`${BASE}/live/diagnostics`)
    await expect(page.getByRole('button', { name: 'Export Dump' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Restart Collector' })).toBeDisabled()
  })
})
