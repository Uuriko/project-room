// Agent work exchange slice 1: HTTP integration for the escrowed-bounty routes.
// Covers the specified public API over the wire: post → fund → claim →
// submit → accept → epoch-close → balances, plus the triage quartet
// (decline/duplicate/snooze), watch stickiness, idempotency, and the 4xx
// error mapping. Credits are valueless ledger units: no cash-out, no
// on-chain touch, no real money.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  // Test-only ledger seeding: grant the fixture members payable credits so
  // fund/claim/dispute can lock real (valueless) balances over HTTP.
  const escrow = new BountyEscrow(fixture.store);
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys, fixture };
}

const post = (origin, path, body, secret, extraHeaders = {}) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${secret}`,
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: { authorization: `Bearer ${secret}` },
});

const ROOM = "commons";
const bountyBody = (overrides = {}) => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change with a before/after example.",
  amount: 100,
  deadline: new Date(Date.now() + 86400000).toISOString(),
  ...overrides,
});

test("post → fund → claim → submit → accept → epoch-close → balances", async t => {
  const { origin, keys, fixture } = await startServer(t);
  // Jill (owner) proposes; the bounty is PROPOSED and locks nothing.
  const createRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody(), keys.owner);
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  const bountyId = created.bounty.bountyId;
  assert.equal(created.bounty.state, "proposed");
  assert.equal(created.bounty.group, "proposed");
  assert.match(bountyId, /^[A-Z]+-\d+$/, "sequential room-local id (e.g. COMMONS-1)");

  // Proposed is excluded from funded listings.
  const fundedList = await get(origin, `/api/rooms/${ROOM}/bounties?group=funded`, keys.owner);
  assert.equal(fundedList.status, 200);
  assert.deepEqual((await fundedList.json()).bounties, []);

  // Triage: fund locks the budget and publishes to watchers.
  const fundRes = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
  assert.equal(fundRes.status, 200);
  assert.equal((await fundRes.json()).bounty.state, "funded");

  // Grok Bot (producer) claims; the 1-credit claim bond locks.
  const claimRes = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/claim`, {}, keys.producer);
  assert.equal(claimRes.status, 200);
  assert.equal((await claimRes.json()).bounty.state, "claimed");

  // Double claim is a 409.
  const doubleClaim = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/claim`, {}, keys.reviewer);
  assert.equal(doubleClaim.status, 409);

  // Grok Bot submits with the work.completed evidence receipt.
  const submitRes = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/1",
    evidenceKind: "work.completed",
    summary: "Migration guide drafted with before/after examples.",
    checksClaimed: ["breaking-changes"],
    producerId: "producer",
  }, keys.producer);
  assert.equal(submitRes.status, 200);
  assert.equal((await submitRes.json()).bounty.group, "in-review");

  // Jill accepts: explicit gated approval before attribution.
  const acceptRes = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/accept`, {
    verifierAttestation: { reviewerId: "owner", checks: ["breaking-changes"], outcome: "pass", citations: [{ criterionId: "c1", verdict: "pass" }] },
  }, keys.owner);
  assert.equal(acceptRes.status, 200);
  const accepted = await acceptRes.json();
  assert.ok(accepted.approval, "accept returns the explicit approval");
  assert.ok(accepted.attribution, "accept returns the attribution");

  // Advance past the challenge window (test-only) so finalize can approve.
  fixture.store.db.prepare(
    "UPDATE bounty_records SET challenge_ends_ms = 0 WHERE room_id = ? AND bounty_id = ?"
  ).run(ROOM, bountyId);
  const finalizeRes = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/finalize`, {}, keys.owner);
  assert.equal(finalizeRes.status, 200);
  assert.equal((await finalizeRes.json()).action, "approved");

  // Epoch close sweeps 99% to the earner and 1% to the pool.
  const epochRes = await post(origin, `/api/rooms/${ROOM}/credits/epoch/close`, {}, keys.owner);
  assert.equal(epochRes.status, 200);

  const balancesRes = await get(origin, `/api/rooms/${ROOM}/credits/balances/producer`, keys.owner);
  assert.equal(balancesRes.status, 200);
  const balances = (await balancesRes.json()).balances;
  assert.equal(balances.payable, 199, "100 seeded + 99 payout (1% fee) = 199; claim bond returned");
  assert.equal(balances.reputation.completedBounties, 1, "paid-only reputation accrues");
});

test("triage quartet: decline, duplicate, snooze", async t => {
  const { origin, keys } = await startServer(t);

  const declineRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody({ title: "Declined work" }), keys.owner);
  const declineId = (await declineRes.json()).bounty.bountyId;
  const decline = await post(origin, `/api/rooms/${ROOM}/bounties/${declineId}/decline`, { reason: "out of scope" }, keys.owner);
  assert.equal(decline.status, 200);
  assert.equal((await decline.json()).bounty.state, "cancelled");

  const dupRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody({ title: "Duplicate work" }), keys.owner);
  const dupId = (await dupRes.json()).bounty.bountyId;
  const dup = await post(origin, `/api/rooms/${ROOM}/bounties/${dupId}/duplicate`, { canonical_id: declineId }, keys.owner);
  assert.equal(dup.status, 200);
  const dupJson = await dup.json();
  assert.equal(dupJson.bounty.state, "cancelled");
  assert.equal(dupJson.bounty.duplicateOf, declineId);

  const snoozeRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody({ title: "Snoozed work" }), keys.owner);
  const snoozeId = (await snoozeRes.json()).bounty.bountyId;
  const snooze = await post(origin, `/api/rooms/${ROOM}/bounties/${snoozeId}/snooze`, {
    until: new Date(Date.now() + 7 * 86400000).toISOString(),
  }, keys.owner);
  assert.equal(snooze.status, 200);
  assert.equal((await snooze.json()).bounty.state, "proposed", "snooze keeps the proposal open");

  // Only the poster may triage.
  const forbidden = await post(origin, `/api/rooms/${ROOM}/bounties/${snoozeId}/decline`, { reason: "no" }, keys.producer);
  assert.equal(forbidden.status, 403);
});

test("watch is sticky and idempotent; idempotency keys replay safely", async t => {
  const { origin, keys } = await startServer(t);
  const createRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody(), keys.owner);
  const bountyId = (await createRes.json()).bounty.bountyId;

  const watch1 = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/watch`, {}, keys.guest);
  assert.equal(watch1.status, 200);
  const watch2 = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/watch`, {}, keys.guest);
  assert.equal(watch2.status, 200, "watch is idempotent");

  // Idempotent fund replay returns the original receipt without double-locking.
  const idem = `idem-${Date.now()}`;
  const fund1 = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, keys.owner, { "idempotency-key": idem });
  assert.equal(fund1.status, 200);
  const fund2 = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, keys.owner, { "idempotency-key": idem });
  assert.equal(fund2.status, 200);
  assert.deepEqual(await fund2.json(), await fund1.json(), "replay returns the stored receipt");
});

test("error mapping: unknown bounty, invalid input, unauthenticated", async t => {
  const { origin, keys } = await startServer(t);

  const unknown = await post(origin, `/api/rooms/${ROOM}/bounties/ROOM-9999/fund`, {}, keys.owner);
  assert.equal(unknown.status, 404);

  const invalid = await post(origin, `/api/rooms/${ROOM}/bounties`, { title: "" }, keys.owner);
  assert.equal(invalid.status, 422);

  const noAuth = await fetch(`${origin}/api/rooms/${ROOM}/bounties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bountyBody()),
  });
  assert.equal(noAuth.status, 401);
});

