import { expect, test } from '@playwright/test'

const BASE = process.env.FACTORIX_E2E_BASE || 'http://127.0.0.1:8080'
const PASSWORD = 'Plant-Model-2026!'

test.describe('FactoriX auth', () => {
  test('A-001 login shell has no app sidebar', async ({ page }) => {
    await page.goto(`${BASE}/login`)
    await expect(page.getByRole('heading', { name: 'Sign in to FactoriX' })).toBeVisible()
    await expect(page.getByText('CORE COLLECTOR')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Revert To Zero' })).toHaveCount(0)
  })

  test('A-002 unauthenticated overview redirects to auth', async ({ page }) => {
    await page.goto(`${BASE}/overview`)
    await expect(page).toHaveURL(/\/(login|register)/)
  })

  test('A-012 register validation blocks empty submit', async ({ page }) => {
    const status = await page.request.get(`${BASE}/api/v1/auth/status`)
    const body = await status.json()
    test.skip(body.admin_exists, 'Admin already exists')
    await page.goto(`${BASE}/register`)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText('Enter your full name.')).toBeVisible()
  })

  test('A-019 no company/factory/role fields on register', async ({ page }) => {
    await page.goto(`${BASE}/register`)
    await expect(page.locator('label', { hasText: 'Company' })).toHaveCount(0)
    await expect(page.locator('label', { hasText: 'Factory' })).toHaveCount(0)
    await expect(page.locator('label', { hasText: /^Role$/ })).toHaveCount(0)
  })

  test('A-003/A-018 first-run create account then sign in', async ({ page }) => {
    const status = await page.request.get(`${BASE}/api/v1/auth/status`)
    const body = await status.json()
    if (!body.admin_exists) {
      await page.goto(`${BASE}/register`)
      await page.getByLabel('Full name').fill('Plant Lead')
      await page.getByLabel('Work email').fill('plantlead@example.com')
      await page.getByLabel('Username').fill('plantlead')
      await page.locator('#register-password').fill(PASSWORD)
      await page.locator('#register-confirm').fill(PASSWORD)
      await page.getByRole('button', { name: 'Create account' }).click()
      await expect(page).toHaveURL(/created=1/)
    }
    await page.goto(`${BASE}/login`)
    await page.getByLabel('Email or username').fill('plantlead')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: /^Sign in$/ }).click()
    await expect(page.getByText('Operations Overview')).toBeVisible({ timeout: 30000 })
  })

  test('A-006 logout returns to login', async ({ page }) => {
    await page.goto(`${BASE}/login`)
    await page.getByLabel('Email or username').fill('plantlead')
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: /^Sign in$/ }).click()
    await expect(page.getByText('Operations Overview')).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 })
  })
})
