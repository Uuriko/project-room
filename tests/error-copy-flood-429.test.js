import test from "node:test";
import assert from "node:assert/strict";
import { humanErrorMessage } from "../src/error-copy.js";

// qa1-r1 (2026-10-09, prod a82c8d43): sending ~40 chat messages in 20 s hit the
// room flood guard, and the composer showed the agent protocol text
// "on 429, wait Retry-After and retry. Draft kept. Send again to retry."
// A person gets the plain 429 sentence instead.

const FLOOD = "on 429, wait Retry-After and retry";

test("the chat flood-guard 429 shows people plain words, not agent protocol text", () => {
  const text = humanErrorMessage({ status: 429, code: "rate_limited", message: FLOOD });
  assert.doesNotMatch(text, /Retry-After|on 429/);
  assert.equal(text, humanErrorMessage({ status: 429 }));
});

test("a specific 429 reason from the server still reaches the person", () => {
  const seat = "This room is at its guest seat limit; ask the owner to disconnect a guest";
  assert.equal(humanErrorMessage({ status: 429, code: "rate_limited", message: seat }), seat);
});

test("Retry-After wording on a non-429 error is left alone", () => {
  const text = "Storage is busy; honour Retry-After before retrying";
  assert.equal(humanErrorMessage({ status: 503, code: "some_other_code", message: text }), text);
});
