// Reach recovery through the visible password-first entry, including invitation hosts.
export async function openMagicSignin(page) {
  const controller = page.locator("#auth-signin-ui");
  await controller.locator("[data-forgot-password]").click();
  await controller.locator('[data-recovery-option="magic"]').click();
  const form = controller.locator('[data-signin-form="magic-request"]');
  await form.waitFor({ state: "visible" });
  return form;
}
export async function backToPasswordSignin(page) {
  const controller = page.locator("#auth-signin-ui");
  for (let step = 0; step < 3; step++) {
    if (await controller.locator('[data-signin-form="password"]').isVisible()) return;
    await controller.locator("[data-signin-back]").click();
    await page.waitForFunction(() => !globalThis.document.querySelector('[data-signin-form="magic-request"]'));
  }
  await controller.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
}
