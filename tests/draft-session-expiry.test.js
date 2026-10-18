// E-H2: session expiry must not destroy unsent drafts.
//
// Test audit gate:
// 1. Protects: the draft-preservation policy decision — shouldPreserveDrafts()
//    classifies 401/403 session expiry as "preserve" and intentional leaves
//    (sign-out, room/account switch, page unload) as "clear". This is the real
//    production seam: src/app.js onAccessEnded() consults it (line ~297) to
//    decide whether recovery.clear() runs, and whether the in-memory drafts
//    and composer text are reset (lines ~340-344).
// 2. Fails when: shouldPreserveDrafts() misclassifies session expiry as an
//    intentional leave.
// 3. No existing test covers the access-end draft policy; client.test.js only
//    asserts the onAccessEnded callback fires, not what the policy decides.
// 4. No production seam added: shouldPreserveDrafts lives in
//    src/conversation.js next to DraftRecovery and is used by app.js.
//
// Honesty note (G-LOW-10): an earlier version of this file wrapped the policy
// in a local teardownDrafts() replica and asserted a ternary in the test
// body — both vacuous, testing the test rather than the app. The app.js
// branch itself (which side of the if clears) is not unit-testable without
// touching app.js; that wiring was verified by reading onAccessEnded
// directly. These tests pin the decision table and the DraftRecovery
// mechanism the policy gates.
import test from "node:test";
import assert from "node:assert/strict";
import { ConversationDrafts, DraftRecovery, DRAFT_RECOVERY_MAX_CHARS, shouldPreserveDrafts } from "../src/conversation.js";

// Minimal sessionStorage stand-in.
function mapStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

const SCOPE = JSON.stringify(["room-1", "acct-1", 5, "member-1", "binding-1"]);

function writeInFlightDraft() {
  const storage = mapStorage();
  const recovery = new DraftRecovery(storage, () => 1000);
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: "unsent mid-send message", toMemberId: "", replyToId: null });
  assert.ok(recovery.write(SCOPE, drafts, null), "precondition: draft persists");
  return { storage, recovery, drafts };
}

test("shouldPreserveDrafts: session expiry preserves, intentional leaves clear", () => {
  // 401/403 mid-operation: no context, no sign-out, not leaving the page.
  assert.equal(
    shouldPreserveDrafts({ leavingPage: false, pendingSignout: false, endedContext: null }),
    true, "unexpected session end preserves drafts");
  assert.equal(
    shouldPreserveDrafts({ leavingPage: false, pendingSignout: false, endedContext: undefined }),
    true, "missing context also preserves");
  // Intentional leaves clear as before.
  assert.equal(
    shouldPreserveDrafts({ leavingPage: false, pendingSignout: true, endedContext: null }),
    false, "explicit sign-out clears drafts");
  assert.equal(
    shouldPreserveDrafts({ leavingPage: false, pendingSignout: false, endedContext: "account-switch" }),
    false, "account switch clears drafts");
  assert.equal(
    shouldPreserveDrafts({ leavingPage: false, pendingSignout: false, endedContext: "accepted-room-switch" }),
    false, "room switch clears drafts");
  assert.equal(
    shouldPreserveDrafts({ leavingPage: true, pendingSignout: false, endedContext: null }),
    false, "page unload clears drafts");
});

test("DraftRecovery cap evicts the least-recently-written draft, not the oldest-created (HUNT-FRONTEND F4)", () => {
  // write() persists only the last 50 text drafts, in entry order. Entry
  // order must be last-write order: a user with drafts in 51 threads who
  // returns to the first thread and edits it has just made THAT draft the
  // most recent work — insertion-order eviction silently dropped exactly
  // it. save() now moves the entry it touches to the end.
  const storage = mapStorage();
  const recovery = new DraftRecovery(storage, () => 1000);
  const drafts = new ConversationDrafts();
  for (let i = 0; i < 51; i++) drafts.save(`thread-${i}`, { body: `draft ${i}`, replyToId: null });
  drafts.save("thread-0", { body: "thread 0 — edited most recently" });
  assert.equal(recovery.write(SCOPE, drafts, "thread-0"), true);
  const saved = JSON.parse(storage.getItem("project-room:drafts:v3"));
  const ids = saved.entries.map(([id]) => id);
  assert.equal(ids.length, 50, "the 50-draft cap still holds");
  assert.ok(ids.includes("thread-0"), "the most recently edited draft survives the cap");
  assert.equal(ids.at(-1), "thread-0", "the most recently written draft sorts last");
  assert.ok(!ids.includes("thread-1"), "the least-recently-written draft is the one evicted");
  // save() re-inserts the same object: the identity app.js guards on holds.
  const before = drafts.get("thread-7");
  drafts.save("thread-7", { error: "x" });
  assert.equal(drafts.entries.get("thread-7"), before, "save keeps entry identity");
});

test("DraftRecovery write never persists a payload read() would reject wholesale (HUNT-FRONTEND F5)", () => {
  // read() treats an oversized payload as corruption and clears it — every
  // draft gone. Composer bodies run to 65,536 chars, so eight large drafts
  // (520k+ serialized) crossed the 500k cap while write() happily persisted
  // them. write() now sheds least-recently-written entries until the
  // payload fits the one shared cap.
  const storage = mapStorage();
  const recovery = new DraftRecovery(storage, () => 1000);
  const drafts = new ConversationDrafts();
  for (let i = 0; i < 8; i++) drafts.save(`thread-${i}`, { body: "x".repeat(65000), replyToId: null });
  assert.equal(recovery.write(SCOPE, drafts, "thread-7"), true);
  const raw = storage.getItem("project-room:drafts:v3");
  assert.ok(raw.length <= DRAFT_RECOVERY_MAX_CHARS, `persisted payload ${raw.length} exceeds the read cap`);
  const state = { messages: Array.from({ length: 8 }, (_, i) => ({ id: `thread-${i}` })) };
  const restored = recovery.read(SCOPE, state);
  assert.ok(restored, "the restore survives instead of wiping every draft");
  assert.equal(restored.drafts.entries.size, 7, "only the oldest draft was shed to fit the cap");
  assert.ok(!restored.drafts.entries.has("thread-0"), "the least-recently-written draft is shed first");
  assert.equal(restored.drafts.entries.get("thread-7").body.length, 65000, "the most recent draft is intact");
});

test("DraftRecovery mechanism: write survives when clear() is skipped, read is null after clear()", () => {
  // The mechanism the preserve/clear policy gates: skipping clear() leaves
  // the backup readable (session expiry path); calling clear() wipes it
  // (intentional-leave path).
  const { recovery } = writeInFlightDraft();
  const preserved = recovery.read(SCOPE, { messages: [] });
  assert.ok(preserved, "backup readable when clear() is skipped");
  assert.equal(preserved.drafts.get(null).body, "unsent mid-send message");
  recovery.clear();
  assert.equal(recovery.read(SCOPE, { messages: [] }), null, "backup gone after clear()");
});
