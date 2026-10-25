// The live-seat predicate regression suite (Cluster 8 lane B8's matrix,
// adopted as the amended A5 charter's §5.0 acceptance): one shared
// predicate — guestSeatLive in server/wake-identity-resolution.mjs —
// judged identically at every surface that decides whether a guest seat
// is seated. Surfaces: S1 webhook drain, S2 wake-status room
// enumeration, S3 wake-status membership gate, S4 public agent page,
// S5 wake ping (accepted-as-signal under decision D-3: pinned as
// unchanged), plus the amendment-1 GAP surfaces (needs-me, agent-rooms,
// agentPresence, the public-work receipt exception) and the §5.2–§5.4
// probes (fallback, sweep determinism, no per-seat loop).
//
// Transition vocabulary (B8): T1 disconnect before the act · T2 the
// mid-flight windows (a held / T2a, per-attempt recheck skip / T2b,
// disconnect during the POST itself / T2c) · T3 credential expiry,
// unswept and swept · T4 identity revocation (decision D-2: revoked_at
// is OUT of the predicate — enumeration lists and the page renders;
// pinned as the recorded choice) · T5 member removal (its resulting
// credential state is T1's; B6 §4) · T6 re-seat / reactivation.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import {
  guestSeatLive, guestSeatLiveMemberIds, guestSeatLiveSql,
  identityIdForWakeMember, identityIdsForWakeRoom, isWakeRoomMember,
  memberIdForWakeIdentity,
} from "../server/wake-identity-resolution.mjs";
import { identityRoomSeats } from "../server/membership-resolution.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { PublicWorkClaims } from "../server/public-work-claims.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

const NOW = 1_800_000_000_000;
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });

async function startServer(t, f, { publicAgentPages = false } = {}) {
  const server = createRoomServer({ store: f.store, publicAgentPages });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret) => fetch(`${origin}${path}`, {
  headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
});

async function mintInvite(origin, ownerKey, label) {
  const attempt = rev => post(origin, "/api/rooms/commons/guest-invites",
    { requestId: randomUUID(), guestLabel: label, expectedOwnerRevision: rev, credentialTtlMs: 3600_000 }, ownerKey);
  let body = await (await attempt(0)).json();
  if (!body.code) {
    const rev = body?.error?.details?.currentRevision ?? body?.error?.currentRevision ?? body?.currentRevision;
    if (Number.isInteger(rev)) body = await (await attempt(rev)).json();
  }
  assert.ok(body.code, `mint returns a code: ${JSON.stringify(body).slice(0, 200)}`);
  return body.code;
}
async function redeemWithIdentity(f, origin, ownerKey, identity, name) {
  const code = await mintInvite(origin, ownerKey, `guest ${name}`);
  const kp = generateKeyPair();
  const cardBody = { name, description: "live-seat regression guest", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: kp.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: kp.privateKey }) };
  const redeemed = await (await post(origin, "/api/guest-invites/redeem",
    { inviteCode: code, card }, identity.secret)).json();
  assert.ok(redeemed.member?.id, `redeem seats a member: ${JSON.stringify(redeemed).slice(0, 200)}`);
  return { identity, memberId: redeemed.member.id, token: redeemed.token, credential: redeemed.credential ?? redeemed.token };
}
async function seatGuest(f, origin, ownerKey, name) {
  const identity = f.store.identities.create(name);
  return redeemWithIdentity(f, origin, ownerKey, identity, name);
}
const deliveriesFor = (f, identityId) => f.store.db.prepare(
  "SELECT delivery_id AS id FROM agent_webhook_deliveries WHERE agent_id=? AND event_type='message.posted'")
  .all(identityId).map(r => r.id);
