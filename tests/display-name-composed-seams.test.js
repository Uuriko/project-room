// CURE-4348 composed-path specimens. The two blockers they pin escaped the
// store/reducer-level suites because production composes differently than
// the unit tests drive:
//  1. The Durable Object (and first seed) installs the room-guide command
//     hook, whose wrapper forwarded only 4 of store.command's 5 arguments —
//     dropping the internal-options argument the account-deletion flow uses
//     to carry membershipEndReason, so the account_deleted stamp never
//     landed in production and the deleted member's name stayed reserved.
//  2. The reducer's reactivation same-name guard fired unconditionally,
//     while the store stamped displayNamePolicyVersion only on member.added
//     — so replaying stored history (whose member.access_changed events
//     carry no stamp) tripped the v3 guard on legacy reactivations.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { installGuideCommandHook } from "../server/room-guide.mjs";
import { EVENT_TYPES as T, applyEvent, event, replay, DISPLAY_NAME_POLICY_VERSION } from "../src/events.js";

function openStore(t, { hook }) {
  const directory = mkdtempSync(join(tmpdir(), "cure-4348-composed-"));
  // A fresh subclass per wiring state: installGuideCommandHook patches the
  // prototype, so the hooked state must not leak into the direct state.
  class Store extends RoomStore {}
  const store = new Store(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  // The DO installs the hook in its constructor, before any command runs
  // (cloudflare/room.mjs); the seed path installs it the same way
  // (server/starter-room.mjs). Mirror that order here.
  if (hook) installGuideCommandHook(store);
  return store;
}

// The account-deletion flow's deactivation, verbatim in shape from
// server/account-deletion.mjs (deactivateBoundMembers): the member's own
// key, a member.access_changed command deactivating them, and the reason
// riding the store's INTERNAL fifth argument — never command data.
function deletionDeactivation(store, memberId) {
  const member = store.room("commons").state.members[memberId];
  const key = store.issueAccessKey("commons", memberId, 60000, "composed-specimen");
  store.command(key, "commons", {
    id: `account-delete-leave-${randomUUID().replaceAll("-", "").slice(0, 32)}`,
    type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false },
  }, null, { membershipEndReason: "account_deleted" });
}

function storedEvents(store, type) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence")
    .all("commons").map(row => JSON.parse(row.body)).filter(parsed => parsed.type === type);
}

function driveDeletion(t, hook) {
  const store = openStore(t, { hook });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "deleted-human", displayName: "Departed", kind: "human", permissions: ["steer"] } });
  deletionDeactivation(store, "deleted-human");
  const ended = store.room("commons").state.members["deleted-human"];
  const accessEvent = storedEvents(store, T.MEMBER_ACCESS_CHANGED).at(-1);
  // The freed name admits the next joiner under the exact name.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "next-human", displayName: "Departed", kind: "human", permissions: ["steer"] } });
  return {
    active: ended.active,
    membershipEndedBy: ended.membershipEndedBy ?? null,
    eventEndReason: accessEvent.data.membershipEndReason ?? null,
    eventEndedBy: accessEvent.data.membershipEndedBy ?? null,
    nextJoinerAdmitted: store.room("commons").state.members["next-human"]?.displayName === "Departed",
  };
}

test("composed: the account-deletion stamp lands identically with the guide hook installed (DO wiring) and direct", async t => {
  const direct = driveDeletion(t, false);
  assert.equal(direct.membershipEndedBy, "account_deleted");
  const hooked = driveDeletion(t, true);
  assert.deepEqual(hooked, direct, "the guide hook must forward store.command's internal-options argument, so the deletion flow stamps account_deleted through the DO wiring exactly as it does direct");
});

// --- Blocker 2: the reactivation guard gates on the policy stamp -----------

function history() {
  let tick = 0;
  const ev = (type, data, actorId = "owner") => event({
    type, actorId, roomId: "commons", id: randomUUID(), idempotencyKey: randomUUID(),
    at: new Date(Date.UTC(2026, 9, 5) + (tick++) * 1000).toISOString(), data,
  });
  const add = (memberId, version) => ev(T.MEMBER_ADDED, { memberId, displayName: "Shared Name", kind: "human", permissions: ["steer"], displayNamePolicyVersion: version });
  const setActive = (state, memberId, active, version) => {
    const m = state.members[memberId];
    return ev(T.MEMBER_ACCESS_CHANGED, {
      memberId, expectedMemberRevision: m.revision, permissions: [...m.permissions], active,
      ...(version != null ? { displayNamePolicyVersion: version } : {}),
    });
  };
  let state = replay([...initialRoom("commons")]);
  state = applyEvent(state, add("first-holder", DISPLAY_NAME_POLICY_VERSION));
  // Stored member.access_changed history carries no policy stamp (the store
  // stamped only member.added before the cure): model it unstamped.
  state = applyEvent(state, setActive(state, "first-holder", false));
  // A distinct member admitted under the v2-era rules actively holds the name.
  state = applyEvent(state, add("second-holder", 2));
  return { state, setActive };
}

test("replay: a legacy (unstamped or v2-stamped) reactivation replays clean; only a v3-stamped reactivation is guarded", () => {
  const legacy = history();
  const unstamped = applyEvent(legacy.state, legacy.setActive(legacy.state, "first-holder", true));
  assert.equal(unstamped.members["first-holder"].active, true, "an unstamped stored reactivation is history, not a live admission: it must not be re-judged by the v3 guard");

  const v2 = history();
  const v2Stamped = applyEvent(v2.state, v2.setActive(v2.state, "first-holder", true, 2));
  assert.equal(v2Stamped.members["first-holder"].active, true, "a v2-stamped reactivation replays under its era's rules");

  const v3 = history();
  assert.throws(
    () => applyEvent(v3.state, v3.setActive(v3.state, "first-holder", true, DISPLAY_NAME_POLICY_VERSION)),
    error => error.code === "display_name_unavailable",
    "a current-stamp (live) reactivation still refuses while a distinct active member holds the name",
  );
});

test("live admission stamps displayNamePolicyVersion on member.access_changed, not only member.added", async t => {
  const store = openStore(t, { hook: false });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "mover", displayName: "Mover", kind: "human", permissions: ["steer"] } });
  const member = store.room("commons").state.members["mover"];
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId: "mover", expectedMemberRevision: member.revision, permissions: member.permissions, active: false } });
  const accessEvent = storedEvents(store, T.MEMBER_ACCESS_CHANGED).at(-1);
  assert.equal(accessEvent.data.displayNamePolicyVersion, DISPLAY_NAME_POLICY_VERSION,
    "the store stamps the policy version at live admission for member.access_changed, so the reducer can tell a live reactivation from stored legacy history");
});
