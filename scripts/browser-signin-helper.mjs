// Follow the visible sign-in disclosure; never force-fill a hidden credential.
export async function ensureSignIn(page) {
  const input = page.locator('#access-key');
  if (!await input.isVisible()) await page.locator('#sign-in-entry').click();
  await input.waitFor({state:'visible'});
}