const postRoom = (f, ownerKey, messageId, body, extra = {}) => f.store.command(ownerKey, "commons", {
  id: randomUUID(), type: "message.posted", data: { messageId, body, ...extra },
});
// T3's state, constructed exactly: the access credential's expiry is
// moved into the past WITHOUT revoking it and WITHOUT sweeping — the
// member projection still reads active.
function expireGuestCredential(f, memberId) {
  f.store.db.prepare("UPDATE credentials SET expires_at=1 WHERE room_id='commons' AND member_id=? AND kind='access'")
    .run(memberId);
  const member = f.store.roomAuthority("commons")?.members?.[memberId];
  assert.ok(member && member.active !== false, "expiry-unswept leaves the member projection active");
  const cred = f.store.db.prepare(
    "SELECT revoked, expires_at FROM credentials WHERE room_id='commons' AND member_id=? AND kind='access'").get(memberId);
  assert.equal(cred.revoked, 0, "the credential is expired, not revoked");
}

// ---------------------------------------------------------------------------
// §5.2 — the three forms of the predicate agree; fallback and failure modes.
// ---------------------------------------------------------------------------

function predicateDb(t, { credentialsTable = true } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE identity_links (room_id TEXT, identity_id TEXT, member_id TEXT);
    CREATE TABLE guest_members (room_id TEXT, guest_identity_id TEXT, member_id TEXT);
    INSERT INTO identity_links VALUES ('room-a', 'id-linked', 'mem-linked');
    INSERT INTO guest_members VALUES ('room-a', 'id-live', 'mem-live');
    INSERT INTO guest_members VALUES ('room-a', 'id-disconnected', 'mem-disconnected');
    INSERT INTO guest_members VALUES ('room-a', 'id-expired', 'mem-expired');
    INSERT INTO guest_members VALUES ('room-a', 'id-rotated', 'mem-rotated');
  `);
  if (credentialsTable) {
    db.exec(`
      CREATE TABLE credentials (room_id TEXT, member_id TEXT, kind TEXT,
        expires_at INTEGER, revoked INTEGER);
      INSERT INTO credentials VALUES ('room-a', 'mem-live', 'access', ${NOW + 60_000}, 0);
      INSERT INTO credentials VALUES ('room-a', 'mem-disconnected', 'access', ${NOW + 60_000}, 1);
      INSERT INTO credentials VALUES ('room-a', 'mem-expired', 'access', ${NOW - 1}, 0);
      INSERT INTO credentials VALUES ('room-a', 'mem-rotated', 'access', ${NOW - 1}, 0);
      INSERT INTO credentials VALUES ('room-a', 'mem-rotated', 'access', ${NOW + 60_000}, 0);
    `);
  }
  return db;
}

test("§5.2 predicate forms agree: single-seat JS, batched set, generated SQL", t => {
  const db = predicateDb(t);
  assert.equal(guestSeatLive(db, "room-a", "mem-live", NOW), true);
  assert.equal(guestSeatLive(db, "room-a", "mem-disconnected", NOW), false, "revoked latest state is dead");
  assert.equal(guestSeatLive(db, "room-a", "mem-expired", NOW), false, "expired unswept is dead");
  assert.equal(guestSeatLive(db, "room-a", "mem-rotated", NOW), true,
    "a later live row coexisting with an expired one keeps the seat (D-1)");
  assert.deepEqual([...guestSeatLiveMemberIds(db, "room-a", NOW)].sort(), ["mem-live", "mem-rotated"]);
  assert.deepEqual(identityIdsForWakeRoom(db, "room-a", NOW).sort(),
    ["id-linked", "id-live", "id-rotated"], "enumeration: live and rotated guests plus links only");
  assert.equal(isWakeRoomMember(db, "room-a", "id-expired", NOW), false);
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-disconnected", NOW), null);
  assert.equal(identityIdForWakeMember(db, "room-a", "mem-rotated", NOW), "id-rotated");

  // The generated SQL form, spliced into the drain's batch SELECT shape,
  // selects exactly the seats the JS forms call live.
  db.exec(`
    CREATE TABLE agent_webhook_subs (subscription_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE agent_webhook_deliveries (delivery_id TEXT PRIMARY KEY, subscription_id TEXT, agent_id TEXT NOT NULL,
      room_id TEXT, state TEXT NOT NULL, next_attempt_at INTEGER NOT NULL);
    INSERT INTO agent_webhook_subs VALUES ('sub-live', 'id-live', 1), ('sub-disconnected', 'id-disconnected', 1),
      ('sub-expired', 'id-expired', 1), ('sub-linked', 'id-linked', 1), ('sub-stranger', 'id-stranger', 1);
    INSERT INTO agent_webhook_deliveries VALUES ('del-live', 'sub-live', 'id-live', 'room-a', 'pending', ${NOW}),
      ('del-disconnected', 'sub-disconnected', 'id-disconnected', 'room-a', 'pending', ${NOW}),
      ('del-expired', 'sub-expired', 'id-expired', 'room-a', 'pending', ${NOW}),
      ('del-linked', 'sub-linked', 'id-linked', 'room-a', 'pending', ${NOW}),
      ('del-stranger', 'sub-stranger', 'id-stranger', 'room-a', 'pending', ${NOW}),
      ('del-orphan', 'sub-removed', 'id-live', 'room-a', 'pending', ${NOW}),
      ('del-roomless', 'sub-live', 'id-live', NULL, 'pending', ${NOW});
  `);
  const drainSelect = `
    SELECT d.* FROM agent_webhook_deliveries d
     LEFT JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id
     WHERE d.state IN ('pending','failed') AND d.next_attempt_at <= ?
     AND (s.subscription_id IS NULL OR (s.enabled = 1 AND (d.room_id IS NULL
       OR EXISTS (SELECT 1 FROM identity_links l WHERE l.room_id = d.room_id AND l.identity_id = d.agent_id)
       OR EXISTS (SELECT 1 FROM guest_members g WHERE g.room_id = d.room_id AND g.guest_identity_id = d.agent_id
         AND ${guestSeatLiveSql("g.room_id", "g.member_id")}))))
     ORDER BY d.next_attempt_at ASC LIMIT ?`;
  const selected = db.prepare(drainSelect).all(NOW, NOW, 25).map(r => r.delivery_id).sort();
  assert.deepEqual(selected, ["del-linked", "del-live", "del-orphan", "del-roomless"],
    "the generated SQL selects the same seats as the verbatim pre-composition query (pinned in guest-wake-live-seat.test.js)");
});

test("§5.2 fallback: no credentials table counts as live; other SQL errors fail closed", t => {
  const bare = predicateDb(t, { credentialsTable: false });
  assert.equal(guestSeatLive(bare, "room-a", "mem-expired", NOW), true,
    "pre-schema fallback: a seat with no credentials table to judge it is live");
  assert.equal(guestSeatLiveMemberIds(bare, "room-a", NOW), null,
    "the batched form reports the fallback as null, distinct from an empty live set");
  assert.ok(identityIdsForWakeRoom(bare, "room-a", NOW).includes("id-expired"),
    "enumeration falls back through the primitive for every guest seat");

  const broken = new DatabaseSync(":memory:");
  t.after(() => broken.close());
  broken.exec(`
    CREATE TABLE identity_links (room_id TEXT, identity_id TEXT, member_id TEXT);
    CREATE TABLE guest_members (room_id TEXT, guest_identity_id TEXT, member_id TEXT);
    CREATE TABLE credentials (room_id TEXT, member_id TEXT, expires_at INTEGER, revoked INTEGER);
    INSERT INTO guest_members VALUES ('room-a', 'id-live', 'mem-live');
    INSERT INTO credentials VALUES ('room-a', 'mem-live', ${NOW + 60_000}, 0);
  `);
  assert.equal(guestSeatLive(broken, "room-a", "mem-live", NOW), false,
    "a credentials table missing the kind column is an error, not the fallback: fail closed");
  assert.deepEqual([...guestSeatLiveMemberIds(broken, "room-a", NOW)], [],
    "the batched form fails closed to an empty set on a non-fallback error");
});

// ---------------------------------------------------------------------------
// §5.6.1/2 + §5.4 — the shared enumeration primitive (G-1).
// ---------------------------------------------------------------------------

test("§5.6.1/2 identityRoomSeats: default unchanged; liveGuestsOnly filters before pagination", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE identity_links (room_id TEXT, identity_id TEXT, member_id TEXT, display_name TEXT, permissions_json TEXT, created_at INTEGER);
    CREATE TABLE guest_members (room_id TEXT, guest_identity_id TEXT, member_id TEXT, tier TEXT);
    CREATE TABLE credentials (room_id TEXT, member_id TEXT, kind TEXT, expires_at INTEGER, revoked INTEGER);
    INSERT INTO identity_links VALUES ('room-b', 'id-x', 'mem-x-link', 'X', '[]', 1);
    INSERT INTO guest_members VALUES ('room-a', 'id-x', 'mem-x-dead', 'contributor');
    INSERT INTO guest_members VALUES ('room-c', 'id-x', 'mem-x-live', 'contributor');
    INSERT INTO guest_members VALUES ('room-a', 'id-other', 'mem-other', 'contributor');
    INSERT INTO credentials VALUES ('room-a', 'mem-x-dead', 'access', ${NOW - 1}, 0);
    INSERT INTO credentials VALUES ('room-c', 'mem-x-live', 'access', ${NOW + 60_000}, 0);
  `);
  const roomIds = seats => seats.map(s => s.roomId).sort();
  assert.deepEqual(roomIds(identityRoomSeats(db, "id-x")), ["room-a", "room-b", "room-c"],
    "default off: every seat, exactly as before the amendment");
  assert.deepEqual(roomIds(identityRoomSeats(db, "id-x", { liveGuestsOnly: true, now: NOW })), ["room-b", "room-c"],
    "the dead guest seat is filtered; links are never judged");
  const firstPage = identityRoomSeats(db, "id-x", { liveGuestsOnly: true, now: NOW, limit: 1 });
  assert.deepEqual(firstPage.map(s => s.roomId), ["room-b"],
    "filtering precedes the limit: the dead room-a seat does not consume the page");
  const afterDead = identityRoomSeats(db, "id-x", { liveGuestsOnly: true, now: NOW, after: "room-a", limit: 1 });
  assert.deepEqual(afterDead.map(s => s.roomId), ["room-b"], "cursor arithmetic runs on the filtered set");
});

