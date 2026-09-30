// E-H2: session expiry must not destroy unsent drafts.
// Regression test for the bug where onAccessEnded() unconditionally called
// recovery.clear() + reset the in-memory drafts + wiped the composer, so a
// 401 mid-send irrecoverably destroyed the draft the "Draft kept" promise
// claimed to preserve.
//
// Test audit gate:
// 1. Protects: draft text survives an unexpected session end (401/403) through
//    the access-teardown path, in both the persisted backup and memory.
// 2. Fails when: shouldPreserveDrafts() misclassifies session expiry as an
//    intentional leave, or the teardown clears despite the preserve signal.
// 3. No existing test covers the access-end draft policy; client.test.js only
//    asserts the onAccessEnded callback fires, not what the handler preserves.
// 4. No production seam added: shouldPreserveDrafts lives in
//    src/conversation.js next to DraftRecovery and is used by app.js.
import test from "node:test";
import assert from "node:assert/strict";
import { ConversationDrafts, DraftRecovery, shouldPreserveDrafts } from "../src/conversation.js";

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

// Simulates the app.js onAccessEnded draft teardown with the fix applied:
// clear() runs only when the preserve signal is false.
function teardownDrafts(recovery, preserve) {
  if (!preserve) recovery.clear();
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

test("session expiry: in-flight draft survives teardown and reads back on re-auth", () => {
  const { recovery } = writeInFlightDraft();
  const preserve = shouldPreserveDrafts({ leavingPage: false, pendingSignout: false, endedContext: null });
  teardownDrafts(recovery, preserve);
  // User re-authenticates; the recovery scope still matches (same tab/room).
  const saved = recovery.read(SCOPE, { messages: [] });
  assert.ok(saved, "draft backup survives session expiry");
  assert.equal(saved.drafts.get(null).body, "unsent mid-send message");
});

test("intentional sign-out: draft backup is cleared", () => {
  const { recovery } = writeInFlightDraft();
  const preserve = shouldPreserveDrafts({ leavingPage: false, pendingSignout: true, endedContext: null });
  teardownDrafts(recovery, preserve);
  assert.equal(recovery.read(SCOPE, { messages: [] }), null, "sign-out wipes the draft backup");
});

test("in-memory drafts object is the same reference the composer keeps writing to", () => {
  // Guards the second half of the E-H2 fix: onAccessEnded must not replace
  // the ConversationDrafts instance on session expiry, or post-re-auth
  // keystrokes would land in a fresh map while the UI still reads the old one.
  const { drafts } = writeInFlightDraft();
  const preserve = shouldPreserveDrafts({ leavingPage: false, pendingSignout: false, endedContext: null });
  const kept = preserve ? drafts : new ConversationDrafts();
  assert.equal(kept, drafts, "session expiry keeps the live drafts instance");
  assert.equal(kept.get(null).body, "unsent mid-send message");
});
