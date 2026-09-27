import test from "node:test";
import assert from "node:assert/strict";
import { ConversationDrafts, DraftRecovery } from "../src/conversation.js";
import { replyDraftKey } from "../src/reply-requests.js";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

function memoryStorage() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  };
}

test("draft recovery preserves valid and overflow message text for editing", () => {
  const recovery = new DraftRecovery(memoryStorage(), () => 1_000);
  const drafts = new ConversationDrafts();
  const body = "x".repeat(4001);
  drafts.save(null, { body, toMemberId: "", replyToId: null });
  assert.equal(recovery.write("scope", drafts, null), true);
  const restored = recovery.read("scope", { messages: [], members: {} });
  assert.equal(restored?.drafts.entries.get(null)?.body, body);

  const tooLong = new ConversationDrafts();
  tooLong.save(null, { body: "y".repeat(MAX_MESSAGE_BODY_CHARS + 1), toMemberId: "", replyToId: null });
  const overflow = new DraftRecovery(memoryStorage(), () => 1_000);
  assert.equal(overflow.write("scope", tooLong, null), true);
  assert.equal(overflow.read("scope", { messages: [], members: {} })?.drafts.entries.get(null)?.body.length, MAX_MESSAGE_BODY_CHARS + 1);
  const mode = { kind: "request" }, key = replyDraftKey(mode);
  tooLong.save(key, { body: "z".repeat(MAX_MESSAGE_BODY_CHARS + 1), mode, threadId: null, toMemberId: "", replyToId: null });
  assert.equal(overflow.write("scope", tooLong, null, key), true);
  const selected = overflow.read("scope", { messages: [], members: {} });
  assert.equal(selected.activeKey, key);
  assert.equal(selected.drafts.entries.get(key).body.length, MAX_MESSAGE_BODY_CHARS + 1);
  assert.deepEqual(selected.drafts.entries.get(key).mode, mode);
});