test("§5.4 batched enumeration: constant query count at 1 vs 25 guest seats; strict expiry boundary", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE identity_links (room_id TEXT, identity_id TEXT, member_id TEXT);
    CREATE TABLE guest_members (room_id TEXT, guest_identity_id TEXT, member_id TEXT);
    CREATE TABLE credentials (room_id TEXT, member_id TEXT, kind TEXT, expires_at INTEGER, revoked INTEGER);
  `);
  const seat = (i, expiresAt) => {
    db.prepare("INSERT INTO guest_members VALUES ('room-a', ?, ?)").run(`id-g${i}`, `mem-g${i}`);
    db.prepare("INSERT INTO credentials VALUES ('room-a', ?, 'access', ?, 0)").run(`mem-g${i}`, expiresAt);
  };
  seat(0, NOW + 60_000);
  let prepares = 0;
  const counting = { prepare: sql => { prepares += 1; return db.prepare(sql); } };
  identityIdsForWakeRoom(counting, "room-a", NOW);
  const oneSeatQueries = prepares;
  for (let i = 1; i < 25; i += 1) seat(i, i % 5 === 0 ? NOW + 60_000 : NOW - 1);
  prepares = 0;
  const listed = identityIdsForWakeRoom(counting, "room-a", NOW);
  assert.equal(prepares, oneSeatQueries, "query count is constant in the guest-seat count (no per-seat loop)");
  assert.deepEqual(listed.sort(), ["id-g0", "id-g10", "id-g15", "id-g20", "id-g5"],
    "exactly the live seats are listed");
  // Boundary: expires_at == now is dead (strict >), now + 1 is live.
  db.prepare("INSERT INTO guest_members VALUES ('room-a', 'id-edge', 'mem-edge')").run();
  db.prepare("INSERT INTO credentials VALUES ('room-a', 'mem-edge', 'access', ?, 0)").run(NOW);
  assert.equal(guestSeatLive(db, "room-a", "mem-edge", NOW), false, "expiring exactly at now is not live");
  db.prepare("UPDATE credentials SET expires_at=? WHERE member_id='mem-edge'").run(NOW + 1);
  assert.equal(guestSeatLive(db, "room-a", "mem-edge", NOW), true);
});

// ---------------------------------------------------------------------------
// §5.3 — sweep judgement determinism (query level; the flavour-level pin is
// the branch's own tests/guest-sweep-rotated-credential.test.mjs).
// ---------------------------------------------------------------------------

test("§5.3 the sweep's judged row is the latest-expiring unrevoked row in both insertion orders", t => {
  const judged = rows => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec("CREATE TABLE credentials (hash TEXT, room_id TEXT, member_id TEXT, kind TEXT, expires_at INTEGER, revoked INTEGER)");
    for (const [hash, expiresAt] of rows) {
      db.prepare("INSERT INTO credentials VALUES (?, 'room-a', 'mem-x', 'access', ?, 0)").run(hash, expiresAt);
    }
    // The guest-invites sweep's judged-row query, verbatim at the composed head.
    return db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0 ORDER BY expires_at DESC")
      .get("room-a", "mem-x").hash;
  };
  assert.equal(judged([["h-live", NOW + 60_000], ["h-expired", NOW - 1]]), "h-live");
  assert.equal(judged([["h-expired", NOW - 1], ["h-live", NOW + 60_000]]), "h-live",
    "insertion order cannot flip the judgement: a seat with a live row is never swept");
});

// ---------------------------------------------------------------------------
// §5.6.5 — G-5: the public-work receipt member exception.
// ---------------------------------------------------------------------------

test("§5.6.5 receipt exception: a dead guest member loses the exception; live guests and non-guests keep it", t => {
  const db = predicateDb(t);
  const claims = new PublicWorkClaims({
    db,
    roomDirectory: { publicReceiptsVisible: () => false },
    roomAuthority: () => ({ members: {
      "mem-live": { active: true }, "mem-expired": { active: true }, "mem-plain": { active: true },
    } }),
    now: () => NOW,
  });
  claims._requireReceiptVisible("room-a", "mem-live");
  claims._requireReceiptVisible("room-a", "mem-plain");
  assert.throws(() => claims._requireReceiptVisible("room-a", "mem-expired"),
    err => (err?.code ?? "") === "receipts_private" || /receipts_private/.test(String(err?.message ?? err)),
    "an expired-unswept guest member no longer reads through membership alone");
  const open = new PublicWorkClaims({
    db,
    roomDirectory: { publicReceiptsVisible: () => true },
    roomAuthority: () => ({ members: {} }),
    now: () => NOW,
  });
  open._requireReceiptVisible("room-a", "mem-expired");
});

// ---------------------------------------------------------------------------
// S1 — the webhook drain (B8 rows S1×T1/T2a/T2b/T2c/T3/T6).
// ---------------------------------------------------------------------------

async function seatedSubscribedGuest(t, name) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guest = await seatGuest(f, origin, ownerKey, name);
  f.store.agentPlugin.subscribeWebhook({
    identityId: guest.identity.identityId, url: `https://${name}.example.test/hook`, events: ["message.posted"],
  });
  return { f, origin, ownerKey, guest };
}

