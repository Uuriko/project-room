// EA-011: invite-redemption identities are created outside the mint pool.
//
// Authoring gate:
// 1. An agent-invite redemption that creates a new identity must (a) record
//    a non-null mint provenance on the identity row, (b) count toward the
//    GLOBAL daily mint budget (200/day by default), so the counted path and
//    later redemptions see the spend, and (c) be refused, with the same
//    refusal shape the counted path uses for its global tier (429,
//    rate_limited, "Identity mint daily budget reached", Retry-After header
//    plus retryAfterSeconds/mintBudget detail naming scope "global"), once
//    that budget is exhausted.
// 2. Redemption must NOT gain per-address or per-network metering and must
//    not require proof-of-work: legitimate owner issuance stays unmetered
//    per-address, so several redemptions in a row succeed even with the
//    address/network/minute tiers set to 1, and each redemption's
//    provenance is its own (no shared address bucket).
// 3. Plain in-process mints (no anonymous argument, no redemption) stay
//    uncounted with mint_address NULL, exactly as before.
// 4. Limits are the constructor options production uses, swapped onto the
//    store so the real AgentInvites.redeem path exercises them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentIdentities } from "../server/agent-identities.mjs";

function openStore(t, budgets = {}) {
  const directory = mkdtempSync(join(tmpdir(), "invite-redemption-mint-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  // AgentInvites.redeem reaches identities through the store, so swapping
  // the instance puts the real redemption path under small test budgets.
  store.identities = new AgentIdentities(store, {
    anonymousDailyLimit: 30,
    addressDailyLimit: 30,
    networkDailyLimit: 30,
    addressMinuteLimit: 30,
    proofFreePerAddress: 30,
    capacityAlert: () => {},
    ...budgets,
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const ownerKey = store => store.issueAccessKey("commons", "owner");
const redeemOne = (store, key, name) => {
  const minted = store.invites.create(key, "commons", { permissions: ["accept_work"] });
  return store.invites.redeem(minted.code, { displayName: name });
};
const rowOf = (store, identityId) => store.db.prepare(
  "SELECT mint_address AS mintAddress, mint_network AS mintNetwork FROM agent_identities WHERE identity_id=?"
).get(identityId);
const identityCount = store => store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
const globalCounted = store => store.db.prepare(
  "SELECT count(*) AS n FROM agent_identities WHERE mint_address IS NOT NULL"
).get().n;

function refusal(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail("expected a refusal");
}

test("EA-011: invite redemption records mint provenance and spends the global mint budget", t => {
  const store = openStore(t, { anonymousDailyLimit: 2 });
  const key = ownerKey(store);
  assert.equal(globalCounted(store), 0);

  const first = redeemOne(store, key, "Redeemed One");
  const firstRow = rowOf(store, first.identityId);
  assert.ok(firstRow, "redemption created an identity row");
  assert.notEqual(firstRow.mintAddress, null,
    "redemption-created identity must record a non-null mint provenance (EA-011: was NULL)");
  assert.equal(globalCounted(store), 1,
    "one redemption must move the global counted-mint counter by one (EA-011: moved none)");

  const second = redeemOne(store, key, "Redeemed Two");
  assert.notEqual(rowOf(store, second.identityId).mintAddress, null);
  assert.equal(globalCounted(store), 2);

  // The two redemptions spent the whole global budget: the counted
  // (anonymous) path now refuses at its global tier.
  const over = refusal(() => store.identities.create("Anon Over", {
    anonymous: { address: "198.51.100.7" },
  }));
  assert.equal(over.status, 429);
  assert.match(over.message, /daily budget/);
  assert.equal(over.detail.mintBudget.scope, "global");
  assert.equal(identityCount(store), 2, "a refused mint writes no row");
});

test("EA-011: invite redemption is refused when the global mint budget is exhausted, in the counted path's shape", t => {
  const store = openStore(t, { anonymousDailyLimit: 1 });
  const key = ownerKey(store);
  // Fill the global budget through the counted path.
  store.identities.create("Anon One", { anonymous: { address: "198.51.100.8" } });
  assert.equal(globalCounted(store), 1);
  const before = identityCount(store);

  const minted = store.invites.create(key, "commons", { permissions: ["accept_work"] });
  const over = refusal(() => store.invites.redeem(minted.code, { displayName: "Redeemed Over" }));
  assert.equal(over.status, 429, "redemption past the global budget must be refused with 429");
  assert.equal(over.code, "rate_limited");
  assert.equal(over.message, "Identity mint daily budget reached");
  assert.equal(over.detail.mintBudget.scope, "global");
  assert.equal(over.detail.mintBudget.limit, 1);
  assert.equal(over.detail.mintBudget.windowMs, 24 * 60 * 60 * 1000);
  assert.ok(Number.isInteger(over.detail.retryAfterSeconds) && over.detail.retryAfterSeconds >= 1);
  assert.equal(over.headers["Retry-After"], String(over.detail.retryAfterSeconds));
  assert.equal(identityCount(store), before, "a refused redemption writes no identity row");
  const codeRow = store.db.prepare(
    "SELECT redeemed_at AS redeemedAt FROM agent_invite_codes"
  ).get();
  assert.equal(codeRow.redeemedAt, null, "a refused redemption does not burn the invite code");
});

test("EA-011: redemption is not metered per-address or per-network and needs no proof", t => {
  // Every per-address/per-network/minute tier trips after a single counted
  // mint from one bucket; redemptions carry no address, so none may trip.
  const store = openStore(t, {
    anonymousDailyLimit: 10,
    addressDailyLimit: 1,
    networkDailyLimit: 1,
    addressMinuteLimit: 1,
    proofFreePerAddress: 0,
  });
  const key = ownerKey(store);
  const names = ["Redeemed A", "Redeemed B", "Redeemed C"];
  const redeemed = names.map(name => redeemOne(store, key, name));
  assert.equal(identityCount(store), 3);
  const provenances = redeemed.map(row => rowOf(store, row.identityId).mintAddress);
  assert.ok(provenances.every(value => typeof value === "string" && value.length > 0),
    "every redemption records a non-null mint provenance");
  assert.equal(new Set(provenances).size, 3,
    "provenance is per-redemption, not one shared address bucket that would meter later mints per-address");
});

test("EA-011: plain in-process mints stay uncounted (redemption-only change)", t => {
  const store = openStore(t, { anonymousDailyLimit: 1 });
  const internal = store.identities.create("Internal");
  assert.equal(rowOf(store, internal.identityId).mintAddress, null);
  assert.equal(globalCounted(store), 0);
});
