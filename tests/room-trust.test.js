// Room Trust: one owner kill-switch. Default open. Off blocks cross-owner
// assign and wake. Same-owner work stays open. Not Bond.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";
import {
  EVENT_TYPES as T, replay, roomTrust, distinctMemberOwnerIds, isCrossOwnerAgentAction
} from "../src/events.js";
import { agentErrorBody } from "../src/agent-error.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const state = () => f.store.room("commons").state;
  const setTrust = enabled => send("owner", T.ROOM_TRUST_SET, { enabled });
  send("owner", T.MEMBER_ADDED, {
    memberId: "foreign", displayName: "Foreign agent", kind: "agent",
    accountableHumanId: "guest", permissions: ["accept_work", "steer"]
  });
  f.keys.foreign = f.store.issueAccessKey("commons", "foreign");
  send("owner", T.MEMBER_ACCESS_CHANGED, {
    memberId: "producer", expectedMemberRevision: 0,
    permissions: ["accept_work", "complete_work", "steer"], active: true
  });
  send("owner", T.MEMBER_ACCESS_CHANGED, {
    memberId: "guest", expectedMemberRevision: 0, permissions: ["steer"], active: true
  });
  const propose = (actor, workItemId, accountableMemberId) => send(actor, T.WORK_PROPOSED, {
    workItemId, title: `Outcome ${workItemId}`, definitionOfDone: "Exact result recorded",
    accountableMemberId, mode: "read"
  });
  const post = (actor, body, extra = {}) => send(actor, T.MESSAGE_POSTED, {
    messageId: extra.messageId ?? randomUUID(), body, ...extra
  });
  return { ...f, send, state, setTrust, propose, post };
}

function assertTrustOff(fn) {
  assert.throws(fn, error => error.status === 403 && error.code === "trust_off"
    && /Room Trust is off/.test(error.message) && /turn Trust on/.test(error.message));
}

test("Room Trust defaults open and only the owner can flip it", t => {
  const f = fixture(t);
  assert.deepEqual(roomTrust(f.state()), { enabled: true });
  assert.equal(f.state().room.trust, undefined, "an untouched room stores no trust field");
  assert.ok(distinctMemberOwnerIds(f.state()).size > 1);
  assert.equal(isCrossOwnerAgentAction(f.state(), "owner", "producer"), false, "owner and their agent are the same owner");
  assert.equal(isCrossOwnerAgentAction(f.state(), "owner", "foreign"), true);
  assert.equal(isCrossOwnerAgentAction(f.state(), "guest", "owner"), false, "two humans are not the agent gate");
  assert.throws(() => f.send("guest", T.ROOM_TRUST_SET, { enabled: false }), {
    status: 422, code: "command_rejected", message: /Only the Room owner may set Room Trust/
  });
  assert.throws(() => f.send("owner", T.ROOM_TRUST_SET, {}), {
    status: 422, code: "command_rejected", message: /enabled as true or false/
  });
  assert.throws(() => f.send("owner", T.ROOM_TRUST_SET, { enabled: "no" }), { status: 422, code: "invalid_command" });
  f.setTrust(false);
  assert.equal(roomTrust(f.state()).enabled, false);
  assert.equal(f.state().room.trust.revision, 1);
  assert.equal(f.state().room.trust.setById, "owner");
  f.setTrust(true);
  assert.equal(roomTrust(f.state()).enabled, true);
  assert.equal(f.state().room.trust.revision, 2);
  const events = [];
  for (let after = 0; ;) {
    const page = f.store.eventsAfter(f.keys.owner, "commons", after, 100);
    events.push(...page.events.map(row => row.event));
    if (page.events.length < 100) break;
    after = page.events.at(-1).sequence;
  }
  assert.deepEqual(replay(events).room.trust, f.state().room.trust);
});

test("Trust off blocks cross-owner assign and leaves same-owner assign open", t => {
  const f = fixture(t);
  f.propose("owner", "same-owner-open", "producer");
  assert.equal(f.state().workItems["same-owner-open"].accountableMemberId, "producer");
  f.setTrust(false);
  assert.equal(f.state().workItems["same-owner-open"].accountableMemberId, "producer", "a later flip does not rewrite earlier work");
  const before = f.store.room("commons").sequence;
  assertTrustOff(() => f.propose("owner", "cross-human", "foreign"));
  assertTrustOff(() => f.propose("producer", "cross-agent", "foreign"));
  assertTrustOff(() => f.propose("foreign", "cross-back", "producer"));
  assert.equal(f.store.room("commons").sequence, before, "a refused assign records nothing");
  assert.equal(f.state().workItems["cross-human"], undefined);
  assert.equal(f.state().workItems["cross-agent"], undefined);
  f.propose("owner", "same-owner-closed", "producer");
  f.propose("guest", "human-to-human", "owner");
  f.propose("foreign", "own-sponsor", "foreign");
  assert.equal(f.state().workItems["same-owner-closed"].accountableMemberId, "producer");
  assert.equal(f.state().workItems["human-to-human"].accountableMemberId, "owner");
  assert.equal(f.state().workItems["own-sponsor"].proposedById, "foreign");
  f.setTrust(true);
  f.propose("producer", "cross-open", "foreign");
  assert.equal(f.state().workItems["cross-open"].accountableMemberId, "foreign");
});