test("regression S1×T2b: a row queued while live is skipped by the per-attempt recheck after disconnect", async t => {
  const { f, ownerKey, guest } = await seatedSubscribedGuest(t, "RegT2b");
  postRoom(f, ownerKey, "t2b-1", "queued while live");
  const row = f.store.db.prepare("SELECT * FROM agent_webhook_deliveries WHERE agent_id=?")
    .get(guest.identity.identityId);
  f.store.guestInvites.disconnect(ownerKey, "commons", guest.memberId);
  const posted = [];
  const result = await f.store.agentPlugin.attemptStoredDelivery(row, {
    fetchImpl: async url => { posted.push(url); return ok200(); },
    now: Date.now(), dnsResolvers: publicDns,
  });
  assert.equal(result, "skipped", "the recheck judges the seat at attempt time and skips");
  assert.deepEqual(posted, [], "nothing is POSTed");
  const after = f.store.db.prepare("SELECT state, attempts FROM agent_webhook_deliveries WHERE delivery_id=?")
    .get(row.delivery_id);
  assert.equal(after.state, "pending", "the row is held for a possible re-seat, not dead-lettered");
  assert.equal(after.attempts, 0, "a skip is not an attempt");
});

test("regression S1×T2c: a disconnect landing during the POST does not stop that POST; the next row skips (accepted race)", async t => {
  const { f, ownerKey, guest } = await seatedSubscribedGuest(t, "RegT2c");
  postRoom(f, ownerKey, "t2c-1", "first");
  postRoom(f, ownerKey, "t2c-2", "second");
  const rows = f.store.db.prepare("SELECT * FROM agent_webhook_deliveries WHERE agent_id=? ORDER BY next_attempt_at, delivery_id")
    .all(guest.identity.identityId);
  assert.equal(rows.length, 2);
  let disconnected = false;
  const fetchImpl = async () => {
    if (!disconnected) {
      disconnected = true;
      f.store.guestInvites.disconnect(ownerKey, "commons", guest.memberId);
    }
    return ok200();
  };
  const first = await f.store.agentPlugin.attemptStoredDelivery(rows[0], {
    fetchImpl, now: Date.now(), dnsResolvers: publicDns,
  });
  assert.equal(first, "delivered",
    "the accepted single-attempt race: the recheck passed before the disconnect landed");
  const second = await f.store.agentPlugin.attemptStoredDelivery(rows[1], {
    fetchImpl, now: Date.now(), dnsResolvers: publicDns,
  });
  assert.equal(second, "skipped", "every later attempt rechecks and skips");
});

