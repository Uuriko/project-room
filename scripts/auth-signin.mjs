// Auth first paint collapses key sign-in and extra methods behind the
// "More options" toggle. Browser checks must expand it first, exactly as
// a human visitor does.
export async function expandSigninMore(page) {
  const more = page.locator('#signin-more');
  const extra = page.locator('#signin-extra');
  // Wait for the panel to settle, then open the section only if it is
  // actually collapsed — never toggle blindly. Right after sign-out the
  // panel can appear with the section already open, and a stray click
  // would close it again (that race timed out the guest re-sign-in in
  // help-invitation-browser-check).
  await more.waitFor({ state: 'attached' });
  await extra.waitFor({ state: 'attached' });
  await more.waitFor({ state: 'visible' });
  if (await extra.isHidden()) await more.click();
  await extra.waitFor({ state: 'visible' });
}

export async function fillAccessKey(page, value) {
  const key = page.locator('#access-key');
  await expandSigninMore(page);
  await key.waitFor({ state: 'visible' });
  await key.fill(value);
}
