// Auth first paint collapses key sign-in behind the "More sign-in options"
// toggle. Every browser check that signs in with a key must expand it first,
// exactly as a human visitor does. This helper does that expansion when it
// is needed (toggle present and collapsed), then fills the key field.
export async function fillAccessKey(page, value) {
  const more = page.locator('#signin-more');
  const key = page.locator('#access-key');
  const extra = page.locator('#signin-extra');
  // The key form lives behind "More sign-in options" on first paint. Wait for
  // the panel to settle, then open the section only if it is actually
  // collapsed — never toggle blindly. Right after sign-out the panel can
  // appear with the section already open, and a stray click would close it
  // again (that race timed out the guest re-sign-in in
  // help-invitation-browser-check).
  await more.waitFor({ state: 'attached' });
  await extra.waitFor({ state: 'attached' });
  await more.waitFor({ state: 'visible' });
  if (await extra.isHidden()) await more.click();
  await key.waitFor({ state: 'visible' });
  await key.fill(value);
}
