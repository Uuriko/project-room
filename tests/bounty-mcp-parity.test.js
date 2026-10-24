// MCP parity for the two money-lifecycle verbs that existed only on HTTP
// (QA-MONEY-API defect D-1): bounty_decline and bounty_reject.
//
// These tests drive the real hosted dispatch (callHostedStdioTool) against a
// real RoomStore, run the full two-party journey through the MCP door only,
// and read the outcomes back the way an MCP-only poster would. They also
// re-verify the pre-existing HTTP behaviour on the same build (the two doors
// invoke the same escrow transitions, so their outcomes must agree), and pin
// bounty_read_history's documented order: newest first by recorded time.

import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { issueSpendGrant } from "../server/spend-grants.mjs";

const ROOM = "commons";
const POSTER = "agent";
const WORKER = "worker";

function fixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey(ROOM, "owner") };
  for (const memberId of [POSTER, WORKER]) {
    store.command(keys.owner, ROOM, { id: `add-${memberId}`, type: "member.added",
      data: { memberId, displayName: memberId, kind: "agent",
        permissions: ["accept_work", "complete_work"] } });
    keys[memberId] = store.issueAccessKey(ROOM, memberId);
    setTier(store.db, ROOM, memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  // bounty_post is priced for agents; the poster holds a grant (as in the
  // sibling idempotency fixture).
  issueSpendGrant(store.db, ROOM, POSTER, { grantedBy: "owner", capCents: "100000", perTxCapCents: "10000", nowMs: Date.now() });
  store.bountyEscrow.ensureGenesis(ROOM);
  return { store, keys };
}

const call = (store, secret, name, args) =>
  callHostedStdioTool(store, secret, name, { roomId: ROOM, ...args });

const postArgs = (key, overrides = {}) => ({
  title: "Parity bounty", criteria: "Done means the exact string.",
  amount: 10, deadline: new Date(Date.now() + 3_600_000).toISOString(),
  idempotencyKey: key, ...overrides });

async function runToSubmitted(store, keys, keyPrefix) {
  const posted = await call(store, keys[POSTER], "bounty_post", postArgs(`${keyPrefix}-post`));
  assert.equal(posted.isError, false, JSON.stringify(posted));
  const bountyId = posted.value.bounty.bountyId;
  await call(store, keys[POSTER], "bounty_fund", { bountyId, idempotencyKey: `${keyPrefix}-fund` });
  await call(store, keys[WORKER], "bounty_claim", { bountyId, idempotencyKey: `${keyPrefix}-claim` });
  const submitted = await call(store, keys[WORKER], "bounty_submit",
    { bountyId, evidenceUrl: "https://example.com/result", summary: "wrong string",
      idempotencyKey: `${keyPrefix}-submit` });
  assert.equal(submitted.value.bounty.state, "submitted");
  return bountyId;
}

test("MCP-only journey: decline a proposal, reason read back on the MCP door", async t => {
  const { store, keys } = fixture(t);
  const posted = await call(store, keys[POSTER], "bounty_post", postArgs("decline-post"));
  const bountyId = posted.value.bounty.bountyId;
  const reason = "poster withdraws this proposal before funding";
  const declined = await call(store, keys[POSTER], "bounty_decline",
    { bountyId, reason, idempotencyKey: "decline-1" });
  assert.equal(declined.isError, false, JSON.stringify(declined));
  assert.equal(declined.value.bounty.state, "cancelled");
  assert.equal(declined.value.bounty.declineReason, reason);
  // Read back through the MCP door only, as the other member.
  const listed = await call(store, keys[WORKER], "bounty_list", { group: "cancelled" });
  const readBack = listed.value.bounties.find(b => b.bountyId === bountyId);
  assert.ok(readBack, "declined bounty must be listed");
  assert.equal(readBack.declineReason, reason);
  // A keyed replay returns the stored outcome instead of re-transitioning.
  const replay = await call(store, keys[POSTER], "bounty_decline",
    { bountyId, reason, idempotencyKey: "decline-1" });
  assert.equal(replay.value.idempotentReplay, true);
});

test("MCP-only journey: reject submitted work, free-miss settlement read back", async t => {
  const { store, keys } = fixture(t);
  const posterBefore = store.bountyEscrow.balances(ROOM, POSTER);
  const bountyId = await runToSubmitted(store, keys, "reject");
  const workerClaimed = store.bountyEscrow.balances(ROOM, WORKER);
  assert.equal(workerClaimed.locked, 1, "claim bond locked");

  const reason = "evidence does not contain the exact string";
  const rejected = await call(store, keys[POSTER], "bounty_reject",
    { bountyId, reason, idempotencyKey: "reject-1" });
  assert.equal(rejected.isError, false, JSON.stringify(rejected));
  assert.equal(rejected.value.bounty.state, "refunded");
  assert.equal(rejected.value.alreadySettled, false);
  assert.equal(rejected.value.settlement.kind, "failed");
  assert.equal(rejected.value.settlement.workerCredits, 0);
  assert.equal(rejected.value.settlement.refundCredits, 10);
  assert.equal(rejected.value.settlement.reason, reason);
  assert.equal(rejected.value.bounty.resolution.kind, "rejected");
  assert.equal(rejected.value.bounty.resolution.reason, reason);
  // Free-miss money shape: poster made whole, worker settles at zero and
  // forfeits the claim bond (locked drops by the bond, nothing attributed).
  assert.deepEqual(store.bountyEscrow.balances(ROOM, POSTER), posterBefore);
  const workerAfter = store.bountyEscrow.balances(ROOM, WORKER);
  assert.equal(workerAfter.locked, 0);
  assert.equal(workerAfter.attributed, 0);
  // The bond was already out of payable at claim time; the forfeit moves it
  // from locked to the pool, so payable is unchanged and the total drops by 1.
  assert.equal(workerAfter.payable, workerClaimed.payable, "payable untouched by the forfeit");
  assert.equal(workerAfter.payable + workerAfter.locked + workerAfter.attributed + workerAfter.approved,
    workerClaimed.payable + workerClaimed.locked + workerClaimed.attributed + workerClaimed.approved - 1,
    "bond forfeited to the pool");
  // A keyed replay returns the stored settlement; no credits move twice.
  const replay = await call(store, keys[POSTER], "bounty_reject",
    { bountyId, reason, idempotencyKey: "reject-1" });
  assert.equal(replay.value.idempotentReplay, true);
  assert.deepEqual(store.bountyEscrow.balances(ROOM, WORKER), workerAfter);
  assert.deepEqual(store.bountyEscrow.balances(ROOM, POSTER), posterBefore);
});

test("HTTP decline and reject behave exactly as before, on the same build", async t => {
  const { store, keys } = fixture(t);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const http = async (secret, bountyId, verb, payload) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/${ROOM}/bounties/${bountyId}/${verb}`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() };
  };

  const proposed = await call(store, keys[POSTER], "bounty_post", postArgs("http-decline-post"));
  const declined = await http(keys[POSTER], proposed.value.bounty.bountyId, "decline",
    { reason: "http decline reason", idempotencyKey: "http-decline-1" });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body.bounty.state, "cancelled");
  assert.equal(declined.body.bounty.declineReason, "http decline reason");

  const bountyId = await runToSubmitted(store, keys, "http-reject");
  const rejected = await http(keys[POSTER], bountyId, "reject",
    { reason: "http reject reason", idempotencyKey: "http-reject-1" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.bounty.state, "refunded");
  assert.equal(rejected.body.settlement.kind, "failed");
  assert.equal(rejected.body.bounty.resolution.reason, "http reject reason");
});

test("bounty_read_history returns receipts newest first by recorded time", async t => {
  const { store, keys } = fixture(t);
  await runToSubmitted(store, keys, "hist-a");
  const bountyId = await runToSubmitted(store, keys, "hist-b");
  await call(store, keys[POSTER], "bounty_reject",
    { bountyId, reason: "ordering probe", idempotencyKey: "hist-b-reject" });
  const proposed = await call(store, keys[POSTER], "bounty_post", postArgs("hist-decline-post"));
  await call(store, keys[POSTER], "bounty_decline",
    { bountyId: proposed.value.bounty.bountyId, reason: "ordering probe", idempotencyKey: "hist-decline" });

  const viaTool = await call(store, keys[POSTER], "bounty_read_history", {});
  assert.equal(viaTool.isError, false, JSON.stringify(viaTool));
  const receipts = viaTool.value.receipts;
  // The poster's journal: genesis + two escrow-locks + the reject's refund.
  assert.equal(receipts.length, 4, `expected the poster's 4 receipts, got ${receipts.length}`);
  for (let i = 1; i < receipts.length; i++)
    assert.ok(receipts[i].at <= receipts[i - 1].at,
      `history must be newest first: ${receipts[i - 1].kind}@${receipts[i - 1].at} before ${receipts[i].kind}@${receipts[i].at}`);
  // The genesis issuance is the poster's earliest movement: it reads last.
  assert.equal(receipts[receipts.length - 1].kind, "genesis");
  // No receipt field was altered by the ordering: the chain fields ride along.
  for (const r of receipts) {
    assert.equal(typeof r.receiptId, "string");
    assert.equal(typeof r.hash, "string");
    assert.ok(Array.isArray(r.entries) && r.entries.length >= 1);
  }
});
