// Auth first paint collapses key sign-in behind the "More sign-in options"
// toggle. Every browser check that signs in with a key must expand it first,
// exactly as a human visitor does. This helper does that expansion when it
// is needed (toggle present and collapsed), then fills the key field.
export async function fillAccessKey(page, value) {
  const more = page.locator('#signin-more');
  try {
    if (await more.isVisible({ timeout: 500 }) && await more.getAttribute('aria-expanded') === 'false') {
      await more.click();
    }
  } catch {
    // No toggle on this build (or it vanished mid-check): fill as before.
  }
  await page.locator('#access-key').fill(value);
}
