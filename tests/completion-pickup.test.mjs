import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { buildReplyCommand, declineAlternativeOperationId, recordedReplyAction } from "../client/reply-actions.mjs";
import { confirmsAgentCommand } from "../client/work-actions.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { startCompletionPickup } from "../server/completion-pickup.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { atomicPrivateJson } from "../room-acp/src/private-files.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function checkScopedInvestigation(t, firstLine) {
  const f = createAcceptanceFixture(), roomId = "commons", workItemId = "qa-work", recipientId = "pickup-reviewer";
  const agent = f.store.identities.create("Pickup reviewer");
  linkWithProof(f.store, f.keys.owner, roomId, agent, { memberId: recipientId, permissions: ["accept_work","verify"] });
  const requesterId = f.store.authenticate(f.keys.owner, roomId).member.id;
  f.store.command(f.keys.owner, roomId, { id: randomUUID(), type:"work.proposed",
    data:{ workItemId, title:"QA lane", definitionOfDone:"Return read-only evidence.", accountableMemberId:requesterId, mode:"read" } });
  const request = (body,id) => f.store.command(f.keys.owner, roomId, buildReplyCommand({roomId,memberId:requesterId},"room_request_reply",
    {requestId:id,toMemberId:recipientId,workItemId,body}));
  const answer = messageId => {
    const exact = f.store.replyRequests.selected(agent.secret,roomId,messageId);
    const template = exact.responseActions.find(a=>a.arguments.responseOutcome==="answered");
    const {roomId: _roomId,...args}=template.arguments;
    f.store.command(agent.secret,roomId,buildReplyCommand({roomId,memberId:recipientId},template.tool,
      {...args,requestId:randomUUID(),body:"Checked the current authorized evidence."}));
  };
  const after = f.store.headSequence(roomId);
  const checkpointPath = join(f.directory,"checkpoint.json"), config = join(f.directory,"pickup.json"),
    credentialPath = join(f.directory,"operator.json");
  chmodSync(f.directory,0o700);
  atomicPrivateJson(credentialPath,{ identitySecret:f.keys.owner });
  atomicPrivateJson(config,{checkpointPath,routes:[{ roomId, requesterId, recipientId, workItemId, credentialPath, after, firstLine }]});
  const log=[];
  const start=()=>startCompletionPickup(f.store,config,msg=>log.push(JSON.parse(msg)));
  let stop=start();
  t.after(()=>{stop();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const read=()=>f.store.replyRequests.list(f.keys.owner,roomId,{direction:"outgoing",status:"all"}).requests;
  const first = request("Verify current evidence", "initial-qa");
  await setImmediate();
  assert.equal(read().length,1);
  answer(first.event.data.messageId);
  await setImmediate();
  assert.equal(read().length,2,JSON.stringify(log));
  const next=read().find(item=>item.id!==first.event.data.messageId);
  assert.equal(next.workItemId,workItemId);
  const opened = f.store.replyRequests.selected(agent.secret,roomId,next.id,{view:"compact"}).page.items[0].message.body;
  assert.ok(opened.startsWith(firstLine === undefined ? `@(${recipientId}) Room investigation pass.\n`
    : `${firstLine}\nRoom investigation pass.\n`));
  stop();
  rmSync(checkpointPath);
  stop=start();
  await setImmediate();
  assert.equal(read().length,2);
  answer(next.id);
  await setImmediate();
  assert.equal(read().length,2);
  assert.deepEqual(log.map(x=>x.event),["completion_pickup.posted"]);
}

test("a settled formal QA opens one scoped investigation, and catch-up cannot reopen it",
  t => checkScopedInvestigation(t));
test("a completion route preserves the receiver's exact first line without chaining an investigation",
  t => checkScopedInvestigation(t, "Claude Code QA"));

async function checkPlannedContinuation(t, representation) {
  const directory = mkdtempSync(join(tmpdir(), "room-planned-continuation-"));
  const db = join(directory, "room.sqlite");
  const roomId = "commons", workItemId = "qa-work";
  const wallClock = Date.now;
  let now = wallClock();
  const openStore = () => new RoomStore(db, { now: () => now });
  const f = { directory, store: openStore() };
  let stop = () => {};
  t.after(() => { Date.now = wallClock; stop(); f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.store.initialize(initialRoom(roomId), representation ? { representation } : {});
  f.keys = { owner: f.store.issueAccessKey(roomId, "owner") };
  const requesterId = f.store.authenticate(f.keys.owner, roomId).member.id;
  const identity = { roomId, memberId: requesterId };
  const lanes = ["claude", "dot", "muse"].map(name => {
    const agent = f.store.identities.create(name);
    linkWithProof(f.store, f.keys.owner, roomId, agent, { memberId: name, permissions: ["accept_work", "verify"] });
    return { name, agent };
  });
  f.store.command(f.keys.owner, roomId, { id: randomUUID(), type: "work.proposed",
    data: { workItemId, title: "QA lane", definitionOfDone: "Return source evidence.", accountableMemberId: requesterId, mode: "read" } });
  const after = f.store.headSequence(roomId);
  chmodSync(f.directory, 0o700);
  const checkpointPath = join(f.directory, "checkpoint.json");
  const config = join(f.directory, "pickup.json");
  const credentialPath = join(f.directory, "operator.json");
  atomicPrivateJson(credentialPath, { identitySecret: f.keys.owner });
  atomicPrivateJson(config, {
    checkpointPath,
    routes: lanes.map(({ name }) => ({
      roomId, requesterId, recipientId: name, workItemId, credentialPath, after,
      firstLine: name === "claude" ? "Claude Code QA" : `@(${name})`,
      continuation: { seedRequestId: `${name}-seed`, steps: [
        { requestId: `${name}-second`, body: "Check the pinned source and report the observed result." },
        { requestId: `${name}-third`, body: "Verify the next exact candidate and record a result." },
      ] },
    })),
  });
  const request = (name, id) => f.store.command(f.keys.owner, roomId,
    buildReplyCommand(identity, "room_request_reply", {
      requestId: id, toMemberId: name, workItemId, body: "Read-only QA seed.",
    })).event.data.messageId;
  const requestId = operationId => {
    const receipt = f.store.operationReceipt(f.keys.owner, roomId, operationId);
    assert.equal(receipt.status, "recorded", operationId);
    return JSON.parse(f.store.db.prepare("SELECT body FROM events WHERE room_id=? AND sequence=?")
      .get(roomId, receipt.sequence).body).data.messageId;
  };
  const record = (operationId, name, outcome = "answered") => {
    const { agent } = lanes.find(lane => lane.name === name);
    const exact = f.store.replyRequests.selected(agent.secret, roomId, requestId(operationId));
    const template = exact.responseActions.find(action => action.arguments.responseOutcome === outcome);
    const { roomId: _roomId, ...args } = template.arguments;
    f.store.command(agent.secret, roomId, buildReplyCommand({ roomId, memberId: name }, template.tool,
      { ...args, requestId: randomUUID(), body: "Exact result for this check." }));
  };
  const status = id => f.store.operationReceipt(f.keys.owner, roomId, id).status;
  const log = [];
  const start = () => startCompletionPickup(f.store, config, message => log.push(JSON.parse(message)));
  stop = start();
  for (const { name } of lanes) request(name, `${name}-seed`);
  const competing = request("dot", "dot-other-work");
  const dot = lanes.find(lane => lane.name === "dot");
  f.store.command(dot.agent.secret, roomId, buildReplyCommand({ roomId, memberId: "dot" }, "room_progress_request", {
    requestId: "dot-other-acknowledged", requestMessageId: competing, expectedRequestRevision: 0, progress: "acknowledged",
  }));
  await setImmediate();
  for (const { name } of lanes) assert.equal(status(`${name}-second`), "not_recorded");
  record("claude-seed", "claude");
  record("dot-seed", "dot");
  record("muse-seed", "muse", "declined");
  await setImmediate();
  assert.equal(status("claude-second"), "recorded", JSON.stringify(log));
  assert.equal(status("claude-third"), "not_recorded");
  assert.equal(status("dot-second"), "not_recorded");
  assert.equal(status("muse-second"), "not_recorded");
  const claudeSecond = f.store.replyRequests.selected(lanes[0].agent.secret, roomId, requestId("claude-second"));
  assert.equal(claudeSecond.page.items[0].message.body, "Claude Code QA\nCheck the pinned source and report the observed result.");
  const originalSecond = f.store.operationReceipt(f.keys.owner, roomId, "claude-second").eventId;

  now += 31 * 60 * 1000;
  Date.now = () => now;
  const aged = f.store.replyRequests.list(f.keys.owner, roomId, { direction: "outgoing", status: "open", states: true })
    .requests.find(item => item.id === competing);
  assert.equal(aged.lifecycle.state, "stale");
  assert.equal(aged.lifecycle.unresponsive, false);
  stop();
  stop = start();
  await setImmediate();
  assert.equal(status("dot-second"), "not_recorded");

  stop();
  record("claude-second", "claude");
  record("dot-other-work", "dot");
  f.store.close();
  f.store = openStore();
  stop = start();
  await setImmediate();
  assert.equal(status("claude-third"), "recorded", JSON.stringify(log));
  assert.equal(status("dot-second"), "recorded");
  assert.equal(status("dot-third"), "not_recorded");
  assert.equal(status("muse-second"), "not_recorded");
  assert.equal(f.store.operationReceipt(f.keys.owner, roomId, "claude-second").eventId, originalSecond);

  record("dot-second", "dot");
  record("claude-third", "claude");
  await setImmediate();
  assert.equal(status("dot-third"), "recorded");
  record("dot-third", "dot");
  await setImmediate();
  const before = f.store.headSequence(roomId);
  stop();
  rmSync(checkpointPath);
  stop = start();
  await setImmediate();
  assert.equal(f.store.headSequence(roomId), before);
  assert.equal(log.filter(row => row.event === "completion_pickup.continued").length, 4);
  assert.equal(log.filter(row => row.event === "completion_pickup.posted").length, 0);
}

test("legacy Room advances three explicit lanes through restart, refusal and competing work",
  t => checkPlannedContinuation(t));
test("normalized Room advances three explicit lanes through restart, refusal and competing work",
  t => checkPlannedContinuation(t, "normalized-current-v1"));

for (const representation of ["legacy", "normalized-current-v1"]) {
  test(`planned and request-authored alternatives wait for a fresh receiver (${representation})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-decline-continuation-"));
    chmodSync(directory, 0o700);
    const store = new RoomStore(join(directory, "room.sqlite"));
    const roomId = "commons", requesterId = "requester", recipientId = "reviewer", workItemId = "qa";
    store.initialize(initialRoom(roomId), representation === "legacy" ? {} : { representation });
    const admin = store.issueAccessKey(roomId, "owner");
    const requester = store.identities.create("Requester");
    linkWithProof(store, admin, roomId, requester, { memberId: requesterId, permissions: ["steer", "accept_work"] });
    const owner = requester.secret;
    const agent = store.identities.create("Reviewer");
    linkWithProof(store, admin, roomId, agent, { memberId: recipientId, permissions: [] });
    store.command(admin, roomId, { id: "create-qa", type: "work.proposed",
      data: { workItemId, title: "QA", definitionOfDone: "Review the given evidence.", accountableMemberId: requesterId, mode: "read" } });
    const server = createRoomServer({ store });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const checkpointPath = join(directory, "checkpoint.json");
    const config = join(directory, "pickup.json");
    const credentialPath = join(directory, "operator.json");
    const replacement = "Review the separate Changes label and give one concrete improvement.";
    atomicPrivateJson(credentialPath, { identitySecret: owner });
    atomicPrivateJson(config, { checkpointPath, routes: [{
      roomId, requesterId, recipientId, workItemId, credentialPath, after: store.headSequence(roomId),
      allowUnadvertisedReceiver: representation === "legacy",
      allowRequestAlternatives: true,
      continuation: { seedRequestId: "seed-review", steps: [
        { requestId: "separate-review", body: replacement, afterOutcome: "declined" },
      ] },
    }] });
    const log = [];
    const start = () => startCompletionPickup(store, config, message => log.push(JSON.parse(message)), server);
    let stop = start();
    t.after(async () => {
      stop();
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const fire = (token, memberId, name, args) =>
      store.command(token, roomId, buildReplyCommand({ roomId, memberId }, name, args));
    const seed = fire(owner, requesterId, "room_request_reply", { requestId: "seed-review",
      toMemberId: recipientId, workItemId, body: "Decline if this sketch cannot establish exact width." });
    const scope = { requesters: [requesterId], workItems: [workItemId], requests: [] };
    const connect = async (receiverScope, waiting = true, after = store.headSequence(roomId)) => {
      const response = await fetch(`${origin}/api/rooms/${roomId}/stream?after=${after}`, { headers: {
        Authorization: "Bearer " + agent.secret,
        ...(receiverScope ? { "X-Project-Room-Receiver-Scope": JSON.stringify(receiverScope) } : {}),
        ...(waiting ? { "X-Project-Room-Receiver-State": "waiting_for_work" } : {}),
      } });
      assert.equal(response.status, 200);
    };
    const receipt = () => store.operationReceipt(owner, roomId, "separate-review");
    await connect(scope);
    assert.equal(receipt().status, "not_recorded");
    const selected = store.replyRequests.selected(agent.secret, roomId, seed.event.data.messageId);
    const { tool, arguments: { roomId: _roomId, ...decline } } =
      selected.responseActions.find(action => action.arguments.responseOutcome === "declined");
    fire(agent.secret, recipientId, tool, { ...decline, requestId: "decline-review", body: "The exact width is unavailable." });
    await setImmediate();
    assert.equal(receipt().status, "not_recorded", "a stream opened before decline does not show rearm");
    await connect({ ...scope, workItems: ["other-work"] });
    await connect(scope, false);
    await setImmediate();
    assert.equal(receipt().status, "not_recorded", "wrong scope and scope without waiting cannot trigger pickup");
    server.closeStreams();
    await connect(undefined, false, seed.sequence);
    assert.equal(receipt().status, "not_recorded", "a legacy connection must have caught up through the decline");
    if (representation === "legacy") {
      await connect(undefined, false);
    } else {
      await connect(undefined, false);
      assert.equal(receipt().status, "not_recorded", "legacy readiness requires route opt-in");
      await connect(scope);
    }
    await setImmediate();
    assert.equal(receipt().status, "recorded", JSON.stringify(log));
    const after = store.headSequence(roomId), recorded = receipt();
    const next = store.replyRequests.list(owner, roomId, { direction: "outgoing", status: "open" }).requests;
    assert.equal(next.length, 1);
    const opened = store.replyRequests.selected(agent.secret, roomId, next[0].id).page.items[0].message;
    assert.equal(opened.body, `@(${recipientId})\n${replacement}`);
    stop();
    stop = start();
    server.closeStreams();
    await connect(scope);
    await setImmediate();
    assert.equal(receipt().eventId, recorded.eventId);
    assert.equal(store.headSequence(roomId), after);
    assert.deepEqual(log.map(row => row.opening), [recorded.sequence]);

    const respond = (id, outcome, operationId) => {
      const request = store.replyRequests.selected(agent.secret, roomId, id);
      const action = request.responseActions.find(option => option.arguments.responseOutcome === outcome);
      const { roomId: _roomId, ...args } = action.arguments;
      return fire(agent.secret, recipientId, action.tool, { ...args, requestId: operationId, body: "Reviewed the exact request." });
    };
    respond(opened.id, "answered", "answer-static");
    server.closeStreams();
    const postDraft = (actor, id, body, work = workItemId) => store.command(actor, roomId, {
      id, type: "message.posted", data: { messageId: id, body, workItemId: work },
    });
    const dynamicBody = "Review the empty-state wording for a dismissed note.";
    postDraft(owner, "replacement-draft", dynamicBody);
    postDraft(owner, "unlinked-draft", "Outside this Work Thread.", null);
    const makeSeed = (requestId, declineAlternativeMessageId) => buildReplyCommand(
      { roomId, memberId: requesterId }, "room_request_reply",
      { requestId, toMemberId: recipientId, workItemId, body: "Check whether the exact hunk can be seen.", declineAlternativeMessageId },
    );
    assert.throws(() => store.command(owner, roomId, makeSeed("outside-scope", "unlinked-draft")), { code: "invalid_arguments" });
    const command = makeSeed("room-authored-seed", "replacement-draft");
    const dynamic = store.command(owner, roomId, command);
    assert.ok(confirmsAgentCommand(dynamic, command, { roomId, memberId: requesterId }));
    const operationId = declineAlternativeOperationId(dynamic.event.id);
    const recovery = { sourceMessageId: "replacement-draft", operationId,
      nextRead: { tool: "room_receipt", arguments: { roomId, operationId } } };
    assert.deepEqual(recordedReplyAction("room_request_reply", {}, command, dynamic).declineAlternative, recovery);
    assert.equal(store.command(owner, roomId, command).duplicate, true);
    const retry = await fetch(origin + "/mcp", {
      method: "POST", headers: { Authorization: "Bearer " + owner, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_request_reply",
        arguments: { roomId, requestId: command.id, toMemberId: recipientId, workItemId, body: command.data.body,
          declineAlternativeMessageId: "replacement-draft" } } }),
    });
    const rpc = await retry.json();
    assert.equal(rpc.result?.structuredContent?.duplicate, true, JSON.stringify(rpc));
    assert.deepEqual(rpc.result.structuredContent.declineAlternative, recovery);
    assert.equal(dynamic.event.data.body, command.data.body);
    assert.ok(!JSON.stringify(dynamic.event).includes(dynamicBody));
    respond(dynamic.event.data.messageId, "declined", "decline-room-authored");
    await setImmediate();
    const dynamicReceipt = () => store.operationReceipt(owner, roomId, operationId);
    assert.equal(dynamicReceipt().status, "not_recorded");
    stop();
    stop = start();
    await connect(scope);
    await setImmediate();
    const alternative = dynamicReceipt();
    assert.equal(alternative.status, "recorded", JSON.stringify(log));
    const published = store.replyRequests.list(owner, roomId, { direction: "outgoing", status: "open" }).requests;
    assert.equal(published.length, 1);
    const task = store.replyRequests.selected(agent.secret, roomId, published[0].id).page.items[0].message;
    assert.equal(task.body, `@(${recipientId})\n${dynamicBody}`);
    respond(task.id, "answered", "answer-dynamic");
    server.closeStreams();

    const edited = store.command(owner, roomId, makeSeed("edited-draft-seed", "replacement-draft"));
    const editedDecline = respond(edited.event.data.messageId, "declined", "decline-edited-draft");
    store.command(owner, roomId, { id: "edit-approved-draft", type: "message.edited",
      data: { messageId: "replacement-draft", body: "Different evidence and a different request.", expectedMessageRevision: 0 } });
    await connect(scope);
    await setImmediate();
    assert.equal(store.operationReceipt(owner, roomId, declineAlternativeOperationId(edited.event.id)).status, "not_recorded");
    assert.equal(log.filter(row => row.event === "completion_pickup.decline_alternative").length, 1);
    assert.equal(log.some(row => row.decline === editedDecline.sequence), false);
    server.closeStreams();
    postDraft(owner, "draft-to-remove", "Review the wording for a closed hunk.");
    const deleted = store.command(owner, roomId, makeSeed("deleted-draft-seed", "draft-to-remove"));
    respond(deleted.event.data.messageId, "declined", "decline-deleted-draft");
    store.command(owner, roomId, { id: "delete-approved-draft", type: "message.deleted",
      data: { messageId: "draft-to-remove", expectedMessageRevision: 0 } });
    await connect(scope);
    await setImmediate();
    assert.equal(store.operationReceipt(owner, roomId, declineAlternativeOperationId(deleted.event.id)).status, "not_recorded");
    server.closeStreams();
    const withdrawn = store.command(owner, roomId, makeSeed("cancelled-dynamic-seed", "replacement-draft"));
    fire(owner, requesterId, "room_cancel_request", { requestId: "cancel-dynamic", requestMessageId: withdrawn.event.data.messageId,
      expectedRequestRevision: 0, reason: "The requester no longer needs this check." });
    const answered = store.command(owner, roomId, makeSeed("answered-dynamic-seed", "replacement-draft"));
    respond(answered.event.data.messageId, "answered", "answer-pending");
    stop();
    rmSync(checkpointPath);
    stop = start();
    await connect(scope);
    await setImmediate();
    assert.equal(store.operationReceipt(owner, roomId, declineAlternativeOperationId(withdrawn.event.id)).status, "not_recorded");
    assert.equal(store.operationReceipt(owner, roomId, declineAlternativeOperationId(answered.event.id)).status, "not_recorded");
    assert.equal(dynamicReceipt().eventId, alternative.eventId);
    assert.equal(log.filter(row => row.event === "completion_pickup.decline_alternative").length, 1);
  });
}
