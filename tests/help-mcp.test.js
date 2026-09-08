import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";

// Independent protocol processes with separate private credentials, not LLM actors.
test("two helper MCP clients coordinate with one accountable agent through races, restart and explicit release", { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), clients = [], now = Date.now(), workItemId = "test-handoff";
  f.store.now = () => now;
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  for (const memberId of ["helper-a", "helper-b"]) {
    send("owner", "member.added", { memberId, displayName: memberId, kind: "agent", permissions: [], accountableHumanId: "owner" });
    f.keys[memberId] = f.store.issueAccessKey("commons", memberId);
  }
  send("producer", "work.accepted", { workItemId, expectedRevision: 0 });
  const help = send("producer", "work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 0,
    status: "open", scope: "Suggest two agenda items only", expiresAt: new Date(now + 3600000).toISOString() });
  const before = f.store.room("commons").state, beforeMarkers = ["producer", "helper-a", "helper-b"].map(id => f.store.snapshot(f.keys[id], "commons").cursor);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(clients.map(c => c.close()));
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const directories = {};
  for (const memberId of ["producer", "helper-a", "helper-b"]) {
    directories[memberId] = join(f.directory, memberId);
    saveAgentConnection(directories[memberId], { version: 1, roomId: "commons", memberId, token: f.keys[memberId], origin: "http://127.0.0.1:" + server.address().port });
  }
  const open = async member => { const c = await openMcpTestClient(directories[member]); clients.push(c); return c; };
  let a = await open("helper-a"); const b = await open("helper-b"), coordinator = await open("producer"), coordinator2 = await open("producer");
  const read = async c => {
    const reply = (await c.call("room_read_work", { workItemId, includeOffers: true })).result;
    assert.equal(reply.isError, undefined, JSON.stringify(reply)); return reply.structuredContent;
  };
  const call = async (c, tool, args) => (await c.call(tool, args)).result;
  const base = { workItemId, expectedRevision: 1, expectedHelpRevision: 1, helpEventId: help.event.id };
  const offers = [
    { ...base, requestId: "a-offer", offerId: "a", plan: "I can draft the first two agenda items." },
    { ...base, requestId: "b-offer", offerId: "b", plan: "I can draft two alternative agenda items." }
  ];
  const discovery = (await a.call("room_list_work", { focus: "help_wanted" })).result.structuredContent;
  assert.equal(discovery.work.some(w => w.id === workItemId), true);
  assert.equal((await read(a)).offers.availability.canOffer, true);
  const opened = await Promise.all([call(a, "room_offer_help", offers[0]), call(b, "room_offer_help", offers[1])]);
  assert.ok(opened.every(r => r.structuredContent.status === "recorded"));
  const seen = await read(coordinator);
  assert.equal(seen.offers.offers.length, 2); assert.ok(seen.offers.offers.every(o => o.canSelect));
  const selections = ["a", "b"].map(offerId => ({ ...base, offerId, expectedOfferRevision: 0, requestId: "select-" + offerId, reason: "Use this contribution for the agenda" }));
  const raced = await Promise.all([call(coordinator, "room_select_help_offer", selections[0]), call(coordinator2, "room_select_help_offer", selections[1])]);
  assert.equal(raced.filter(r => r.structuredContent.status === "recorded").length, 1);
  const winner = raced.findIndex(r => r.structuredContent.status === "recorded"), loser = 1 - winner;
  assert.equal(raced[loser].isError, true); assert.equal(raced[loser].structuredContent.outcome, "this_attempt_refused");
  assert.equal(raced[loser].structuredContent.code, "command_rejected");
  assert.equal((await read(b)).offers.availability.selectedOfferId, offers[winner].offerId);
  assert.equal((await read(b)).offers.offers.find(o => o.offer.id === offers[loser].offerId).canSelect, false);
  const forbidden = await call(a, "room_select_help_offer", { ...selections[loser], requestId: "forged-selection" });
  assert.equal(forbidden.isError, true);
  // Reconnect and recover the exact opening receipt without reviving an old offer.
  assert.equal((await a.close()).diagnostics, ""); clients.splice(clients.indexOf(a), 1); a = await open("helper-a");
  const replay = (await call(a, "room_offer_help", offers[0])).structuredContent;
  assert.equal(replay.duplicate, true); assert.equal(replay.eventId, opened[0].structuredContent.eventId); assert.equal(replay.currentStateVerified, false);
  const conflict = await call(a, "room_offer_help", { ...offers[0], plan: "Changed plan" });
  assert.equal(conflict.structuredContent.code, "idempotency_conflict");
  // Changing consent does not silently free an active selection.
  send("producer", "work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 1, status: "withdrawn" });
  const changed = await read(coordinator);
  assert.equal(changed.offers.offers.find(o => o.offer.id === offers[winner].offerId).status, "selection_needs_review");
  const helper = winner === 0 ? a : b;
  const release = { requestId: "release-selection", workItemId, expectedRevision: 1, offerId: offers[winner].offerId,
    expectedOfferRevision: 1, reason: "Scope changed; release coordination", externalActivityUnverified: true };
  const invalidRelease = await helper.call("room_release_help_offer", { ...release, externalActivityUnverified: false });
  assert.equal(invalidRelease.error.code, -32602);
  const released = (await call(helper, "room_release_help_offer", release)).structuredContent;
  assert.equal(released.status, "recorded"); assert.equal(released.appliedOfferRevision, 2);
  assert.equal((await call(helper, "room_release_help_offer", release)).structuredContent.duplicate, true);
  const declined = await call(coordinator, "room_decline_help_offer", { requestId: "decline-other", workItemId, expectedRevision: 1,
    offerId: offers[loser].offerId, expectedOfferRevision: 0, reason: "Invitation ended" });
  assert.equal(declined.structuredContent.status, "recorded");
  // A refreshed invitation supports a new offer and explicit withdrawal, with no
  // implicit resubmission of a declined or released offer.
  const renewed = send("producer", "work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 2,
    status: "open", scope: "Suggest one agenda item", expiresAt: new Date(now + 3600000).toISOString() });
  const newOffer = { ...offers[0], requestId: "new-scope-offer", offerId: "a-new", expectedHelpRevision: 3, helpEventId: renewed.event.id, plan: "One item only" };
  assert.equal((await call(a, "room_offer_help", newOffer)).structuredContent.status, "recorded");
  const withdraw = { requestId: "withdraw-new", workItemId, expectedRevision: 1, offerId: "a-new", expectedOfferRevision: 0, reason: "No longer available" };
  assert.equal((await call(b, "room_withdraw_help_offer", withdraw)).isError, true);
  assert.equal((await call(a, "room_withdraw_help_offer", withdraw)).structuredContent.status, "recorded");
  const final = await read(coordinator), state = f.store.room("commons").state;
  assert.equal(final.offers.availability.selectedOfferId, null);
  assert.equal(final.offers.offers.find(o => o.offer.id === offers[winner].offerId).offer.externalActivityUnverified, true);
  assert.equal(state.workItems[workItemId].revision, 1); assert.equal(state.workItems[workItemId].state, before.workItems[workItemId].state);
  assert.deepEqual(state.messages, before.messages); assert.deepEqual(state.members, before.members);
  assert.deepEqual(["producer", "helper-a", "helper-b"].map(id => f.store.snapshot(f.keys[id], "commons").cursor), beforeMarkers);
  assert.equal(JSON.stringify([opened, raced, final]).includes(f.keys["helper-a"]), false);
});
