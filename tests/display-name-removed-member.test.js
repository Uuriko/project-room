// QA card qa-name-reuse-after-removal: display-name uniqueness in a room
// survives member removal. A removed member's name stays reserved in that
// room — a NEW identity may not redeem/join under the exact name (or a
// confusable spelling), while a different name joins, the same identity's
// own record never blocks the identity itself, and pre-v3 policy stamps
// keep replaying under the rules they were admitted with.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, applyEvent, event, replay, DISPLAY_NAME_POLICY_VERSION } from "../src/events.js";
import { assessMemberDisplayName } from "../server/display-name-guard.mjs";

const post = async (origin, path, body, token) => {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
};

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-name-reuse-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` };
}

function setMemberActive(store, ownerKey, memberId, active) {
  const member = store.room("commons").state.members[memberId];
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active },
  });
  return store.room("commons").state.members[memberId];
}

test("a removed member's name stays reserved: fresh redeem under the exact name is refused, a different name joins, reactivation keeps the name", async t => {
  const { store, ownerKey, origin } = await serve(t);

  const invite1 = store.invites.create(ownerKey, "commons", { profile: "chat" });
  const ann = await post(origin, "/api/agent-invites/redeem", { code: invite1.code, displayName: "FLEET-QA Ann" });
  assert.equal(ann.status, 201);
  const annId = ann.json.memberId;
  assert.equal(store.room("commons").state.members[annId].active, true);

  // Control: while Ann is active, the exact name is refused (existing behaviour).
  const invite2 = store.invites.create(ownerKey, "commons", { profile: "chat" });
  const whileActive = await post(origin, "/api/agent-invites/redeem", { code: invite2.code, displayName: "FLEET-QA Ann" });
  assert.equal(whileActive.status, 422);
  assert.equal(whileActive.json.error.code, "display_name_unavailable");
  assert.equal(whileActive.json.displayNameReason, "duplicate");

  // Remove Ann. Her messages and member record stay; the record goes inactive.
  const removed = setMemberActive(store, ownerKey, annId, false);
  assert.equal(removed.active, false);
  assert.equal(removed.displayName, "FLEET-QA Ann");

  // The defect: a brand-new identity (no credential) redeems under the exact
  // name of the removed member. Must be refused; at the pre-fix base this
  // returned 201 and minted a second "FLEET-QA Ann".
  const identitiesBefore = store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
  const reuse = await post(origin, "/api/agent-invites/redeem", { code: invite2.code, displayName: "FLEET-QA Ann" });
  assert.equal(reuse.status, 422, reuse.text);
  assert.equal(reuse.json.error.code, "display_name_unavailable");
  assert.equal(reuse.json.displayNameReason, "duplicate");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n, identitiesBefore, "a refused redeem writes no identity");
  const holders = Object.values(store.room("commons").state.members).filter(m => m.displayName === "FLEET-QA Ann");
  assert.equal(holders.length, 1, "exactly one member record holds the removed member's name");
  assert.equal(holders[0].id, annId);

  // A confusable spelling of the removed member's name is refused too.
  const lookalike = await post(origin, "/api/agent-invites/redeem", { code: invite2.code, displayName: "FLEET-QA Аnn" });
  assert.equal(lookalike.status, 422, lookalike.text);
  assert.equal(lookalike.json.error.code, "display_name_unavailable");

  // A genuinely different name still joins on the same unburned code.
  const other = await post(origin, "/api/agent-invites/redeem", { code: invite2.code, displayName: "FLEET-QA Anne" });
  assert.equal(other.status, 201, other.text);
  assert.equal(other.json.displayName, "FLEET-QA Anne");

  // The same identity re-joining (owner reactivation of her own record)
  // keeps its name — no new record, no rename.
  const back = setMemberActive(store, ownerKey, annId, true);
  assert.equal(back.active, true);
  assert.equal(back.displayName, "FLEET-QA Ann");
});

test("guard: includeInactive reserves removed members' names, excludeId spares the returning identity, default semantics unchanged", () => {
  const members = {
    owner: { id: "owner", displayName: "Room owner", active: true },
    gone: { id: "ai_gone", displayName: "Retired", active: false },
  };
  // Default (replay and non-admission callers): an inactive member does not block.
  assert.equal(assessMemberDisplayName("Retired", members).available, true);
  // Admission opt-in: the removed member's exact name and lookalikes block.
  const exact = assessMemberDisplayName("Retired", members, { includeInactive: true });
  assert.equal(exact.available, false);
  assert.equal(exact.reason, "duplicate");
  assert.notEqual(exact.suggestion, "Retired");
  assert.equal(assessMemberDisplayName(exact.suggestion, members, { includeInactive: true }).available, true, "the suggestion is itself admissible");
  assert.equal(assessMemberDisplayName("Retirеd", members, { includeInactive: true }).reason, "confusable");
  // The returning identity's own inactive record never blocks the identity itself.
  assert.equal(assessMemberDisplayName("Retired", members, { includeInactive: true, excludeId: "ai_gone" }).available, true);
  // Another identity gets no such spare.
  assert.equal(assessMemberDisplayName("Retired", members, { includeInactive: true, excludeId: "ai_other" }).available, false);
  // Unrelated names are unaffected by the opt-in.
  assert.equal(assessMemberDisplayName("Newcomer", members, { includeInactive: true }).available, true);
});

test("a membership ended by account deletion frees the name; a plain removal does not", async t => {
  const { store, ownerKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "deleted-human", displayName: "Departed", kind: "human", permissions: ["steer"] } });
  const member = store.room("commons").state.members["deleted-human"];
  // The account-deletion flow's deactivation shape (server/account-deletion.mjs):
  // the reason rides the store's internal command option, never command data.
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "deleted-human", expectedMemberRevision: member.revision, permissions: member.permissions, active: false },
  }, null, { membershipEndReason: "account_deleted" });
  const ended = store.room("commons").state.members["deleted-human"];
  assert.equal(ended.active, false);
  assert.equal(ended.membershipEndedBy, "account_deleted");
  // The freed name admits a current-stamp joiner.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "next-human", displayName: "Departed", kind: "human", permissions: ["steer"] } });
  assert.equal(store.room("commons").state.members["next-human"].displayName, "Departed");
  // The guard agrees at admission scope.
  const members = store.room("commons").state.members;
  assert.equal(assessMemberDisplayName("Departed", members, { includeInactive: true }).reason, "duplicate", "the new active holder blocks the name");
  const withoutHolder = Object.fromEntries(Object.entries(members).filter(([id]) => id !== "next-human"));
  assert.equal(assessMemberDisplayName("Departed", withoutHolder, { includeInactive: true }).available, true, "the deletion-ended record alone does not hold the name");
});

test("a forged membershipEndReason in public command data is refused and frees nothing", async t => {
  const { store, ownerKey, origin } = await serve(t);
  const invite1 = store.invites.create(ownerKey, "commons", { profile: "chat" });
  const ann = await post(origin, "/api/agent-invites/redeem", { code: invite1.code, displayName: "Forged Stamp" });
  assert.equal(ann.status, 201, ann.text);
  const memberId = ann.json.memberId;
  const member = () => store.room("commons").state.members[memberId];
  const forged = key => () => store.command(key, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId, expectedMemberRevision: member().revision, permissions: member().permissions, active: false, membershipEndReason: "account_deleted" },
  });
  // Owner remove carrying the forged field in public command data: the
  // command shape refuses the field outright, so the removal never happens
  // and the name is never freed. A member's own leave is refused the same way.
  assert.throws(forged(ownerKey), /Unexpected field: membershipEndReason/);
  assert.equal(member().active, true, "the forged owner-remove changed nothing");
  assert.throws(forged(store.issueAccessKey("commons", memberId)), /Unexpected field: membershipEndReason/);
  assert.equal(member().active, true, "the forged self-leave changed nothing");
  // A clean owner removal ends the membership WITHOUT the deletion marker,
  // and the name stays reserved: a fresh redeem under it still 422s.
  const removed = setMemberActive(store, ownerKey, memberId, false);
  assert.equal(removed.active, false);
  assert.equal(removed.membershipEndedBy, undefined);
  const invite2 = store.invites.create(ownerKey, "commons", { profile: "chat" });
  const reuse = await post(origin, "/api/agent-invites/redeem", { code: invite2.code, displayName: "Forged Stamp" });
  assert.equal(reuse.status, 422, reuse.text);
  assert.equal(reuse.json.error.code, "display_name_unavailable");
  assert.equal(reuse.json.displayNameReason, "duplicate");
});

test("reactivation is refused while a distinct active member holds the name; allowed when none does", () => {
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
  state = applyEvent(state, setActive(state, "first-holder", false));
  assert.equal(state.members["first-holder"].active, false);
  // A distinct member admitted under the v2-era rules now actively holds
  // the name (its era let an inactive member's name be reused).
  state = applyEvent(state, add("second-holder", 2));
  assert.equal(state.members["second-holder"].active, true);
  // Reactivating the first holder would put two active members under one
  // name; the reducer refuses it. The reactivation event carries the v3
  // policy stamp a live admission writes (the store stamps
  // member.access_changed at admission): the guard gates on that stamp, so
  // an UNSTAMPED stored reactivation is legacy history and replays clean —
  // that leg is pinned in tests/display-name-composed-seams.test.js.
  assert.throws(() => applyEvent(state, setActive(state, "first-holder", true, DISPLAY_NAME_POLICY_VERSION)), /already used/);
  // Positive control: with no distinct active holder, reactivation applies
  // and the member keeps its name.
  let solo = replay([...initialRoom("commons")]);
  solo = applyEvent(solo, add("first-holder", DISPLAY_NAME_POLICY_VERSION));
  solo = applyEvent(solo, setActive(solo, "first-holder", false));
  solo = applyEvent(solo, setActive(solo, "first-holder", true));
  assert.equal(solo.members["first-holder"].active, true);
  assert.equal(solo.members["first-holder"].displayName, "Shared Name");
});

test("reducer: a v2-stamped member.added replays under the rules of its era; a current-stamp add of a removed member's name is refused", async t => {
  const { store, ownerKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "gone", displayName: "Retired", kind: "human", permissions: ["steer"] } });
  setMemberActive(store, ownerKey, "gone", false);
  const state = store.room("commons").state;
  // Policy v2 admitted names without the removed-member reservation, so a
  // v2-stamped event still applies — history is not rewritten.
  const legacy = applyEvent(state, event({
    type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons",
    data: { memberId: "legacy-joiner", displayName: "Retired", kind: "human", permissions: ["steer"], displayNamePolicyVersion: 2 },
  }));
  assert.equal(legacy.members["legacy-joiner"].displayName, "Retired");
  // A current-stamp add under the removed member's name is refused.
  assert.throws(() => applyEvent(state, event({
    type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons",
    data: { memberId: "new-joiner", displayName: "Retired", kind: "human", permissions: ["steer"], displayNamePolicyVersion: DISPLAY_NAME_POLICY_VERSION },
  })), error => error.code === "display_name_unavailable" && error.reason === "duplicate");
});
