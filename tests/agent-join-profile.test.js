// Join profile: optional on redeem, strict fields, defaults when omitted,
// GET/PATCH for the member or the owner, and the stored cap and event
// filter on the claim and wake paths main already has.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AGENT_JOIN_PROFILE_ROUTES } from "../server/routes/agent-join-profile.mjs";
import { enqueueClaimWake } from "../server/work-claim-events.mjs";
import {
  claimAllowedByProfile,
  claimWakeAttention,
  declaredProfileWantsWake,
  effectiveOpenClaimLimit,
  joinProfileLine,
  profileWantsEvent,
  readDeclaredAgentProfile,
} from "../src/agent-join-profile.js";

const DEFAULTS = {
  wake: "pull",
  events: "mentions-and-own-claims",
  maxClaims: 2,
  roles: [],
  detail: "brief",
  capabilities: [],
};

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "join-profile-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function send(origin, method, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const profileEvents = store => store.db.prepare("SELECT body FROM events WHERE room_id='commons'").all()
  .map(row => JSON.parse(row.body))
  .filter(event => event.type === "member.profile_set");

async function mint(origin, ownerKey) {
  const minted = await send(origin, "POST", "/api/rooms/commons/agent-invites", { permissions: ["accept_work"] }, ownerKey);
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  return minted.json.code;
}

test("join profile is redeemed and read on the member profile routes", () => {
  assert.deepEqual(AGENT_JOIN_PROFILE_ROUTES.map(row => `${row.method} ${row.path}`), [
    "POST /api/agent-invites/redeem",
    "GET /api/rooms/{roomId}/members/{memberId}/profile",
    "PATCH /api/rooms/{roomId}/members/{memberId}/profile",
  ]);
});

test("a bad join profile names one field and one next step", async t => {
  const { origin } = await serve(t);
  const cases = [
    [{ wake: "sms" }, "join_profile_wake"],
    [{ events: "everything" }, "join_profile_events"],
    [{ maxClaims: 0 }, "join_profile_max_claims"],
    [{ maxClaims: 11 }, "join_profile_max_claims"],
    [{ maxClaims: 1.5 }, "join_profile_max_claims"],
    [{ maxClaims: "2" }, "join_profile_max_claims"],
    [{ roles: ["coordinator", "coordinator"] }, "join_profile_roles"],
    [{ roles: "coordinator" }, "join_profile_roles"],
    [{ detail: "verbose" }, "join_profile_detail"],
    [{ capabilities: ["x".repeat(41)] }, "join_profile_capabilities"],
    [{ capabilities: ["docs", "docs"] }, "join_profile_capabilities"],
    [{ capabilities: ["ok", "a\u0000b"] }, "join_profile_capabilities"],
    [{ wake: "pull", extra: true }, "join_profile_invalid"],
    [{}, "join_profile_invalid"],
    [null, "join_profile_invalid"],
    [[], "join_profile_invalid"],
  ];
  for (const [profile, code] of cases) {
    const res = await send(origin, "POST", "/api/agent-invites/redeem", {
      code: "RM-0123456789ABCDEF", displayName: "Probe", profile,
    });
    assert.equal(res.status, 422, `${code} ${JSON.stringify(res.json)}`);
    assert.equal(res.json?.error?.code, code);
    assert.equal(res.json?.next?.length, 1, JSON.stringify(res.json?.next));
    assert.equal(typeof res.json.next[0].command, "string");
    assert.equal(res.json.next[0].command, res.json.error.message);
  }
});

test("omitting profile keeps the defaults and writes no profile event", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const code = await mint(origin, ownerKey);
  const redeemed = await send(origin, "POST", "/api/agent-invites/redeem", { code, displayName: "Quiet Bot" });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  const read = await send(origin, "GET", `/api/rooms/commons/members/${redeemed.json.memberId}/profile`, undefined, redeemed.json.identitySecret);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.declared, false);
  assert.deepEqual(read.json.profile, DEFAULTS);
  assert.equal(profileEvents(store).length, 0);
  const member = store.room("commons").state.members[redeemed.json.memberId];
  assert.equal(readDeclaredAgentProfile(member).declared, false);
  assert.deepEqual(readDeclaredAgentProfile(member).roles, []);
  assert.deepEqual(readDeclaredAgentProfile(member).capabilities, []);
});

