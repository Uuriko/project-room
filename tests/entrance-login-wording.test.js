// QA9 (2026-10-09): one word for the same action. The landing button says
// "Log in", so the password form, its mode toggle and the invite join screen
// must say "Log in" too, never "Sign in".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

const buttons = html => [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(m => m[1].trim()).filter(Boolean);
function mount() {
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  const container = {
    status, innerHTML: "", listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); }, removeEventListener() {},
    querySelector: sel => sel === "[data-signin-status]" ? status : null,
    setAttribute() {}, querySelectorAll: () => [], contains: () => true
  };
  const client = { generation: 0, session: { authenticated: false }, currentSession() { return this.session; }, owns: () => true, invalidate: () => true, async restore() { return null; }, async request() { return null; } };
  createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: async () => {} }).mount(container);
  return container;
}
const toggle = mode => ({ target: { closest: sel => sel.includes("data-password-mode") ? { dataset: { passwordMode: mode } } : null } });

test("landing entry and the log-in form use the same word", async () => {
  const welcome = JSON.parse(readFileSync(new URL("../strings/en.json", import.meta.url), "utf8"))["signin.copy.004"];
  assert.ok(buttons(welcome).includes("Log in"), "landing offers Log in");
  const container = mount();
  const login = buttons(container.innerHTML);
  assert.ok(login.includes("Log in"), `log-in form submit says Log in: ${login.join(" | ")}`);
  assert.ok(!login.includes("Sign in"), "no competing Sign in button on the log-in form");
  await container.listeners.click[0](toggle("signup"));
  const signup = buttons(container.innerHTML);
  assert.ok(signup.includes("Create account"), "sign-up submit unchanged");
  assert.ok(signup.includes("Log in"), `sign-up form links back with Log in: ${signup.join(" | ")}`);
  assert.ok(!signup.includes("Sign in"));
});

test("the invite join screen's account button says Log in", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<button id="join-account-signin"[^>]*>Log in<\/button>/);
});