test("Trust off blocks cross-owner wake and still posts ordinary chat", t => {
  const f = fixture(t);
  f.setTrust(false);
  const hello = f.post("owner", "hello room, no address");
  assert.equal(hello.event.type, T.MESSAGE_POSTED);
  f.post("owner", "same owner @producer please look");
  f.post("guest", "@foreign this is your sponsor");
  const before = f.store.room("commons").sequence;
  assertTrustOff(() => f.post("owner", "cross @foreign please look", { messageId: "blocked-mention" }));
  assertTrustOff(() => f.post("producer", "@foreign and @producer together", { messageId: "blocked-mixed" }));
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.state().messages.some(message => message.id === "blocked-mention"), false);
  assert.equal(f.state().messages.some(message => message.id === "blocked-mixed"), false);
  // DMs are open by default: consent no longer gates this DM; the trust-off
  // cross-owner policy blocks it instead.
  assertTrustOff(() => f.post("producer", "cross owner dm", { messageId: "needs-consent", toMemberId: "foreign" }));
  f.store.dmConsents.request("commons", "producer", "foreign", "acceptance");
  f.store.dmConsents.decide("commons", "foreign", "producer", "approve");
  assertTrustOff(() => f.post("producer", "cross owner dm", { messageId: "blocked-dm", toMemberId: "foreign" }));
  f.store.dmConsents.request("commons", "owner", "producer", "acceptance");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  f.post("owner", "same owner dm", { messageId: "same-dm", toMemberId: "producer" });
  assert.equal(f.state().messages.some(message => message.id === "same-dm"), true);
  f.setTrust(true);
  f.post("owner", "cross @foreign now allowed", { messageId: "open-mention" });
  assert.equal(f.state().messages.some(message => message.id === "open-mention"), true);
  f.post("producer", "cross owner dm open", { messageId: "open-dm", toMemberId: "foreign" });
  assert.equal(f.state().messages.some(message => message.id === "open-dm"), true);
});

test("Trust off does not enqueue a cross-owner wake; Trust on does", t => {
  const f = fixture(t);
  let at = Date.now();
  f.store.now = () => at;
  const identity = f.store.identities.create("Foreign wake");
  const home = f.store.identities.create("Home wake");
  const link = f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)");
  link.run("commons", identity.identityId, "foreign", at);
  link.run("commons", home.identityId, "producer", at);
  const beat = agentId => f.store.agentHeartbeats.heartbeat({
    agentId, hostId: "host-1", mode: "wakeable", wakeUrl: "https://host.example.test/wake"
  });
  beat(identity.identityId);
  beat(home.identityId);
  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  f.setTrust(false);
  assertTrustOff(() => f.post("owner", "@foreign wake", { messageId: "no-wake" }));
  assert.equal(f.store.agentHeartbeats.pendingWakes(identity.identityId).length, 0);
  f.post("owner", "@producer wake", { messageId: "home-wake" });
  assert.equal(f.store.agentHeartbeats.pendingWakes(home.identityId).length, 1);
  assert.equal(f.store.agentHeartbeats.pendingWakes(home.identityId)[0].messageId, "home-wake");
  f.setTrust(true);
  f.post("owner", "@foreign wake", { messageId: "yes-wake" });
  const pending = f.store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "mention");
  assert.equal(pending[0].messageId, "yes-wake");
});

test("trust_off HTTP body names the kill-switch and keeps the hint", async t => {
  const f = fixture(t);
  f.setTrust(false);
  const server = createRoomServer({ store: f.store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeStreams(); server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.keys.owner}`, "content-type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: "http-cross", title: "Cross", definitionOfDone: "Done", accountableMemberId: "foreign", mode: "read"
    } })
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error.code, "trust_off");
  assert.match(body.error.message, /foreign/);
  assert.match(body.hint, /turn Trust on/);
  assert.match(body.hint, /Same-owner/);
  assert.equal(body.reason, "trust_off");
  assert.equal(body.status, "action_required");
  const shaped = agentErrorBody({ httpStatus: 403, code: body.error.code, message: body.error.message, roomId: "commons" });
  assert.equal(shaped.hint, body.hint);
});