test("regression S1×T3: expiry unswept — fan-out journals nothing new and the drain selects nothing queued", async t => {
  const { f, ownerKey, guest } = await seatedSubscribedGuest(t, "RegT3");
  postRoom(f, ownerKey, "t3-1", "queued while live");
  assert.equal(deliveriesFor(f, guest.identity.identityId).length, 1);
  expireGuestCredential(f, guest.memberId);
  postRoom(f, ownerKey, "t3-2", "after expiry");
  assert.equal(deliveriesFor(f, guest.identity.identityId).length, 1,
    "fan-out journals no new delivery for an expired-unswept seat");
  const posted = [];
  const summary = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async url => { posted.push(url); return ok200(); },
    now: Date.now() + 1000, dnsResolvers: publicDns,
  });
  assert.equal(summary.processed, 0, "the drain's generated SQL leg excludes the dead seat's queued row");
  assert.deepEqual(posted, []);
});

test("regression S1×T2a+T6: a held row delivers after the seat is re-seated by a fresh redeem", async t => {
  const { f, origin, ownerKey, guest } = await seatedSubscribedGuest(t, "RegT6");
  postRoom(f, ownerKey, "t6-1", "held across the disconnect");
  f.store.guestInvites.disconnect(ownerKey, "commons", guest.memberId);
  const quiet = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: Date.now() + 1000, dnsResolvers: publicDns,
  });
  assert.equal(quiet.processed, 0, "nothing drains while the seat is down");
  const reseated = await redeemWithIdentity(f, origin, ownerKey, guest.identity, "RegT6");
  assert.equal(reseated.memberId, guest.memberId, "the fresh redeem reactivates the same seat");
  const posted = [];
  const summary = await f.store.agentPlugin.drainWebhookDeliveries({
    fetchImpl: async (url, init) => { posted.push(init.headers["x-webhook-delivery"]); return ok200(); },
    now: Date.now() + 1000, dnsResolvers: publicDns,
  });
  assert.equal(summary.delivered, 1, "the held row delivers to the reactivated seat");
  assert.deepEqual(posted, deliveriesFor(f, guest.identity.identityId));
});

