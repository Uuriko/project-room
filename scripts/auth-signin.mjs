// Browser checks open the same secondary sign-in controls as a visitor.
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
  const support = page.locator("#signin-support-root");
  if (await support.isHidden()) await page.locator("#signin-more").click();
  if (await support.count() && !(await support.evaluate(node => node.open))) await support.locator(":scope > summary").click();
  await key.waitFor({ state: 'visible' });
  await key.fill(value);
}
