// L3-D1 regression: public receipts for current-format (native) rooms.
//
// A current room never writes public_receipts rows — syncRoomPublication
// returns for rooms named in current_room_head and the native
// publication hook caches room metadata only — so before this fix an
// opted-in current room's completed, verified receipts listed nowhere
// on GET /api/public/receipts and their wir_ pages 404'd, before and
// after restart. The public surfaces now derive a current room's
// work-item receipts at read time from its canonical records while
// its recorded room.public_receipts_set opt-in is on
// (server/public-read-model.mjs currentDerivedReceipts, fed by
// server/current-receipts.mjs). These tests drive a native room
// through the real store + HTTP server, like
// tests/current-receipts.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { createRoomServer } from "../server/http.mjs";
import { publicWorkItemReceiptId } from "../server/public-read-model.mjs";

const PERMISSIONS = ["accept_work", "complete_work", "verify", "decide"];
const WIR = publicWorkItemReceiptId("commons", "verified-task");

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

function completeNative(cmd, item, { workId, title }) {
  cmd("owner", `propose-${workId}`, "work.proposed", { workItemId: workId, title,
    definitionOfDone: "Saved result", accountableMemberId: "worker", verifierMemberId: "verifier",
    independentVerificationRequired: true, ownerDecisionRequired: false, mode: "read" });
  cmd("worker", `accept-${workId}`, "work.accepted", { workItemId: workId, expectedRevision: 0 });
  const body = `Result body for ${workId}`;
  const post = cmd("worker", `result-${workId}`, "message.posted", { messageId: `result-${workId}`, body, workItemId: workId });
  return cmd("worker", `complete-${workId}`, "work.completed", { workItemId: workId,
    expectedRevision: item(workId).revision, evidenceKind: "room_text",
    evidenceMessageId: `result-${workId}`, evidenceMessageEventId: post.event.id,
    evidenceVersion: textVersion(body), producerId: "worker", previousCompletionEventId: null,
    summary: `Summary for ${workId}`, nextAction: "Independent review" });
}

function verifiedFixture(t) {
  const f = baseStore(t);
  const completion = completeNative(f.cmd, f.item, { workId: "verified-task", title: "Verified native work" });
  const current = f.item("verified-task");
  f.cmd("verifier", "verify-verified-task", "verification.recorded", { workItemId: "verified-task",
    expectedRevision: current.revision, result: "pass",
    completionEventId: completion.event.id, evidenceVersion: current.receipt.evidenceVersion,
    summary: "Exact result checked" });
  // A second completion that is never verified is not a receipt and
  // must never be derived, opted in or not.
  completeNative(f.cmd, f.item, { workId: "unverified-task", title: "Unverified native work" });
  return f;
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

const get = async (origin, path) => {
  const res = await fetch(`${origin}${path}`);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, text, json };
};

test("before the opt-in, a current room's verified receipt is not public", async t => {
  const f = verifiedFixture(t);
  const origin = await serve(t, f.s);
  const feed = await get(origin, "/api/public/receipts?limit=50");
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.json.receipts, []);
  assert.equal((await get(origin, `/receipts/${WIR}.json`)).status, 404);
});

test("opted-in current room's verified receipt lists and resolves publicly", async t => {
  const f = verifiedFixture(t);
  const origin = await serve(t, f.s);
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });

  const feed = await get(origin, "/api/public/receipts?limit=50");
  assert.equal(feed.status, 200);
  const listed = feed.json.receipts.find(receipt => receipt.id === WIR);
  assert.ok(listed, `expected ${WIR} in ${JSON.stringify(feed.json.receipts.map(r => r.id))}`);
  assert.equal(listed.title, "Verified native work");
  assert.equal(listed.source, "work-item");
  assert.equal(listed.verification.state, "room_recorded");
  assert.deepEqual(listed.hashes, [f.item("verified-task").receipt.evidenceVersion]);
  assert.ok(!feed.json.receipts.some(receipt => receipt.id === publicWorkItemReceiptId("commons", "unverified-task")),
    "an unverified completion is not a receipt and must not be derived");

  const byRoom = await get(origin, "/api/public/receipts?room=commons&limit=50");
  assert.ok(byRoom.json.receipts.some(receipt => receipt.id === WIR));

  const detail = await get(origin, `/receipts/${WIR}.json`);
  assert.equal(detail.status, 200, detail.text.slice(0, 300));
  assert.equal(detail.json.id, WIR);
  assert.equal(detail.json.title, "Verified native work");
  assert.equal((await get(origin, `/receipts/${WIR}`)).status, 200);
});

test("recording the opt-in off hides the current room's receipt again", async t => {
  const f = verifiedFixture(t);
  const origin = await serve(t, f.s);
  f.cmd("owner", "optin-1", "room.public_receipts_set", { enabled: true });
  assert.ok((await get(origin, "/api/public/receipts?limit=50")).json.receipts.some(r => r.id === WIR));
  f.cmd("owner", "optout-1", "room.public_receipts_set", { enabled: false });
  assert.deepEqual((await get(origin, "/api/public/receipts?limit=50")).json.receipts, []);
  assert.equal((await get(origin, `/receipts/${WIR}.json`)).status, 404);
});