// ---------------------------------------------------------------------------
// S2/S3 — wake-status enumeration and gate; S5 — the wake ping (D-3).
// ---------------------------------------------------------------------------

test("regression S2×T1 + S3×T1: disconnect removes the seat from the room roster and closes the gate; caller-only mode is unchanged", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const subject = await seatGuest(f, origin, ownerKey, "RegS2Subject");
  const reader = await seatGuest(f, origin, ownerKey, "RegS2Reader");
  const beat = g => post(origin, "/api/agent-heartbeats", { hostId: `h-${g.memberId}` }, g.identity.secret);
  assert.equal((await beat(subject)).status, 200);
  const roster = async () => (await (await get(origin, "/api/wake-status?roomId=commons", reader.identity.secret)).json());
  assert.ok(JSON.stringify(await roster()).includes(subject.identity.identityId),
    "a live guest with a fresh heartbeat is on the room roster");
  const ownRead = await get(origin, "/api/wake-status?roomId=commons", subject.identity.secret);
  assert.equal(ownRead.status, 200, "the gate admits a live guest member");

  f.store.guestInvites.disconnect(ownerKey, "commons", subject.memberId);
  assert.ok(!JSON.stringify(await roster()).includes(subject.identity.identityId),
    "after disconnect the seat is in neither roster list, heartbeat notwithstanding");
  const closed = await get(origin, "/api/wake-status?roomId=commons", subject.identity.secret);
  assert.equal(closed.status, 403, "the gate closes for the disconnected seat");
  const closedBody = await closed.json();
  assert.equal(closedBody?.error?.code ?? closedBody?.code, "room_membership_required");
  assert.equal((await beat(subject)).status, 200, "heartbeats still land (identity-level, not room-level)");
  const callerOnly = await get(origin, "/api/wake-status", subject.identity.secret);
  assert.equal(callerOnly.status, 200,
    "caller-only mode keeps serving the identity's own liveness — the deliberate asymmetry");
});

