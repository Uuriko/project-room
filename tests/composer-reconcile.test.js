// Audit D1: on the plain send path, a lost response leaves the sent text in
// the composer under "Draft kept. Send again to retry." while the message is
// already posted. An unchanged resend is safe (the command id is reused and
// the server returns a duplicate receipt). Any edit mints a new command id
// and would post a near-duplicate. reconcileLandedDrafts detaches that
// landed pending only once the author has changed the draft. Unchanged
// pendings, request-mode locks, and sends whose confirmation is still in
// flight stay exact retries.
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

test("lost response, unchanged draft: the pending command stays so the exact retry still works", () => {
  const drafts = draftsWithPending();
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.deepEqual(reconciled, []);
  const draft = drafts.get(null);
  assert.equal(draft.pending.command.id, COMMAND_ID);
  assert.equal(draft.body, BODY);
  assert.equal(draft.error, RETRY_ERROR, "the retry instruction stays until the duplicate receipt");
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

test("only the changed landed draft reconciles; unchanged siblings and cancel pendings are left alone", () => {
  const drafts = draftsWithPending({ body: "Send the deployment summary, revised" });
  const cancelled = { contents: "{}", command: { id: "cmd-cancel-1", type: "reply_request.cancelled",
    data: { messageId: MESSAGE_ID, body: BODY, toMemberId: null, replyToId: "msg-root" } } };
  drafts.save("msg-root", { body: BODY, toMemberId: "", replyToId: "msg-root", error: RETRY_ERROR,
    mode: { kind: "cancelled" }, pending: cancelled });
  drafts.save("msg-note", { body: "A note with no send in flight", toMemberId: "", replyToId: "msg-note" });
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].key, null);
  assert.equal(drafts.get(null).pending, null);
  assert.equal(drafts.get("msg-root").pending.command.id, "cmd-cancel-1", "cancel pendings are not message sends");
  assert.equal(drafts.get("msg-note").body, "A note with no send in flight");
});

test("request-mode pendings stay locked to the exact command after the message lands", () => {
  const drafts = draftsWithPending({ body: "An explicit question", mode: { kind: "request" } });
  assert.deepEqual(reconcileLandedDrafts(drafts, landed()), []);
  const draft = drafts.get(null);
  assert.equal(draft.pending.command.id, COMMAND_ID);
  assert.equal(draft.body, "An explicit question");
  assert.equal(draft.error, RETRY_ERROR);
});

test("a command whose confirmation is still in flight is not reconciled", () => {
  const drafts = draftsWithPending({ body: "edited while the send is still awaiting its response" });
  const command = drafts.get(null).pending.command;
  const reconciled = reconcileLandedDrafts(drafts, landed(), { retain: candidate => candidate.id === command.id });
  assert.deepEqual(reconciled, []);
  assert.equal(drafts.get(null).pending.command.id, COMMAND_ID);
  assert.equal(drafts.get(null).error, RETRY_ERROR);
});

test("legacy pending without data.messageId matches on the command id", () => {
  const edited = "Send the deployment summary, revised";
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: edited, toMemberId: "", replyToId: null, error: RETRY_ERROR,
    pending: pending({ id: MESSAGE_ID, messageId: undefined }) });
  const reconciled = reconcileLandedDrafts(drafts, landed());
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].message.id, MESSAGE_ID);
  assert.equal(drafts.get(null).pending, null, "the command id matched the landed message");
  assert.equal(drafts.get(null).body, edited);
  const unchanged = new ConversationDrafts();
  unchanged.save(null, { body: BODY, toMemberId: "", replyToId: null, error: RETRY_ERROR,
    pending: pending({ id: MESSAGE_ID, messageId: undefined }) });
  assert.deepEqual(reconcileLandedDrafts(unchanged, landed()), []);
  assert.equal(unchanged.get(null).pending.command.id, MESSAGE_ID);
});

test("a committed file on an unchanged body stays a retry; an uncommitted file detaches and stays", () => {
  const drafts = draftsWithPending({ files: [{ id: "file-1", status: "staged", commitMessageId: MESSAGE_ID }] });
  const other = pending({ id: "cmd-pending-2", messageId: "msg-landed-2" });
  drafts.save("msg-root", { body: BODY, toMemberId: "", replyToId: "msg-root", error: RETRY_ERROR, pending: other,
    files: [{ id: "file-2", status: "staged" }] });
  const reconciled = reconcileLandedDrafts(drafts, [...landed(), { id: "msg-landed-2", body: BODY }]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].key, "msg-root");
  assert.equal(drafts.get(null).pending.command.id, COMMAND_ID, "body unchanged and its only file committed: exact retry stays");
  const kept = drafts.get("msg-root");
  assert.equal(kept.pending, null);
  assert.deepEqual(kept.files.map(file => file.id), ["file-2"], "the uncommitted file stays with the kept draft");
});

function mapStorage() {
  const map = new Map();
  return { getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}

test("session-expiry restore: an edited landed pending detaches; an unlanded retry keeps its command", () => {
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
  assert.equal(restored.drafts.get(null).pending.command.id, "cmd-landed-1", "reload keeps the unchanged landed retry");
  const edited = "Send the deployment summary to the fleet";
  restored.drafts.save(null, { body: edited });
  const reconciled = reconcileLandedDrafts(restored.drafts, state.messages);
  assert.equal(reconciled.length, 1, "only the edited landed pending reconciles");
  assert.equal(reconciled[0].key, null);
  const changed = restored.drafts.get(null);
  assert.equal(changed.pending, null);
  assert.equal(changed.body, edited);
  const kept = restored.drafts.get("msg-root-1");
  assert.equal(kept.pending.command.id, COMMAND_ID, "the unlanded send keeps its exact retry identity");
  assert.equal(kept.body, threadBody);
});
