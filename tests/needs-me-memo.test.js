// NM (PERF-50 E2-b): needs-me memoisation characterisation.
//
// collectNeedsMe is the prescribed polling read. These tests pin, over a
// scripted stream, that (a) a repeat call with unchanged inputs returns
// JSON-byte-identical output without recomputing the claim board, and
// (b) every mutation channel the read consumes — room events, direct
// work-claim registry writes (CI / review / claim, which append NO room
// event), land-queue writes, bond proposals, wake pauses, and pure clock
// advances across modelled time flips — is reflected by the next call.
// A memo that serves a stale attention item is a correctness defect, so
// (b) is the load-bearing half.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { createWork, claimWork, recordReview, recordCi } from "../server/work-claims.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const T0 = Date.parse("2026-10-05T00:00:00Z");
const WRITER = ["steer", "accept_work", "complete_work", "verify"];
const json = value => JSON.stringify(value);

function setup(t) {
  const clock = { t: T0 };
  const store = new RoomStore(":memory:", { now: () => clock.t });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create("Ada");
  const bob = store.identities.create("Bob");
  const owners = {};
  for (const roomId of ["alpha", "beta"]) {
    const owner = store.identities.create(`Owen ${roomId}`);
    owners[roomId] = owner;
    rooms.create(owner.secret, { roomId, title: roomId, purpose: "memo", kind: "personal" });
    linkWithProof(store, owner.secret, roomId, ada, { displayName: "Ada", permissions: WRITER });
    linkWithProof(store, owner.secret, roomId, bob, { displayName: "Bob", permissions: WRITER });
  }
  const memberOf = (identity, roomId) => store.db.prepare(
    "SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?"
  ).get(identity.identityId, roomId).m;
  const adaAlpha = memberOf(ada, "alpha");
  const bobAlpha = memberOf(bob, "alpha");
  // Instrument the claim board: a memo hit must not re-list it.
  let listCalls = 0;
  const rawList = store.workClaims.list.bind(store.workClaims);
  store.workClaims.list = roomId => { listCalls += 1; return rawList(roomId); };
  const call = (secret = ada.secret, opts = {}) => collectNeedsMe(store, secret, opts);
  // A repeat call must be byte-identical to the call just before it and
  // must not recompute the board.
  const repeatIsStable = (opts = {}) => {
    const first = call(ada.secret, opts);
    const before = listCalls;
    const second = call(ada.secret, opts);
    assert.equal(json(second), json(first), "repeat call is byte-identical");
    assert.equal(listCalls, before, "repeat call does not re-list the claim board");
    return second;
  };
  const putClaim = (id, ownerMember, roomId = "alpha") => {
    let item = { ...createWork({ id, title: `Task ${id}` }, { now: clock.t, agentId: "owner" }) };
    if (ownerMember) item = claimWork(item, ownerMember, { now: clock.t });
    store.workClaims.set(roomId, item);
    return item;
  };
  return { store, clock, ada, bob, owners, adaAlpha, bobAlpha, call, repeatIsStable, putClaim,
    listCalls: () => listCalls };
}

test("memo: repeats are byte-identical, board-free, and scoped per identity/cursor", t => {
  const { store, ada, bob, call, repeatIsStable } = setup(t);
  store.command(bob.secret, "alpha", { id: "m1", type: "message.posted",
    data: { messageId: "m1", body: "@Ada first" } });
  const page = repeatIsStable();
  assert.ok(page.items.some(item => item.kind === "mention"), "fixture mention is present");
  // A different identity never shares Ada's entry.
  const bobPage = call(bob.secret, {});
  assert.notEqual(json(bobPage), json(page));
  repeatIsStable();
  // A different cursor never shares the no-cursor entry.
  const caught = call(ada.secret, { since: page.cursor });
  assert.deepEqual(caught.items, []);
  const before = json(caught);
  assert.equal(json(call(ada.secret, { since: page.cursor })), before);
  // Errors are not memoised: they throw on every call.
  assert.throws(() => call("no-such-secret", {}), error => error.code === "unauthenticated");
  assert.throws(() => call("no-such-secret", {}), error => error.code === "unauthenticated");
  assert.throws(() => call(ada.secret, { since: "junk{" }), error => error.code === "invalid_cursor");
  assert.throws(() => call(ada.secret, { since: "junk{" }), error => error.code === "invalid_cursor");
});

