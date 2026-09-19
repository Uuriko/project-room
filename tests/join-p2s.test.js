// RC-2026-09-19-071: P2 join-flow fixes from the 2026-09-19 QA audit.
//
// QAJ-001: a bad/expired invite dialog was a dead end — the request-access
// door in the invite UI lets a stranger with a dead link ask to join instead
// of bouncing. The door policy (which previews qualify, form validation, the
// per-room identity stash) lives in src/invite-context.js as pure functions;
// these tests pin that contract.
//
// QAJ-006: access requests fired no owner notification — a new request now
// appends an access.requested room event (timeline-visible) and raises an
// access_request notification for the room owner. These tests pin the event
// emission, the owner-only notification derivation, idempotent-retry silence,
// and the archived-room behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { deriveNotifications } from "../server/notifications.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  REQUESTABLE_INVITE_STATUSES,
  inviteRequestDoor,
  defaultRequestPermissions,
  FALLBACK_REQUEST_PERMISSIONS,
  validateAccessRequestForm,
  newAccessRequestId,
  accessRequestStorageKey,
  stashAccessRequest,
  readAccessRequest,
} from "../src/invite-context.js";

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-p2s-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, ownerToken, identity };
}

const requestEvents = (store, roomId = "commons") =>
  store.db.prepare("SELECT id, body FROM events WHERE room_id=?").all(roomId)
    .map(r => ({ id: r.id, event: JSON.parse(r.body) }))
    .filter(r => r.event.type === T.ACCESS_REQUESTED);

// --- QAJ-001: the request-access door -------------------------------------

test("QAJ-001: door opens for dead invites that name the room, stays shut otherwise", () => {
  assert.deepEqual(inviteRequestDoor({ status: "expired", roomId: "room-1", roomTitle: "Club" }),
    { roomId: "room-1", roomTitle: "Club" });
  assert.deepEqual(inviteRequestDoor({ status: "revoked", roomId: "room-1" }),
    { roomId: "room-1", roomTitle: "Project Room" });
  assert.deepEqual(inviteRequestDoor({ status: "stale", roomId: "room-1", roomTitle: "Club" }).roomId, "room-1");
  assert.deepEqual([...REQUESTABLE_INVITE_STATUSES].sort(), ["expired", "revoked", "stale"]);
  // Live or already-consumed invitations keep their own flows — no door.
  assert.equal(inviteRequestDoor({ status: "pending", roomId: "room-1" }), null);
  assert.equal(inviteRequestDoor({ status: "accepted", roomId: "room-1" }), null);
  // No preview (invalid token, failed preview): the room is unknown, so
  // there is nowhere to request access to — the door stays shut.
  assert.equal(inviteRequestDoor(null), null);
  assert.equal(inviteRequestDoor(undefined), null);
  assert.equal(inviteRequestDoor({ status: "expired" }), null);
  assert.equal(inviteRequestDoor({ status: "expired", roomId: "" }), null);
});

test("QAJ-001: requested permissions default to the dead invite's grant, else a minimal ask", () => {
  assert.deepEqual(defaultRequestPermissions({ permissions: ["steer", "accept_work"] }), ["steer", "accept_work"]);
  assert.deepEqual(defaultRequestPermissions({ permissions: [] }), [...FALLBACK_REQUEST_PERMISSIONS]);
  assert.deepEqual(defaultRequestPermissions({}), [...FALLBACK_REQUEST_PERMISSIONS]);
  assert.deepEqual(defaultRequestPermissions(null), [...FALLBACK_REQUEST_PERMISSIONS]);
});

test("QAJ-001: form validation mirrors the server limits before any network call", () => {
  assert.deepEqual(validateAccessRequestForm({ displayName: "  Ada  ", note: " hi " }),
    { ok: true, displayName: "Ada", note: "hi" });
  assert.deepEqual(validateAccessRequestForm({ displayName: "Ada" }),
    { ok: true, displayName: "Ada", note: null });
  assert.equal(validateAccessRequestForm({ displayName: "   " }).ok, false);
  assert.equal(validateAccessRequestForm({ displayName: "" }).ok, false);
  assert.equal(validateAccessRequestForm({ displayName: "x".repeat(81) }).ok, false);
  assert.equal(validateAccessRequestForm({ displayName: "Ada", note: "x".repeat(501) }).ok, false);
});

test("QAJ-001: request ids match the server's idempotency-key pattern", () => {
  for (let i = 0; i < 25; i++) {
    const id = newAccessRequestId();
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, `request id ${id}`);
  }
  assert.equal(new Set(Array.from({ length: 25 }, newAccessRequestId)).size, 25, "ids are unique");
});

