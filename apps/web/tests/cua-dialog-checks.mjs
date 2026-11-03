/** Run against the actual CUA-controlled browser, never a fabricated DOM. */
export async function verifyDialogFocusCycle(tab, { lastButton = 'Done', returnButton = 'Import resources' } = {}) {
  await tab.playwright.getByRole('button', { name: lastButton, exact: true }).press('Tab')
  const first = await tab.playwright.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  if (first !== 'Close dialog') throw new Error(`Tab escaped the modal: expected Close dialog, observed ${first || 'no in-dialog control'}.`)
  await tab.playwright.getByRole('button', { name: 'Close dialog', exact: true }).press('Shift+Tab')
  const last = await tab.playwright.evaluate(() => document.activeElement?.textContent?.trim())
  if (last !== lastButton) throw new Error(`Reverse Tab did not wrap to ${lastButton}.`)
  await tab.playwright.getByRole('button', { name: lastButton, exact: true }).press('Escape')
  await tab.playwright.getByRole('dialog', { name: 'Import resources', exact: true }).waitFor({ state: 'hidden' })
  const returned = await tab.playwright.evaluate(() => document.activeElement?.textContent?.trim())
  if (returned !== returnButton) throw new Error(`Closing the modal did not restore focus to ${returnButton}.`)
  return { forwardWrap: true, reverseWrap: true, escape: true, focusReturn: true }
}
