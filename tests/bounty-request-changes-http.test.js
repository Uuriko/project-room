// REQUEST-CHANGES over HTTP (charter request-changes.md, Option A):
// POST /api/rooms/{roomId}/bounties/{bountyId}/request-changes with a
// mandatory {summary} returns a submitted bounty to its worker (200,
// state claimed, changesRequested carrying the summary verbatim); without
// a summary the refusal names `summary`. Re-submit and accept then settle
// over the wire exactly as a first-round cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";

const ROOM = "commons";

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  ensureSpendGrantsSchema(fixture.store.db);
  for (const memberId of ["producer", "reviewer"]) {
    issueSpendGrant(fixture.store.db, ROOM, memberId,
      { grantedBy: "owner", capCents: "100000", perTxCapCents: "100000", nowMs: Date.now() });
  }
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys, fixture };
}

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: 'Bearer ' + secret },
  body: JSON.stringify(body),
});

test("POST request-changes: summary required, worker re-delivers, accept settles", async t => {
  const { origin, keys } = await startServer(t);
  const created = await (await post(origin, `/api/rooms/${ROOM}/bounties`, {
    title: "Write the guide", criteria: "Cover every breaking change.", amount: 10,
    deadline: new Date(Date.now() + 86400000).toISOString(),
  }, keys.owner)).json();
  const bountyId = created.bounty.bountyId;
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
  await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/claim`, {}, keys.producer);
  const submit = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/1", summary: "guide v1",
  }, keys.producer);
  assert.equal(submit.status, 200);

  // Without a summary: 422 naming the field.
  const noSummary = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/request-changes`, {}, keys.owner);
  assert.equal(noSummary.status, 422);
  assert.match(JSON.stringify(await noSummary.json()), /summary/);

  // The worker cannot send their own work back.
  const selfSendBack = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/request-changes`,
    { summary: "mine" }, keys.producer);
  assert.equal(selfSendBack.status, 403);

  const returned = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/request-changes`,
    { summary: "Add a before/after example for the rename" }, keys.owner);
  assert.equal(returned.status, 200);
  const returnedBody = await returned.json();
  assert.equal(returnedBody.bounty.state, "claimed");
  assert.equal(returnedBody.bounty.changesRequested.summary, "Add a before/after example for the rename");
  assert.equal(returnedBody.bounty.reworkRounds, 1);

  const resubmit = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/2", summary: "guide v2 with examples",
  }, keys.producer);
  assert.equal(resubmit.status, 200);
  const resubmittedBody = await resubmit.json();
  assert.equal(resubmittedBody.bounty.state, "submitted");
  assert.equal(resubmittedBody.bounty.deliveries.length, 2);

  const accept = await post(origin, `/api/rooms/${ROOM}/bounties/${bountyId}/accept`, {
    verifierAttestation: { reviewerId: "owner", citations: [{ criterionId: "c1", verdict: "pass" }] },
  }, keys.owner);
  assert.equal(accept.status, 200);
  assert.equal((await accept.json()).bounty.state, "accepted");
});
