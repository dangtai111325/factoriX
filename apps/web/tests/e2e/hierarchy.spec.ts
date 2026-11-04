import { test, expect } from '@playwright/test';
import { BASE, ensureSignedIn } from './helpers';

test.describe('Hierarchy Structure (TC-UI-HS)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('HS-01..03 tree view and inspector with valid path and details', async ({ page }) => {
    await page.goto(`${BASE}/factory/structure`);
    await expect(page.getByRole('heading', { name: /Hierarchy Structure/i })).toBeVisible();

    // Check if tree contains TIPA or resources
    const tipaNode = page.getByText('TIPA').first();
    if (await tipaNode.isVisible()) {
      await tipaNode.click();
      // Inspector should show path
      await expect(page.getByText('TIPA · Enterprise').or(page.getByText('Enterprise'))).toBeVisible();
      // No "NO DATA" badge on enterprise
      await expect(page.getByText('NO DATA')).toHaveCount(0);
    }
  });

  test('HS-12/13/14 add resource modal validation rules', async ({ page }) => {
    await page.goto(`${BASE}/factory/structure`);

    const addBtn = page.getByRole('button', { name: /Add resource|Add child/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();

      const dialog = page.getByRole('dialog', { name: /Add Resource/i });
      await expect(dialog).toBeVisible();

      const nameInput = dialog.getByPlaceholder(/Assembly Line 01|Acme Corp/i);
      const submitBtn = dialog.getByRole('button', { name: /Create Resource|Add Resource/i });

      // HS-13: empty/whitespace name
      await nameInput.fill('   ');
      await submitBtn.click();
      await expect(dialog.getByText('Enter a name.')).toBeVisible();

      // HS-12: forbidden chars
      await nameInput.fill('QA/slash');
      await submitBtn.click();
      await expect(dialog.getByText('Names cannot contain / # + $ or control characters.')).toBeVisible();

      await nameInput.fill('QA#1');
      await submitBtn.click();
      await expect(dialog.getByText('Names cannot contain / # + $ or control characters.')).toBeVisible();

      // HS-14: counter 200
      await expect(dialog.getByText(/\/200/)).toBeVisible();

      // HS-18: Escape closes dialog
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
    }
  });

  test('HS-15/16/17 automatic slugification and code validation', async ({ page }) => {
    await page.goto(`${BASE}/factory/structure`);

    const addBtn = page.getByRole('button', { name: /Add resource|Add child/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();

      const dialog = page.getByRole('dialog', { name: /Add Resource/i });
      await expect(dialog).toBeVisible();

      const nameInput = dialog.getByPlaceholder(/Assembly Line 01|Acme Corp/i);
      const codeInput = dialog.getByPlaceholder(/ASSY-01|e\.g\./i);

      // HS-15: Máy ép số 1 -> May-ep-so-1
      await nameInput.fill('Máy ép số 1');
      await expect(codeInput).toHaveValue('May-ep-so-1');

      // HS-16: Xưởng Đúc -> Xuong-Duc
      await nameInput.fill('Xưởng Đúc');
      await expect(codeInput).toHaveValue('Xuong-Duc');

      // HS-17: Invalid code manual edit
      await codeInput.fill('1abc!');
      const submitBtn = dialog.getByRole('button', { name: /Create Resource|Add Resource/i });
      await submitBtn.click();
      await expect(dialog.getByText('Code must start with a letter or digit and use only letters, digits, . _ -')).toBeVisible();

      await page.keyboard.press('Escape');
    }
  });

  test('HS-21 selection inspector shows properties and quick actions', async ({ page }) => {
    await page.goto(`${BASE}/factory/structure`);
    const node = page.getByText(/Assembly-AA10|DongNai|TIPA/).first();
    if (await node.isVisible()) {
      await node.click();
      await expect(page.getByText(/Location Path|Resource Type|Code/i).first()).toBeVisible();
    }
  });
});
