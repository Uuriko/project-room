// PRODUCT-200 RELIABILITY worker A6/50 — INVARIANT: "FAILED ACTIONS PRESERVE DATA"
// Slice: invite redeem. server/agent-invites.mjs redeem().
//
// Scenario (a): a redeem that FAILS midway must leave the invite redeemable.
// redeem() runs the whole join (identity mint, member.added event, room
// projection write, identity link, compare-and-swap burn, referral journal,
// onboarding MCP token) inside one store.transaction — any throw rolls
// everything back. These tests lock that atomicity in at the HTTP layer:
//   - a1: a failure at the LAST in-transaction step (onboarding MCP token
//     issuance, which runs after the CAS burn) still rolls the burn back —
//     the invite stays redeemable and the retry succeeds;
//   - a2: a pre-write validation failure (oversized displayName) burns nothing.
//
// Scenario (b) is G1-adjacent: redeem COMMITS but the response is lost.
//   - b1: a redeemer who arrived with an existing identity secret retries
//     idempotently (201, duplicate:true) — covered, passing.
//   - b2: a redeemer who minted a FRESH identity (no secret to present on
//     retry) gets a dead 409 invite_already_used with no recovery path —
//     the membership is stranded. This test is INTENTIONALLY RED: it
//     documents the desired invariant (idempotent completion OR a recovery
//     path) as a fail-first anchor. The fix belongs to the idempotency /
//     G1 lane (e.g. client-supplied Idempotency-Key replay of the redeem
//     response, or an owner-assisted recovery of the stranded identity).
//     DO NOT MERGE this PR until the fix lane turns b2 green.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const slowHash = code => scryptSync(code, "project-room-agent-invite-v2", 32, { N: 16384, r: 8, p: 1 }).toString("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-atomicity-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function post(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const mint = (origin, ownerKey, body) => post(origin, "/api/rooms/commons/agent-invites", body, ownerKey);
const redeem = (origin, code, displayName = "Atomic Bot", token) =>
  post(origin, "/api/agent-invites/redeem", { code, displayName }, token);
const mintIdentity = (origin, displayName) => post(origin, "/api/agent-identities", { displayName });

// Observable write surface of a redeem: everything that must roll back together.
const snapshot = store => ({
  events: store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id='commons'").get().n,
  sequence: store.db.prepare("SELECT sequence AS s FROM rooms WHERE id='commons'").get().s,
  links: store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id='commons'").get().n,
  identities: store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n,
});
const inviteRow = (store, code) =>
  store.db.prepare("SELECT redeemed_at, redeemed_identity_id FROM agent_invite_codes WHERE code_hash=?").get(slowHash(code));

test("(a1) a redeem that fails at the last in-transaction step leaves the invite redeemable", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const code = minted.json.code;
  const before = snapshot(store);

  // Sabotage the LAST write inside redeem's transaction: the onboarding MCP
  // token is issued after the compare-and-swap burn. If the transaction is
  // not atomic, the burn would survive the failure and the invite would be
  // consumed by a failed redeem.
  const plugin = store.agentPlugin;
  const original = plugin.issueOnboardingMcpToken;
  plugin.issueOnboardingMcpToken = () => { throw new Error("simulated onboarding-token outage"); };
  let failed;
  try {
    failed = await redeem(origin, code, "Late Failure Bot");
  } finally {
    plugin.issueOnboardingMcpToken = original;
  }
  assert.notEqual(failed.status, 201, `failed redeem must not claim success: ${JSON.stringify(failed.json)}`);
  assert.equal(failed.status, 500, JSON.stringify(failed.json));

  // The whole join rolled back: invite unburned, no event, no link, no identity.
  const row = inviteRow(store, code);
  assert.equal(row.redeemed_at, null, "burn must roll back when a late step fails");
  assert.equal(row.redeemed_identity_id, null);
  assert.deepEqual(snapshot(store), before, "no partial writes may survive a failed redeem");

  // The invite is still live: a clean retry completes the join.
  const retry = await redeem(origin, code, "Late Failure Bot");
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.ok(retry.json.memberId, "retry mints the membership");
  assert.equal(retry.json.duplicate, undefined, "fresh redeem is not flagged duplicate");
  const burned = inviteRow(store, code);
  assert.ok(burned.redeemed_at != null, "successful retry burns the invite");
  assert.equal(burned.redeemed_identity_id, retry.json.identityId);
  const after = snapshot(store);
  // redeem reserves two event slots: member.added plus the referral.completed
  // journal event, both written in the same transaction (agent-invites.mjs).
  assert.equal(after.events, before.events + 2, "member.added + referral.completed journal events land");
  assert.equal(after.links, before.links + 1, "exactly one identity link lands");
});

