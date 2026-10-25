// Regression test for #2858: the direct-send composer minted a fresh
// idempotency key on every submit, so when the first POST delivered but
// its response was lost, the user's retry carried a new key and the server
// delivered the message a second time.
//
// Test audit gate:
// 1. Protects: an uncertain retry of an unchanged message reuses the same
//    requestId (the server replays its journaled receipt); a definitive
//    outcome or an edit starts a new logical send with a fresh key.
// 2. Fails when: send() mints crypto.randomUUID() per attempt again, keeps
//    the key past a final receipt / sub-500 rejection, or reuses the key
//    for an edited payload (which would trip the server's key conflict).
// 3. No existing test installs installInboxDirectSend — inbox-send-ui.test.js
//    covers only the pure contracts and leaves the installers to DOM tests.
// 4. No production seam added: the installer already takes { api, ownerKey,
//    ids }; the test supplies a stub document, fake elements, and a fake api.
import test from "node:test";
import assert from "node:assert/strict";
import { installInboxDirectSend } from "../archive/deferred-email/src/inbox-send-ui.js";

const IDS = { form: "ds-form", channel: "ds-channel", to: "ds-to", subject: "ds-subject", body: "ds-body", send: "ds-send", status: "ds-status" };
const receipt = { contractVersion: 1, send: { id: "send-1", status: "sent", channel: "gmail" } };
// A dropped response / unreachable service: no HTTP status, outcome unknown.
const uncertainError = () => Object.assign(new Error("response dropped"), { code: "gmail_unavailable" });
// A definitive refusal: the server answered and journaled nothing.
const rejectedError = () => Object.assign(new Error("invalid"), { status: 422, code: "invalid_direct_send" });

function stubElement() {
  return {
    value: "", disabled: false, hidden: false, textContent: "", dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, reset() {},
  };
}

function install(t, outcomes) {
  const elements = {};
  for (const id of Object.values(IDS)) elements[id] = stubElement();
  const handlers = {};
  elements[IDS.form].addEventListener = (type, fn) => { handlers[type] = fn; };
  elements[IDS.channel].value = "gmail";
  elements[IDS.to].value = "friend@example.com";
  elements[IDS.subject].value = "Hello";
  elements[IDS.body].value = "First version";
  const calls = [];
  const api = {
    request: async (path, opts) => {
      calls.push({ path, data: { ...opts.data } });
      const outcome = outcomes[calls.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const prevDocument = globalThis.document;
  globalThis.document = { getElementById: id => elements[id] ?? null };
  t.after(() => { globalThis.document = prevDocument; });
  const composer = installInboxDirectSend({ api, ownerKey: () => "owner-1", ids: IDS });
  return { elements, calls, composer, submit: () => handlers.submit({ preventDefault() {} }) };
}

test("an uncertain retry of an unchanged message reuses the same idempotency key", async t => {
  const { calls, composer, submit } = install(t, [uncertainError(), receipt]);
  await submit();
  assert.equal(composer.state, "failed");
  await submit();
  assert.equal(composer.state, "sent");
  assert.equal(calls.length, 2);
  assert.equal(typeof calls[0].data.requestId, "string");
  assert.ok(calls[0].data.requestId.length > 0);
  assert.equal(calls[1].data.requestId, calls[0].data.requestId,
    "the retry must replay the journaled send, not deliver a second copy");
});

test("editing the message after an uncertain attempt starts a new send with a fresh key", async t => {
  const { elements, calls, submit } = install(t, [uncertainError(), receipt]);
  await submit();
  elements[IDS.body].value = "Edited version";
  await submit();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].data.requestId, calls[0].data.requestId);
  assert.equal(calls[1].data.body, "Edited version");
});

test("a definitive rejection ends the logical send, so the retry mints a fresh key", async t => {
  const { calls, submit } = install(t, [rejectedError(), receipt]);
  await submit();
  await submit();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].data.requestId, calls[0].data.requestId);
});

test("a final receipt ends the logical send, so a later submit mints a fresh key", async t => {
  const { calls, submit } = install(t, [receipt, receipt]);
  await submit();
  await submit();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].data.requestId, calls[0].data.requestId);
});
