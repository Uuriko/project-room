import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSigninUI } from "../src/agent-signin-ui.js";

test("agent sign-in skips only an unambiguous room choice and can retry", async t => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = { activeElement: null };
  globalThis.FormData = class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } };
  t.after(() => Object.assign(globalThis, previous));

  async function run(rooms, sessionStatus = 200, autoSelectSingleRoom = true) {
    const calls = [];
    const listeners = {};
    const form = { dataset: { agentForm: "credentials" }, values: { identityId: "ai_test", secret: "pri_test" } };
    form.closest = () => form;
    const container = { innerHTML: "", addEventListener: (name, fn) => { listeners[name] = fn; },
      removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      contains: node => node === form, getClientRects: () => [] };
    let signedIn = false;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return url.endsWith("/rooms")
        ? { ok: true, json: async () => ({ displayName: "Agent", rooms }) }
        : { ok: sessionStatus === 200, status: sessionStatus, json: async () => ({}) };
    };
    createAgentSigninUI({ onSignedIn() { signedIn = true; }, autoSelectSingleRoom }).mount(container);
    await listeners.submit({ target: form, preventDefault() {} });
    return { calls, html: container.innerHTML, signedIn };
  }

  const single = await run([{ roomId: "one", title: "One" }]);
  assert.deepEqual(single.calls.map(call => call.url), ["/api/auth/agent/rooms", "/api/auth/agent/session"]);
  assert.equal(single.calls[1].body.roomId, "one");
  assert.equal(single.signedIn, true);

  const multiple = await run([{ roomId: "one", title: "One" }, { roomId: "two", title: "Two" }]);
  assert.equal(multiple.calls.length, 1);
  assert.match(multiple.html, /data-room-id="one"/);
  assert.match(multiple.html, /data-room-id="two"/);
  assert.equal(multiple.signedIn, false);

  const explicitDestination = await run([{ roomId: "one", title: "One" }], 200, false);
  assert.equal(explicitDestination.calls.length, 1, "a destination-bearing entry does not silently select a room");
  assert.match(explicitDestination.html, /data-room-id="one"/);

  const failure = await run([{ roomId: "one", title: "One" }], 503);
  assert.equal(failure.signedIn, false);
  assert.match(failure.html, /data-room-id="one"/, "the room picker remains available for retry");
  assert.match(failure.html, /Sign-in failed/);
});
