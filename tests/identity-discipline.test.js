// Identity discipline: spawner-bound minting + endorsement tiers (guild
// spec §§2-4) + cluster-pooled quotas (AQ-HI-09 / AQ-MD-10 / AQ-MD-11).
//
// Authoring gate:
// 1. Observable contracts: (a) anonymous-mint identities are born
//    unendorsed and get 403 unendorsed_identity on poll votes and
//    work-claim acquisition; (b) spawner-bound mints record minted_by, are
//    born endorsed in the spawner's rooms, and never spend anonymous
//    budgets; (c) the per-spawner daily cap answers 429 spawner_limit with
//    Retry-After; (d) the grandfathering migration endorses every
//    pre-existing link exactly once; (e) identities sharing a mint cluster
//    share one claim-seat quota and one write bucket per room, while solo
//    identities keep the old per-member behavior; (f) the room owner (or
//    manage_members) can flip endorsement; nobody else can.
// 2. Credible regressions: deleting the requireEndorsed call, the
//    spawner_limit check, the grandfathering UPDATE, the cluster pooling,
//    or the mint_delegate vocabulary each fails at least one test below.
// 3. No existing coverage: the tier, the spawner path, and cluster pooling
//    are new; the seat/write checks previously counted per member/credential.
// 4. No production seams: every test drives the real RoomStore,
//    AgentIdentities, and (for the HTTP surface) createRoomServer. Fail-first
//    was demonstrated by watching each test fail against the pre-change
//    code path where applicable (missing columns / missing gates throw).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  ensureIdentityDisciplineSchema,
  identityClusterKey,
  SPAWNER_MINT_DAILY_CAP_DEFAULT,
} from "../server/agent-identities.mjs";
import { ensurePayoutColumns } from "../server/growth-loop.mjs";
import { POLL_OPTION_EMOJIS } from "../src/polls.js";
import { ServiceError } from "../server/store.mjs";

// The pre-discipline schema: agent_identities without minted_by,
// identity_links without endorsed/endorsed_by. Copied from the schema text
// before this slice so the grandfathering migration has a real legacy DB
// to converge.
const LEGACY_IDENTITY_SCHEMA = `
  CREATE TABLE agent_identities (
    identity_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE identity_links (
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, identity_id)
  );
`;

function openStore() {
  const store = new RoomStore(":memory:");
  return store;
}

