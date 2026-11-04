import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Create Enterprise Flow', () => {
  test('empty model allows creating enterprise with populated resource types', async ({ page }) => {
    await ensureSignedIn(page);
    await page.goto(`${BASE}/factory/structure`);
    await page.waitForLoadState('networkidle');

    // Check for "Create enterprise" button on empty hierarchy
    const createBtn = page.getByRole('button', { name: /Create enterprise/i });
    await expect(createBtn).toBeVisible({ timeout: 10000 });
    await createBtn.click();

    // Dialog should be open
    const dialog = page.getByRole('dialog', { name: /Add Factory Resource/i });
    await expect(dialog).toBeVisible();

    // Check select dropdown options
    const selectElem = dialog.locator('select');
    await expect(selectElem).toBeVisible();

    // Verify option count > 0
    const options = await selectElem.locator('option').allTextContents();
    console.log('Resource Types in select dropdown:', options);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.includes('Enterprise'))).toBe(true);

    // Take screenshot of modal with populated options
    await page.screenshot({
      path: 'C:/Users/Ave-T14-001/.gemini/antigravity/brain/53bc9a76-577a-4ba5-8175-947e53bf5611/screen_create_enterprise_modal.png',
    });

    // Fill in Name and Code
    const nameInput = dialog.getByPlaceholder(/Acme Corp|Assembly Line 01/i);
    await nameInput.fill('TIPA Enterprise');

    const codeInput = dialog.locator('input').nth(1);
    await codeInput.fill('TIPA');

    // Submit
    const submitBtn = dialog.getByRole('button', { name: /Create Resource/i });
    await submitBtn.click();

    // Verify dialog closes without error
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // Verify TIPA Enterprise appears in the hierarchy tree
    const enterpriseNode = page.getByText('TIPA Enterprise').first();
    await expect(enterpriseNode).toBeVisible({ timeout: 10000 });

    // Take screenshot of created enterprise in tree
    await page.screenshot({
      path: 'C:/Users/Ave-T14-001/.gemini/antigravity/brain/53bc9a76-577a-4ba5-8175-947e53bf5611/screen_enterprise_created.png',
    });
  });
});
