// Identity-sybil guild — attribution primitive: every event written for an
// authenticated request carries the authenticated identityId in its envelope.
// The identityId is resolved at auth and must survive to persistence; readers
// treat a missing field as "unknown" (the unattributed-gap signal).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T, event, applyEvent, emptyRoomState } from "../src/events.js";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}

function linkIdentity(f, displayName = "Stamped agent") {
  const agent = f.store.identities.create(displayName);
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, permissions: ["accept_work"] });
  return agent;
}

const post = (f, token, body) => f.store.command(token, "commons", {
  id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body }
});

const persistedBody = (f, sequence) => JSON.parse(
  f.store.db.prepare("SELECT body FROM events WHERE room_id=? AND sequence=?").get("commons", sequence).body);

test("command() with identity-secret auth stamps the authenticated identityId into the event envelope", t => {
  const f = fixture(t);
  const agent = linkIdentity(f);
  const result = post(f, agent.secret, "hello from the identity");
  // The returned event and the persisted row agree.
  assert.equal(result.event.identityId, agent.identityId);
  assert.equal(persistedBody(f, result.sequence).identityId, agent.identityId);
  // The stamp rides next to actorId (member id), not inside data.
  assert.equal(result.event.actorId, agent.identityId);
  assert.equal(result.event.data.identityId, undefined);
});

test("command() with legacy access-key auth stamps the linked identityId via the identity-links fallback", t => {
  const f = fixture(t);
  const agent = linkIdentity(f);
  const legacyKey = f.store.issueAccessKey("commons", agent.identityId);
  const result = post(f, legacyKey, "hello via legacy key");
  assert.equal(result.event.identityId, agent.identityId);
  assert.equal(persistedBody(f, result.sequence).identityId, agent.identityId);
});

test("command() for a member with no identity link stamps null — the honest unknown signal", t => {
  const f = fixture(t);
  const result = post(f, f.keys.owner, "owner speaks");
  assert.equal(result.event.identityId, null);
  assert.equal(persistedBody(f, result.sequence).identityId, null);
});

test("the envelope identityId is server-stamped from auth, never copied from command data", t => {
  const f = fixture(t);
  const agentB = f.store.identities.create("Second agent"); // linked to nobody
  // member.added is the one command type whose data legitimately carries an
  // identityId (the new member's identity binding). The envelope must still
  // say who acted (the human owner: no link → null), not who was added.
  const result = f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED, data: {
      memberId: "spoof-member", displayName: "Spoof Member", kind: "agent",
      permissions: ["accept_work"], identityId: agentB.identityId
    }
  });
  assert.equal(result.event.identityId, null);
  assert.equal(result.event.data.identityId, agentB.identityId);
});

test("events without the envelope field keep validating and replaying — missing means unknown", t => {
  // A legacy envelope: every field the constructor used to emit, no identityId.
  const legacy = event({ type: T.ROOM_CREATED, roomId: "legacy-room", actorId: "owner-1",
    data: { roomId: "legacy-room", title: "t", purpose: "p", ownerId: "owner-1" } });
  delete legacy.identityId;
  assert.ok(!("identityId" in legacy));
  const state = applyEvent(emptyRoomState(), legacy);
  assert.equal(state.room.id, "legacy-room");
  // The constructor defaults a missing stamp to null: unknown, not absent.
  assert.equal(event({ type: T.MESSAGE_POSTED, roomId: "r", actorId: "m", data: {} }).identityId, null);
});