test("memo: every mutation channel invalidates — events, registry-only writes, land, bonds, pause", t => {
  const { store, clock, ada, bob, adaAlpha, bobAlpha, repeatIsStable, putClaim } = setup(t);
  const seqOf = roomId => store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;

  // 1. Room event: a mention appears.
  let page = repeatIsStable();
  assert.deepEqual(page.items, []);
  store.command(bob.secret, "alpha", { id: "m1", type: "message.posted",
    data: { messageId: "m1", body: "@Ada please review" } });
  page = repeatIsStable();
  assert.ok(page.items.some(item => item.kind === "mention" && item.id === "m1"), "mention lands");

  // 2. Registry-only write (NO room event): Ada claims work.
  const seqBefore = seqOf("alpha");
  putClaim("job-1", adaAlpha);
  assert.equal(seqOf("alpha"), seqBefore, "fixture: claim write appends no room event");
  page = repeatIsStable();
  assert.ok(page.myClaims?.[0].top.some(row => row.id === "job-1"), "myClaims reflects a registry-only claim");

  // 3. Registry-only CI record: the failure becomes an action.
  let item = store.workClaims.list("alpha").find(row => row.id === "job-1");
  store.workClaims.set("alpha", recordCi(item, { state: "failure", headSha: "a".repeat(40), url: "https://ci.example/1" }, clock.t).item);
  assert.equal(seqOf("alpha"), seqBefore, "fixture: CI record appends no room event");
  page = repeatIsStable();
  assert.ok(page.actionsNeeded?.[0].top.some(row => row.id === "job-1" && row.why === "ci_failed"),
    "ci_failed reflects a registry-only CI record");

  // 4. Registry-only review: changes requested (the dispute-shaped send-back).
  item = store.workClaims.list("alpha").find(row => row.id === "job-1");
  store.workClaims.set("alpha", recordReview(item, bobAlpha, { verdict: "changes_requested", summary: "Add the test", now: clock.t }));
  page = repeatIsStable();
  assert.ok(page.actionsNeeded?.[0].top.some(row => row.id === "job-1" && row.why === "changes_requested"),
    "changes_requested reflects a registry-only review");

  // 5. Re-delivery retires the ask; closing the claim retires the claim.
  item = store.workClaims.list("alpha").find(row => row.id === "job-1");
  store.workClaims.set("alpha", { ...item, state: "delivered", deliveryGeneration: (item.deliveryGeneration ?? 0) + 1 });
  page = repeatIsStable();
  assert.equal(page.actionsNeeded?.[0].top.some(row => row.id === "job-1" && row.why === "changes_requested"), false,
    "re-delivery retires the send-back (the CI row is a separate, still-true action)");
  item = store.workClaims.list("alpha").find(row => row.id === "job-1");
  store.workClaims.set("alpha", { ...item, state: "done" });
  page = repeatIsStable();
  assert.equal(page.myClaims, undefined, "a closed claim leaves myClaims");

  // 6. Land-queue write (no room event, no claim change): the change appears.
  store.db.prepare(`INSERT INTO land_queue(room_id,item_id,repo,pr_number,claimant_member_id,added_by_member_id,title,mergeable,behind,checks_state,observed,created_at,updated_at)
    VALUES('alpha','land-1','example/repo',7,?,'x','Land me','unknown',0,'pending',1,?,?)`)
    .run(adaAlpha, clock.t, clock.t);
  page = repeatIsStable();
  assert.ok(page.items.some(entry => entry.kind === "land_queue" && entry.id === "land-1"), "land change lands");

  // 7. Bond proposal (event in the room): the request appears for Ada.
  store.command(bob.secret, "alpha", { id: "bond-1", type: "bond.propose",
    data: { to: ada.identityId, scopes: ["peer.dm"] } });
  page = repeatIsStable();
  assert.ok(page.items.some(entry => entry.kind === "bond_request"), "bond request lands");

  // 8. Wake pause (side-table write, no room event): the paused section appears.
  store.db.prepare("INSERT INTO wake_queue_pause(room_id,member_id,paused_at,reason) VALUES('alpha',?,?,?)")
    .run(adaAlpha, clock.t, "hold");
  page = repeatIsStable();
  assert.ok(page.paused?.some(row => row.roomId === "alpha"), "pause lands");
  store.db.prepare("DELETE FROM wake_queue_pause WHERE room_id='alpha' AND member_id=?").run(adaAlpha);
  page = repeatIsStable();
  assert.equal(page.paused, undefined, "resume retires the paused section");

  // 9. An event in the OTHER room changes only that room's slice.
  const alphaBefore = json(page.items.filter(entry => entry.roomId === "alpha"));
  store.command(bob.secret, "beta", { id: "m9", type: "message.posted",
    data: { messageId: "m9", body: "@Ada beta news" } });
  page = repeatIsStable();
  assert.ok(page.items.some(entry => entry.roomId === "beta" && entry.id === "m9"), "beta mention lands");
  assert.equal(json(page.items.filter(entry => entry.roomId === "alpha")), alphaBefore, "alpha slice is untouched");
});

