// QA2 P1-4: a new member name is refused when it is a reserved label, a
// control character, a duplicate of an active member, or a lookalike of one.
// Existing member rows stay as stored.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { EVENT_TYPES as T, applyEvent, event, DISPLAY_NAME_POLICY_VERSION } from "../src/events.js";
import { assessMemberDisplayName } from "../server/display-name-guard.mjs";

const reserved = ["system", "project room", "room owner", "owner", "admin", "moderator", "everyone", "here", "channel", "all"];
const bidi = ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069", "\u200E", "\u200F"];

test("reserved labels, control characters, duplicates, and lookalikes are classified without echoing hidden characters", () => {
  const members = {
    owner: { id: "owner", displayName: "Room owner", active: true },
    potter: { id: "potter", displayName: "Potter", active: true },
    gone: { id: "gone", displayName: "Retired", active: false },
  };
  for (const label of reserved) {
    for (const name of [label, label.toUpperCase(), `@${label}`, `Ada (${label})`, `Ada [${label}]`]) {
      const verdict = assessMemberDisplayName(name, members);
      const sameMember = name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() === "room owner";
      assert.equal(verdict.available, false, name);
      assert.equal(verdict.reason, sameMember ? "duplicate" : "reserved", name);
      assert.equal(assessMemberDisplayName(verdict.suggestion, members).available, true, verdict.suggestion);
    }
  }
  assert.equal(assessMemberDisplayName("ＳＹＳＴＥＭ", members).reason, "reserved");
  assert.equal(assessMemberDisplayName("Room owner (verified)", members).reason, "reserved");
  assert.equal(assessMemberDisplayName("Potter (owner)", members).reason, "reserved");
  assert.equal(assessMemberDisplayName("@everyone", members).reason, "reserved");
  assert.equal(assessMemberDisplayName("Calliope", members).available, true);
  assert.equal(assessMemberDisplayName("Allen", members).available, true);
  assert.equal(assessMemberDisplayName("Channeling", members).available, true);
  assert.equal(assessMemberDisplayName("Room owner", members).reason, "duplicate");
  assert.equal(assessMemberDisplayName("room owner", members).reason, "duplicate");
  assert.equal(assessMemberDisplayName("Potter", members).reason, "duplicate");
  assert.equal(assessMemberDisplayName("potter", members).reason, "duplicate");
  assert.equal(assessMemberDisplayName("Ｐｏｔｔｅｒ", members).reason, "duplicate");
  assert.equal(assessMemberDisplayName("Potter", members).suggestion, "Potter 2");
  const crowded = { ...members, next: { displayName: "Potter 2", active: true } };
  assert.equal(assessMemberDisplayName("Potter", crowded).suggestion, "Potter 3");
  const lookalike = assessMemberDisplayName("\u0420otter", members);
  assert.equal(lookalike.reason, "confusable");
  assert.equal(assessMemberDisplayName(lookalike.suggestion, members).available, true);
  assert.equal(assessMemberDisplayName("Retired", members).available, true, "an inactive member does not hold the name");
  for (const mark of [...bidi, "\n", "\u0000", "\u007f", "\u200D", "\u2028"]) {
    const verdict = assessMemberDisplayName(`${mark}Ada`, members);
    assert.equal(verdict.reason, "control_characters");
    assert.equal(verdict.suggestion, "Ada");
    assert.equal(verdict.message.includes(mark), false);
    assert.equal(JSON.stringify(verdict).includes(mark), false);
  }
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-display-name-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "potter", displayName: "Potter", kind: "human", permissions: ["steer"] } });
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

const post = async (origin, path, body, token) => {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
};

const memberNames = store => Object.values(store.room("commons").state.members).map(member => member.displayName).sort();

