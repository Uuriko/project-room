// #650: A2A agent-card set completion — per-room cards, registry skill
// query, and deploy-aware fields. (Item 1, the well-known server card,
// already shipped and is covered by tests/agent-card-wellknown.test.js.)
//
// Authoring gate:
// 1. Contract: GET /api/rooms/{id}/agent-card respects room visibility
//    EXACTLY (invisible == nonexistent, same status/code/message/body);
//    GET /api/agent-directory/cards?skill=&capability= filters the signed
//    directory; every card surface carries live sourceRevision/buildId.
// 2. Credible regression: a refactor leaks a private room's existence or
//    title, lets a query surface unpublished cards, or hardcodes a
//    revision string that drifts from server/version.mjs.
// 3. Existing coverage: room-directory.test.js owns the listing shape;
//    agent-directory-a2a.test.mjs owns the A2A projection. This file owns
//    the #650 remainder.
// 4. No production seams: visibility is decided by RoomDirectory.agentCard
//    over the same store state the listing uses.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
// (no fs fixtures: in-memory store)
// 
// 
import { RoomDirectory, roomDirectorySchema } from "../server/room-directory.mjs";
import { roomPublicFaceSchema } from "../server/public-face.mjs";
import { PUBLIC_READ_MODEL_SCHEMA } from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";
import { createAgentDirectory } from "../server/agent-directory.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { agentCard } from "../server/agent-discovery.mjs";
import { deployFields, SOURCE_REVISION, BUILD_ID } from "../server/version.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(roomDirectorySchema);
  db.exec(roomPublicFaceSchema);
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, archived_at TEXT)");
  const insertRoom = db.prepare("INSERT INTO rooms (id, archived_at) VALUES (?, ?)");
  for (const [id, { archived = false }] of Object.entries(states)) insertRoom.run(id, archived ? "2026-09-20" : null);
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const entry = states[id];
      return entry ? { state: entry.state } : null;
    }
  };
}

const stateFor = (id, { ownerId = "owner", title = "Build week", purpose = "Ship the thing", kind = "personal" } = {}) => ({
  state: {
    room: { id, title, purpose, kind, ownerId, createdAt: 1000 },
    members: {
      [ownerId]: member(ownerId, "Olivia Owner"),
      alice: { ...member("alice", "Alice"), email: "alice@example.com", identityId: "idt_1" },
      ghost: member("ghost", "Ghost", false),
    },
  }
});

const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("per-room card: discoverable room is readable anonymously, with public facts only", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  dir.set("r1", "owner", true);
  const card = dir.agentCard("r1", null);
  assert.equal(card.name, "Build week");
  assert.equal(card.purpose, "Ship the thing");
  assert.equal(card.kind, "personal");
  assert.equal(card.memberCount, 2);
  assert.equal(card.visibility, "discoverable");
  assert.deepEqual(card.openJoin, { discoverable: true, policy: "request-access", mechanisms: ["access-request", "invite", "share-link"] });
  assert.deepEqual(card.requiredAuth, ["bearerAuth", "guestLinkAuth"]);
  const serialized = JSON.stringify(card);
  assert.ok(!serialized.includes("alice@example.com"), "no emails leak");
  assert.ok(!serialized.includes("idt_1"), "no identity ids leak");
  assert.ok(!serialized.includes("Olivia Owner"), "no member handles leak");
  assert.ok(!serialized.includes("alice"), "no member ids leak");
});

test("per-room card: invisible room is indistinguishable from a nonexistent room", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  const invisible = errOf(() => dir.agentCard("r1", null));
  const absent = errOf(() => dir.agentCard("no-such-room", null));
  assert.ok(invisible && absent);
  assert.equal(invisible.status, 404);
  assert.deepEqual(
    { status: invisible.status, code: invisible.code, message: invisible.message },
    { status: absent.status, code: absent.code, message: absent.message });
  // A non-member credential changes nothing; an inactive member neither.
  assert.equal(errOf(() => dir.agentCard("r1", "mallory")).code, "room_not_found");
  assert.equal(errOf(() => dir.agentCard("r1", "ghost")).code, "room_not_found");
  // Prototype ids must not pose as members (ownMember, src/events.js).
  assert.equal(errOf(() => dir.agentCard("r1", "toString")).code, "room_not_found");
  assert.equal(errOf(() => dir.agentCard("r1", "constructor")).code, "room_not_found");
});

