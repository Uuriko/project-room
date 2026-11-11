// N20-01 acceptance tests: GET /api/rooms/{id}/receipts on current-format
// (native) rooms. On unmodified main the list returns {"receipts":[]} and
// the single-receipt route 404s for native completions, because the
// handlers read only the legacy Board store (work_claims), which native
// rooms never write. Acceptance test 5 of the filed set is the existing
// tests/receipt-search.test.js suite passing unmodified (run separately).
// covers server/current-receipts.mjs via HTTP boundary
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { createRoomServer } from "../server/http.mjs";

const PERMISSIONS = ["accept_work", "complete_work", "verify", "decide"];

function baseStore(t) {
  const s = new RoomStore(":memory:");
  t.after(() => s.close());
  const events = initialRoom();
  for (const id of ["worker", "verifier"]) {
    events.push(event({ roomId: "commons", actorId: "owner", type: "member.added",
      data: { memberId: id, displayName: id, kind: "agent", permissions: PERMISSIONS } }));
  }
  s.initialize(events, { representation: "normalized-current-v1" });
  const keys = Object.fromEntries(["owner", "worker", "verifier"].map(id => [id, s.issueAccessKey("commons", id)]));
  const cmd = (who, id, type, data) => s.command(keys[who], "commons", { id, type, data });
  const item = workId => JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE room_id='commons' AND work_id=?").get(workId).body);
  return { s, keys, cmd, item };
}

// Propose -> accept -> post room_text evidence -> complete. Returns the
// completion command result (its event id is the receipt's eventId).
function completeNative(cmd, item, { workId, title, summary, independentVerificationRequired, verifierMemberId = null }) {
  cmd("owner", `propose-${workId}`, "work.proposed", { workItemId: workId, title,
    definitionOfDone: "Saved result", accountableMemberId: "worker",
    ...(verifierMemberId ? { verifierMemberId } : {}),
    independentVerificationRequired, ownerDecisionRequired: false, mode: "read" });
  cmd("worker", `accept-${workId}`, "work.accepted", { workItemId: workId, expectedRevision: 0 });
  const body = `Result body for ${workId}`;
  const post = cmd("worker", `result-${workId}`, "message.posted", { messageId: `result-${workId}`, body, workItemId: workId });
  const completion = cmd("worker", `complete-${workId}`, "work.completed", { workItemId: workId,
    expectedRevision: item(workId).revision, evidenceKind: "room_text",
    evidenceMessageId: `result-${workId}`, evidenceMessageEventId: post.event.id,
    evidenceVersion: textVersion(body), producerId: "worker", previousCompletionEventId: null,
    summary, nextAction: "Independent review" });
  return completion;
}

function verifyNative(cmd, item, { workId, completion }) {
  const current = item(workId);
  cmd("verifier", `verify-${workId}`, "verification.recorded", { workItemId: workId,
    expectedRevision: current.revision, result: "pass",
    completionEventId: completion.event.id, evidenceVersion: current.receipt.evidenceVersion,
    summary: "Exact result checked" });
}