async function httpFixture(t) {
  const store = openStore();
  const agentRooms = new AgentRooms(store);
  const owner = store.identities.create("Olive");
  const created = agentRooms.create(owner.secret, {
    title: "Discipline", purpose: "identity discipline tests",
    kind: "personal", roomId: "discipline", displayName: "Olive",
  });
  assert.equal(created.roomId, "discipline");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body, method) => {
    const response = await fetch(`${origin}/api${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, value: await response.json(), headers: response.headers };
  };
  return { store, owner, roomId: "discipline", call };
}

function serviceErrorOf(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

test("grandfathering migration endorses every pre-existing link exactly once", () => {
  const store = openStore();
  try {
    // The store cold start already created the new-schema tables; drop them
    // so the legacy schema below is genuinely legacy.
    store.db.exec("DROP TABLE IF EXISTS identity_links; DROP TABLE IF EXISTS agent_identities;");
    store.db.exec(LEGACY_IDENTITY_SCHEMA);
    const now = Date.now();
    for (const [id, name] of [["ai_old1", "Old One"], ["ai_old2", "Old Two"]]) {
      store.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at) VALUES(?,?,?,?)")
        .run(id, `hash-${id}`, name, now);
      store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run("room-a", id, id, now);
    }
    ensureIdentityDisciplineSchema(store.db);
    const rows = store.db.prepare("SELECT identity_id AS id, endorsed, endorsed_by AS by FROM identity_links ORDER BY identity_id").all();
    assert.deepEqual(rows.map(r => [r.id, r.endorsed, r.by]), [
      ["ai_old1", 1, "grandfathered"],
      ["ai_old2", 1, "grandfathered"],
    ]);
    assert.equal(store.db.prepare("SELECT minted_by AS m FROM agent_identities WHERE identity_id='ai_old1'").get().m, null);
    // A fresh unendorsed link added after the migration is never
    // grandfathered by a re-run.
    store.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at) VALUES(?,?,?,?)")
      .run("ai_new", "hash-new", "New", now);
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at,endorsed,endorsed_by) VALUES(?,?,?,?,?,?)")
      .run("room-a", "ai_new", "ai_new", now, 0, null);
    ensureIdentityDisciplineSchema(store.db);
    const fresh = store.db.prepare("SELECT endorsed, endorsed_by AS by FROM identity_links WHERE identity_id='ai_new'").get();
    assert.deepEqual([fresh.endorsed, fresh.by], [0, null]);
  } finally { store.close(); }
});

test("anonymous mint links unendorsed; poll vote and claim acquire refuse 403 unendorsed_identity", async t => {
  const { store, owner, roomId, call } = await httpFixture(t);
  const anon = store.identities.create("Anon Agent");
  store.identities.link(owner.secret, roomId, { identityId: anon.identityId, permissions: ["accept_work", "complete_work"] });
  const link = store.db.prepare("SELECT endorsed FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, anon.identityId);
  assert.equal(link.endorsed, 0);

  // Poll vote via the command path.
  const poll = await call(owner.secret, `/rooms/${roomId}/commands`, {
    id: "poll-1", type: "message.posted",
    data: { messageId: "poll-1", body: "Pick one", kind: "poll", poll: { question: "Q?", options: ["A", "B"] } },
  });
  assert.equal(poll.status, 201);
  const vote = await call(anon.secret, `/rooms/${roomId}/commands`, {
    id: "vote-1", type: "message.reaction_set",
    data: { messageId: "poll-1", reaction: POLL_OPTION_EMOJIS[0], active: true },
  });
  assert.equal(vote.status, 403);
  assert.equal(vote.value.error.code, "unendorsed_identity");

  // Work-claim acquire via the board routes.
  const created = await call(owner.secret, `/rooms/${roomId}/work-claims`, { id: "claim-1", title: "Work" });
  assert.equal(created.status, 201);
  const claim = await call(anon.secret, `/rooms/${roomId}/work-claims/claim-1/claim`, {});
  assert.equal(claim.status, 403);
  assert.equal(claim.value.error.code, "unendorsed_identity");

  // Read and chat are unaffected: the same identity can still post.
  const chat = await call(anon.secret, `/rooms/${roomId}/commands`, {
    id: "chat-1", type: "message.posted", data: { messageId: "chat-1", body: "hello" },
  });
  assert.equal(chat.status, 201);
});

test("spawner-bound mint over HTTP: minted_by recorded, born endorsed, vote succeeds", async t => {
  const { store, owner, roomId, call } = await httpFixture(t);
  const res = await call(owner.secret, "/agent-identities", { displayName: "Kid One", spawnerBound: true });
  assert.equal(res.status, 201);
  const child = res.value;
  assert.equal(child.mintedBy, owner.identityId);
  assert.ok(child.secret?.startsWith("pri_"), "child gets a one-time secret");
  const row = store.db.prepare("SELECT minted_by AS m FROM agent_identities WHERE identity_id=?").get(child.identityId);
  assert.equal(row.m, owner.identityId);
  const link = store.db.prepare("SELECT endorsed, endorsed_by AS by FROM identity_links WHERE room_id=? AND identity_id=?")
    .get(roomId, child.identityId);
  assert.deepEqual([link.endorsed, link.by], [1, `spawner:${owner.identityId}`]);

  // The born-endorsed child can vote immediately.
  const poll = await call(owner.secret, `/rooms/${roomId}/commands`, {
    id: "poll-2", type: "message.posted",
    data: { messageId: "poll-2", body: "Pick", kind: "poll", poll: { question: "Q?", options: ["A", "B"] } },
  });
  assert.equal(poll.status, 201);
  const vote = await call(child.secret, `/rooms/${roomId}/commands`, {
    id: "vote-2", type: "message.reaction_set",
    data: { messageId: "poll-2", reaction: POLL_OPTION_EMOJIS[0], active: true },
  });
  assert.equal(vote.status, 201);
});

test("spawner mint requires an authorized spawner", async t => {
  const { store, owner, roomId, call } = await httpFixture(t);
  // No bearer at all.
  const noAuth = await call(null, "/agent-identities", { displayName: "Kid X", spawnerBound: true });
  assert.equal(noAuth.status, 401);
  // An ordinary linked identity is not a spawner.
  const plain = store.identities.create("Plain Jane");
  store.identities.link(owner.secret, roomId, { identityId: plain.identityId, permissions: [] });
  const denied = await call(plain.secret, "/agent-identities", { displayName: "Kid Y", spawnerBound: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.error.code, "not_spawner");
});

test("per-spawner daily cap answers 429 spawner_limit with Retry-After", async t => {
  const store = openStore();
  try {
    const agentRooms = new AgentRooms(store);
    const owner = store.identities.create("Olive");
    agentRooms.create(owner.secret, { title: "Caps", purpose: "cap tests", kind: "personal", roomId: "caps", displayName: "Olive" });
    store.db.prepare("INSERT INTO room_identity_settings(room_id, spawn_mint_cap, updated_at) VALUES(?,?,?)")
      .run("caps", 2, Date.now());
    store.identities.spawnChild({ displayName: "Kid One", spawnerSecret: owner.secret });
    store.identities.spawnChild({ displayName: "Kid Two", spawnerSecret: owner.secret });
    const error = serviceErrorOf(() => store.identities.spawnChild({ displayName: "Kid Three", spawnerSecret: owner.secret }));
    assert.ok(error instanceof ServiceError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "spawner_limit");
    assert.ok(Number(error.headers?.["Retry-After"]) > 0, "Retry-After names the window reset");
    // A spawner mint never spends the anonymous budgets: the anonymous
    // address counter is untouched by the two spawner mints above.
    const anonCount = store.db.prepare("SELECT count(*) AS n FROM agent_identities WHERE mint_address IS NOT NULL").get().n;
    assert.equal(anonCount, 0);
  } finally { store.close(); }
});

test("manual endorsement: owner flips the bit, others get 403, member alias works", async t => {
  const { store, owner, roomId, call } = await httpFixture(t);
  const anon = store.identities.create("Anon Agent");
  store.identities.link(owner.secret, roomId, { identityId: anon.identityId, permissions: [] });
  const other = store.identities.create("Other Agent");
  store.identities.link(owner.secret, roomId, { identityId: other.identityId, permissions: [] });

  // Non-owner cannot endorse.
  const denied = await call(other.secret, `/rooms/${roomId}/identity-endorsements`,
    { identityId: anon.identityId, endorse: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.error.code, "owner_required");

  // Owner endorses via the identity endpoint.
  const endorsed = await call(owner.secret, `/rooms/${roomId}/identity-endorsements`,
    { identityId: anon.identityId, endorse: true });
  assert.equal(endorsed.status, 200);
  assert.equal(endorsed.value.endorsed, true);
  assert.equal(endorsed.value.endorsedBy, `owner:${owner.identityId}`);

  // The endorsement is journaled as a room event.
  const events = store.db.prepare("SELECT body FROM events WHERE room_id=? AND body LIKE '%identity.endorsement_changed%'").all(roomId);
  assert.ok(events.length >= 1, "endorsement flip is journaled");

  // Roster lists the tier state.
  const roster = await call(owner.secret, `/rooms/${roomId}/identity-endorsements`);
  assert.equal(roster.status, 200);
  const anonRow = roster.value.endorsements.find(e => e.identityId === anon.identityId);
  assert.equal(anonRow.endorsed, true);
  assert.equal(anonRow.endorsedBy, `owner:${owner.identityId}`);

  // Member-id alias flips it back off.
  const off = await call(owner.secret, `/rooms/${roomId}/members/${anon.identityId}/endorse`, { endorsed: false });
  assert.equal(off.status, 200);
  assert.equal(off.value.endorsed, false);

  // Unknown identity -> 404.
  const missing = await call(owner.secret, `/rooms/${roomId}/identity-endorsements`,
    { identityId: "ai_nope", endorse: true });
  assert.equal(missing.status, 404);
});

test("room owner can configure the spawner cap 1..1000", async t => {
  const { call, roomId, owner } = await httpFixture(t);
  const read = await call(owner.secret, `/rooms/${roomId}/identity-settings`, undefined, "GET");
  assert.equal(read.status, 200);
  assert.equal(read.value.spawnMintCap, SPAWNER_MINT_DAILY_CAP_DEFAULT);
  const set = await call(owner.secret, `/rooms/${roomId}/identity-settings`, { spawnMintCap: 7 }, "PUT");
  assert.equal(set.status, 200);
  assert.equal(set.value.spawnMintCap, 7);
  const bad = await call(owner.secret, `/rooms/${roomId}/identity-settings`, { spawnMintCap: 0 }, "PUT");
  assert.equal(bad.status, 422);
  const tooHigh = await call(owner.secret, `/rooms/${roomId}/identity-settings`, { spawnMintCap: 1001 }, "PUT");
  assert.equal(tooHigh.status, 422);
});

test("mint_delegate holder (non-owner) is an authorized spawner", () => {
  const store = openStore();
  try {
    const agentRooms = new AgentRooms(store);
    const owner = store.identities.create("Olive");
    agentRooms.create(owner.secret, { title: "Deleg", purpose: "delegate tests", kind: "personal", roomId: "deleg", displayName: "Olive" });
    const delegate = store.identities.create("Dele Gate");
    // The owner confers mint_delegate on an agent member.
    store.identities.link(owner.secret, "deleg", { identityId: delegate.identityId, permissions: ["mint_delegate"] });
    store.identities.setEndorsement(owner.secret, "deleg", { identityId: delegate.identityId, endorsed: true });
    const child = store.identities.spawnChild({ displayName: "Kid Delegate", spawnerSecret: delegate.secret });
    assert.equal(child.mintedBy, delegate.identityId);
    const link = store.db.prepare("SELECT endorsed, endorsed_by AS by FROM identity_links WHERE room_id='deleg' AND identity_id=?")
      .get(child.identityId);
    assert.deepEqual([link.endorsed, link.by], [1, `spawner:${delegate.identityId}`]);
  } finally { store.close(); }
});

test("cluster key: shared mint signals pool, spawner tree feeds the root, solo stays null", () => {
  const store = openStore();
  try {
    ensurePayoutColumns(store.db);
    const a = store.identities.create("Alfa");
    const b = store.identities.create("Bravo");
    const solo = store.identities.create("Solo");
    store.db.prepare("UPDATE agent_identities SET growth_mint_address='digest-same' WHERE identity_id IN (?,?)")
      .run(a.identityId, b.identityId);
    assert.equal(identityClusterKey(store.db, a.identityId), "gx:digest-same");
    assert.equal(identityClusterKey(store.db, b.identityId), "gx:digest-same");
    assert.equal(identityClusterKey(store.db, solo.identityId), null);
    // A spawner child with no signals of its own belongs to the spawner's cluster.
    store.db.prepare("UPDATE agent_identities SET minted_by=? WHERE identity_id=?").run(a.identityId, solo.identityId);
    assert.equal(identityClusterKey(store.db, solo.identityId), "gx:digest-same");
    // A spawner root with no growth signals clusters by root id.
    const root = store.identities.create("Rooty");
    const kid = store.identities.create("Kiddy");
    store.db.prepare("UPDATE agent_identities SET minted_by=? WHERE identity_id=?").run(root.identityId, kid.identityId);
    assert.equal(identityClusterKey(store.db, kid.identityId), `sp:${root.identityId}`);
    assert.equal(identityClusterKey(store.db, root.identityId), null);
  } finally { store.close(); }
});

test("cluster-pooled claim seats: one operator's N identities share maxMemberOpenClaims", async t => {
  const { store, owner, roomId, call } = await httpFixture(t);
  ensurePayoutColumns(store.db);
  // Two identities, one operator (same mint address digest).
  const op1 = store.identities.create("Op One");
  const op2 = store.identities.create("Op Two");
  store.db.prepare("UPDATE agent_identities SET growth_mint_address='digest-op' WHERE identity_id IN (?,?)")
    .run(op1.identityId, op2.identityId);
  for (const op of [op1, op2]) {
    store.identities.link(owner.secret, roomId, { identityId: op.identityId, permissions: ["accept_work", "complete_work"] });
    store.identities.setEndorsement(owner.secret, roomId, { identityId: op.identityId, endorsed: true });
  }
  // A solo identity keeps its own full seat quota (control).
  const solo = store.identities.create("Solo Seat");
  store.identities.link(owner.secret, roomId, { identityId: solo.identityId, permissions: ["accept_work", "complete_work"] });
  store.identities.setEndorsement(owner.secret, roomId, { identityId: solo.identityId, endorsed: true });

  const config = await call(owner.secret, `/rooms/${roomId}/work-claims/config`, { maxMemberOpenClaims: 3 });
  assert.equal(config.status, 200);

  const createAndClaim = async (token, id) => {
    const created = await call(owner.secret, `/rooms/${roomId}/work-claims`, { id, title: id });
    assert.equal(created.status, 201);
    return call(token, `/rooms/${roomId}/work-claims/${id}/claim`, {});
  };
  // Cluster aggregate: op1 takes 2, op2 takes 1 (cluster = 3, at cap).
  assert.equal((await createAndClaim(op1.secret, "seat-1")).status, 200);
  assert.equal((await createAndClaim(op1.secret, "seat-2")).status, 200);
  assert.equal((await createAndClaim(op2.secret, "seat-3")).status, 200);
  // op2's next claim would exceed the cluster's shared 3 seats.
  const refused = await createAndClaim(op2.secret, "seat-4");
  assert.equal(refused.status, 409);
  assert.equal(refused.value.error.code, "too_many_open_claims");
  // The solo identity is unaffected: its own 3 seats are still free.
  assert.equal((await createAndClaim(solo.secret, "seat-5")).status, 200);
  assert.equal((await createAndClaim(solo.secret, "seat-6")).status, 200);
  assert.equal((await createAndClaim(solo.secret, "seat-7")).status, 200);
  const soloRefused = await createAndClaim(solo.secret, "seat-8");
  assert.equal(soloRefused.status, 409);
  assert.equal(soloRefused.value.error.code, "too_many_open_claims");
});

test("cluster-pooled write bucket: one operator's identities share 60/min", async t => {
  const { store, owner, roomId, call } = await httpFixture(t);
  // Two identities minted over HTTP from this client share the mint-address
  // cluster; a third minted in-process stays solo.
  const mintA = await call(null, "/agent-identities", { displayName: "Writer A" });
  const mintB = await call(null, "/agent-identities", { displayName: "Writer B" });
  assert.equal(mintA.status, 201);
  assert.equal(mintB.status, 201);
  const secretA = mintA.value.secret;
  const secretB = mintB.value.secret;
  const solo = store.identities.create("Writer Solo");
  for (const [secret, name] of [[secretA, "Writer A"], [secretB, "Writer B"]]) {
    const id = (secret === secretA ? mintA : mintB).value.identityId;
    store.identities.link(owner.secret, roomId, { identityId: id, permissions: [] });
    void name;
  }
  store.identities.link(owner.secret, roomId, { identityId: solo.identityId, permissions: [] });
  // A message to react to (reactions spend the write bucket but not the
  // per-member chat flood bucket).
  const posted = await call(owner.secret, `/rooms/${roomId}/commands`, {
    id: "wmsg-1", type: "message.posted", data: { messageId: "wmsg-1", body: "react here" },
  });
  assert.equal(posted.status, 201);
  const react = (token, n) => call(token, `/rooms/${roomId}/commands`, {
    id: `wreact-${n}`, type: "message.reaction_set",
    data: { messageId: "wmsg-1", reaction: "👍", active: n % 2 === 0 },
  });
  // 60 writes from A: the cluster bucket fills.
  for (let n = 0; n < 60; n++) {
    const res = await react(secretA, n);
    assert.equal(res.status, 201, `write ${n} from A should pass`);
  }
  // B is in A's cluster: its very next write is refused — 60N/min denied.
  const bRefused = await react(secretB, 1000);
  assert.equal(bRefused.status, 429);
  // The solo identity still has its own full bucket.
  const soloOk = await react(solo.secret, 2000);
  assert.equal(soloOk.status, 201);
});
