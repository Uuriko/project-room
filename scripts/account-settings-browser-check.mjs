// Browser coverage for the account settings UI (slice 7, RC-2026-09-17-016):
// the session menu opens Sign-in & security, the linked methods render with
// honest provider-unconfigured states, disable/enable/remove work through
// the real UI (including the last-active-method guard), and recovery codes
// are generated and shown once. Boots a real server against an
// acceptance-fixture store over loopback; no network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t) {
  const f = createAcceptanceFixture();
  const accountId = "slice7-browser";
  f.store.createAccount(accountId, "settings-browser-fixture");
  f.store.accountLogins.linkPasswordMethod(accountId, { email: "browser@example.invalid", verifier: "fixture-verifier" });
  f.store.accountLogins.linkMagicMethod(accountId, { email: "browser@example.invalid" });
  const key = f.store.issueAccountAccessKey(accountId);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [], outside = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { f, page, origin, key, accountId };
}

const methodRow = (page, label) => page.locator(".settings-method", { hasText: label });

test("account settings: methods render, disable/enable/remove, recovery codes, honest provider states", { timeout: 45000 }, async t => {
  const { page, origin, key, accountId, f } = await setup(t);
  await page.goto(origin + "/?account=1");
  await page.locator("#access-key").fill(key);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.locator("#account-rooms-panel").waitFor();

  await page.locator("#session-menu-button").click();
  await page.locator("#account-settings-button").click();
  const body = page.locator("#account-settings-body");
  await body.getByText("Linked sign-in methods").waitFor();

  // Both linked methods render with safe public detail.
  await body.getByText("Password").first().waitFor();
  await body.getByText("Email magic link").waitFor();
  assert.ok((await body.textContent()).includes("browser@example.invalid"));

  // Honest provider-unconfigured states (no OAuth or mail bindings in the fixture).
  for (const note of ["GitHub sign-in isn\u2019t configured on this Room.",
    "Google sign-in isn\u2019t configured on this Room.", "Email delivery isn\u2019t configured on this Room"]) {
    await body.getByText(note, { exact: false }).first().waitFor();
  }

  // Disable the magic method through the real UI.
  await methodRow(page, "Email magic link").getByRole("button", { name: "Disable" }).click();
  await methodRow(page, "Email magic link").getByText("disabled").waitFor();

  // The last active method cannot be disabled: the guard message surfaces.
  await methodRow(page, "Password").getByRole("button", { name: "Disable" }).click();
  await body.getByText("Keep at least one active sign-in method").waitFor();

  // Re-enable, then remove the disabled magic method (confirm auto-accepted).
  await methodRow(page, "Email magic link").getByRole("button", { name: "Enable" }).click();
  await methodRow(page, "Email magic link").getByRole("button", { name: "Disable" }).waitFor();
  await methodRow(page, "Email magic link").getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".settings-method")].some(li => li.textContent.includes("Email magic link")));
  assert.equal(f.store.accountLogins.listMethods(accountId).some(m => m.type === "magic"), false);

  // Removing the last active method is refused in the UI too.
  await methodRow(page, "Password").getByRole("button", { name: "Remove" }).click();
  await body.getByText("Keep at least one active sign-in method").waitFor();
  assert.equal(f.store.accountLogins.listMethods(accountId).some(m => m.type === "password"), true);

  // Recovery codes generate and display exactly once.
  await body.getByRole("button", { name: "Generate recovery codes" }).click();
  await body.getByText("they are shown once and each works a single time").waitFor();
  const codes = await body.locator("[data-recovery-codes] code").allTextContents();
  assert.equal(codes.length, 10);
  assert.ok(codes.every(code => /^[a-z0-9_-]{6}-[a-z0-9_-]{6}$/.test(code)));
});