test("an explicit profile is stored and recorded, including a default-shaped one", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const code = await mint(origin, ownerKey);
  const profile = { ...DEFAULTS, roles: ["builder", "coordinator"], capabilities: [" agenda "] };
  const redeemed = await send(origin, "POST", "/api/agent-invites/redeem", {
    code, displayName: "Declared Bot", profile,
  });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  const read = await send(origin, "GET", `/api/rooms/commons/members/${redeemed.json.memberId}/profile`, undefined, redeemed.json.identitySecret);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.declared, true);
  assert.deepEqual(read.json.profile.roles, ["coordinator", "builder"]);
  assert.deepEqual(read.json.profile.capabilities, ["agenda"]);
  assert.equal(read.json.profile.maxClaims, 2);
  const events = profileEvents(store);
  assert.equal(events.length, 1);
  assert.equal(events[0].actorId, redeemed.json.memberId);
  assert.deepEqual(events[0].data.profile.roles, ["coordinator", "builder"]);
  const member = store.room("commons").state.members[redeemed.json.memberId];
  const declared = readDeclaredAgentProfile(member);
  assert.deepEqual(declared.roles, ["coordinator", "builder"]);
  assert.deepEqual(declared.capabilities, ["agenda"]);
  assert.equal(declared.declared, true);
});

test("only the member or the owner can change a join profile", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const firstCode = await mint(origin, ownerKey);
  const secondCode = await mint(origin, ownerKey);
  const first = await send(origin, "POST", "/api/agent-invites/redeem", { code: firstCode, displayName: "First Bot" });
  const second = await send(origin, "POST", "/api/agent-invites/redeem", { code: secondCode, displayName: "Second Bot" });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(second.status, 201, JSON.stringify(second.json));
  const path = `/api/rooms/commons/members/${first.json.memberId}/profile`;
  const denied = await send(origin, "PATCH", path, { profile: { wake: "push" } }, second.json.identitySecret);
  assert.equal(denied.status, 403, JSON.stringify(denied.json));
  assert.equal(denied.json?.error?.code, "join_profile_forbidden");
  assert.equal(denied.json?.next?.length, 1);
  assert.equal(denied.json.next[0].command, "Retry as this member or the room owner.");
  assert.equal(profileEvents(store).length, 0);

  const self = await send(origin, "PATCH", path, { profile: { wake: "webhook", maxClaims: 10 } }, first.json.identitySecret);
  assert.equal(self.status, 200, JSON.stringify(self.json));
  assert.equal(self.json.profile.wake, "webhook");
  assert.equal(self.json.profile.maxClaims, 10);
  assert.equal(self.json.declared, true);
  assert.equal(profileEvents(store).length, 1);

  const same = await send(origin, "PATCH", path, { profile: { wake: "webhook" } }, first.json.identitySecret);
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.equal(same.json.unchanged, true);
  assert.equal(profileEvents(store).length, 1);

  const owner = await send(origin, "PATCH", path, { profile: { detail: "full" } }, ownerKey);
  assert.equal(owner.status, 200, JSON.stringify(owner.json));
  assert.equal(owner.json.profile.detail, "full");
  assert.equal(owner.json.profile.wake, "webhook");
  assert.equal(profileEvents(store).length, 2);
  assert.equal(profileEvents(store)[1].actorId, "owner");

  const over = await send(origin, "PATCH", path, { profile: { maxClaims: 11 } }, first.json.identitySecret);
  assert.equal(over.status, 422, JSON.stringify(over.json));
  assert.equal(over.json?.error?.code, "join_profile_max_claims");
  assert.equal(over.json?.next?.length, 1);
  assert.equal(profileEvents(store).length, 2);
  const kept = await send(origin, "GET", path, undefined, ownerKey);
  assert.equal(kept.json.profile.maxClaims, 10);
});