test("per-room card: an active member reads an unlisted room's card", () => {
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  const card = dir.agentCard("r1", "alice");
  assert.equal(card.name, "Build week");
  assert.equal(card.visibility, "members-only");
  assert.deepEqual(card.openJoin, { discoverable: false, policy: "invite-only", mechanisms: ["invite", "share-link"] });
});

test("per-room card: archived rooms stay invisible even when flagged discoverable", () => {
  const store = makeStore({ r2: { ...stateFor("r2"), archived: true } });
  const dir = new RoomDirectory(store);
  dir.set("r2", "owner", true);
  assert.equal(errOf(() => dir.agentCard("r2", null)).code, "room_not_found");
});

test("deploy fields are the live stamped values, never hardcoded", () => {
  const fields = deployFields();
  const unstamped = SOURCE_REVISION === "unstamped" || BUILD_ID === "unstamped";
  assert.equal(fields.sourceRevision, unstamped ? "dev" : SOURCE_REVISION);
  assert.equal(fields.buildId, unstamped ? "dev" : BUILD_ID);
  // Server card (item 1 surface) carries the filed top-level names with the
  // same values as its deployed{} block.
  const server = agentCard();
  assert.equal(server.sourceRevision, server.deployed.revision);
  assert.equal(server.buildId, server.deployed.buildId);
  // Per-room card carries them too.
  const store = makeStore({ r1: stateFor("r1") });
  const dir = new RoomDirectory(store);
  dir.set("r1", "owner", true);
  const room = dir.agentCard("r1", null);
  assert.equal(room.sourceRevision, fields.sourceRevision);
  assert.equal(room.buildId, fields.buildId);
});

const CARD_A = {
  name: "Verifier", description: "Checks work.", url: "https://agents.example/verifier",
  capabilities: ["webhooks"], skills: ["verification"], version: "1.0.0",
};
const CARD_B = {
  name: "Builder", description: "Builds things.", url: "https://agents.example/builder",
  capabilities: ["code"], skills: ["building"], version: "1.0.0",
};

const publishSigned = (dir, { agentId, card, visibility } = {}) => {
  const keyPair = generateKeyPair();
  const signature = signCard({ agentId, card, privateKey: keyPair.privateKey });
  return dir.publish({ agentId, card, visibility, publicKey: keyPair.publicKey, signature });
};

test("registry query: skill and capability filters compose; unpublished cards stay unlisted", () => {
  const dir = createAgentDirectory();
  publishSigned(dir, { agentId: "verifier", card: CARD_A });
  publishSigned(dir, { agentId: "builder", card: CARD_B });
  publishSigned(dir, { agentId: "hidden-verifier", card: CARD_A, visibility: "private" });
  assert.deepEqual(dir.list({ skill: "verification" }).map(c => c.agentId), ["verifier"]);
  assert.deepEqual(dir.list({ capability: "webhooks" }).map(c => c.agentId), ["verifier"]);
  assert.deepEqual(dir.list({ skill: "verification", capability: "webhooks" }).map(c => c.agentId), ["verifier"]);
  assert.deepEqual(dir.list({ skill: "verification", capability: "code" }), []);
  assert.deepEqual(dir.list({ skill: "nope" }), []);
  // Directory card docs carry the deploy-aware fields (item 4).
  const [doc] = dir.list({ skill: "verification" });
  assert.equal(doc.sourceRevision, deployFields().sourceRevision);
  assert.equal(doc.buildId, deployFields().buildId);
});

