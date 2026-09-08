import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { workOffersContext } from "../src/help-offers.js";

const task = "test-handoff";
function setup(t) {
  const f = createAcceptanceFixture(); let now = Date.now(); f.store.now = () => now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  const help = (id = task, status = "open") => {
    const item = f.store.room("commons").state.workItems[id];
    return send("producer", "work.help_updated", { workItemId: id, expectedRevision: item.revision,
      expectedHelpRevision: item.helpWanted?.revision ?? 0, status,
      ...(status === "open" ? { scope: "Suggest two agenda items", expiresAt: new Date(now + 3600000).toISOString() } : {}) });
  };
  const offer = (actor = "guest", id = task) => {
    const item = f.store.room("commons").state.workItems[id], offerId = crypto.randomUUID();
    send(actor, "work.help_offer_opened", { workItemId: id, offerId, expectedRevision: item.revision,
      expectedHelpRevision: item.helpWanted.revision, helpEventId: item.helpWanted.eventId,
      plan: id === task ? "I can suggest two items" : "OTHER-TASK-PLAN-SENTINEL" });
    return offerId;
  };
  const change = (offerId, status, actor = "producer") => {
    const state = f.store.room("commons").state, prior = state.helpOffers[offerId], item = state.workItems[prior.workItemId];
    return send(actor, "work.help_offer_updated", { workItemId: item.id, offerId, expectedRevision: item.revision,
      expectedOfferRevision: prior.revision, status, reason: "Explicit choice",
      ...(status === "selected" ? { expectedHelpRevision: item.helpWanted.revision, helpEventId: item.helpWanted.eventId } : {}),
      ...(status === "released" ? { externalActivityUnverified: true } : {}) });
  };
  const addWork = id => {
    send("owner", "work.proposed", { workItemId: id, title: "Other work", definitionOfDone: "Other task",
      accountableMemberId: "producer", mode: "read" });
    send("producer", "work.accepted", { workItemId: id, expectedRevision: 0 }); help(id);
  };
  send("producer", "work.accepted", { workItemId: task, expectedRevision: 0 }); help();
  const view = (actor = "guest", options = {}) => f.store.workContext(f.keys[actor], "commons", task, { includeOffers: true, ...options });
  const client = actor => new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: "commons", token: f.keys[actor],
    fetchImpl: async () => ({ ok: true, json: async () => view(actor) }) });
  return { ...f, send, help, offer, change, addWork, view, client, advance: ms => { now += ms; } };
}

test("offer reads are opt-in, atomic, detached and limited to selected work", async t => {
  const f = setup(t), id = f.offer();
  f.addWork("other"); f.offer("owner", "other");
  const before = f.store.room("commons"), readTransaction = f.store.readTransaction.bind(f.store); let reads = 0;
  f.store.readTransaction = callback => { reads++; return readTransaction(callback); };
  const result = f.view("producer"); assert.equal(reads, 1);
  assert.equal(result.offerContextVersion, 1); assert.equal(result.offers.retainedOfferCount, 2);
  assert.deepEqual(result.offers.offers.map(entry => entry.offer.id), [id]);
  assert.equal(result.offers.offers[0].canSelect, true);
  assert.equal(result.offers.availability.evaluatedAt, result.evaluatedAt);
  assert.equal(JSON.stringify(result).includes("OTHER-TASK-PLAN-SENTINEL"), false);
  assert.equal(result.context.source.status, "not_requested");
  assert.ok(result.context.participants.some(member => member.id === "guest"));
  const legacy = f.view("producer", { includeOffers: false });
  assert.equal(Object.hasOwn(legacy, "offers"), false); assert.equal(Object.hasOwn(legacy, "offerContextVersion"), false);
  assert.equal(Object.hasOwn(f.store.snapshot(f.keys.guest, "commons", null, "work", true), "offers"), false);
  result.offers.offers[0].offer.plan = "mutated";
  assert.deepEqual(f.store.room("commons"), before);
  assert.equal((await f.client("producer").workContext(task, { includeOffers: true })).offers.offers[0].canSelect, true);
  const reopened = new RoomStore(`${f.directory}/room.sqlite`, { now: f.store.now, readOnly: true });
  try { assert.deepEqual(reopened.workContext(f.keys.guest, "commons", task, { includeOffers: true }), f.view()); }
  finally { reopened.close(); }
});