async function serve(t, s) {
  const server = createRoomServer({ store: s });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const getJson = async (origin, path, secret = null) => {
  const res = await fetch(`${origin}${path}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  return { res, json: await res.json() };
};

function verifiedFixture(t) {
  const f = baseStore(t);
  const completion = completeNative(f.cmd, f.item, { workId: "verified-task", title: "Verified native work",
    summary: "Verified completion summary", independentVerificationRequired: true, verifierMemberId: "verifier" });
  verifyNative(f.cmd, f.item, { workId: "verified-task", completion });
  return f;
}

test("1. native verified completion is listed as a receipt", async t => {
  const f = verifiedFixture(t);
  const origin = await serve(t, f.s);
  const { res, json } = await getJson(origin, "/api/rooms/commons/receipts", f.keys.worker);
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.receipts.length, 1, JSON.stringify(json.receipts));
  const [receipt] = json.receipts;
  assert.equal(receipt.receiptId, "rc_verified-task");
  assert.equal(receipt.workItemId, "verified-task");
  assert.equal(receipt.summary, "Verified completion summary");
  assert.equal(receipt.createdBy, "worker");
  assert.equal(typeof receipt.createdAt, "number");
  assert.ok(receipt.createdAt > 0);
  assert.ok(receipt.verification, "verification must be non-null");
  assert.equal(receipt.verification.state, "pass");
  assert.equal(receipt.verification.by, "verifier");
  assert.equal(receipt.deliveryDigest, null);
});

test("2. named native receipt resolves by receiptId", async t => {
  const f = verifiedFixture(t);
  const origin = await serve(t, f.s);
  const { res, json } = await getJson(origin, "/api/rooms/commons/receipts/rc_verified-task", f.keys.worker);
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.receipt?.receiptId, "rc_verified-task");
  assert.equal(json.receipt?.workItemId, "verified-task");
  assert.equal(json.receipt?.summary, "Verified completion summary");
});

test("3. unverified native completion is not a receipt", async t => {
  const f = baseStore(t);
  completeNative(f.cmd, f.item, { workId: "unverified-task", title: "Delivered but unverified",
    summary: "Delivered summary", independentVerificationRequired: true, verifierMemberId: "verifier" });
  const origin = await serve(t, f.s);
  const list = await getJson(origin, "/api/rooms/commons/receipts", f.keys.worker);
  assert.equal(list.res.status, 200, JSON.stringify(list.json));
  assert.deepEqual(list.json.receipts, []);
  const single = await getJson(origin, "/api/rooms/commons/receipts/rc_unverified-task", f.keys.worker);
  assert.equal(single.res.status, 404);
  assert.equal(single.json?.error?.code, "receipt_not_found");
});

test("4. self-contained native completion (no verification required) is listed", async t => {
  const f = baseStore(t);
  completeNative(f.cmd, f.item, { workId: "launch-note-v2", title: "Launch note",
    summary: "Launch note shipped", independentVerificationRequired: false });
  const origin = await serve(t, f.s);
  const { res, json } = await getJson(origin, "/api/rooms/commons/receipts", f.keys.worker);
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.deepEqual(json.receipts.map(r => r.receiptId), ["rc_launch-note-v2"]);
  assert.equal(json.receipts[0].summary, "Launch note shipped");
  assert.equal(json.receipts[0].verification, null);
});

test("6. member contract preserved on native rooms", async t => {
  const f = verifiedFixture(t);
  const origin = await serve(t, f.s);
  const unauthenticated = await getJson(origin, "/api/rooms/commons/receipts", null);
  assert.equal(unauthenticated.res.status, 401);
  assert.equal(unauthenticated.json?.error?.code, "unauthenticated");
  // A member who is not the worker can still read the list.
  const byVerifier = await getJson(origin, "/api/rooms/commons/receipts", f.keys.verifier);
  assert.equal(byVerifier.res.status, 200, JSON.stringify(byVerifier.json));
  assert.deepEqual(byVerifier.json.receipts.map(r => r.receiptId), ["rc_verified-task"]);
  const byOwner = await getJson(origin, "/api/rooms/commons/receipts", f.keys.owner);
  assert.equal(byOwner.res.status, 200);
  assert.deepEqual(byOwner.json.receipts.map(r => r.receiptId), ["rc_verified-task"]);
});

test("8. B7: room with 100 work items still serves its receipts (windowed projection)", async t => {
  const f = baseStore(t);
  // 97 merely-proposed items plus 3 terminal completions = 100 work items.
  // On the pre-cure head the projector enumerated all summaries in one
  // 256 KiB read context and both routes returned 409
  // current_room_context_unavailable at this size.
  const completedIds = ["bulk-005", "bulk-077", "bulk-099"];
  for (let i = 0; i < 100; i++) {
    const workId = `bulk-${String(i).padStart(3, "0")}`;
    if (completedIds.includes(workId)) continue;
    f.cmd("owner", `propose-${workId}`, "work.proposed", { workItemId: workId, title: `Title ${workId}`,
      definitionOfDone: "Saved result", accountableMemberId: "worker",
      independentVerificationRequired: false, ownerDecisionRequired: false, mode: "read" });
  }
  for (const workId of completedIds) {
    completeNative(f.cmd, f.item, { workId, title: `Title ${workId}`,
      summary: `Done ${workId}`, independentVerificationRequired: false });
  }
  const origin = await serve(t, f.s);
  const list = await getJson(origin, "/api/rooms/commons/receipts?limit=50", f.keys.worker);
  assert.equal(list.res.status, 200, JSON.stringify(list.json));
  assert.deepEqual(new Set(list.json.receipts.map(r => r.receiptId)),
    new Set(completedIds.map(id => `rc_${id}`)), JSON.stringify(list.json.receipts));
  const single = await getJson(origin, "/api/rooms/commons/receipts/rc_bulk-077", f.keys.worker);
  assert.equal(single.res.status, 200, JSON.stringify(single.json));
  assert.equal(single.json.receipt?.receiptId, "rc_bulk-077");
  assert.equal(single.json.receipt?.workItemId, "bulk-077");
});

test("9. owner-decision item is a receipt only with a current approved decision bound to its receipt", async t => {
  const f = baseStore(t);
  f.cmd("owner", "propose-decision-task", "work.proposed", { workItemId: "decision-task", title: "Decision gated work",
    definitionOfDone: "Saved result", accountableMemberId: "worker",
    humanDecisionMakerId: "owner", independentVerificationRequired: false, ownerDecisionRequired: true, mode: "read" });
  f.cmd("worker", "accept-decision-task", "work.accepted", { workItemId: "decision-task", expectedRevision: 0 });
  const body = "Result body for decision-task";
  const post = f.cmd("worker", "result-decision-task", "message.posted", { messageId: "result-decision-task", body, workItemId: "decision-task" });
  const completion = f.cmd("worker", "complete-decision-task", "work.completed", { workItemId: "decision-task",
    expectedRevision: f.item("decision-task").revision, evidenceKind: "room_text",
    evidenceMessageId: "result-decision-task", evidenceMessageEventId: post.event.id,
    evidenceVersion: textVersion(body), producerId: "worker", previousCompletionEventId: null,
    summary: "Decision gated summary", nextAction: "Owner decision" });
  const origin = await serve(t, f.s);
  // Completed, but no owner decision yet: not a receipt.
  const before = await getJson(origin, "/api/rooms/commons/receipts", f.keys.worker);
  assert.equal(before.res.status, 200, JSON.stringify(before.json));
  assert.deepEqual(before.json.receipts, [], JSON.stringify(before.json.receipts));
  const beforeSingle = await getJson(origin, "/api/rooms/commons/receipts/rc_decision-task", f.keys.worker);
  assert.equal(beforeSingle.res.status, 404);
  assert.equal(beforeSingle.json?.error?.code, "receipt_not_found");
  // Owner approves the exact current receipt: now it is a receipt.
  f.cmd("owner", "rationale-decision-task", "message.posted", { messageId: "rationale-decision-task",
    body: "I reviewed the exact result" });
  f.cmd("owner", "decide-decision-task", "owner.decision_recorded", { workItemId: "decision-task",
    expectedRevision: f.item("decision-task").revision, decision: "approved",
    completionEventId: completion.event.id, evidenceVersion: f.item("decision-task").receipt.evidenceVersion,
    reason: "Result accepted", sourceMessageId: "rationale-decision-task" });
  const after = await getJson(origin, "/api/rooms/commons/receipts", f.keys.worker);
  assert.equal(after.res.status, 200, JSON.stringify(after.json));
  assert.deepEqual(after.json.receipts.map(r => r.receiptId), ["rc_decision-task"]);
  const afterSingle = await getJson(origin, "/api/rooms/commons/receipts/rc_decision-task", f.keys.worker);
  assert.equal(afterSingle.res.status, 200, JSON.stringify(afterSingle.json));
  assert.equal(afterSingle.json.receipt?.receiptId, "rc_decision-task");
});

test("7. no Board pollution: native completions write no work_claims rows", async t => {
  const f = verifiedFixture(t);
  completeNative(f.cmd, f.item, { workId: "launch-note-v2", title: "Launch note",
    summary: "Launch note shipped", independentVerificationRequired: false });
  const origin = await serve(t, f.s);
  const list = await getJson(origin, "/api/rooms/commons/receipts", f.keys.worker);
  assert.equal(list.res.status, 200);
  assert.equal(list.json.receipts.length, 2, JSON.stringify(list.json.receipts));
  const claims = await getJson(origin, "/api/rooms/commons/work-claims", f.keys.owner);
  assert.equal(claims.res.status, 200, JSON.stringify(claims.json));
  assert.ok(!JSON.stringify(claims.json).includes("verified-task"), "native item leaked into Board claims");
  assert.ok(!JSON.stringify(claims.json).includes("launch-note-v2"), "native item leaked into Board claims");
  const rows = f.s.db.prepare("SELECT count(*) AS n FROM work_claims WHERE room_id='commons'").get();
  assert.equal(rows.n, 0);
});
