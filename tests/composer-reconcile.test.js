// Audit D1: on the plain send path, a lost response leaves the sent text in
// the composer under "Draft kept. Send again to retry." while the message is
// already posted. An unchanged resend is safe (the command id is reused),
// but any edit mints a new command id and posts a near-duplicate — a second
// instruction in the room. reconcileLandedDrafts resolves the draft the
// moment state proves the pending command's message landed: untouched
// drafts clear outright; edited drafts survive as plain drafts with the
// landed pending detached, so a later send is deliberate, never a retry.
import test from "node:test";
import assert from "node:assert/strict";
import { ConversationDrafts, DraftRecovery, reconcileLandedDrafts } from "../src/conversation.js";

const BODY = "Send the deployment summary";
const MESSAGE_ID = "msg-landed-1";
const COMMAND_ID = "cmd-pending-1";
const RETRY_ERROR = "The connection was interrupted and the result could not be confirmed. Draft kept. Send again to retry.";

function pending({ id = COMMAND_ID, messageId = MESSAGE_ID, body = BODY, toMemberId = null, replyToId = null } = {}) {
  const data = { ...(messageId === undefined ? {} : { messageId }), body, toMemberId, replyToId };
  return { contents: JSON.stringify({ type: "message.posted", data, causationId: null }),
    command: { id, type: "message.posted", data } };
}

function draftsWithPending(draft = {}) {
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: BODY, toMemberId: "", replyToId: null, error: RETRY_ERROR, pending: pending(), ...draft });
  return drafts;
}

const landed = (overrides = {}) => [{ id: MESSAGE_ID, body: BODY, ...overrides }];

test("lost response, unchanged draft: the landed pending is cleared outright", () => {
  const drafts = draftsWithPending();
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].cleared, true);
  assert.equal(reconciled[0].command.id, COMMAND_ID);
  assert.equal(reconciled[0].message.id, MESSAGE_ID);
  assert.equal(drafts.entries.has(null), false, "the draft entry is gone, error and all");
});

test("lost response, edited draft: text survives as a plain draft, pending detached, stale error dropped", () => {
  const edited = "Send the deployment summary to the whole fleet";
  const drafts = draftsWithPending({ body: edited });
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].cleared, false);
  const draft = drafts.get(null);
  assert.equal(draft.body, edited, "the edit is the author's text and stays");
  assert.equal(draft.pending, null, "the landed command can no longer be retried or re-minted from this draft");
  assert.equal(draft.error, "", "the 'Draft kept. Send again to retry.' instruction is gone");
});

test("retargeted draft (recipient changed after the lost response) is kept and detached, not cleared", () => {
  const drafts = draftsWithPending({ toMemberId: "member-2" });
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled[0].cleared, false);
  const draft = drafts.get(null);
  assert.equal(draft.toMemberId, "member-2");
  assert.equal(draft.pending, null);
  assert.equal(draft.error, "");
});

test("unlanded pending is untouched: a genuine retry keeps its command identity", () => {
  const drafts = draftsWithPending();
  const reconciled = reconcileLandedDrafts(drafts, [{ id: "msg-other", body: "Unrelated" }]);
  assert.deepEqual(reconciled, []);
  const draft = drafts.get(null);
  assert.equal(draft.pending.command.id, COMMAND_ID);
  assert.equal(draft.error, RETRY_ERROR, "a send that may truly have failed still says so");
});

test("only the landed draft reconciles; sibling drafts and non-message pendings are left alone", () => {
  const drafts = draftsWithPending();
  const cancelled = { contents: "{}", command: { id: "cmd-cancel-1", type: "reply_request.cancelled",
    data: { messageId: MESSAGE_ID, body: BODY, toMemberId: null, replyToId: "msg-root" } } };
  drafts.save("msg-root", { body: BODY, toMemberId: "", replyToId: "msg-root", error: RETRY_ERROR,
    mode: { kind: "cancelled" }, pending: cancelled });
  drafts.save("msg-note", { body: "A note with no send in flight", toMemberId: "", replyToId: "msg-note" });
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].key, null);
  assert.equal(drafts.get("msg-root").pending.command.id, "cmd-cancel-1", "cancel pendings are not message sends");
  assert.equal(drafts.get("msg-note").body, "A note with no send in flight");
});

test("legacy pending without data.messageId matches on the command id", () => {
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: BODY, toMemberId: "", replyToId: null, error: RETRY_ERROR,
    pending: pending({ id: MESSAGE_ID, messageId: undefined }) });
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].cleared, true);
  assert.equal(drafts.entries.has(null), false);
});

test("files committed to the landed message leave with it; uncommitted files keep the draft", () => {
  const drafts = draftsWithPending({ files: [{ id: "file-1", status: "staged", commitMessageId: MESSAGE_ID }] });
  const other = pending({ id: "cmd-pending-2", messageId: "msg-landed-2" });
  drafts.save("msg-root", { body: BODY, toMemberId: "", replyToId: "msg-root", error: RETRY_ERROR, pending: other,
    files: [{ id: "file-2", status: "staged" }] });
  const reconciled = reconcileLandedDrafts(drafts, [...landed(), { id: "msg-landed-2", body: BODY }]);
  assert.equal(reconciled.length, 2);
  assert.equal(drafts.entries.has(null), false, "body unchanged and its only file committed: cleared");
  const kept = drafts.get("msg-root");
  assert.equal(kept.pending, null);
  assert.deepEqual(kept.files.map(file => file.id), ["file-2"], "the uncommitted file stays with the kept draft");
});

function mapStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}

test("session-expiry restore: a preserved pending whose message landed reconciles; one that never landed keeps its retry", () => {
  const scope = JSON.stringify(["commons", "acct-1", 5, "owner", "binding-1"]);
  const storage = mapStorage();
  const recovery = new DraftRecovery(storage, () => 1000);
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: BODY, toMemberId: "", replyToId: null,
    pending: pending({ id: "cmd-landed-1" }) });
  const threadBody = "Follow up on the deployment summary";
  drafts.save("msg-root-1", { body: threadBody, toMemberId: "", replyToId: "msg-root-1",
    pending: pending({ id: COMMAND_ID, messageId: "msg-never-landed", body: threadBody, replyToId: "msg-root-1" }) });
  assert.equal(recovery.write(scope, drafts, null), true, "session expiry preserves the drafts (E-H2 behaviour)");

  const state = { messages: [
    { id: "msg-root-1", body: "Root" },
    { id: "msg-reply-1", body: "Reply", replyToId: "msg-root-1" },
    { id: MESSAGE_ID, body: BODY },
  ], members: {}, channels: {} };
  const restored = recovery.read(scope, state);
  assert.ok(restored, "the preserved drafts restore after the session expiry");
  const reconciled = reconcileLandedDrafts(restored.drafts, state.messages);
  assert.equal(reconciled.length, 1, "only the landed pending reconciles");
  assert.equal(restored.drafts.entries.has(null), false, "the landed send's draft is cleared after restore");
  const kept = restored.drafts.get("msg-root-1");
  assert.equal(kept.pending.command.id, COMMAND_ID, "the unlanded send keeps its exact retry identity");
  assert.equal(kept.body, threadBody);
});