test("selected offers remain explicit when scope expires or is withdrawn, with release available", async t => {
  const f = setup(t), id = f.offer(); f.change(id, "selected");
  let result = await f.client("guest").workContext(task, { includeOffers: true });
  assert.equal(result.offers.offers[0].canRelease, true);
  assert.equal(result.offers.offers[0].offer.status, "selected");
  assert.equal(result.offers.offers[0].externalExecution, false);
  f.advance(3600000);
  result = await f.client("producer").workContext(task, { includeOffers: true });
  assert.equal(result.help.status, "expired");
  assert.equal(result.offers.offers[0].status, "selection_needs_review");
  assert.equal(result.offers.offers[0].canRelease, true);
  f.help(task, "withdrawn");
  assert.equal(f.view().offers.offers[0].status, "selection_needs_review");
  f.change(id, "released", "guest");
  result = await f.client("guest").workContext(task, { includeOffers: true });
  assert.equal(result.offers.offers[0].offer.externalActivityUnverified, true);
  assert.equal(result.offers.offers[0].canRelease, false);
});

test("pending scope/member changes are re-evaluated without reviving old offers", async t => {
  const f = setup(t), id = f.offer();
  f.help();
  let result = await f.client("producer").workContext(task, { includeOffers: true });
  assert.equal(result.offers.offers[0].status, "unavailable");
  assert.equal(result.offers.offers[0].canSelect, false);
  assert.equal(result.offers.offers[0].canDecline, true);
  assert.equal(result.offers.availability.pendingForWork, 0);
  f.send("owner", "member.access_changed", { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false });
  result = await f.client("producer").workContext(task, { includeOffers: true });
  assert.equal(result.offers.offers[0].offer.id, id);
  assert.equal(result.context.participants.find(p => p.id === "guest").active, false);
  assert.throws(() => f.view(), { status: 401, code: "unauthenticated" });
});

test("room-wide limits do not require exporting other work or its offers", async t => {
  const f = setup(t);
  for (let i = 0; i < 5; i++) { f.addWork(`other-${i}`); f.offer("guest", `other-${i}`); }
  const result = await f.client("guest").workContext(task, { includeOffers: true });
  assert.equal(result.offers.availability.reason, "member_offer_limit");
  assert.equal(result.offers.availability.pendingForViewer, 5);
  assert.equal(result.offers.availability.pendingForWork, 0);
  assert.deepEqual(result.offers.offers, []);
  assert.equal(JSON.stringify(result).includes("OTHER-TASK-PLAN-SENTINEL"), false);
  assert.equal(result.help.canOffer, true, "invitation-v1 remains distinct from queue eligibility");
});

test("historical helper participants may exceed ten without broadening ordinary selected reads", async t => {
  const f = setup(t);
  for (let i = 0; i < 11; i++) {
    const memberId = `helper-${i}`;
    f.send("owner", "member.added", { memberId, displayName: memberId, kind: "agent", permissions: [] });
    f.keys[memberId] = f.store.issueAccessKey("commons", memberId);
    f.change(f.offer(memberId), "withdrawn", memberId);
  }
  const result = await f.client("producer").workContext(task, { includeOffers: true });
  assert.ok(result.context.participants.length > 10);
  assert.equal(result.offers.offers.length, 11);
  assert.ok(f.view("producer", { includeOffers: false }).context.participants.length <= 10);
});