test("a second redeem with a different profile conflicts and keeps the first one", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const code = await mint(origin, ownerKey);
  const first = await send(origin, "POST", "/api/agent-invites/redeem", {
    code, displayName: "Once Bot", profile: { wake: "push", maxClaims: 2 },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const again = await send(origin, "POST", "/api/agent-invites/redeem", {
    code, displayName: "Once Bot", profile: { wake: "pull" },
  }, first.json.identitySecret);
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.equal(again.json?.error?.code, "join_profile_conflict");
  assert.equal(again.json?.next?.length, 1);
  const read = await send(origin, "GET", `/api/rooms/commons/members/${first.json.memberId}/profile`, undefined, first.json.identitySecret);
  assert.equal(read.json.profile.wake, "push");
  assert.equal(profileEvents(store).length, 1);
  assert.equal(store.room("commons").state.members[first.json.memberId].active, true);
});

test("maxClaims caps a new claim and events filtering stays a pure decision", () => {
  assert.equal(claimAllowedByProfile({ maxClaims: 2 }, 0), true);
  assert.equal(claimAllowedByProfile({ maxClaims: 2 }, 1), true);
  assert.equal(claimAllowedByProfile({ maxClaims: 2 }, 2), false);
  assert.equal(claimAllowedByProfile(undefined, 1), true);
  assert.equal(claimAllowedByProfile(undefined, 2), false);
  assert.equal(claimAllowedByProfile({ maxClaims: 10 }, 9), true);
  assert.equal(claimAllowedByProfile({ maxClaims: 10 }, 10), false);
  assert.equal(profileWantsEvent({ events: "mentions-and-own-claims" }, "mention"), true);
  assert.equal(profileWantsEvent({ events: "mentions-and-own-claims" }, "own-claim"), true);
  assert.equal(profileWantsEvent({ events: "mentions-and-own-claims" }, "other"), false);
  assert.equal(profileWantsEvent({ events: "all" }, "other"), true);
  assert.equal(profileWantsEvent(undefined, "mention"), true);
  assert.equal(profileWantsEvent(undefined, "other"), false);
  const line = joinProfileLine({
    kind: "agent",
    joinProfile: { wake: "webhook", events: "all", maxClaims: 2, roles: ["builder", "coordinator"], detail: "brief", capabilities: ["docs"] },
  });
  assert.equal(line, "Coordinator, builder · Webhook");
  assert.equal(joinProfileLine({ kind: "agent" }), "Pull");
  assert.equal(joinProfileLine({ kind: "human" }), "");
  const declared = { joinProfile: { wake: "pull", events: "mentions-and-own-claims", maxClaims: 1, roles: [], detail: "brief", capabilities: [] } };
  assert.equal(effectiveOpenClaimLimit(declared, 20), 1);
  assert.equal(effectiveOpenClaimLimit({ joinProfile: { ...declared.joinProfile, maxClaims: 10 } }, 2), 2);
  assert.equal(effectiveOpenClaimLimit({ kind: "agent" }, 20), 20);
  assert.equal(claimWakeAttention("assigned", null, "ai_1"), "own-claim");
  assert.equal(claimWakeAttention("review", "ai_other", "ai_1"), "other");
  assert.equal(claimWakeAttention("ci", "ai_1", "ai_1"), "own-claim");
  assert.equal(declaredProfileWantsWake(declared, "other"), false);
  assert.equal(declaredProfileWantsWake({ kind: "agent" }, "other"), true);
});

test("a stored maxClaims caps claim and assign under the room cap", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const cappedMint = await send(origin, "POST", "/api/rooms/commons/agent-invites", { profile: "contribute" }, ownerKey);
  assert.equal(cappedMint.status, 201, JSON.stringify(cappedMint.json));
  const cappedCode = cappedMint.json.code;
  const capped = await send(origin, "POST", "/api/agent-invites/redeem", {
    code: cappedCode, displayName: "Cap Bot", profile: { maxClaims: 1, wake: "pull", events: "mentions-and-own-claims" },
  });
  assert.equal(capped.status, 201, JSON.stringify(capped.json));
  const openMint = await send(origin, "POST", "/api/rooms/commons/agent-invites", { profile: "contribute" }, ownerKey);
  assert.equal(openMint.status, 201, JSON.stringify(openMint.json));
  const openCode = openMint.json.code;
  const open = await send(origin, "POST", "/api/agent-invites/redeem", { code: openCode, displayName: "Open Bot" });
  assert.equal(open.status, 201, JSON.stringify(open.json));
  for (const id of ["a", "b", "c", "d", "e"]) {
    const created = await send(origin, "POST", "/api/rooms/commons/work-claims", { id, title: id }, ownerKey);
    assert.equal(created.status, 201, JSON.stringify(created.json));
  }
  const first = await send(origin, "POST", "/api/rooms/commons/work-claims/a/claim", {}, capped.json.identitySecret);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const second = await send(origin, "POST", "/api/rooms/commons/work-claims/b/claim", {}, capped.json.identitySecret);
  assert.equal(second.status, 409, JSON.stringify(second.json));
  assert.equal(second.json?.error?.code, "too_many_open_claims");
  assert.match(second.json.error.message, /\b1\b/);
  const assigned = await send(origin, "POST", "/api/rooms/commons/work-claims", {
    id: "assigned", title: "Assigned", assignee: capped.json.memberId,
  }, ownerKey);
  assert.equal(assigned.status, 409, JSON.stringify(assigned.json));
  assert.equal(assigned.json?.error?.code, "too_many_open_claims");
  assert.match(assigned.json.error.message, /\b1\b/);
  const held = store.workClaims.get("commons", "e");
  const reassigned = await send(origin, "POST", "/api/rooms/commons/work-claims/e/reassign", {
    newOwner: capped.json.memberId,
    expectedClaimedAt: held?.claimedAt ?? null,
    expectedHistoryLength: held?.history?.length ?? 0,
  }, ownerKey);
  assert.equal(reassigned.status, 409, JSON.stringify(reassigned.json));
  assert.equal(reassigned.json?.error?.code, "too_many_open_claims");
  assert.match(reassigned.json.error.message, /\b1\b/);
  for (const id of ["b", "c", "d"]) {
    const claimed = await send(origin, "POST", `/api/rooms/commons/work-claims/${id}/claim`, {}, open.json.identitySecret);
    assert.equal(claimed.status, 200, `${id} ${JSON.stringify(claimed.json)}`);
  }
});

