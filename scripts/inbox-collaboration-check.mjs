// Automated counterpart to the staged actual-assistant exercise. No model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInboxCollaborationJourney } from "./inbox-collaboration-journey.mjs";
import { openMcpTestClient } from "./mcp-test-client.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";

for (const mobile of [false, true]) test(`private collaboration ${mobile ? "mobile" : "desktop"}: excerpt, offer, draft, review, return and unknown-send recovery`, { timeout: 60000 }, async t => {
  const journey = await createInboxCollaborationJourney({ mobile }), { configDirectory, workItemId, helperId, evidenceDirectory } = journey.manifest;
  let agent;
  t.after(async () => { try { await agent?.close(); } finally { await journey.close(); } });
  agent = await openMcpTestClient(configDirectory);
  const calls = [];
  const call = async (name, input = {}) => {
    const result = await agent.call(name, input);
    assert.equal(result.result?.isError, undefined, JSON.stringify(result));
    assert.ok(result.result?.structuredContent);
    const value = result.result.structuredContent, text = JSON.stringify(value);
    for (const privateText of ["ORCHID-482", "maya@example.test", "you@example.test"]) assert.equal(text.includes(privateText), false);
    calls.push({ name, requestId: input.requestId ?? null });
    return value;
  };
  const access = await call("room_check_access"); assert.equal(access.memberId, helperId); assert.deepEqual(access.permissions, []);
  const context = await call("room_read_work", { workItemId, includeSource: true, includeOffers: true });
  assert.equal(context.work.accountableMemberId, "owner");
  assert.match(context.context.source.message.body, /one small next step/);
  assert.equal(context.offers.availability.canOffer, true);
  await call("room_read_work_discussion", { workItemId, limit: 20 });
  const offerInput = { requestId: "offer-reply", offerId: "helper-reply", workItemId,
    expectedRevision: context.work.revision, expectedHelpRevision: context.help.revision, helpEventId: context.help.eventId,
    plan: "I can draft one short reply from the selected excerpt. I will not send it." };
  const offered = await call("room_offer_help", offerInput);
  await journey.stage("select", { offerId: offerInput.offerId });
  const selected = await call("room_read_work", { workItemId, includeOffers: true });
  assert.equal(selected.offers.availability.selectedOfferId, offerInput.offerId);
  assert.equal(selected.work.revision, context.work.revision);
  const body = "Thanks for inviting me. What’s one small idea we could explore together?";
  const input = { requestId: "reply-draft", workItemId, packetId: "selected-excerpt-reply", basisRevision: selected.work.revision, body };
  const draft = await call("room_post_draft", input);
  await agent.close(); agent = await openMcpTestClient(configDirectory);
  assert.equal((await call("room_offer_help", offerInput)).eventId, offered.eventId);
  const retry = await call("room_post_draft", input); assert.equal(retry.duplicate, true); assert.equal(retry.eventId, draft.eventId);
  const direct = new RoomAgentClient(readAgentConnection(configDirectory));
  const exact = await direct.workResult(workItemId, { draftMessageId: draft.messageId });
  assert.equal(exact.result.text.body, body); assert.equal(exact.result.text.postedById, helperId);
  await journey.stage("adopt", { messageId: draft.messageId, expectedBody: body });
  const reviewed = await journey.stage("review", { expectedBody: body, reason: "Scripted reviewer checks the exact concise invitation reply with one next step; no invented details." });
  assert.equal(reviewed.work.decision, null); assert.equal(reviewed.providerSubmissions, 0);
  const finished = await journey.stage("finish", { expectedBody: body });
  assert.equal(finished.draft.body, body); assert.equal(finished.draft.origin.unchanged, true);
  assert.equal(finished.sends[0].envelope.body, body); assert.equal(finished.sends[0].status, "accepted");
  assert.equal(finished.offers[offerInput.offerId].status, "selected", "Approving a result does not silently release its helper.");
  const current = await call("room_read_work", { workItemId, includeOffers: true });
  const own = current.offers.offers.find(row => row.offer.id === offerInput.offerId);
  assert.equal(own.canRelease, true);
  await call("room_release_help_offer", { requestId: "release-reply", workItemId, offerId: offerInput.offerId,
    expectedRevision: current.work.revision, expectedOfferRevision: own.offer.revision,
    reason: "Contribution handed back. Release coordination only.", externalActivityUnverified: true });
  const final = await journey.stage("read");
  assert.equal(final.offers[offerInput.offerId].status, "released"); assert.equal(final.helperCursor, 0);
  assert.equal(final.messages.filter(m => m.id === draft.messageId).length, 1);
  assert.equal(final.providerSubmissions, 1); assert.equal(final.providerMessages, 1);
  writeFileSync(join(evidenceDirectory, "classification.json"), JSON.stringify({ simulatedHumans: true, scriptedMcp: true,
    actualModelInThisAutomatedRun: false, mobile, calls, workItemId }, null, 2));
  console.log(JSON.stringify({ evidenceDirectory, mobile, workItemId }));
});