test("client explicitly negotiates offers and never retries a weaker legacy response", async t => {
  const f = setup(t), calls = []; let response = f.view();
  const client = new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: "commons", token: f.keys.guest,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => response }; } });
  const controller = new AbortController();
  await client.workContext(task, { includeOffers: true, signal: controller.signal });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers["X-Project-Room-Offer-Context"], "1");
  assert.equal(calls[0].options.method, "GET"); assert.equal(calls[0].options.redirect, "error");
  controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  await assert.rejects(client.workContext(task), { code: "invalid_response" });
  response = f.view("guest", { includeOffers: false });
  const before = calls.length;
  await assert.rejects(client.workContext(task, { includeOffers: true }), { code: "offer_context_unavailable" });
  assert.equal(calls.length, before + 1);
  const count = calls.length;
  await assert.rejects(client.workContext(task, { includeOffers: "true" }));
  assert.equal(calls.length, count);
});

test("client rejects inconsistent offers, authority, scope, capacity and participant facts", async t => {
  const f = setup(t); f.offer(); const original = f.view("producer"); let response;
  const client = new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: "commons", token: f.keys.producer,
    fetchImpl: async () => ({ ok: true, json: async () => response }) });
  const changes = [
    r => { r.offerContextVersion = 2; }, r => { delete r.offers; }, r => { delete r.helpContextVersion; },
    r => { r.offers.version = 2; }, r => { r.offers.extra = "unrequested"; },
    r => { r.offers.retainedOfferCount = 0; }, r => { r.offers.retainedOfferCount = 501; },
    r => { r.offers.availability.pendingForViewer = 6; },
    r => { r.offers.availability.canOffer = true; }, r => { r.offers.availability.pendingForWork = 0; },
    r => { r.offers.availability.evaluatedAt = new Date(0).toISOString(); },
    r => { r.offers.offers[0].canSelect = false; }, r => { r.offers.offers[0].externalExecution = true; },
    r => { r.offers.offers[0].offer.workItemId = "other"; }, r => { r.offers.offers[0].offer.offererRevision = 999; },
    r => { r.offers.offers[0].offer.updatedAt = new Date(Date.parse(r.evaluatedAt) + 1).toISOString(); },
    r => { r.offers.offers[0].offer.actorId = "invented"; },
    r => { r.offers.offers.push(structuredClone(r.offers.offers[0])); r.offers.retainedOfferCount++; },
    r => { r.context.participants = r.context.participants.filter(p => p.id !== "guest"); },
    r => { r.context.participants.find(p => p.id === "guest").active = false; }
  ];
  for (const change of changes) {
    response = structuredClone(original); change(response);
    await assert.rejects(client.workContext(task, { includeOffers: true }), { code: "invalid_response" }, change.toString());
  }
});

test("HTTP negotiation preserves session fences, authentication and unchanged default reads", async t => {
  const f = setup(t); f.offer();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, path = "/api/rooms/commons/work-context?workItemId=test-handoff";
  const headers = { Authorization: `Bearer ${f.keys.producer}`, "X-Project-Room-Offer-Context": "1" };
  const response = await fetch(origin + path, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).offers.offers[0].canSelect, true);
  for (const version of ["0", "2", "1, 1", "true"]) assert.equal((await fetch(origin + path, {
    headers: { ...headers, "X-Project-Room-Offer-Context": version } })).status, 422);
  assert.equal((await fetch(origin + path)).status, 401);
  assert.equal((await fetch(origin + path.replace("commons", "elsewhere"), { headers })).status, 403);
  const session = f.store.createSession(f.keys.owner);
  assert.equal((await fetch(origin + path, { headers: { Cookie: `room_session=${session.token}`,
    "X-Session-Binding": "f".repeat(64), "X-Project-Room-Offer-Context": "1" } })).status, 409);
  const client = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.producer });
  assert.equal((await client.workContext(task, { includeOffers: true })).offers.offers.length, 1);
  assert.equal(Object.hasOwn(await client.workContext(task), "offers"), false);
});

test("bulk projection validates malformed histories before presenting an empty or available queue", t => {
  const f = setup(t), state = f.store.room("commons").state;
  state.helpOffers = [];
  assert.throws(() => workOffersContext(state, task, "guest", new Date().toISOString()));
});