test("a mentions profile wakes on mentions and own claims across 50 events", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const code = await mint(origin, ownerKey);
  const redeemed = await send(origin, "POST", "/api/agent-invites/redeem", {
    code, displayName: "Pull Bot",
    profile: { wake: "pull", events: "mentions-and-own-claims", maxClaims: 1, roles: ["builder"], detail: "brief", capabilities: ["claims"] },
  });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  store.agentHeartbeats.heartbeat({ agentId: redeemed.json.identityId, hostId: "host-1", mode: "pull-only" });
  for (let i = 0; i < 20; i += 1) {
    store.command(ownerKey, "commons", {
      id: `mention-${i}`, type: "message.posted",
      data: { messageId: `mention-${i}`, body: `@Pull Bot please look ${i}` },
    });
  }
  for (let i = 0; i < 10; i += 1) {
    store.command(ownerKey, "commons", {
      id: `plain-${i}`, type: "message.posted",
      data: { messageId: `plain-${i}`, body: `status note ${i}` },
    });
  }
  for (let i = 0; i < 10; i += 1) {
    enqueueClaimWake(store, "commons", redeemed.json.memberId, `work-claim:item-${i}:assigned:${i}`, { reason: "assigned", actorId: "owner" });
  }
  for (let i = 0; i < 10; i += 1) {
    enqueueClaimWake(store, "commons", redeemed.json.memberId, `work-claim:other-${i}:review:${i}`, { reason: "review", actorId: "owner" });
  }
  const rows = store.db.prepare("SELECT message_id AS messageId FROM agent_wake_signals WHERE agent_id=?").all(redeemed.json.identityId);
  const ids = rows.map(row => row.messageId);
  assert.equal(ids.filter(id => id.startsWith("mention-")).length, 20);
  assert.equal(ids.filter(id => id.startsWith("plain-")).length, 0);
  assert.equal(ids.filter(id => id.includes(":assigned:")).length, 10);
  assert.equal(ids.filter(id => id.includes(":review:")).length, 0);
  assert.equal(ids.length, 30);
  const widened = await send(origin, "PATCH", `/api/rooms/commons/members/${redeemed.json.memberId}/profile`, {
    profile: { events: "all" },
  }, ownerKey);
  assert.equal(widened.status, 200, JSON.stringify(widened.json));
  enqueueClaimWake(store, "commons", redeemed.json.memberId, "work-claim:other-extra:review:extra", { reason: "review", actorId: "owner" });
  const after = store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get(redeemed.json.identityId).n;
  assert.equal(after, 31);
});
