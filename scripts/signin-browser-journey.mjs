// Since the #3341 one-email-field merge there is a single email form:
// email + optional password. Email-link ("magic") sign-in is that same
// form submitted with the password left blank, so opening it is just
// reaching the form — callers fill the email and submit.
export async function openMagicSignin(page) {
  const controller = page.locator("#auth-signin-ui");
  await controller.waitFor({ state: "visible" });
  if (await controller.locator('[data-password-mode="login"]').isVisible()) await controller.locator('[data-password-mode="login"]').click();
  const form = controller.locator('[data-signin-form="password"]');
  await form.waitFor({ state: "visible" });
  // The pre-merge journey ended focused on the email field (the view
  // switches focused it); keep that end state for callers that type
  // straight into the form.
  const email = form.locator('[name="email"]');
  if (await email.evaluate(node => node !== document.activeElement)) await email.focus();
  return form;
}
export async function backToPasswordSignin(page) {
  const controller = page.locator("#auth-signin-ui");
  for (let step = 0; step < 3; step++) {
    if (await controller.locator('[data-signin-form="password"]').isVisible()) return;
    // The sent view's own way back is "Use a different email"; other
    // views use the panel Back button.
    const restart = controller.locator("[data-magic-restart]");
    if (await restart.isVisible()) { await restart.click(); continue; }
    await controller.locator("[data-signin-back]").click();
    await page.waitForFunction(() => !globalThis.document.querySelector('[data-signin-form="magic-code"]'));
  }
  await controller.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
}