test("QAJ-001: the per-room identity stash round-trips and is room-scoped", () => {
  const storage = fakeStorage();
  assert.equal(readAccessRequest(storage, "room-1"), null);
  stashAccessRequest(storage, "room-1", { identityId: "ai_abc", secret: "pri_xyz", requestId: "ar_1", displayName: "Ada" });
  assert.deepEqual(readAccessRequest(storage, "room-1"),
    { identityId: "ai_abc", secret: "pri_xyz", requestId: "ar_1", displayName: "Ada" });
  assert.equal(readAccessRequest(storage, "room-2"), null, "stash is keyed per room");
  assert.ok(accessRequestStorageKey("room-1").includes("room-1"));
  // Malformed or incomplete records never surface.
  assert.equal(readAccessRequest(fakeStorage({ [accessRequestStorageKey("r")]: "not-json" }), "r"), null);
  stashAccessRequest(storage, "room-3", { identityId: "", requestId: "ar_2" });
  assert.equal(readAccessRequest(storage, "room-3"), null);
});

// --- QAJ-006: owner notification on new access requests --------------------

test("QAJ-006: a new access request appends an access.requested timeline event", async t => {
  const { store, requests, identity } = setup(t);
  const before = store.room("commons").sequence;
  const created = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"],
    note: "I can triage.",
    requestId: "p2s-req-1",
  });
  assert.equal(created.status, "pending");
  const events = requestEvents(store);
  assert.equal(events.length, 1, "exactly one access.requested event");
  const { event } = events[0];
  assert.equal(event.type, "access.requested");
  assert.equal(event.roomId, "commons");
  assert.equal(event.actorId, identity.identityId);
  assert.deepEqual(event.data, {
    requestId: "p2s-req-1",
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    permissions: ["accept_work"],
    note: "I can triage.",
  });
  assert.equal(store.room("commons").sequence, before + 1, "room sequence advances");
  // The event replays cleanly through the projection.
  const room = store.room("commons");
  assert.ok(room.state, "projection still parses after the new event type");
});

test("QAJ-006: the room owner gets an access_request notification; nobody else does", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"],
    note: "Let me in.",
    requestId: "p2s-req-2",
  });
  const feed = store.notifications.list(ownerToken, "commons");
  const items = feed.notifications.filter(item => item.kind === "access_request");
  assert.equal(items.length, 1, "owner sees one access_request item");
  const item = items[0];
  assert.equal(item.requestId, "p2s-req-2");
  assert.equal(item.displayName, "Requesting Agent");
  assert.equal(item.note, "Let me in.");
  assert.ok(item.eventId, "item links to the timeline event");
  assert.ok(item.sequence > 0 && item.at, "item carries sequence and timestamp");
});

test("QAJ-006: access_request notifies the owner only (deriveNotifications)", () => {
  const row = {
    sequence: 7,
    event: {
      id: "evt-access-1",
      type: T.ACCESS_REQUESTED,
      roomId: "commons",
      actorId: "ai_stranger",
      at: new Date().toISOString(),
      data: {
        requestId: "ar-x",
        identityId: "ai_stranger",
        displayName: "Ada",
        permissions: ["accept_work"],
        note: null,
      },
    },
  };
  const state = { room: { id: "commons", ownerId: "owner" }, members: { owner: { id: "owner" } }, messages: [], workItems: {} };
  const forOwner = deriveNotifications({ events: [row], state, member: { id: "owner" } });
  assert.equal(forOwner.length, 1);
  assert.equal(forOwner[0].kind, "access_request");
  assert.equal(forOwner[0].requestId, "ar-x");
  const forOther = deriveNotifications({ events: [row], state, member: { id: "someone-else" } });
  assert.equal(forOther.length, 0, "non-owners get no access_request item");
});

test("QAJ-006: idempotent retry of a request emits no duplicate event", async t => {
  const { store, requests, identity } = setup(t);
  const first = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "p2s-req-3",
  });
  const retry = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "p2s-req-3",
  });
  assert.equal(retry.requestId, first.requestId);
  assert.equal(requestEvents(store).length, 1, "retry reuses the original, emits nothing new");
});

test("QAJ-006: archived rooms record the request without a timeline event", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  store.command(ownerToken, "commons", { id: randomUUID(), type: "room.archived", data: {} });
  const created = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "p2s-req-4",
  });
  assert.equal(created.status, "pending", "request still records (unchanged behavior)");
  assert.equal(requestEvents(store).length, 0, "no timeline event for an archived room");
});
