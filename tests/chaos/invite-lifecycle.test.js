// Chaos properties for the agent-invite lifecycle (server/agent-invites.mjs).
//
// P1 — random mint/redeem/revoke/expire sequences: every redeemed code links
//   exactly one member (exactly-once), every agent member traces to exactly
//   one redeemed code (no orphans), and no code is ever both redeemed and
//   revoked.
// P2 — redeem racing revoke: exactly one outcome per code, never both, never
//   two successful redeems. Deterministic interleaving matrix (single-thread
//   SQLite serializes transactions, so all orderings reduce to op order;
//   the compare-and-swap burn in redeem() is what makes exactly-one win).
//
// Permanent prevention: these run on every CI pass (smoke) and deeper with
// CHAOS_MODE=full. One-off bug-finding fuzzing is WAVE-400's lane.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { runProperty } from "./harness.mjs";

const ROOM = "commons";
// Owner-grantable permissions (PERMISSIONS minus NEVER_GRANT): the owner
// holds every bit, so any subset is a legal mint.
const GRANTABLE = ["steer", "manage_claims", "accept_work", "complete_work", "verify", "write_external"];

// --- fixture ---------------------------------------------------------------
function buildFixture(tag) {
  const dir = mkdtempSync(join(tmpdir(), `chaos-invite-${tag}-`));
  let nowMs = 1_786_000_000_000;
  const store = new RoomStore(join(dir, "room.sqlite"), { now: () => nowMs });
  store.initialize(initialRoom(ROOM));
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  return {
    store,
    ownerKey,
    tick: ms => { nowMs += ms; },
    nowMs: () => nowMs,
    codes: [], // driver-visible: { code, inviteId } minted this seed
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// --- P1: random sequences ---------------------------------------------------
const pickPermissions = rng => {
  const count = rng.int(1, 3);
  const shuffled = rng.shuffle(GRANTABLE);
  return shuffled.slice(0, count);
};

function opMint(fx, rng, seed) {
  const res = fx.store.invites.create(fx.ownerKey, ROOM, {
    permissions: pickPermissions(rng),
    expiresInMinutes: rng.int(5, 90),
    displayName: `S${seed}-Bot-${rng.int(1, 999999)}`,
  });
  fx.codes.push({ code: res.code, inviteId: res.inviteId });
  return `mint ${res.inviteId}`;
}

function opRedeem(fx, rng, seed) {
  const r = rng.float();
  let code;
  if (fx.codes.length > 0 && r < 0.7) {
    code = rng.pick(fx.codes).code; // live, redeemed, or revoked — all legal targets
  } else if (r < 0.85) {
    code = `RM-${"0".repeat(16)}`; // well-formed but never issued
  } else {
    code = rng.pick(["garbage", "RM-SHORT", "RM-!!!!!!!!!!!!!!!!", `RM-${"I".repeat(16)}`]);
  }
  const res = fx.store.invites.redeem(code, { displayName: `S${seed}-Redeemed-${rng.int(1, 999999)}` });
  return `redeem ${code.slice(0, 12)}… -> member ${res.memberId}`;
}

function opRevoke(fx, rng) {
  const inviteId = fx.codes.length > 0 && rng.bool(0.8)
    ? rng.pick(fx.codes).inviteId
    : "deadbeef"; // well-formed handle, never issued
  fx.store.invites.revoke(fx.ownerKey, ROOM, inviteId);
  return `revoke ${inviteId} -> ok`;
}

function opTick(fx, rng) {
  const minutes = rng.int(1, 240);
  fx.tick(minutes * 60_000);
  return `tick +${minutes}m`;
}

// P1 invariants, read from the database (source of truth), after every op.
function checkInviteInvariants(fx) {
  const db = fx.store.db;
  const rows = db.prepare(
    "SELECT code_hash, redeemed_at, redeemed_identity_id, revoked_at FROM agent_invite_codes"
  ).all();
  const members = fx.store.room(ROOM).state.members;

  const redeemedIdentityIds = new Set();
  for (const row of rows) {
    const handle = row.code_hash.slice(0, 8);
    // P2 at the row level: revoke only targets unredeemed rows and redeem
    // fails on revoked rows, so both timestamps can never be set.
    assert.ok(
      !(row.redeemed_at !== null && row.revoked_at !== null),
      `code ${handle}… is both redeemed and revoked`
    );
    if (row.redeemed_at === null) continue;
    // P1a: exactly-once — one redeemed row burns into exactly one member.
    assert.ok(row.redeemed_identity_id, `code ${handle}… redeemed without an identity`);
    assert.ok(!redeemedIdentityIds.has(row.redeemed_identity_id),
      `identity ${row.redeemed_identity_id} redeemed two codes`);
    redeemedIdentityIds.add(row.redeemed_identity_id);
    const links = db.prepare(
      "SELECT member_id FROM identity_links WHERE room_id = ? AND identity_id = ?"
    ).all(ROOM, row.redeemed_identity_id);
    assert.equal(links.length, 1,
      `code ${handle}… links ${links.length} members, want exactly 1`);
    const member = members[links[0].member_id];
    assert.ok(member, `code ${handle}… links unknown member ${links[0].member_id}`);
    assert.equal(member.kind, "agent", `code ${handle}… linked a non-agent member`);
    assert.notEqual(member.active, false, `code ${handle}… linked an inactive member`);
  }

  // P1b: no orphans — every active agent member traces to exactly one redeemed code.
  const agentMembers = Object.values(members).filter(m => m.kind === "agent" && m.active !== false);
  for (const member of agentMembers) {
    const link = db.prepare(
      "SELECT identity_id FROM identity_links WHERE room_id = ? AND member_id = ?"
    ).get(ROOM, member.id);
    assert.ok(link, `agent member ${member.id} has no identity link (orphan)`);
    assert.ok(redeemedIdentityIds.has(link.identity_id),
      `agent member ${member.id} has no redeemed invite code (orphan)`);
  }
  assert.equal(agentMembers.length, redeemedIdentityIds.size,
    `agent members (${agentMembers.length}) != redeemed codes (${redeemedIdentityIds.size})`);
}

test("P1: random mint/redeem/revoke/expire sequences keep the invite lifecycle exact", async () => {
  await runProperty({
    name: "invite-lifecycle",
    file: "tests/chaos/invite-lifecycle.test.js",
    defaultSeeds: { smoke: 3, full: 10 },
    defaultOps: { smoke: 12, full: 30 },
    defaultSeedBase: 0xc1a05,
    build: seed => ({ ...buildFixture(`p1-${seed}`), seed }),
    perform: (fx, rng) => {
      const op = rng.weighted([[30, "mint"], [40, "redeem"], [20, "revoke"], [10, "tick"]]);
      if (op === "mint") return opMint(fx, rng, fx.seed);
      if (op === "redeem") return opRedeem(fx, rng, fx.seed);
      if (op === "revoke") return opRevoke(fx, rng);
      return opTick(fx, rng);
    },
    checkInvariants: fx => checkInviteInvariants(fx),
    teardown: fx => fx.close(),
  });
});

// --- P2: redeem racing revoke — exactly one outcome --------------------------
// One shared fixture: codes are independent rows, so scenarios compose.
// attempt* helpers return { ok, code } instead of throwing.
function attemptRedeem(fx, code, name) {
  try {
    const res = fx.store.invites.redeem(code, { displayName: name });
    return { ok: true, code: null, memberId: res.memberId };
  } catch (error) {
    return { ok: false, code: error.code };
  }
}

function attemptRevoke(fx, inviteId) {
  try {
    fx.store.invites.revoke(fx.ownerKey, ROOM, inviteId);
    return { ok: true, code: null };
  } catch (error) {
    return { ok: false, code: error.code };
  }
}

const freshCode = fx =>
  fx.store.invites.create(fx.ownerKey, ROOM, { permissions: ["accept_work"], expiresInMinutes: 60 });

function rowState(fx, inviteId) {
  return fx.store.db.prepare(
    "SELECT redeemed_at, revoked_at, redeemed_identity_id FROM agent_invite_codes WHERE substr(code_hash, 1, 8) = ?"
  ).get(inviteId);
}

test("P2: redeem racing revoke resolves to exactly one outcome, never both", async t => {
  const fx = buildFixture("p2");
  t.after(() => fx.close());

  // redeem, redeem: exactly one wins; the loser sees the burn.
  {
    const { code, inviteId } = freshCode(fx);
    const first = attemptRedeem(fx, code, "P2 Racer A");
    const second = attemptRedeem(fx, code, "P2 Racer B");
    assert.equal(first.ok, true, "first redeem wins");
    assert.equal(second.ok, false);
    assert.equal(second.code, "invite_already_used");
    const row = rowState(fx, inviteId);
    assert.ok(row.redeemed_at !== null && row.revoked_at === null);
    assert.equal(
      fx.store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE identity_id = ?")
        .get(row.redeemed_identity_id).n,
      1, "exactly one member from the raced code"
    );
  }

  // redeem, revoke: redeem wins; revoke sees the burn.
  {
    const { code, inviteId } = freshCode(fx);
    const r = attemptRedeem(fx, code, "P2 Racer C");
    const v = attemptRevoke(fx, inviteId);
    assert.equal(r.ok, true);
    assert.equal(v.ok, false);
    assert.equal(v.code, "invite_unavailable");
    const row = rowState(fx, inviteId);
    assert.ok(row.redeemed_at !== null && row.revoked_at === null);
  }

  // revoke, redeem: revoke wins; redeem sees the revocation.
  {
    const { code, inviteId } = freshCode(fx);
    const v = attemptRevoke(fx, inviteId);
    const r = attemptRedeem(fx, code, "P2 Latecomer");
    assert.equal(v.ok, true);
    assert.equal(r.ok, false);
    assert.equal(r.code, "invite_revoked");
    const row = rowState(fx, inviteId);
    assert.ok(row.redeemed_at === null && row.revoked_at !== null);
  }

  // revoke, revoke: exactly one wins.
  {
    const { inviteId } = freshCode(fx);
    const first = attemptRevoke(fx, inviteId);
    const second = attemptRevoke(fx, inviteId);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.code, "invite_unavailable");
  }

  // redeem x5: the compare-and-swap burn lets exactly one through.
  {
    const { code, inviteId } = freshCode(fx);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(attemptRedeem(fx, code, `P2 Stampede ${i}`));
    assert.equal(results.filter(r => r.ok).length, 1, "exactly one of five redeems wins");
    for (const loser of results.filter(r => !r.ok)) assert.equal(loser.code, "invite_already_used");
    const row = rowState(fx, inviteId);
    assert.ok(row.redeemed_at !== null && row.revoked_at === null);
  }

  // Triple interleavings: [redeem, revoke, redeem] and [revoke, redeem, redeem]
  // each resolve to exactly one winner, never both, never neither.
  for (const order of [["redeem", "revoke", "redeem"], ["revoke", "redeem", "redeem"]]) {
    const { code, inviteId } = freshCode(fx);
    let redeemWins = 0;
    let revokeWins = 0;
    for (const [i, kind] of order.entries()) {
      const res = kind === "redeem" ? attemptRedeem(fx, code, `P2 Interleave ${i}`) : attemptRevoke(fx, inviteId);
      if (res.ok && kind === "redeem") redeemWins++;
      if (res.ok && kind === "revoke") revokeWins++;
    }
    assert.equal(redeemWins + revokeWins, 1,
      `order [${order}] resolved to ${redeemWins} redeem wins + ${revokeWins} revoke wins, want exactly 1`);
    const row = rowState(fx, inviteId);
    assert.ok(!(row.redeemed_at !== null && row.revoked_at !== null), "never both");
    assert.ok(row.redeemed_at !== null || row.revoked_at !== null, "never neither");
  }

  // Global P1 invariants still hold after the whole race battery.
  checkInviteInvariants(fx);
});
