// Live contract test: the plugin's actions against a real room server
// running in-process (the repo's own serve pattern).
//
// Authoring gate: this is the only test that crosses the real HTTP boundary
// with the plugin's assumptions — redeem enrolls and the pri_ secret
// authenticates; the register -> claim -> post -> done -> receipt round-trip
// behaves as the actions expect. Server-side contract drift (redeem response
// shape, claim route semantics) breaks every ElizaOS operator's plugin, and
// only this test can catch it. No new production seams.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { createRoomClient } from "../src/roomClient.js";
import { roomActions } from "../src/actions.js";
import { buildRoomContext } from "../src/providers.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-elizaos-live-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function ownerCall(origin, ownerKey, method, path, body) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const config = { roomId: "commons" };

test("full agent lifecycle through the plugin actions: join, board, claim, post, receipt, inbox, release", async t => {
  const { origin, ownerKey } = await serve(t);

  // Owner mints a one-time invite and registers a work item.
  const minted = await ownerCall(origin, ownerKey, "POST", "/api/rooms/commons/agent-invites",
    { permissions: ["accept_work", "complete_work"] });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const registered = await ownerCall(origin, ownerKey, "POST", "/api/rooms/commons/work-claims",
    { id: "e2e-task", title: "Write the E2E summary" });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const registered2 = await ownerCall(origin, ownerKey, "POST", "/api/rooms/commons/work-claims",
    { id: "e2e-task-2", title: "Second task" });
  assert.equal(registered2.status, 201);

  // Join: redeem the invite through the plugin action (no credential yet).
  const anon = createRoomClient({ baseUrl: origin });
  const joined = await roomActions.join.run({ client: anon, params: { code: minted.json.code, displayName: "Eliza E2E" }, config });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.match(joined.secret, /^pri_/, "redeem issues the pri_ identity secret");
  assert.match(joined.memberId, /^ai_/);
  assert.equal(joined.roomId, "commons");
  assert.ok(joined.secretWarning.includes("ROOM_AGENT_SECRET"), "join tells the operator to persist the secret");
  assert.ok(Array.isArray(joined.nextSteps), "room's machine-readable next steps surface");

  const client = createRoomClient({ baseUrl: origin, credential: joined.secret });

  // Board: the registered item is open; nothing is mine yet.
  const board = await roomActions.listWork.run({ client, params: { memberId: joined.memberId }, config });
  assert.equal(board.ok, true, JSON.stringify(board));
  assert.ok(board.open.some(c => c.id === "e2e-task"), "registered item appears as open");
  assert.equal(board.mine.length, 0);

  // Claim it.
  const claimed = await roomActions.claimTask.run({ client, params: { claimId: "e2e-task", note: "on it" }, config });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.claim.state, "claimed");
  assert.equal(claimed.claim.owner, joined.memberId);
  assert.ok(claimed.leaseNote, "claim reports the lease");

  // A second agent colliding on the same item gets the anti-collision failure, surfaced not thrown.
  const mintedB = await ownerCall(origin, ownerKey, "POST", "/api/rooms/commons/agent-invites", { permissions: ["accept_work"] });
  const joinedB = await roomActions.join.run({ client: anon, params: { code: mintedB.json.code, displayName: "Eliza B" }, config });
  const clientB = createRoomClient({ baseUrl: origin, credential: joinedB.secret });
  const collision = await roomActions.claimTask.run({ client: clientB, params: { claimId: "e2e-task" }, config });
  assert.equal(collision.ok, false);
  assert.equal(collision.code, "work_claim_conflict");

  // Post a progress update to the room.
  const posted = await roomActions.postUpdate.run({ client, params: { body: "E2E progress: claim taken, working through it." }, config });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  // Submit the receipt (done transition with delivery evidence).
  const done = await roomActions.submitReceipt.run({
    client,
    params: { claimId: "e2e-task", note: "Summary written and posted.", deliveryMode: "result", tags: ["e2e"] },
    config,
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.claim.state, "done");
  assert.equal(done.receiptId, "rc_e2e-task");

  // The receipt is searchable on the room's receipt board via the raw client.
  const receipts = await client.listReceipts("commons", { q: "e2e" });
  assert.ok(receipts.receipts.some(r => r.receiptId === "rc_e2e-task"), "done item projects as a receipt");

  // Inbox: the agent reads its own items.
  const inbox = await roomActions.readInbox.run({ client, params: {}, config });
  assert.equal(inbox.ok, true, JSON.stringify(inbox));
  assert.equal(inbox.agentId, joined.memberId);

  // Release the second claim back to the board.
  const claimed2 = await roomActions.claimTask.run({ client, params: { claimId: "e2e-task-2" }, config });
  assert.equal(claimed2.ok, true);
  const released = await roomActions.releaseClaim.run({ client, params: { claimId: "e2e-task-2", note: "not mine" }, config });
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(released.claim.state, "unclaimed");

  // Provider snapshot: my done claim is gone from open claims; board still lists e2e-task-2 as open.
  const context = await buildRoomContext({ client, roomId: "commons", memberId: joined.memberId });
  assert.ok(context.includes("My open claims (0):"), "done claim leaves the open list");
  assert.ok(context.includes("Open work on the board:"), "board totals render");
});

test("room failures surface as { ok: false, code } the agent can explain", async t => {
  const { origin } = await serve(t);
  const anon = createRoomClient({ baseUrl: origin });
  const badCode = await roomActions.join.run({ client: anon, params: { code: "RM-0000AAAA", displayName: "Ghost" }, config });
  assert.equal(badCode.ok, false);
  assert.equal(badCode.code, "invite_unavailable");
  const noAuth = await roomActions.listWork.run({ client: anon, params: {}, config });
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.code, "unauthenticated");
  const missing = await roomActions.claimTask.run({ client: anon, params: { claimId: "nope", note: "x" }, config });
  assert.equal(missing.ok, false);
  assert.ok(["unauthenticated", "work_claim_not_found"].includes(missing.code), missing.code);
});
