import assert from "node:assert/strict";
import test from "node:test";
import { privateWorkFixture } from "./helpers/private-work-fixture.mjs";

function seedReady(f, id = "solo") {
  const now = typeof f.store.now === "function" ? f.store.now() : Date.now();
  f.store.workClaims.set("commons", {
    id, title: "Solo ready work", state: "unclaimed", kind: "work", owner: null,
    history: [], dependsOn: [], tags: [], updatedAt: new Date(now - 30 * 60 * 1000).toISOString()
  });
}

async function advertisedClaim(origin, who, action) {
  const response = await fetch(`${origin}${action.endpoint}`, {
    method: action.method,
    headers: {
      authorization: `Bearer ${who.secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(action.params)
  });
  return { status: response.status, value: await response.json() };
}

test("two eligible readers posting the advertised pickup claim get one 200 and one 409, and the loser re-reads dry", async t => {
  const f = await privateWorkFixture(t, "legacy");
  seedReady(f);
  const firstOffer = await f.mcp(f.observer, "room_next", { view: "pickup" });
  const secondOffer = await f.mcp(f.broad, "room_next", { view: "pickup" });
  assert.equal(firstOffer.value.ifIdle.status, "ready_work");
  assert.equal(secondOffer.value.ifIdle.status, "ready_work");
  assert.equal(firstOffer.value.ifIdle.claimId, "solo");
  assert.deepEqual(firstOffer.value.ifIdle.claimAction.params, { leaseHours: 2 });
  assert.deepEqual(Object.keys(firstOffer.value.ifIdle.claimAction.params).sort(), ["leaseHours"]);
  assert.deepEqual(firstOffer.value.ifIdle.claimAction, secondOffer.value.ifIdle.claimAction);

  const first = await advertisedClaim(f.origin, f.observer, firstOffer.value.ifIdle.claimAction);
  const second = await advertisedClaim(f.origin, f.broad, secondOffer.value.ifIdle.claimAction);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const winner = first.status === 200 ? first : second;
  const loserCall = first.status === 409 ? first : second;
  const loser = first.status === 409 ? f.observer : f.broad;
  assert.equal(winner.value.id, "solo");
  assert.equal(loserCall.value.error?.code ?? loserCall.value.error, "work_claim_conflict");

  const again = await f.mcp(loser, "room_next", { view: "pickup" });
  assert.equal(again.ok, true, again.text);
  assert.equal(again.value.ifIdle.status, "dry");
  assert.equal(again.value.ifIdle.readyCount, 0);
  assert.equal(again.value.ifIdle.claimAction, undefined);
});

test("an ineligible reader is not offered a claim they would be refused", async t => {
  const f = await privateWorkFixture(t, "legacy");
  seedReady(f);
  const eligible = await f.mcp(f.observer, "room_next", { view: "pickup" });
  assert.equal(eligible.value.ifIdle.status, "ready_work");
  assert.equal(eligible.value.ifIdle.claimId, "solo");
  const ineligible = await f.mcp(f.triage, "room_next", { view: "pickup" });
  assert.equal(ineligible.ok, true, ineligible.text);
  assert.notEqual(ineligible.value.ifIdle?.status, "ready_work");
  assert.equal(ineligible.value.ifIdle?.claimAction, undefined);
  assert.equal(ineligible.value.ifIdle?.claimId, undefined);
  // They still see an honest idle status, just not a claim they cannot take.
  assert.equal(ineligible.value.ifIdle.status, "dry");
});

test("a Board read failure is not reported as dry", async t => {
  const f = await privateWorkFixture(t, "legacy");
  seedReady(f);
  const list = f.store.workClaims.list.bind(f.store.workClaims);
  f.store.workClaims.list = () => { throw new Error("injected board failure"); };
  t.after(() => { f.store.workClaims.list = list; });
  const pickup = await f.mcp(f.observer, "room_next", { view: "pickup" });
  assert.equal(pickup.ok, true, pickup.text);
  assert.notEqual(pickup.value.ifIdle?.status, "dry");
  assert.equal(pickup.value.ifIdle.status, "unavailable");
  assert.equal(pickup.value.ifIdle.reason, "board_unavailable");
  assert.equal(pickup.value.ifIdle.claimAction, undefined);
});
