import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test("local API handoff: cold action discovery, revision correction, restart, review and human decision", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-handoff-contract-"));
  const filename = join(directory, "fixture.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const identities = new Map();
  for (const [memberId, permissions] of [["producer", ["accept_work", "complete_work"]], ["reviewer", ["verify"]]]) {
    const identity = store.identities.create(`${memberId} (scripted fixture)`); identities.set(memberId, identity);
    linkWithProof(store, ownerKey, "commons", identity, { memberId, displayName: memberId, permissions });
    // Graduated autonomy tiers: the fixture agents are operator-promoted so the
    // handoff contract exercises them as working agents.
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const producerKey = identities.get("producer").secret, reviewerKey = identities.get("reviewer").secret;
  let signEvidence = makeTestSigner(store);
  let server;
  const start = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); };
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  let origin = await start();
  const client = token => new RoomAgentClient({ origin, roomId: "commons", token });
  let owner = client(ownerKey), producer = client(producerKey), reviewer = client(reviewerKey);
  const command = (id, type, data) => ({ id, type, data });
  const item = async actor => (await actor.orient()).work.find(work => work.id === "handoff");
  const mutate = async (actor, id, type, data = {}) => actor.command(command(id, type, { workItemId: "handoff", expectedRevision: (await item(actor)).revision, ...data }));
  await owner.command(command("source", T.MESSAGE_POSTED, { messageId: "request", body: "Prepare a short agenda that names its owner." }));
  await owner.command(command("propose", T.WORK_PROPOSED, {
    workItemId: "handoff", title: "Local handoff fixture", definitionOfDone: "A short agenda naming its owner, checked at the exact submitted version.",
    accountableMemberId: "producer", verifierMemberId: "reviewer", independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "request", mode: "read"
  }));
  assert.equal((await item(producer)).next.action, "accept");
  // A cold agent starts with discovery rather than a preloaded lifecycle tool.
  // Execute the returned action through the hosted transport, then continue the
  // same persisted work through correction, review and the human decision.
  const rpc = async (method, params) => {
    const response = await fetch(`${origin}/room/mcp?profile=lean`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${identities.get("producer").secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "cold-handoff", method, params })
    });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(body.result.isError, undefined, JSON.stringify(body.result)); return body.result;
  };
  const listed = await rpc("tools/list", { profile: "lean" });
  assert.ok(listed.tools.some(tool => tool.name === "room_search_actions"));
  assert.ok(listed.tools.some(tool => tool.name === "room_run_action"),
    "a lean listed-tools-only client can execute its discovered action");
  const found = await rpc("tools/call", { name: "room_search_actions", arguments: { query: "accept assigned work" } });
  const accept = found.structuredContent.matches.find(action => action.name === "room_accept_work");
  assert.ok(accept, "assignment acceptance is discoverable by intent");
  assert.ok(accept.inputSchema.required.includes("workItemId"));
  const args = { roomId: "commons", workItemId: "handoff", requestId: "accept", expectedRevision: (await item(producer)).revision };
  const accepted = await rpc("tools/call", { name: "room_run_action", arguments: { name: accept.name, arguments: args } });
  assert.equal(accepted.structuredContent.status, "recorded");
  assert.equal((await item(producer)).state, "accepted", "discovered action persisted the assignment acceptance");
  await mutate(producer, "start", T.WORK_STARTED);
  assert.equal((await item(producer)).next.needsAttention, false, "running work does not repeatedly request attention");
  const version = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const submit = async (id, text) => mutate(producer, id, T.WORK_COMPLETED, {
    summary: text, evidenceVersion: version(text), producerId: "producer",
    evidenceUrl: "https://example.invalid/explicitly-synthetic-handoff-fixture", nextAction: "Review the text contained in this receipt; the fixture URL is not live.",
    signedEvidence: signEvidence()
  });
  await submit("draft-1", "Agenda: discuss the proposal.");
  let received = await item(reviewer);
  assert.equal(received.next.action, "verify");
  assert.equal(received.receipt.evidenceVersion, version(received.receipt.summary));
  await mutate(reviewer, "finding", T.VERIFICATION_RECORDED, {
    result: "fail", completionEventId: received.receipt.eventId, evidenceVersion: received.receipt.evidenceVersion,
    summary: "The submitted text does not name its owner.", nextAction: "Add the owner to the agenda."
  });
  assert.equal((await item(producer)).next.action, "revise");
  const checkpoint = (await producer.snapshot()).sequence;

  // Close every client transport and reopen the actual persisted database.
  await stop(); store = new RoomStore(filename); origin = await start();
  signEvidence = makeTestSigner(store);
  owner = client(ownerKey); producer = client(producerKey); reviewer = client(reviewerKey);
  assert.equal((await item(producer)).next.action, "revise");
  await mutate(producer, "resolve", T.WORK_BLOCKER_RESOLVED, { resolution: "The correction is understood." });
  await mutate(producer, "restart", T.WORK_STARTED);
  await submit("draft-2", "Owner: Room owner. Agenda: discuss the proposal and record the decision.");
  received = await item(reviewer);
  assert.equal(received.verification, null, "old review is not inherited");
  assert.equal(received.decision, null);
  assert.equal(received.receipt.evidenceVersion, version(received.receipt.summary));
  assert.match(received.receipt.summary, /^Owner:/);
  const review = command("review-2", T.VERIFICATION_RECORDED, {
    workItemId: "handoff", expectedRevision: received.revision, result: "pass",
    completionEventId: received.receipt.eventId, evidenceVersion: received.receipt.evidenceVersion,
    summary: "Scripted local check: text hash matches, and the agenda names its owner. Not a live AI or organizationally independent review."
  });
  await reviewer.command(review);
  assert.equal((await reviewer.command(review)).duplicate, true);
  assert.equal((await item(owner)).next.action, "decide");
  assert.equal((await producer.changes(checkpoint)).events.length > 0, true);
  const brief = await owner.returnBrief();
  assert.equal(brief.current.needsAttention.find(work => work.workItemId === "handoff").step, "decide");
  await mutate(owner, "decision", T.OWNER_DECISION_RECORDED, {
    decision: "approved", completionEventId: received.receipt.eventId, evidenceVersion: received.receipt.evidenceVersion,
    reason: "Synthetic human-role fixture decision; no external action.",
    sourceMessageId: "request"
  });
  assert.equal((await item(owner)).next.action, "complete");
  assert.equal((await owner.snapshot()).state.workItems.handoff.receiptHistory.length, 1);
  store.identities.rotate(identities.get("producer").identityId, producerKey);
  await assert.rejects(() => producer.orient(), error => error.status === 401 && error.code === "unauthenticated");
});

test("structured client keeps credentials private and preserves explicit retry IDs", async () => {
  const calls = [];
  const token = "a".repeat(43);
  const actor = new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: "room", token, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ duplicate: calls.length > 1 }) };
  } });
  const payload = { id: "stable-command", type: T.MESSAGE_POSTED, data: { body: "Local fixture" } };
  await actor.command(payload); await actor.command(payload);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].url.includes(token), false);
  assert.equal(JSON.stringify(actor).includes(token), false);
});
