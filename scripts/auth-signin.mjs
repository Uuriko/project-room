// Auth first paint collapses key sign-in behind the "More sign-in options"
// toggle. Every browser check that signs in with a key must expand it first,
// exactly as a human visitor does. This helper does that expansion when it
// is needed (toggle present and collapsed), then fills the key field.
export async function fillAccessKey(page, value) {
  const more = page.locator('#signin-more');
  const key = page.locator('#access-key');
  // If the key field is already visible there is nothing to expand.
  if (!(await key.isVisible())) {
    // Otherwise wait for the first-paint panel, open "More sign-in options",
    // and wait for the key field to appear — exactly as a human visitor does.
    // (An immediate isVisible check above avoids racing a panel that has not
    // rendered yet: checking the toggle too early used to skip the expansion
    // and then time out filling the hidden field.)
    await more.waitFor({ state: 'visible' });
    await more.click();
    await key.waitFor({ state: 'visible' });
  }
  await key.fill(value);
}