test("(a2) a pre-write validation failure burns nothing and stays retryable", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal(minted.status, 201);
  const code = minted.json.code;
  const before = snapshot(store);

  // 81-char displayName is rejected by validation before any row is written.
  const bad = await redeem(origin, code, "x".repeat(81));
  assert.equal(bad.status, 422, JSON.stringify(bad.json));
  assert.equal(bad.json.error.code, "invalid_invite_name");
  assert.equal(inviteRow(store, code).redeemed_at, null, "validation failure must not burn the invite");
  assert.deepEqual(snapshot(store), before);

  // And a well-formed retry still succeeds.
  const retry = await redeem(origin, code, "Retry Bot");
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
});

test("(b1) lost-response retry with the redeemer identity secret is idempotent", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const created = await mintIdentity(origin, "Idempotent Agent");
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const secret = created.json.secret;
  assert.ok(secret, "identity create returns the bearer secret");

  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal(minted.status, 201);
  const first = await redeem(origin, minted.json.code, "Idempotent Agent", secret);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.duplicate, false);

  // The response was "lost": retry with the same code and the same secret.
  const retry = await redeem(origin, minted.json.code, "Idempotent Agent", secret);
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.equal(retry.json.duplicate, true, "retry is flagged as the duplicate of the original redeem");
  assert.equal(retry.json.identityId, first.json.identityId, "retry resolves to the same identity");
  assert.equal(retry.json.memberId, first.json.memberId, "retry resolves to the same membership");
  const members = store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id='commons' AND identity_id=?")
    .get(first.json.identityId).n;
  assert.equal(members, 1, "no duplicate membership is created");
});

// INTENTIONALLY RED — fail-first anchor for the G1 recovery gap.
// A fresh-identity redeemer whose response is lost has no credential to
// present on retry, so today they get a dead 409 invite_already_used while
// their membership sits stranded. The invariant: the retry must either
// complete idempotently or return a recovery path — never a bare dead end.
// Fix lane: client-supplied Idempotency-Key replay of the redeem response,
// or an owner-assisted recovery for the stranded identity.
test("(b2) lost-response retry for a fresh identity returns a recovery path, not a dead 409", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal(minted.status, 201);
  const code = minted.json.code;

  // Fresh redeem (no bearer secret): the response carries the only credential.
  const first = await redeem(origin, code, "Stranded Agent");
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const identityId = first.json.identityId;

  // The response is lost. The redeemer retries with the code alone.
  const retry = await redeem(origin, code, "Stranded Agent");

  // Evidence for the fix lane: the join really did commit — membership and
  // identity rows are stranded with no way back for the redeemer.
  const stranded = store.db.prepare("SELECT member_id FROM identity_links WHERE room_id='commons' AND identity_id=?")
    .get(identityId);
  assert.ok(stranded, "the committed membership is stranded server-side");
  assert.ok(store.room("commons").state.members[stranded.member_id]?.active, "stranded member is active");

  const idempotent = retry.status >= 200 && retry.status < 300;
  const recovery = retry.json && (retry.json.recovery != null || retry.json?.error?.recovery != null);
  assert.ok(idempotent || recovery,
    `G1: lost-response retry must complete idempotently or return a recovery path; ` +
    `got ${retry.status} ${JSON.stringify(retry.json && retry.json.error)} — membership ${stranded.member_id} stranded`);
});
