// Disposable loopback fixtures only. Real visible login keeps pending browser callbacks alive.
import assert from "node:assert/strict";
import { hashPassword } from "../src/password-auth.mjs";

export async function signInFixtureInPlace(page, store, accessKey, roomId = "commons") {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(page.url()).hostname));
  const member = store.authenticate(accessKey, roomId).member;
  assert.equal(member.kind, "human");
  const account = store.accountForMember(roomId, member.id) ?? store.bindHumanAccount(roomId, member.id, `fixture-${member.id}`);
  store.completeOnboarding(account.id);
  const email = `fixture-${member.id}@example.invalid`, password = "synthetic-replacement-password";
  if (!store.accountLogins.findAccountByVerifiedEmail(email)) store.accountLogins.linkPasswordMethod(account.id, { email, verifier: hashPassword(password) });
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#email-signin").click();
  await page.locator('#email-auth-panel [data-email-method="password"]').click();
  const form = page.locator('#email-auth-panel [data-signin-form="password"]');
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(password);
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/password/login");
  await form.locator('button[type="submit"]').click();
  const accepted = await reply;
  assert.equal(accepted.status(), 200);
  assert.equal((await accepted.json()).account.id, account.id);
  await page.locator("#auth-panel").waitFor({ state: "hidden" });
  await page.waitForFunction(() => globalThis.document.querySelector("#auth-panel").getAttribute("aria-busy") === "false");
  await page.waitForFunction(() => !globalThis.document.querySelector("#main").hidden || !globalThis.document.querySelector("#workspace-nav").hidden);
  if (!await page.locator("#main").isVisible()) {
    await page.locator("#nav-rooms").click();
    await page.waitForFunction(room => !globalThis.document.querySelector("#main").hidden || Boolean(globalThis.document.querySelector(`[data-account-room="${room}"]`)), roomId);
    if (!await page.locator("#main").isVisible()) await page.locator(`[data-account-room="${roomId}"]`).click();
  }
  await page.locator("#main").waitFor({ state: "visible" });
}