test("memo: a pure clock advance across a lease expiry is never served stale", t => {
  const { store, clock, adaAlpha, call, putClaim } = setup(t);
  let item = putClaim("short-lease", adaAlpha);
  item = { ...item, leaseExpiresAt: new Date(T0 + 30 * 60000).toISOString() };
  store.workClaims.set("alpha", item);
  let page = call();
  assert.ok(page.myClaims?.[0].top.some(row => row.id === "short-lease"), "held before expiry");
  assert.equal(json(call()), json(page), "repeat inside the validity horizon is identical");
  clock.t = T0 + 31 * 60000; // no writes at all — time alone moves
  page = call();
  assert.equal(page.myClaims, undefined, "the lapsed claim is no longer served as held");
  assert.ok(page.openWork?.[0].top.some(row => row.id === "short-lease"), "the lapsed claim is open work now");
});

test("memo: a pure clock advance across a bond expiry is never served stale", t => {
  const { store, clock, ada, bob, call } = setup(t);
  store.command(bob.secret, "alpha", { id: "bond-x", type: "bond.propose",
    data: { to: ada.identityId, scopes: ["peer.dm"] } });
  let page = call();
  assert.ok(page.items.some(entry => entry.kind === "bond_request"), "proposal is live before expiry");
  assert.equal(json(call()), json(page), "repeat inside the validity horizon is identical");
  clock.t = T0 + 8 * 24 * 3600000; // bond TTL is 7 days; no writes at all
  page = call();
  assert.equal(page.items.some(entry => entry.kind === "bond_request"), false,
    "the expired proposal is no longer served");
});

test("memo: a governor hardening a self-pause invalidates — heldBy flips from self to owner", t => {
  const { store, ada, adaAlpha, owners, call, repeatIsStable } = setup(t);
  const seqOf = roomId => store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  const pauseAgg = () => store.db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(MAX(paused_at),0) AS mp FROM wake_queue_pause").get();

  // Ada pauses herself: a self-held pause, self-resumable. The second poll
  // inside repeatIsStable is served from the memo.
  store.wakeQueue.pause(ada.secret, "alpha", { requestId: randomUUID(), reason: "own maintenance" });
  let page = repeatIsStable();
  assert.equal(page.paused?.find(row => row.roomId === "alpha")?.heldBy, "self", "self-pause reads self-held");
  assert.equal(page.paused?.find(row => row.roomId === "alpha")?.resume, "wake_resume lifts your own pause");

  // The room owner (a governor) pauses Ada too: this HARDENS the existing
  // pause. wake-queue upserts ONLY wake_queue_pause_by — the pause row,
  // the room sequence and the claim board all stay exactly as they were.
  const seqBefore = seqOf("alpha");
  const aggBefore = pauseAgg();
  store.wakeQueue.pause(owners.alpha.secret, "alpha", { requestId: randomUUID(), reason: "room freeze" }, null, { memberId: adaAlpha });
  assert.equal(seqOf("alpha"), seqBefore, "fixture: hardening appends no room event");
  assert.deepEqual(pauseAgg(), aggBefore, "fixture: hardening leaves the pause aggregate unchanged");
  // Ground truth, read directly: the pause is owner-held now.
  assert.equal(store.agentHeartbeats.pausedRoomsOf(ada.identityId).find(row => row.roomId === "alpha")?.heldBy, "owner",
    "fixture: the direct read shows the hardened holder");

  // The next poll must show the hardening, not the memoised self-held row.
  page = call();
  assert.equal(page.paused?.find(row => row.roomId === "alpha")?.heldBy, "owner", "hardened pause reads owner-held");
  assert.equal(page.paused?.find(row => row.roomId === "alpha")?.resume, "only the room owner or a member manager can resume",
    "hardened pause carries the owner-resume text");
  repeatIsStable();
});