test("a live member.added refuses a reserved or duplicate name, and an older unstamped event still replays", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-display-name-command-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.room("commons").state.members.owner.displayName, "Room owner");
  const sequence = store.room("commons").sequence;
  assert.throws(
    () => store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "ada", displayName: "admin", kind: "human", permissions: ["steer"] } }),
    error => error.status === 422 && error.code === "display_name_unavailable" && /reserved/i.test(error.message));
  assert.equal(store.room("commons").sequence, sequence);
  assert.equal(store.room("commons").state.members.ada, undefined);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "ada", displayName: "Ada", kind: "human", permissions: ["steer"] } });
  assert.equal(store.room("commons").state.members.ada.displayName, "Ada");
  assert.throws(
    () => store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "ada-2", displayName: "Ada", kind: "human", permissions: ["steer"] } }),
    error => error.status === 422 && error.code === "display_name_unavailable" && /already used/i.test(error.message));
  assert.equal(store.room("commons").state.members["ada-2"], undefined);
  const historical = applyEvent(store.room("commons").state, event({
    type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons",
    data: { memberId: "legacy", displayName: "admin", kind: "human", permissions: ["steer"] },
  }));
  assert.equal(historical.members.legacy.displayName, "admin");
  assert.throws(() => applyEvent(store.room("commons").state, event({
    type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons",
    data: { memberId: "stamped", displayName: "admin", kind: "human", permissions: ["steer"], displayNamePolicyVersion: DISPLAY_NAME_POLICY_VERSION },
  })), error => error.code === "display_name_unavailable");
});

