// MCP posting-path surface for bounty pricing guidance (#5160, successor
// to #4017): bounty_list and bounty_post results carry the room's
// pricingGuidance (settled receipts only) plus its poster-facing text, at
// post time, and a guidance failure never blocks posting.
//
// The derivation itself is covered by tests/bounty-pricing-guidance.test.js
// (pure computation + escrow lifecycle room scoping). These tests drive the
// real hosted dispatch (callHostedStdioTool) against a real RoomStore.

import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { issueSpendGrant } from "../server/spend-grants.mjs";

const ROOM = "commons";
const AGENT = "agent";

function fixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey(ROOM, "owner") };
  const send = (actor, command) => store.command(keys[actor], ROOM, command);
  send("owner", { id: "add-agent", type: "member.added",
    data: { memberId: AGENT, displayName: AGENT, kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  keys[AGENT] = store.issueAccessKey(ROOM, AGENT);
  setTier(store.db, ROOM, AGENT, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  issueSpendGrant(store.db, ROOM, AGENT, { grantedBy: "owner", capCents: "100000", perTxCapCents: "10000", nowMs: Date.now() });
  store.bountyEscrow.ensureGenesis(ROOM);
  return { store, keys };
}

const call = (store, keys, name, args) =>
  callHostedStdioTool(store, keys[AGENT], name, { roomId: ROOM, ...args });

const postArgs = (overrides = {}) => ({
  title: "Test bounty", criteria: "Done means done.", amount: 10,
  deadline: new Date(Date.now() + 3_600_000).toISOString(), ...overrides });

test("bounty_list carries cold-start pricingGuidance with plain no-history wording (#5160)", async t => {
  const { store, keys } = fixture(t);
  const listed = await call(store, keys, "bounty_list", {});
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.value.bounties, []);
  assert.equal(listed.value.pricingGuidance.state, "no-settled-history");
  assert.equal(listed.value.pricingGuidance.sampleCount, 0);
  assert.equal(listed.value.pricingGuidance.paidRangeCredits, null);
  assert.equal(listed.value.pricingGuidanceText,
    "No settled bounties in this room yet, so there is no settled receipt history to base a typical paid range on.");
});

test("bounty_post succeeds and its result carries the room's pricingGuidance at post time (#5160)", async t => {
  const { store, keys } = fixture(t);
  const posted = await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "guidance-post" }));
  assert.equal(posted.isError, false);
  assert.ok(posted.value.bounty.bountyId, "posting itself worked");
  assert.equal(posted.value.pricingGuidance.state, "no-settled-history");
  assert.match(posted.value.pricingGuidanceText, /No settled bounties in this room yet/);
  // The just-posted (unsettled) bounty must not move the guidance numbers.
  const listed = await call(store, keys, "bounty_list", {});
  assert.equal(listed.value.pricingGuidance.sampleCount, 0);
  assert.equal(listed.value.pricingGuidance.paidRangeCredits, null);
});

test("guidance failure never blocks posting: a broken escrow.pricingGuidance still posts (#5160)", async t => {
  const { store, keys } = fixture(t);
  const original = store.bountyEscrow.pricingGuidance;
  store.bountyEscrow.pricingGuidance = () => { throw new Error("guidance boom"); };
  t.after(() => { store.bountyEscrow.pricingGuidance = original; });
  const posted = await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "guidance-fail-post" }));
  assert.equal(posted.isError, false);
  assert.ok(posted.value.bounty.bountyId, "posting proceeded exactly as before guidance existed");
  assert.equal(posted.value.pricingGuidance, null);
  assert.equal(posted.value.pricingGuidanceText, null);
  const listed = await call(store, keys, "bounty_list", {});
  assert.equal(listed.isError, false);
  assert.equal(listed.value.bounties.length, 1);
  assert.equal(listed.value.pricingGuidance, null);
});