test("regression S2×T3: expiry unswept removes the seat from the room roster", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const subject = await seatGuest(f, origin, ownerKey, "RegS2Expiry");
  const reader = await seatGuest(f, origin, ownerKey, "RegS2ExpiryReader");
  await post(origin, "/api/agent-heartbeats", { hostId: "h-expiry" }, subject.identity.secret);
  const rosterText = async () => JSON.stringify(
    await (await get(origin, "/api/wake-status?roomId=commons", reader.identity.secret)).json());
  assert.ok((await rosterText()).includes(subject.identity.identityId));
  expireGuestCredential(f, subject.memberId);
  assert.ok(!(await rosterText()).includes(subject.identity.identityId),
    "an expired-unswept seat leaves the roster without any sweep running");
});

test("regression S5×T1 (D-3 accepted-as-signal): the wake ping still journals for a disconnected seat, roomless", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guest = await seatGuest(f, origin, ownerKey, "RegS5");
  f.store.agentPlugin.subscribeWebhook({
    identityId: guest.identity.identityId, url: "https://regs5.example.test/hook", events: ["agent.wake"],
  });
  f.store.guestInvites.disconnect(ownerKey, "commons", guest.memberId);
  const result = f.store.agentPlugin.deliverWakePing({
    identityId: guest.identity.identityId,
    signal: { signalId: "sig-reg-s5", kind: "mention", roomId: "commons", messageId: "m-1", createdAt: 1 },
  });
  assert.ok(result.deliveries.length >= 1,
    "the ping is accepted as a signal, unchanged by this composition (D-3)");
  const row = f.store.db.prepare("SELECT room_id FROM agent_webhook_deliveries WHERE delivery_id=?")
    .get(result.deliveries[0].deliveryId ?? result.deliveries[0].id);
  assert.equal(row.room_id, null, "the ping carries no room body — the residual is a bare wake signal");
});

// ---------------------------------------------------------------------------
// S4 — the public agent page (T3 cell here; the full S4 set rides with
// tests/public-agent-page.test.js).
// ---------------------------------------------------------------------------

