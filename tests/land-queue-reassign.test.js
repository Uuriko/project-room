// Land queue claimant reassignment gate (#3905): re-adding a pull request
// that is already queued with a DIFFERENT claimant is a reassignment, and
// only the current claimant, the room owner, or a member holding
// manage_members may make it. Initial filing may still name another member
// as claimant (the documented coordinator workflow), and a duplicate add
// naming the same claimant is not a reassignment. GitHub is mocked, as in
// tests/land-queue.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const SHA = "a".repeat(40);
const TOKEN = "<redacted>";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-reassign-"));
  const clock = { now: Date.parse("2026-09-24T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, clock, roomId: "commons" };
}

function snapshot() {
  return {
    pr: {
      title: "Land the queue",
      merged: false,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: SHA }
    },
    status: { state: "pending" },
    checks: { check_runs: [{ status: "in_progress", conclusion: null }] }
  };
}

function mockGitHub() {
  const fetchImpl = async url => {
    const scene = snapshot();
    let body = scene.pr;
    if (url.includes("/check-runs")) body = scene.checks;
    else if (url.endsWith("/status")) body = scene.status;
    return { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl };
}

function linkMember(store, ownerKey, displayName) {
  const identity = store.identities.create(displayName);
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName, permissions: []
  });
  return linked.memberId;
}

function addPlainMember(store, ownerKey, memberId, displayName, permissions) {
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId, displayName, kind: "agent", permissions }
  });
  return memberId;
}

function landEvents(store, roomId = "commons") {
  return store.db.prepare(
    "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence"
  ).all(roomId, T.LAND_UPDATED).map(row => JSON.parse(row.body));
}

function setup(t) {
  const { store, ownerKey } = fixture(t);
  store.landQueue.configure({ token: TOKEN, fetchImpl: mockGitHub().fetchImpl });
  const claimant = linkMember(store, ownerKey, "Claimant");
  const successor = linkMember(store, ownerKey, "Successor");
  const thirdParty = addPlainMember(store, ownerKey, "thirdparty", "Third Party", []);
  const manager = addPlainMember(store, ownerKey, "manager", "Manager", ["manage_members"]);
  return { store, ownerKey, claimant, successor, thirdParty, manager };
}

test("initial filing may name another member as claimant", async t => {
  const { store, claimant } = setup(t);
  const added = await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: claimant
  });
  assert.equal(added.item.claimantMemberId, claimant);
  assert.equal(added.item.addedByMemberId, "owner");
  assert.equal(store.workClaims.get("commons", added.item.itemId).owner, claimant);
});

test("a third party cannot reassign an existing item's claimant", async t => {
  const { store, claimant, thirdParty } = setup(t);
  const added = await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: claimant
  });
  await assert.rejects(
    () => store.landQueue.add("commons", thirdParty, {
      repo: "acme/demo", prNumber: 969, claimantMemberId: thirdParty
    }),
    error => error.status === 403 && error.code === "access_denied"
  );
  // The row, the mirrored claim, and the event log all still name the
  // original claimant: no reassignment and no "reassigned" receipt.
  assert.equal(store.landQueue.list("commons", "owner").items[0].claimantMemberId, claimant);
  assert.equal(store.workClaims.get("commons", added.item.itemId).owner, claimant);
  assert.deepEqual(landEvents(store).map(event => event.data.changed), [["added"]]);
});

test("the current claimant can reassign their own item", async t => {
  const { store, claimant, successor } = setup(t);
  await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: claimant
  });
  const moved = await store.landQueue.add("commons", claimant, {
    repo: "acme/demo", prNumber: 969, claimantMemberId: successor
  });
  assert.equal(moved.item.claimantMemberId, successor);
  assert.equal(store.workClaims.get("commons", moved.item.itemId).owner, successor);
  assert.deepEqual(landEvents(store).map(event => event.data.changed), [["added"], ["reassigned"]]);
});

test("a manage_members holder can reassign another member's item", async t => {
  const { store, claimant, successor, manager } = setup(t);
  await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: claimant
  });
  const moved = await store.landQueue.add("commons", manager, {
    repo: "acme/demo", prNumber: 969, claimantMemberId: successor
  });
  assert.equal(moved.item.claimantMemberId, successor);
  assert.equal(store.workClaims.get("commons", moved.item.itemId).owner, successor);
});

test("the room owner can reassign another member's item", async t => {
  const { store, claimant, successor } = setup(t);
  await store.landQueue.add("commons", claimant, { repo: "acme/demo", prNumber: 969 });
  const moved = await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: successor
  });
  assert.equal(moved.item.claimantMemberId, successor);
});

test("a duplicate add naming the same claimant is not a reassignment", async t => {
  const { store, claimant, thirdParty } = setup(t);
  await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: claimant
  });
  const again = await store.landQueue.add("commons", thirdParty, {
    repo: "acme/demo", prNumber: 969, claimantMemberId: claimant
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.item.claimantMemberId, claimant);
});
