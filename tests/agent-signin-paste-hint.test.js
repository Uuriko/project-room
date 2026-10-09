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
