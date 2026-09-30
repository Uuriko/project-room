import test from "node:test";
import assert from "node:assert/strict";
import { resolveMentionTargetsInText } from "../server/mention-lifecycle.mjs";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

const members = { ada: { displayName: "Ada", active: true } };

test("a legal room message longer than 20000 characters still names the mentioned member", () => {
  const body = `@Ada ${"x".repeat(20000)}`;
  assert.ok(body.length > 20000);
  assert.ok(body.length <= MAX_MESSAGE_BODY_CHARS);
  assert.deepEqual(resolveMentionTargetsInText(members, {}, body, "me"), ["ada"]);
});

test("a body past the room message cap names nobody", () => {
  const body = `@Ada ${"y".repeat(MAX_MESSAGE_BODY_CHARS)}`;
  assert.ok(body.length > MAX_MESSAGE_BODY_CHARS);
  assert.deepEqual(resolveMentionTargetsInText(members, {}, body, "me"), []);
});

test("a mention after whitespace at the end of a max-length legal body still names the member", () => {
  const pad = `${"z".repeat(MAX_MESSAGE_BODY_CHARS - 5)} `;
  const body = `${pad}@Ada`;
  assert.equal(body.length, MAX_MESSAGE_BODY_CHARS);
  assert.deepEqual(resolveMentionTargetsInText(members, {}, body, "me"), ["ada"]);
});
