import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  MENTION_STATES, isMentionState, isTerminalMentionState, canTransitionMention,
  assertTransitionMention, effectiveMentionState, resolveMentionTarget,
  MENTION_TIMEOUT_MS_DEFAULT,
} from "../server/mention-lifecycle.mjs";
import { extractAgentMentions } from "../server/inbox-agent-routing.mjs";

// #658: mention lifecycle tracking (delivered → acknowledged → responded,
// delivered|acknowledged → timed_out).
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-mentions-"));
  const clock = { now: Date.parse("2026-09-21T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "alice", displayName: "Alice", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "bob", displayName: "Bobby Tables", kind: "human", permissions: [] });
  keys.alice = store.issueAccessKey("commons", "alice");
  keys.bob = store.issueAccessKey("commons", "bob");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send, clock };
}

const post = (f, actor, body, id = randomUUID()) =>
  f.send(actor, T.MESSAGE_POSTED, { body }, id).event.id;

// --- Pure state machine -------------------------------------------------

test("state machine: legal transitions and terminal states", () => {
  assert.deepEqual([...MENTION_STATES], ["delivered", "acknowledged", "responded", "timed_out"]);
  assert.ok(isMentionState("delivered") && !isMentionState("bogus"));
  assert.ok(isTerminalMentionState("responded") && isTerminalMentionState("timed_out"));
  assert.ok(!isTerminalMentionState("delivered") && !isTerminalMentionState("acknowledged"));
  assert.ok(canTransitionMention("delivered", "acknowledged"));
  assert.ok(canTransitionMention("delivered", "responded"));
  assert.ok(canTransitionMention("delivered", "timed_out"));
  assert.ok(canTransitionMention("acknowledged", "responded"));
  assert.ok(canTransitionMention("acknowledged", "timed_out"));
  assert.ok(!canTransitionMention("acknowledged", "delivered"));
  assert.ok(!canTransitionMention("responded", "acknowledged"));
  assert.ok(!canTransitionMention("timed_out", "responded"));
  assert.ok(!canTransitionMention("delivered", "delivered"));
  assert.throws(() => assertTransitionMention("acknowledged", "delivered"), /illegal mention transition/);
  assert.throws(() => assertTransitionMention("responded", "timed_out"), /illegal mention transition/);
  assert.doesNotThrow(() => assertTransitionMention("delivered", "acknowledged"));
});

test("effectiveMentionState: lazy timeout without a writer", () => {
  const now = 1_000_000;
  assert.equal(effectiveMentionState({ state: "delivered", timeoutAt: now - 1 }, now), "timed_out");
  assert.equal(effectiveMentionState({ state: "acknowledged", timeoutAt: now - 1 }, now), "timed_out");
  assert.equal(effectiveMentionState({ state: "delivered", timeoutAt: now + 1 }, now), "delivered");
  assert.equal(effectiveMentionState({ state: "responded", timeoutAt: now - 1 }, now), "responded", "terminal rows never flip");
  assert.equal(effectiveMentionState({ state: "timed_out", timeoutAt: now - 1 }, now), "timed_out");
});

// --- Shared parser --------------------------------------------------------

test("mentions reuse the shared @agent parser", () => {
  assert.deepEqual(extractAgentMentions("hey @alice, meet @bob"), ["alice", "bob"]);
  assert.deepEqual(extractAgentMentions("@alice @alice twice"), ["alice"], "deduped in encounter order");
  assert.deepEqual(extractAgentMentions("no mentions here"), []);
  assert.deepEqual(extractAgentMentions("email me@home is not a mention"), []);
});

// --- Resolution -----------------------------------------------------------

test("resolveMentionTarget: id, display name, identity; unresolved is null", () => {
  const members = {
    alice: { displayName: "Alice", active: true },
    bob: { displayName: "Bobby Tables", active: true },
    carol: { displayName: "Carol", active: false },
  };
  const identities = { bob: "helper-bot" };
  assert.equal(resolveMentionTarget(members, identities, "alice"), "alice", "member id wins first");
  assert.equal(resolveMentionTarget(members, identities, "ALICE"), "alice", "case-insensitive");
  assert.equal(resolveMentionTarget(members, identities, "Bobby Tables"), "bob", "display name second");
  assert.equal(resolveMentionTarget(members, identities, "helper-bot"), "bob", "linked identity third");
  assert.equal(resolveMentionTarget(members, identities, "nobody"), null, "unresolved names create no row");
  assert.equal(resolveMentionTarget(members, identities, "carol"), null, "inactive members are skipped");
  assert.equal(resolveMentionTarget(members, identities, "alice", "alice"), null, "self-mentions never resolve");
});

// --- Store: tracking ------------------------------------------------------

