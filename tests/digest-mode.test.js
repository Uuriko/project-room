// A015: digest mode. Pure digest builder tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildDigest, shouldDigest, DigestError } from "../server/digest-mode.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DigestError && error.code === code);

const messages = [
  { messageId: "m1", senderId: "news", subject: "Morning headlines" },
  { messageId: "m2", senderId: "news", subject: "Evening update" },
  { messageId: "m3", senderId: "alerts", subject: "Server down" },
  { messageId: "m4", senderId: "friend", subject: "Lunch?" },
];

test("buildDigest groups by sender, busiest first", () => {
  const digest = buildDigest({ messages, senders: new Set(["news", "alerts"]), date: "2026-09-16" });
  assert.equal(digest.totalMessages, 3);
  assert.equal(digest.senderCount, 2);
  assert.deepEqual(digest.sections.map(s => s.senderId), ["news", "alerts"]); // news has 2
  assert.deepEqual(digest.sections[0].subjects, ["Morning headlines", "Evening update"]);
  assert.ok(Object.isFrozen(digest) && Object.isFrozen(digest.sections));
});
test("shouldDigest checks sender membership", () => {
  const senders = ["news", "alerts"];
  assert.equal(shouldDigest({ senderId: "news", senders }), true);
  assert.equal(shouldDigest({ senderId: "friend", senders }), false);
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildDigest({ messages, senders: [], date: "2026-09-16" }), "invalid_digest");
  throwsCode(() => buildDigest({ messages, senders: ["news"], date: "bad-date" }), "invalid_digest");
  throwsCode(() => shouldDigest({ senderId: "", senders: [] }), "invalid_digest");
});