test("regression S4×T3: an expired-unswept guest's page, ask intake, and poll all 404", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { publicAgentPages: true });
  const guest = await seatGuest(f, origin, f.store.issueAccessKey("commons", "owner"), "RegS4");
  f.store.db.prepare(`INSERT INTO agent_public_pages(room_id, member_id, slug, access, blurb, enabled, created_at, updated_at)
    VALUES ('commons', ?, 'reg-s4', 'open', 'regression page', 1, 1, 1)`).run(guest.memberId);
  const card = await get(origin, "/api/public/agents/reg-s4");
  assert.equal(card.status, 200, "the live guest's page serves");
  expireGuestCredential(f, guest.memberId);
  const gone = await get(origin, "/api/public/agents/reg-s4");
  assert.equal(gone.status, 404, "card dark after expiry, no sweep needed");
  assert.equal((await gone.json())?.error?.code, "agent_not_found");
  const page = await get(origin, "/u/reg-s4");
  assert.equal(page.status, 404, "the HTML page is dark too");
  const ask = await post(origin, "/api/public/agents/reg-s4/asks", { name: "Visitor", question: "are you there?" });
  assert.equal(ask.status, 404, "ask intake is closed");
  const poll = await get(origin, "/api/public/agents/reg-s4/asks/ask-nonexistent");
  assert.equal(poll.status, 404, "the poll is gated by the same _publicRow judgement");
});

// ---------------------------------------------------------------------------
// GAP surfaces — §5.6.3 needs-me, §5.6.4 agentPresence, §5.6.6 agent-rooms.
// ---------------------------------------------------------------------------

test("§5.6.3 needs-me: a DM summary served while live disappears when the seat's credential expires unswept", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guest = await seatGuest(f, origin, ownerKey, "RegNeedsMe");
  const marker = `dm-marker-${randomUUID()}`;
  postRoom(f, ownerKey, "nm-1", marker, { toMemberId: guest.memberId });
  const live = JSON.stringify(collectNeedsMe(f.store, guest.identity.secret));
  assert.ok(live.includes(marker), "control: the DM body reaches the live guest's needs-me summary (the B7 leak shape)");
  expireGuestCredential(f, guest.memberId);
  const dead = JSON.stringify(collectNeedsMe(f.store, guest.identity.secret));
  assert.ok(!dead.includes(marker),
    "after expiry the dead seat's room contributes nothing — the leak is closed by the filtered primitive");
});

test("§5.6.4 agentPresence: target seats and caller standing are both judged by the predicate", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guestTarget = await seatGuest(f, origin, ownerKey, "RegPresenceTarget");
  const guestCaller = await seatGuest(f, origin, ownerKey, "RegPresenceCaller");
  const linked = f.store.identities.create("RegPresenceLinked");
  f.store.identities.link(ownerKey, "commons", { identityId: linked.identityId, displayName: "RegPresenceLinked", permissions: [] });
  await post(origin, "/api/agent-heartbeats", { hostId: "h-presence" }, guestTarget.identity.secret);
  const roomsOf = res => (res?.rooms ?? []).map(r => r.roomId);
  assert.ok(roomsOf(f.store.agentPresence({ identityId: guestCaller.identity.identityId }, guestTarget.identity.identityId)).includes("commons"),
    "a live guest target is present to a live guest caller");
  expireGuestCredential(f, guestTarget.memberId);
  assert.deepEqual(roomsOf(f.store.agentPresence({ identityId: guestCaller.identity.identityId }, guestTarget.identity.identityId)), [],
    "an expired-unswept target seat no longer grounds presence");
  assert.ok(roomsOf(f.store.agentPresence({ identityId: guestCaller.identity.identityId }, linked.identityId)).includes("commons"),
    "the caller still has standing while its own seat is live");
  expireGuestCredential(f, guestCaller.memberId);
  assert.deepEqual(roomsOf(f.store.agentPresence({ identityId: guestCaller.identity.identityId }, linked.identityId)), [],
    "a caller whose only seat is a dead guest seat has no standing, though the target is a live linked member");
});

test("§5.6.6 agent-rooms: a dead guest seat's room leaves the identity's room list", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const guest = await seatGuest(f, origin, f.store.issueAccessKey("commons", "owner"), "RegRooms");
  const rooms = new AgentRooms(f.store);
  const listed = await rooms.list(guest.identity.secret);
  assert.ok(JSON.stringify(listed).includes("commons"), "the live guest sees its room");
  expireGuestCredential(f, guest.memberId);
  const after = await rooms.list(guest.identity.secret);
  assert.deepEqual(after.rooms ?? [], [], "after expiry the room list is empty — no dead seat is listed");
});