test("dispute bond is exactly 25% and the dispute lifecycle resolves", async t => {
  const { origin, keys } = await startServer(t);
  const createRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody({ amount: 100 }), keys.owner);
  const bountyId = (await createRes.json()).bounty.bountyId;
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/claim`, {}, keys.producer);
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/2",
    summary: "Done.",
    producerId: "producer",
  }, keys.producer);
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/accept`, {
    verifierAttestation: { reviewerId: "owner", outcome: "pass", citations: [{ criterionId: "c1", verdict: "pass" }] },
  }, keys.owner);

  // Wrong bond size is a 422.
  const badBond = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/dispute`, {
    bond: 10, grounds: "looks wrong",
  }, keys.reviewer);
  assert.equal(badBond.status, 422);

  // Exactly 25% opens the dispute.
  const dispute = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/dispute`, {
    bond: 25, grounds: "deliverable incomplete",
  }, keys.reviewer);
  assert.equal(dispute.status, 201);

  // Credit history is movement-level with before/after and hash links.
  const historyRes = await get(origin, `/api/rooms/${ROOM}/credits/history/producer`, keys.owner);
  assert.equal(historyRes.status, 200);
  const receipts = (await historyRes.json()).receipts;
  assert.ok(receipts.length > 0);
  assert.ok(receipts.every(r => r.after && r.hash), "every receipt carries after and a hash link");
  assert.ok(receipts.every(r => r.kind === "genesis" || r.before),
    "every non-genesis movement receipt carries before");
});

test("rubric route: post with rubric, re-pin pre-funding, frozen after fund", async t => {
  const { origin, keys } = await startServer(t);
  const rubric = [
    { criterionId: "correctness", description: "resolves the bug" },
    { criterionId: "tests", description: "regression tests included" },
  ];
  const createRes = await post(origin, `/api/rooms/${ROOM}/bounties`, bountyBody({ rubric }), keys.owner);
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  const bountyId = created.bounty.bountyId;
  const pinned = created.bounty.rubric;
  assert.equal(pinned.version, 1);
  assert.equal(pinned.criteria.length, 2);

  // Re-pin before funding: v2.
  const repin = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/rubric`, {
    rubric: [{ criterionId: "correctness", description: "resolves the bug, clearer" },
      { criterionId: "tests", description: "regression tests included" }],
  }, keys.owner);
  assert.equal(repin.status, 200);
  assert.equal((await repin.json()).bounty.rubric.version, 2);

  // Non-poster cannot re-pin.
  const foreign = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/rubric`, { rubric }, keys.producer);
  assert.equal(foreign.status, 403);

  // Funding pins the rubric: re-pin is now a 422.
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
  const frozen = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/rubric`, { rubric }, keys.owner);
  assert.equal(frozen.status, 422);
});
