import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConversationDrafts, DraftRecovery } from "../src/conversation.js";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

function memoryStorage() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  };
}

test("a composer draft longer than 4000 characters is kept up to the message limit", () => {
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
  assert.equal(overflow.read("scope", { messages: [], members: {} })?.drafts.entries.get(null), undefined);
});

test("the message box allows a full room message and the inbox draft does not", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const message = html.match(/<textarea id="message-input"[^>]*>/)?.[0] ?? "";
  const inbox = html.match(/<textarea id="inbox-draft"[^>]*>/)?.[0] ?? "";
  assert.match(message, new RegExp(`maxlength="${MAX_MESSAGE_BODY_CHARS}"`));
  assert.match(inbox, /maxlength="4000"/);
});
