// A027: unsubscribe detection. Pure detector tests; nothing is clicked.
import test from "node:test";
import assert from "node:assert/strict";
import { detectUnsubscribe, unsubscribableMessages, UnsubscribeError } from "../server/inbox-unsubscribe.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof UnsubscribeError && error.code === code);

test("List-Unsubscribe header yields ranked mechanisms", () => {
  const result = detectUnsubscribe({ id: "m-1",
    headers: { "List-Unsubscribe": "<mailto:leave@example.com>, <https://example.com/unsub?id=1>" } });
  assert.equal(result.messageId, "m-1");
  assert.deepEqual(result.mechanisms.map(m => [m.method, m.source]),
    [["mailto", "header"], ["http", "header"]]);
  assert.equal(result.recommended.method, "mailto");
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.mechanisms));
});
test("body links are found when the header is missing", () => {
  const result = detectUnsubscribe({ id: "m-2",
    body: 'Hi! <a href="https://example.com/optout">click here to unsubscribe</a> or mailto:stop@example.com' });
  assert.ok(result.mechanisms.some(m => m.method === "http" && m.source === "body"));
  assert.ok(result.mechanisms.some(m => m.method === "mailto" && m.source === "body"));
});
test("returns null when nothing is unsubscribable", () => {
  assert.equal(detectUnsubscribe({ id: "m-3", body: "hello" }), null);
  assert.equal(detectUnsubscribe({ id: "m-4", headers: { "List-Unsubscribe": "not a uri" } }), null);
});
test("dedups repeated targets", () => {
  const result = detectUnsubscribe({ id: "m-5",
    headers: { "List-Unsubscribe": "<mailto:a@b.c>, <mailto:a@b.c>" } });
  assert.equal(result.mechanisms.length, 1);
});
test("oneClick reflects List-Unsubscribe-Post", () => {
  const result = detectUnsubscribe({ id: "m-6",
    headers: { "List-Unsubscribe": "<https://example.com/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  assert.equal(result.oneClick, true);
});
test("unsubscribableMessages filters a list", () => {
  const results = unsubscribableMessages([
    { id: "m-1", headers: { "List-Unsubscribe": "<mailto:a@b.c>" } },
    { id: "m-2", body: "plain" },
  ]);
  assert.deepEqual(results.map(r => r.messageId), ["m-1"]);
  throwsCode(() => unsubscribableMessages("nope"), "invalid_unsubscribe_input");
  throwsCode(() => detectUnsubscribe(null), "invalid_unsubscribe_input");
  throwsCode(() => detectUnsubscribe({ id: 7 }), "invalid_unsubscribe_input");
});
