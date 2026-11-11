// Lane 07 (wave-2700 CONTEXT-FIX) — REPRO A: guest-pass minting in a fresh
// current-format (normalized-current-v1) room, pin
// 8c9deff7534ed549df88b730c03af2d9d3a11db8.
//
// Source: QA-IN-ROOM live reproduction (QA-REPORT.md §5; lane-05 EVIDENCE.md
// steps 2a–2h) + lane-01/lane-02 ROOT-CAUSE.md at the same pin.
//
// The errors catalog at the pin (plugins/project-room/skills/project-room/
// references/errors-catalog.md, `guest_invite_account_session_required`)
// promises: mint with "the owner's signed-in account session
// (POST /api/rooms/{roomId}/guest-invites) or as an owner delegate that
// account granted. An agent identity bearer cannot mint, even as room
// owner". This file encodes exactly that promise in a room created the way
// production rooms are now created (POST /api/agent-rooms — always
// current-format, server/agent-rooms.mjs representation
// 'normalized-current-v1'):
//
//   (a) CONTROL — mint as the agent owner (pri_ identity bearer) is refused
//       403 guest_invite_account_session_required, thrown by design at
//       server/guest-invites.mjs:326 (`!auth.account && !auth.delegate`).
//       Same refusal pinned for legacy rooms by the #3432 test in
//       tests/guest-invite-flow.test.js; here the room format differs.
//   (b) REPRO — mint as the account-granted owner delegate (persisted
//       owner_delegate_grants row created through the owner-only grant
//       route; delegate presents its own pri_ secret, so store.authenticate
//       stamps auth.delegate, server/store.mjs:5265) must SUCCEED (201).
//       On main at the pin this fails 409 current_room_context_required:
//       the mint's expiry sweep (GuestAgentLinks.sweepExpiredAsDelegate,
//       server/guest-agent-links.mjs:144,148) calls the legacy whole-room
//       read store.room(), whose _readProjection refuses current-format
//       rooms at server/store.mjs:4035. This test asserts the promised
//       behaviour, so it FAILS on main for that reason — it is the cure
//       lane's FAIL-on-main / PASS-at-head check.
//   (c) CONTROL — guest-invite list read as the same delegate succeeds
//       (200): list (server/guest-invites.mjs:726) passes the same
//       ownerGate and then reads only the guest_invites table — it never
//       calls store.room(). Matches QA step 2f (list 200 in the same room
//       where mint 409'd).
//
// Fixture shapes are copied from the repo's own suites:
// tests/guest-invite-flow.test.js (#3432 agent-owned room creation),
// tests/owner-delegates.test.js (linkWithProof delegate construction,
// grant route, mint body), tests/helpers/link-with-proof.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-mint-repro-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { store, origin, request };
}

// A fresh current-format room owned by an agent identity, plus a delegate
// constructed exactly as the catalog/code define the grant: a second agent
// identity linked into the room as an active member, then granted through
// the owner-only route POST /api/rooms/{roomId}/owner-delegates/grant.
async function currentRoomFixture(t) {
  const ctx = await serve(t);
  const { store, request } = ctx;
  const owner = store.identities.create("Repro Owner");
  const created = await request("/api/agent-rooms", {
    method: "POST", token: owner.secret,
    data: { roomId: "repro-current-room", title: "Repro current", purpose: "guest mint repro", kind: "personal", displayName: "Repro Owner" },
  });
  assert.equal(created.status, 201, `agent room creation must succeed: ${await created.clone().text()}`);
  const roomId = "repro-current-room";
  // Fixture sanity: the room really is current-format (has a head row), so
  // a pass/fail below is about the format path, not a legacy-room accident.
  assert.ok(
    store.db.prepare("SELECT 1 FROM current_room_head WHERE room_id=?").get(roomId),
    "fixture room must be current-format (current_room_head row present)",
  );

  const delegateIdentity = store.identities.create("Repro Delegate");
  linkWithProof(store, owner.secret, roomId, delegateIdentity, {
    displayName: "Repro Delegate",
    permissions: ["accept_work", "complete_work", "steer", "verify"],
  });
  const grant = await request(`/api/rooms/${roomId}/owner-delegates/grant`, {
    method: "POST", token: owner.secret, data: { identityId: delegateIdentity.identityId },
  });
  assert.equal(grant.status, 200, `owner-delegate grant must succeed (QA step 2c shape): ${await grant.clone().text()}`);
  const grantRow = store.db.prepare(
    "SELECT revoked_at FROM owner_delegate_grants WHERE room_id=? AND identity_id=?",
  ).get(roomId, delegateIdentity.identityId);
  assert.ok(grantRow && grantRow.revoked_at === null, "grant row persisted and active");

  const authority = store.roomAuthority(roomId);
  const mintBody = {
    requestId: randomUUID(),
    guestLabel: "Repro visit",
    expectedOwnerRevision: authority.members[authority.ownerId].revision,
  };
  return { ...ctx, owner, delegateIdentity, roomId, mintBody };
}

test("(a) CONTROL: agent owner mint is refused 403 guest_invite_account_session_required by design", async t => {
  const { request, owner, roomId, mintBody } = await currentRoomFixture(t);
  const res = await request(`/api/rooms/${roomId}/guest-invites`, {
    method: "POST", token: owner.secret, data: mintBody,
  });
  const body = await res.json();
  assert.equal(res.status, 403, `agent owner mint must be refused 403, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.error.code, "guest_invite_account_session_required");
});

test("(c) CONTROL: delegate guest-invite list read succeeds in the same current-format room", async t => {
  const { request, delegateIdentity, roomId } = await currentRoomFixture(t);
  const res = await request(`/api/rooms/${roomId}/guest-invites-list`, {
    method: "POST", token: delegateIdentity.secret, data: {},
  });
  const body = await res.json();
  assert.equal(res.status, 200, `delegate list must succeed, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body), "list returns an array of invites");
});

test("(b) REPRO: account-granted owner delegate mints a guest invite in a current-format room", async t => {
  const { store, request, delegateIdentity, roomId, mintBody } = await currentRoomFixture(t);
  const res = await request(`/api/rooms/${roomId}/guest-invites`, {
    method: "POST", token: delegateIdentity.secret, data: mintBody,
  });
  const body = await res.json().catch(async () => ({ raw: await res.text() }));
  assert.equal(
    res.status, 201,
    `catalog promise: a granted owner delegate can mint; got ${res.status}: ${JSON.stringify(body)}`,
  );
  assert.ok(typeof body.code === "string" && body.code.startsWith("GX-"), "mint returns a GX- invite code");
  const row = store.db.prepare(
    "SELECT minted_by_member_id, minted_by_account_id FROM guest_invites WHERE room_id=?",
  ).get(roomId);
  assert.ok(row, "invite row persisted");
  assert.equal(row.minted_by_account_id, null, "delegate mint is accountless");
});
