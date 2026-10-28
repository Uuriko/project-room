// #3376 / #3383: room-allowance reservations are per-agent state and must
// be keyed like the authorizations they back — (room_id, agent_id, nonce).
//
// Before the fix the reservation table's PK was (room_id, nonce) and
// releaseRoomReservationRow released by (room_id, nonce) alone, so:
//  - one agent's settle/void released ANOTHER agent's allowance
//    reservation while that agent's authorization was still reserved,
//    and the room allowance could be over-committed (120 against 100);
//  - two agents presenting the same nonce with room args collided on the
//    PK and the raw node:sqlite ERR_SQLITE_ERROR escaped authorizeSpend —
//    the designed 409 duplicate_nonce conversion checked for a
//    "SQLITE_CONSTRAINT" code that node:sqlite never produces.
// W5 found both with deterministic repros (w5-harness probeXNonce and
// repro-spend-roomnonce.mjs); these tests pin the sequences.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, authorizeSpend, settleSpend,
} from "../server/spend-grants.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-res-keying-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const owner = store.identities.create("Owen");
  const created = rooms.create(owner.secret, { title: "Keying room", purpose: "x", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const agents = {};
  for (const name of ["A", "B", "C"]) {
    const identity = store.identities.create(`Agent ${name}`);
    const invite = store.invites.create(owner.secret, roomId, { profile: "collaborate", displayName: `Agent ${name}` }, null);
    const joined = store.invites.redeem(invite.code, { displayName: `Agent ${name}`, identitySecret: identity.secret });
    const memberId = joined.memberId ?? joined.member?.id;
    assert.ok(memberId, `member id missing for agent ${name}`);
    setTier(store.db, roomId, memberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
    issueSpendGrant(store.db, roomId, memberId, {
      grantedBy: ownerMemberId, capCents: "1000", perTxCapCents: "1000", nowMs: Date.now(),
    });
    agents[name] = memberId;
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, roomId, agents };
}

const ROOM_ARGS = { roomAllowanceCents: 100, roomCommittedCents: 0 };
const authorize = (f, agent, nonce, roomArgs = {}) => authorizeSpend(f.store.db, {
  roomId: f.roomId, agentId: f.agents[agent], toolName: "room_put_file", priceCents: 60, nonce, nowMs: Date.now(), ...roomArgs,
});
const roomRow = (f, agent, nonce) => f.store.db.prepare(
  "SELECT status FROM spend_room_reservations WHERE room_id = ? AND agent_id = ? AND nonce = ?")
  .get(f.roomId, f.agents[agent], nonce);
const activeRoomSum = f => f.store.db.prepare(
  "SELECT COALESCE(SUM(CAST(amount_cents AS INTEGER)), 0) AS total FROM spend_room_reservations WHERE room_id = ? AND status = 'active'")
  .get(f.roomId).total;

test("#3376: one agent's settle never releases another agent's room reservation", async t => {
  const f = fixture(t);
  authorize(f, "B", "X");                    // B: no room args → no room row
  authorize(f, "A", "X", ROOM_ARGS);         // A: room row (room, A, "X", 60, active)
  assert.equal(roomRow(f, "A", "X").status, "active");
  assert.equal(settleSpend(f.store.db, { roomId: f.roomId, agentId: f.agents.B, nonce: "X" }), true,
    "B settles its own authorization");
  assert.equal(roomRow(f, "A", "X").status, "active",
    "A's reservation survives B's settle — it backs A's still-reserved authorization");
  // The allowance backstop holds: A (60) + C (60) = 120 > 100, so C is refused.
  assert.throws(() => authorize(f, "C", "Y", ROOM_ARGS),
    error => error?.code === "payment_required" || /room_allowance/.test(String(error?.message ?? "") || ""),
    "C's authorize is refused: the room allowance is already committed to A");
  assert.equal(activeRoomSum(f), 60, "only A's live reservation counts against the allowance");
  // A's own settle releases exactly A's row.
  assert.equal(settleSpend(f.store.db, { roomId: f.roomId, agentId: f.agents.A, nonce: "X" }), true);
  assert.equal(roomRow(f, "A", "X").status, "released");
});

test("#3376: one agent's void never releases another agent's room reservation", async t => {
  const f = fixture(t);
  const bHandle = authorize(f, "B", "X");
  authorize(f, "A", "X", ROOM_ARGS);
  assert.equal(bHandle.void(), true, "B voids its own authorization");
  assert.equal(roomRow(f, "A", "X").status, "active", "A's reservation survives B's void");
});

test("#3383: two agents presenting the same nonce with room args both authorize — no raw sqlite error", async t => {
  const f = fixture(t);
  const wide = { roomAllowanceCents: 1000, roomCommittedCents: 0 };
  const a = authorize(f, "A", "SHARED", wide);
  assert.ok(a && typeof a.settle === "function", "A authorized");
  const b = authorize(f, "B", "SHARED", wide);
  assert.ok(b && typeof b.settle === "function",
    "B authorized with its own reservation row (previously a raw ERR_SQLITE_ERROR escaped here)");
  assert.equal(roomRow(f, "A", "SHARED").status, "active");
  assert.equal(roomRow(f, "B", "SHARED").status, "active");
  assert.equal(activeRoomSum(f), 120, "both agents' reservations coexist and both count against the room allowance");
});

test("schema migration: an existing (room_id, nonce)-keyed table converges with its rows intact", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-res-migrate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  // Build the pre-fix table shape by hand, with one live row (the store
  // has already ensured the current shape — drop it to simulate an old DB).
  store.db.exec(`DROP TABLE spend_room_reservations;
  CREATE TABLE spend_room_reservations (
    room_id TEXT NOT NULL, agent_id TEXT NOT NULL, nonce TEXT NOT NULL,
    amount_cents TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL, PRIMARY KEY (room_id, nonce));`);
  store.db.prepare(`INSERT INTO spend_room_reservations (room_id, agent_id, nonce, amount_cents, status, created_at)
    VALUES ('commons', 'agent-a', 'N1', '60', 'active', 123)`)
    .run();
  ensureSpendGrantsSchema(store.db);
  const sql = store.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spend_room_reservations'").get().sql;
  assert.match(sql, /PRIMARY KEY \(room_id, agent_id, nonce\)/, "the PK is widened");
  const row = store.db.prepare(
    "SELECT agent_id, amount_cents, status FROM spend_room_reservations WHERE room_id = 'commons' AND nonce = 'N1'").get();
  assert.deepEqual({ ...row }, { agent_id: "agent-a", amount_cents: "60", status: "active" }, "existing rows survive the rebuild");
  // Idempotent: a second ensure changes nothing and does not throw.
  ensureSpendGrantsSchema(store.db);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM spend_room_reservations").get().n, 1);
});
