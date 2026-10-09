// FIX-63: deciding an admission access request must emit the access_decision
// notification through the existing notification infrastructure (the
// read-time feed in server/notifications.mjs), so requesters stop polling.
// Fail-first: the decision receipt, the row's decisionMessageId, and the
// feed item do not exist before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { permissionDecisionMessages } from "../server/member-permission-requests.mjs";
import { deriveNotifications } from "../server/notifications.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-fix63-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Decision Seeker");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const file = (requestId, displayName = "Decision Seeker") => requests.request("commons", {
    identityId: identity.identityId, displayName, requestedPermissions: [], requestId,
  });
  return { store, requests, ownerToken, identity, file };
}

const feedRows = store => store.db.prepare(
  "SELECT sequence, body FROM events WHERE room_id='commons' ORDER BY sequence DESC LIMIT 501")
  .all().reverse().map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));

const receiptEvent = (store, messageId) => {
  const row = store.db.prepare(
    "SELECT body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')=?")
    .get(messageId);
  return row ? JSON.parse(row.body) : null;
};

test("approve emits access_decision visible in the new member's notification feed", async t => {
  const { store, requests, ownerToken, identity, file } = setup(t);
  assert.equal(file("ar_notify_approve").status, "pending");
  const decided = requests.decide(ownerToken, "commons", "ar_notify_approve", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.ok(decided.decisionMessageId, "the decision records its receipt message id");
  // The receipt is a causally linked public timeline message, not a silent row update.
  const receipt = receiptEvent(store, decided.decisionMessageId);
  assert.ok(receipt, "the decision receipt is on the room timeline");
  const basis = store.db.prepare("SELECT body FROM events WHERE room_id='commons' AND id=?").get(receipt.causationId);
  assert.ok(basis, "the receipt names its causation event");
  assert.equal(JSON.parse(basis.body).type, "access.requested", "the receipt is causally linked to the access.requested event");
  assert.equal(JSON.parse(basis.body).data.requestId, "ar_notify_approve");
  // The requester — now a member — reads the normal notification channel.
  const feed = store.notifications.list(identity.secret, "commons");
  const item = feed.notifications.find(n => n.kind === "access_decision" && n.requestId === "ar_notify_approve");
  assert.ok(item, "the approved requester sees an access_decision item in their feed");
  assert.equal(item.outcome, "approved");
  assert.equal(item.requestId, "ar_notify_approve");
  assert.ok(item.at, "the notification carries a timestamp");
  assert.ok(item.eventId, "the notification carries the receipt event id");
});

test("deny emits access_decision through the notification derivation", async t => {
  const { store, requests, ownerToken, identity, file } = setup(t);
  file("ar_notify_deny");
  const denied = requests.decide(ownerToken, "commons", "ar_notify_deny", { decision: "deny", note: "Not now" });
  assert.equal(denied.status, "denied");
  assert.ok(denied.decisionMessageId, "the denial records its receipt message id");
  assert.ok(receiptEvent(store, denied.decisionMessageId), "the denial receipt is on the room timeline");
  // The feed's own resolution input: every row the channel scans.
  const rows = feedRows(store);
  const decisions = permissionDecisionMessages(store, rows);
  const resolved = decisions.get(denied.decisionMessageId);
  assert.ok(resolved, "the feed resolves the receipt to a decision");
  assert.deepEqual(
    { requestId: resolved.requestId, memberId: resolved.memberId, outcome: resolved.outcome },
    { requestId: "ar_notify_deny", memberId: identity.identityId, outcome: "denied" },
    "the payload shape matches the notification module's expectation");
  assert.ok(resolved.eventId, "the payload carries the receipt event id");
  // A denied requester is not a member, so derive the item exactly the way
  // the feed would for them.
  const state = store.room("commons").state;
  const items = deriveNotifications({
    events: rows, state,
    member: { id: identity.identityId, notificationPreferences: {} },
    accessDecisions: decisions,
  });
  const item = items.find(i => i.kind === "access_decision" && i.requestId === "ar_notify_deny");
  assert.ok(item, "the derivation produces an access_decision item for the requester");
  assert.equal(item.outcome, "denied");
  assert.equal(item.eventId, resolved.eventId);
  assert.ok(item.at, "the notification carries a timestamp");
  assert.ok(!String(item.note ?? "").includes("Not now"), "the private review note stays off the public receipt");
});

test("a retried decision emits no second receipt or notification", async t => {
  const { store, requests, ownerToken, file } = setup(t);
  file("ar_notify_dup");
  const decided = requests.decide(ownerToken, "commons", "ar_notify_dup", { decision: "approve" });
  const sequence = store.room("commons").sequence;
  assert.throws(() => requests.decide(ownerToken, "commons", "ar_notify_dup", { decision: "deny" }),
    error => error.code === "already_decided");
  assert.equal(store.room("commons").sequence, sequence, "a retried decision appends no second receipt event");
  const receipts = store.db.prepare(
    "SELECT count(*) AS n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')=?")
    .get(decided.decisionMessageId).n;
  assert.equal(receipts, 1, "exactly one decision receipt exists for the request");
});