test("redeem, share-link join, access requests, and referral redeem refuse a taken display name and keep the existing roster", async t => {
  const { store, ownerKey, origin } = await serve(t);
  const before = memberNames(store);
  assert.deepEqual(before, ["Potter", "Room owner"]);
  const invite = store.invites.create(ownerKey, "commons", { profile: "chat" });
  const linkToken = randomBytes(32).toString("base64url");
  const revision = store.room("commons").state.members.owner.revision;
  store.shareLinks.create(ownerKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 5, expectedMemberRevision: revision,
  }, null);
  const identity = store.identities.create("Helper");
  const slot = store.createAccountSessionSlot();
  const requests = new AccessRequests(store);
  const identitiesBefore = store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;

  let blocked;
  try {
    requests.request("commons", { identityId: identity.identityId, displayName: "SYSTEM", requestedPermissions: [], requestId: "ar_blocked_name" });
    assert.fail("a reserved display name was stored");
  } catch (error) { blocked = error; }
  assert.equal(blocked.status, 422);
  assert.equal(blocked.code, "display_name_unavailable");
  assert.equal(blocked.reason, "reserved");
  assert.equal(blocked.suggestion, "SYSTEM 2");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM access_requests").get().n, 0);
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Quiet Person", requestedPermissions: [], requestId: "ar_quiet",
  });
  store.db.prepare("UPDATE access_requests SET display_name=? WHERE request_id=?").run("SYSTEM", pending.requestId);
  assert.throws(
    () => requests.decide(ownerKey, "commons", pending.requestId, { decision: "approve" }),
    error => error.status === 422 && error.code === "display_name_unavailable" && error.reason === "reserved" && !String(error.message).includes("SYSTEM\u202e"));
  assert.equal(store.db.prepare("SELECT status FROM access_requests WHERE request_id=?").get(pending.requestId).status, "pending");
  assert.equal(store.room("commons").state.members[identity.identityId], undefined);

  const minted = store.referralInvites.mint(ownerKey, "commons");
  assert.throws(
    () => store.referralInvites.redeem({ token: minted.token, displayName: "\u202eAda" }),
    error => error.code === "display_name_unavailable" && error.reason === "control_characters" && !error.suggestion.includes("\u202e") && !error.message.includes("\u202e"));
  const referred = store.referralInvites.redeem({ token: minted.token, displayName: "Stranger" });
  assert.equal(store.room("commons").state.members[referred.memberId].displayName, "Stranger");

  const refused = [
    ["SYSTEM", "reserved"],
    ["Room owner (verified)", "reserved"],
    ["Project Room", "reserved"],
    ["Room owner", "duplicate"],
    ["Potter (owner)", "reserved"],
    ["@everyone", "reserved"],
    ["\u202eAda", "control_characters"],
    ["room owner", "duplicate"],
    ["potter", "duplicate"],
    ["\u0420otter", "confusable"],
  ];
  for (const [displayName, reason] of refused) {
    const redeemed = await post(origin, "/api/agent-invites/redeem", { code: invite.code, displayName });
    assert.equal(redeemed.status, 422, displayName);
    assert.equal(redeemed.json.error.code, "display_name_unavailable", displayName);
    assert.equal(redeemed.json.displayNameReason, reason, displayName);
    assert.equal(typeof redeemed.json.suggestion, "string");
    assert.equal(redeemed.text.includes("\u202e"), false, displayName);
    assert.equal(redeemed.text.includes("\\u202e"), false, displayName);
    const joined = await post(origin, "/api/share-links/join-agent", { linkToken, displayName }, identity.secret);
    assert.equal(joined.status, 422, displayName);
    assert.equal(joined.json.error.code, "display_name_unavailable");
    assert.equal(joined.json.displayNameReason, reason, displayName);
    assert.equal(joined.text.includes("\u202e"), false);
    assert.throws(
      () => store.shareLinks.join(slot.token, linkToken, {
        displayName, redemptionId: randomUUID(),
        expectedSessionRevision: slot.session.sessionRevision, expectedSessionBinding: slot.session.sessionBinding,
      }),
      error => error.status === 422 && error.code === "display_name_unavailable" && error.reason === reason && error.detail.displayNameReason === reason);
  }
  assert.deepEqual(memberNames(store), ["Potter", "Room owner", "Stranger"].sort());
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n, identitiesBefore + 1, "a refused redeem writes no identity");

  const accepted = await post(origin, "/api/agent-invites/redeem", { code: invite.code, displayName: "Ada Lovelace" });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.json.displayName, "Ada Lovelace");
  const agent = await post(origin, "/api/share-links/join-agent", { linkToken, displayName: "Helper" }, identity.secret);
  assert.equal(agent.status, 201);
  assert.equal(store.room("commons").state.members[identity.identityId].displayName, "Helper");
  const again = await post(origin, "/api/share-links/join-agent", { linkToken, displayName: "SYSTEM" }, identity.secret);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(store.room("commons").state.members[identity.identityId].displayName, "Helper");
  const guest = store.shareLinks.join(slot.token, linkToken, {
    displayName: "Browser guest", redemptionId: randomUUID(),
    expectedSessionRevision: slot.session.sessionRevision, expectedSessionBinding: slot.session.sessionBinding,
  });
  assert.equal(guest.session.member.displayName, "Browser guest");
  const session = store.accountSessionSlot(slot.token);
  const repeat = store.shareLinks.join(slot.token, linkToken, {
    displayName: "SYSTEM", redemptionId: randomUUID(),
    expectedSessionRevision: session.sessionRevision, expectedSessionBinding: session.sessionBinding,
  });
  assert.equal(repeat.duplicate, true);
  assert.equal(store.room("commons").state.members.owner.displayName, "Room owner");
  assert.equal(store.room("commons").state.members.potter.displayName, "Potter");
});

test("member.added through the command route refuses a confusable or reserved display name", async t => {
  const { store, ownerKey, origin } = await serve(t);
  const duplicate = await post(origin, "/api/rooms/commons/commands", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "candidate-dup", displayName: "Potter", kind: "human", permissions: [] },
  }, ownerKey);
  assert.equal(duplicate.status, 422);
  assert.equal(duplicate.json.error.code, "display_name_unavailable");
  assert.equal(store.room("commons").state.members["candidate-dup"], undefined);
  for (const [displayName, memberId] of [["\u0420otter", "candidate-look"], ["Admin", "candidate-admin"]]) {
    const added = await post(origin, "/api/rooms/commons/commands", {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName, kind: "human", permissions: [] },
    }, ownerKey);
    assert.equal(added.status, 422, displayName);
    assert.equal(added.json.error.code, "display_name_unavailable", displayName);
    assert.equal(store.room("commons").state.members[memberId], undefined);
  }
});