async function serve(t) {
  // In-memory store (the RoomStore(":memory:") pattern used by other HTTP
  // suites): this test's subject is routing/visibility, not durability.
  const store = new RoomStore(":memory:");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

const jsonFetch = async (base, path, { method = "GET", token = null, body = null } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* HEAD / non-JSON */ }
  return { status: res.status, body: parsed, text };
};

test("HTTP: per-room card visibility oracle and registry query path", async t => {
  const { base, store } = await serve(t);
  // Mint an identity (proof challenge solved if the server asks for one).
  let mint = await jsonFetch(base, "/api/agent-identities", { method: "POST", body: { displayName: "Card Probe" } });
  if (mint.status === 428 && mint.body?.proof) {
    const { createHash } = await import("node:crypto");
    const proof = mint.body.proof;
    const bucket = proof.acceptBuckets[0];
    let nonce = null;
    for (let i = 0; i < 2_000_000 && nonce === null; i++) {
      const candidate = `n${i}`;
      const hash = createHash("sha256").update(`${bucket}:Card Probe:${candidate}`).digest("hex");
      if (hash.startsWith(proof.prefix)) nonce = candidate;
    }
    assert.ok(nonce, "proof nonce found");
    mint = await jsonFetch(base, "/api/agent-identities", { method: "POST", body: { displayName: "Card Probe", proof: nonce } });
  }
  assert.equal(mint.status, 201, `mint: ${mint.text}`);
  const secret = mint.body.identitySecret ?? mint.body.secret;
  assert.ok(secret, "identity secret returned");

  const room = await jsonFetch(base, "/api/agent-rooms", { method: "POST", token: secret, body: { title: "Card Room", purpose: "Probe the card", starter: false } });
  assert.equal(room.status, 201, `room create: ${room.text}`);
  const roomId = room.body.roomId;
  const ownerMemberId = room.body.ownerMemberId ?? room.body.memberId;
  assert.ok(roomId && ownerMemberId, "room ids returned");

  // Anonymous + unlisted: identical 404 to a nonexistent room. The error
  // envelope carries a per-request operationId diagnostic (true of every
  // error on this server, including its own room_not_found responses), so
  // the comparison strips exactly that field — status, code, message,
  // hint, and next[] must match byte-for-byte otherwise.
  const invisible = await jsonFetch(base, `/api/rooms/${roomId}/agent-card`);
  const absent = await jsonFetch(base, "/api/rooms/no-such-room-650/agent-card");
  assert.equal(invisible.status, 404);
  assert.equal(absent.status, 404);
  const stripOperationId = body => { const { operationId, ...rest } = body; assert.ok(operationId, "operationId present"); return rest; };
  assert.deepEqual(stripOperationId(invisible.body), stripOperationId(absent.body));
  assert.equal(invisible.body.error.code, "room_not_found");

  // The owner member reads the card with the identity bearer.
  const memberView = await jsonFetch(base, `/api/rooms/${roomId}/agent-card`, { token: secret });
  assert.equal(memberView.status, 200, `member card: ${memberView.text}`);
  assert.equal(memberView.body.name, "Card Room");
  assert.equal(memberView.body.visibility, "members-only");
  assert.equal(memberView.body.sourceRevision, deployFields().sourceRevision);
  assert.equal(memberView.body.buildId, deployFields().buildId);

  // Once the owner lists the room, anonymous reads succeed.
  store.roomDirectory.set(roomId, ownerMemberId, true);
  const publicView = await jsonFetch(base, `/api/rooms/${roomId}/agent-card`);
  assert.equal(publicView.status, 200, `public card: ${publicView.text}`);
  assert.equal(publicView.body.visibility, "discoverable");
  assert.equal(publicView.body.openJoin.policy, "request-access");

  // Registry query path serves the directory document anonymously.
  const registry = await jsonFetch(base, "/api/agent-directory/cards?skill=verification&capability=webhooks");
  assert.equal(registry.status, 200, `registry: ${registry.text}`);
  assert.ok(Array.isArray(registry.body.agents));
  assert.deepEqual(registry.body.agents, []);
});
