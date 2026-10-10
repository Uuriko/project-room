// S1b: Agent sign in says who it is for and points people who want to connect
// their own AI to the paste-block page, without asking them for a secret.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSigninUI } from "../src/agent-signin-ui.js";

Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { activeElement: null } });

function mount() {
  const listeners = {};
  const container = { innerHTML: "", hidden: false, listeners, addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; } };
  createAgentSigninUI({ onSignedIn() {}, firstRunActions: {} }).mount(container);
  return container;
}

test("Agent sign in says it is for agents and links the paste-block page", () => {
  const html = mount().innerHTML;
  assert.match(html, /For AI agents that already have a saved identity\. People use Log in\./);
  const hint = /<p class="form-hint" data-agent-paste-hint>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  assert.match(hint, /<a href="\/docs\/agents\/paste">Paste one block instead<\/a>/, hint);
  assert.doesNotMatch(hint, /pri_|secret/i, "the hint never asks for a secret");
});

test("the paste link is hidden while busy, after leaving the sign-in form, and back when idle", async () => {
  const form = { dataset: { agentForm: "credentials" }, values: { identityId: "ai_test", secret: "pri_test" } };
  form.closest = () => form;
  const listeners = {};
  const container = { innerHTML: "", hidden: false, addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, contains: node => node === form, getClientRects: () => [] };
  const hint = () => /data-agent-paste-hint/.test(container.innerHTML);
  const savedFetch = globalThis.fetch, savedFormData = globalThis.FormData;
  let release;
  globalThis.FormData = class { constructor(f) { this.f = f; } entries() { return Object.entries(this.f.values); } };
  globalThis.fetch = () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ displayName: "Test", rooms: [] }) }); });
  try {
    createAgentSigninUI({ onSignedIn() {}, firstRunActions: {} }).mount(container);
    assert.equal(hint(), true, "idle sign-in form shows the link");
    const pending = listeners.submit[0]({ target: form, preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hint(), false, "no plain link while a request is in flight");
    release(); await pending;
    assert.equal(hint(), false, "no link on the rooms step");
    const click = selector => listeners.click[0]({ target: { closest: sel => sel === selector ? {} : null } });
    click("[data-agent-back]");
    assert.equal(hint(), true, "back on the idle sign-in form");
    click("[data-agent-new]");
    assert.equal(hint(), false, "no link on the create-identity step");
  } finally { globalThis.fetch = savedFetch; globalThis.FormData = savedFormData; }
});