test("posting @alice creates a delivered mention row; unknown names do not", t => {
  const f = setup(t);
  const eventId = post(f, "owner", "hey @alice can you look?");
  const view = f.store.mentionView("commons", eventId, "alice");
  assert.equal(view.state, "delivered");
  assert.equal(view.memberId, "alice");
  assert.equal(view.displayName, "Alice");
  assert.equal(view.decidedAt, null);
  assert.equal(f.store.mentionView("commons", eventId, "bob"), null, "bob was not mentioned");
  const ghost = post(f, "owner", "hey @ghost are you there?");
  assert.equal(f.store.mentionView("commons", ghost, "ghost"), null, "unresolved names create no row");
});

test("self-mention creates no row", t => {
  const f = setup(t);
  const eventId = post(f, "alice", "note to self @alice");
  assert.equal(f.store.mentionView("commons", eventId, "alice"), null);
});

test("mention timeout defaults to 30 minutes", () => {
  assert.equal(MENTION_TIMEOUT_MS_DEFAULT, 30 * 60 * 1000);
});

// --- Store: acknowledgement ------------------------------------------------

test("ack: member-only, idempotent, 403 for another member's row, 404 for none", t => {
  const f = setup(t);
  const eventId = post(f, "owner", "@alice please ack this");
  const first = f.store.acknowledgeMention(f.keys.alice, "commons", eventId, null);
  assert.equal(first.state, "acknowledged");
  const second = f.store.acknowledgeMention(f.keys.alice, "commons", eventId, null);
  assert.equal(second.state, "acknowledged", "idempotent re-ack");
  assert.throws(() => f.store.acknowledgeMention(f.keys.bob, "commons", eventId, null),
    { status: 403, code: "mention_not_yours" }, "another member cannot ack alice's row");
  const other = post(f, "owner", "no mentions at all");
  assert.throws(() => f.store.acknowledgeMention(f.keys.alice, "commons", other, null),
    { status: 404, code: "mention_not_found" }, "no row anywhere on the message");
});

// --- Store: auto-response ---------------------------------------------------

test("a later post by the mentioned member implies responded", t => {
  const f = setup(t);
  const eventId = post(f, "owner", "@alice your turn");
  assert.equal(f.store.mentionView("commons", eventId, "alice").state, "delivered");
  post(f, "alice", "on it");
  assert.equal(f.store.mentionView("commons", eventId, "alice").state, "responded");
  // Ack after responding is a no-op view of the terminal state.
  const view = f.store.acknowledgeMention(f.keys.alice, "commons", eventId, null);
  assert.equal(view.state, "responded");
});

// --- Store: lazy timeout ----------------------------------------------------

test("expired mentions flip to timed_out lazily on read", t => {
  const f = setup(t);
  f.store.setMentionTimeout(f.keys.owner, "commons", 60_000, null);
  const eventId = post(f, "owner", "@alice quick?");
  assert.equal(f.store.mentionView("commons", eventId, "alice").state, "delivered");
  f.clock.now += 61_000;
  const listed = f.store.listMentions(f.keys.alice, "commons", {}, null);
  assert.equal(listed.mentions[0].state, "timed_out");
  assert.ok(listed.mentions[0].decidedAt, "terminal transition stamps decidedAt");
  assert.equal(f.store.mentionView("commons", eventId, "alice").state, "timed_out");
});

test("setMentionTimeout: owner-only with bounds", t => {
  const f = setup(t);
  assert.deepEqual(f.store.setMentionTimeout(f.keys.owner, "commons", 3_600_000, null),
    { roomId: "commons", timeoutMs: 3_600_000 });
  assert.throws(() => f.store.setMentionTimeout(f.keys.alice, "commons", 3_600_000, null),
    { status: 403, code: "owner_required" });
  for (const bad of [59_999, 86_400_001, 1.5, Number.NaN, "60000"]) {
    assert.throws(() => f.store.setMentionTimeout(f.keys.owner, "commons", bad, null),
      { status: 422, code: "invalid_mention_timeout" }, `rejects ${String(bad)}`);
  }
});

// --- Store: listing ----------------------------------------------------------

test("listMentions: defaults to caller; owner may query another member", t => {
  const f = setup(t);
  post(f, "owner", "@alice one");
  post(f, "owner", "@bob two");
  const alice = f.store.listMentions(f.keys.alice, "commons", {}, null);
  assert.equal(alice.memberId, "alice");
  assert.equal(alice.mentions.length, 1);
  assert.equal(alice.mentions[0].state, "delivered");
  const ownerView = f.store.listMentions(f.keys.owner, "commons", { memberId: "bob" }, null);
  assert.equal(ownerView.memberId, "bob");
  assert.equal(ownerView.mentions.length, 1);
  assert.throws(() => f.store.listMentions(f.keys.alice, "commons", { memberId: "bob" }, null),
    { status: 403, code: "mention_forbidden" }, "non-owner cannot read another member's mentions");
  const filtered = f.store.listMentions(f.keys.alice, "commons", { state: "responded" }, null);
  assert.equal(filtered.mentions.length, 0, "state filter applies");
  assert.throws(() => f.store.listMentions(f.keys.alice, "commons", { state: "bogus" }, null),
    { status: 422, code: "invalid_mention_query" });
});

