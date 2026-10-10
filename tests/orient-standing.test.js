// orient standing block (lane9, guest->member ladder): the orient payload's
// `you` section must answer "where do I stand and what's next" —
// membership class, guest/autonomy tier, reputation bands, and concrete
// next rungs. Tests run against a real RoomStore.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { buildOrient } from "../server/orient.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

const ROOM = "orient-standing-demo";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-standing-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Standing Demo",
        purpose: "Fixture room for the orient standing block.", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Room owner", kind: "human",
        permissions: [...PERMISSIONS] } })
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.command(ownerKey, ROOM, { id: "st-add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Standing Worker", kind: "agent",
    permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" } });
  const workerKey = store.issueAccessKey(ROOM, "worker");
  // A guest-agent member (no guest_members row -> defaults to observer).
  store.command(ownerKey, ROOM, { id: "st-add-guest", type: T.MEMBER_ADDED, data: {
    memberId: "guest-agent-xyz9", displayName: "Guest Nine (guest)", kind: "agent",
    permissions: [], accountableHumanId: "owner" } });
  const guestKey = store.issueAccessKey(ROOM, "guest-agent-xyz9");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, workerKey, guestKey };
}

const standingOf = (store, viewerId) => buildOrient(store, ROOM, viewerId).you.standing;

test("member sees class, tier and empty-but-legible reputation", t => {
  const f = fixture(t);
  const s = standingOf(f.store, "worker");
  assert.equal(s.class, "member");
  assert.equal(s.guestTier, null);
  assert.equal(s.autonomyTier, "t2_standard");
  assert.ok(s.reputation);
  assert.equal(s.reputation.bounty.band, "standard");
  assert.equal(s.reputation.bounty.score, 0);
  assert.equal(s.reputation.claims.band, "standard");
  assert.equal(s.reputation.claims.score, 0);
  assert.equal(s.reputation.claims.openClaims, 0);
  assert.equal(s.reputation.claims.atCap, false);
  // The trusted rung is named with its criteria, not just "keep going".
  const trusted = s.nextRungs.find(r => r.rung === "trusted");
  assert.ok(trusted, "expected a trusted rung hint: " + JSON.stringify(s.nextRungs));
  assert.match(trusted.how, /40/);
});

test("guest sees observer tier and the upgrade + member rungs", t => {
  const f = fixture(t);
  const s = standingOf(f.store, "guest-agent-xyz9");
  assert.equal(s.class, "guest");
  assert.equal(s.guestTier, "observer");
  const contributor = s.nextRungs.find(r => r.rung === "contributor");
  assert.ok(contributor, "guest needs the contributor rung");
  assert.match(contributor.how, /guest-invites-upgrade/);
  const member = s.nextRungs.find(r => r.rung === "member");
  assert.ok(member, "guest needs the member rung");
  assert.match(member.how, /agent-identit/i);
});

test("t1_readonly member is told plainly and given the restore path", t => {
  const f = fixture(t);
  setTier(f.store.db, ROOM, "worker", "t1_readonly", { updatedBy: "owner" });
  const s = standingOf(f.store, "worker");
  assert.equal(s.autonomyTier, "t1_readonly");
  const restore = s.nextRungs.find(r => r.rung === "t2_standard");
  assert.ok(restore, "expected the restore rung");
  assert.match(restore.how, /operator\/agents/);
});

test("claim reputation accrues visibly: completions up, flakes down", t => {
  const f = fixture(t);
  const insert = f.store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
  let seq = 1000;
  const put = (id, data) => insert.run(ROOM, seq++, id,
    JSON.stringify({ id, roomId: ROOM, type: "work_claim.updated", at: new Date().toISOString(), data }));
  // One clean completion: +3.
  put("wcu-1", { workClaim: "c-done", action: "claimed", ownerId: "worker" });
  put("wcu-2", { workClaim: "c-done", action: "state_changed", claimState: "done", ownerId: "worker" });
  // Four flakes: -24 -> probation band.
  for (let i = 0; i < 4; i++) {
    put(`wcu-f${i}a`, { workClaim: `c-flake-${i}`, action: "claimed", ownerId: "worker" });
    put(`wcu-f${i}b`, { workClaim: `c-flake-${i}`, action: "lease_expired", previousOwnerId: "worker" });
  }
  const s = standingOf(f.store, "worker");
  assert.equal(s.reputation.claims.score, 3 - 24);
  assert.equal(s.reputation.claims.band, "probation");
  const rebuild = s.nextRungs.find(r => /rebuild/i.test(r.action));
  assert.ok(rebuild, "probation must name the way back: " + JSON.stringify(s.nextRungs));
  assert.match(rebuild.how, /\+3/);
});

test("hoarding cap is legible before it bites", t => {
  const f = fixture(t);
  const insert = f.store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
  let seq = 2000;
  for (let i = 0; i < 6; i++) {
    insert.run(ROOM, seq++, `wcu-h${i}`,
      JSON.stringify({ id: `wcu-h${i}`, roomId: ROOM, type: "work_claim.updated",
        at: new Date().toISOString(), data: { workClaim: `c-open-${i}`, action: "claimed", ownerId: "worker" } }));
  }
  const s = standingOf(f.store, "worker");
  assert.equal(s.reputation.claims.openClaims, 6);
  assert.equal(s.reputation.claims.atCap, true);
  const cap = s.nextRungs.find(r => /capacity/i.test(r.action));
  assert.ok(cap, "at-cap must name the surcharge threshold: " + JSON.stringify(s.nextRungs));
  assert.match(cap.how, /5/);
});

test("standing degrades to nulls, never 500s, when reputation stores are absent", t => {
  const f = fixture(t);
  // Simulate a store without the bounty escrow or guest helpers.
  const bare = { db: f.store.db, room: id => f.store.room(id), now: () => f.store.now() };
  const s = buildOrient(bare, ROOM, "worker").you.standing;
  assert.equal(s.class, "member");
  assert.equal(s.reputation.bounty, null);
  assert.ok(Array.isArray(s.nextRungs));
});
