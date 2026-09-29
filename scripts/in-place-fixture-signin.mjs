// Disposable loopback fixtures only. Real visible login keeps pending browser callbacks alive.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/password-auth.mjs";

const fixtureLogins = new WeakMap();

export async function signInFixtureInPlace(page, store, accessKey, roomId = "commons") {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(page.url()).hostname));
  const member = store.authenticate(accessKey, roomId).member;
  assert.equal(member.kind, "human");
  const account = store.accountForMember(roomId, member.id) ?? store.bindHumanAccount(roomId, member.id, `fixture-${member.id}`);
  store.completeOnboarding(account.id);
  let logins = fixtureLogins.get(store);
  if (!logins) { logins = new Map(); fixtureLogins.set(store, logins); }
  let login = logins.get(account.id);
  if (!login) {
    login = { email: `fixture-${member.id}@example.invalid`, password: randomUUID() };
    store.accountLogins.linkPasswordMethod(account.id, { email: login.email, verifier: hashPassword(login.password) });
    logins.set(account.id, login);
  }
  const { email, password } = login;
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
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