// --- Store: chips on message views --------------------------------------------

test("eventsAfter attaches mention chips to message events in one batch", t => {
  const f = setup(t);
  const first = post(f, "owner", "@alice first");
  const second = post(f, "owner", "@alice @bob second");
  post(f, "owner", "plain message");
  const page = f.store.eventsAfter(f.keys.alice, "commons", 0, 100, null);
  const byId = new Map(page.events.map(({ event }) => [event.id, event]));
  assert.ok(Array.isArray(byId.get(first).mentions), "chip array present");
  assert.deepEqual(byId.get(first).mentions.map(m => m.memberId), ["alice"]);
  assert.deepEqual(byId.get(second).mentions.map(m => m.memberId).sort(), ["alice", "bob"]);
  assert.equal(byId.get(first).mentions[0].state, "delivered");
  const nonMessage = page.events.find(({ event }) => event.type !== T.MESSAGE_POSTED);
  if (nonMessage) assert.equal(nonMessage.event.mentions, undefined, "non-message events carry no chips");
});
// --- HTTP routes ---------------------------------------------------------------

import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-mention-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId: id, displayName: name, kind: "human", permissions: [] } });
  }
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey, aliceKey, bobKey };
}
async function httpPost(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function httpGet(origin, path, token) {
  const res = await fetch(`${origin}${path}`, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const httpPostMessage = (origin, token, body) => httpPost(origin, "/api/rooms/commons/commands",
  { id: randomUUID(), type: "message.posted", data: { body } }, token);

test("HTTP: list, ack, and settings routes", async t => {
  const { origin, ownerKey, aliceKey, bobKey } = await serve(t);
  const msg = await httpPostMessage(origin, ownerKey, "hey @alice look at this");
  assert.equal(msg.status, 201, JSON.stringify(msg.json));
  const eventId = msg.json.event.id;

  const list = await httpGet(origin, "/api/rooms/commons/mentions", aliceKey);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.memberId, "alice");
  assert.equal(list.json.mentions.length, 1);
  assert.equal(list.json.mentions[0].state, "delivered");

  const forbidden = await httpGet(origin, "/api/rooms/commons/mentions?memberId=bob", aliceKey);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, "mention_forbidden");
  const ownerPeek = await httpGet(origin, "/api/rooms/commons/mentions?memberId=alice", ownerKey);
  assert.equal(ownerPeek.status, 200);
  assert.equal(ownerPeek.json.mentions.length, 1);

  const ack = await httpPost(origin, `/api/rooms/commons/mentions/${eventId}/ack`, {}, aliceKey);
  assert.equal(ack.status, 200, JSON.stringify(ack.json));
  assert.equal(ack.json.state, "acknowledged");
  const ackAgain = await httpPost(origin, `/api/rooms/commons/mentions/${eventId}/ack`, {}, aliceKey);
  assert.equal(ackAgain.status, 200, "idempotent");
  assert.equal(ackAgain.json.state, "acknowledged");

  const notYours = await httpPost(origin, `/api/rooms/commons/mentions/${eventId}/ack`, {}, bobKey);
  assert.equal(notYours.status, 403);
  assert.equal(notYours.json.error.code, "mention_not_yours");

  const plain = await httpPostMessage(origin, ownerKey, "no mentions here");
  const noRow = await httpPost(origin, `/api/rooms/commons/mentions/${plain.json.event.id}/ack`, {}, aliceKey);
  assert.equal(noRow.status, 404);
  assert.equal(noRow.json.error.code, "mention_not_found");

  const settings = await httpPost(origin, "/api/rooms/commons/mentions/settings", { timeoutMs: 3_600_000 }, ownerKey);
  assert.equal(settings.status, 200, JSON.stringify(settings.json));
  assert.equal(settings.json.timeoutMs, 3_600_000);
  const settingsForbidden = await httpPost(origin, "/api/rooms/commons/mentions/settings", { timeoutMs: 3_600_000 }, aliceKey);
  assert.equal(settingsForbidden.status, 403);
  const settingsBad = await httpPost(origin, "/api/rooms/commons/mentions/settings", { timeoutMs: 5 }, ownerKey);
  assert.equal(settingsBad.status, 422);

  const events = await httpGet(origin, "/api/rooms/commons/events?after=0&limit=100", aliceKey);
  assert.equal(events.status, 200);
  const mentioned = events.json.events.map(({ event }) => event).find(e => e.id === eventId);
  assert.ok(Array.isArray(mentioned.mentions), "chips ride on the message view");
  assert.equal(mentioned.mentions[0].memberId, "alice");
  assert.equal(mentioned.mentions[0].state, "acknowledged", "chip reflects the ack");
});
