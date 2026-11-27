import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { CAPACITY_STOP, compileCapacityWork, capacityWorkHandoff, compileIdleRefill, idleRefill } from "../server/completion-capacity.mjs";
import { startCompletionPickup, startReloadableCompletionPickup } from "../server/completion-pickup.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { atomicPrivateJson } from "../room-acp/src/private-files.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { textVersion } from "../server/text-results.mjs";
import { createWork } from "../server/work-claims.mjs";

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
  test(`an approved alternative waits for a fresh scoped receiver after decline (${representation})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-decline-continuation-"));
    chmodSync(directory, 0o700);
    const store = new RoomStore(join(directory, "room.sqlite"));
    const roomId = "commons", requesterId = "owner", recipientId = "reviewer", workItemId = "qa";
    store.initialize(initialRoom(roomId), representation === "legacy" ? {} : { representation });
    const owner = store.issueAccessKey(roomId, requesterId);
    const agent = store.identities.create("Reviewer");
    linkWithProof(store, owner, roomId, agent, { memberId: recipientId, permissions: [] });
    store.command(owner, roomId, { id: "create-qa", type: "work.proposed",
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
  });
}

test("a validated continuation plan replaces only its subscriber and preserves operation receipts", async t => {
  const f = createAcceptanceFixture(), roomId = "commons", workItemId = "qa-work", recipientId = "reload-reviewer";
  const agent = f.store.identities.create("Reload reviewer");
  linkWithProof(f.store, f.keys.owner, roomId, agent, { memberId: recipientId, permissions: [] });
  const requesterId = f.store.authenticate(f.keys.owner, roomId).member.id;
  const identity = { roomId, memberId: requesterId };
  f.store.command(f.keys.owner, roomId, { id: "qa-proposal", type: "work.proposed",
    data: { workItemId, title: "QA", definitionOfDone: "Review the given evidence.", accountableMemberId: requesterId, mode: "read" } });
  chmodSync(f.directory, 0o700);
  const configPath = join(f.directory, "pickup.json"), checkpointPath = join(f.directory, "checkpoint.json"),
    credentialPath = join(f.directory, "operator.json");
  atomicPrivateJson(credentialPath, { identitySecret: f.keys.owner });
  const after = f.store.headSequence(roomId);
  function config(name) {
    return { checkpointPath, routes: [{ roomId, requesterId, recipientId, workItemId, credentialPath, after,
      continuation: { seedRequestId: `${name}-seed`, steps: [
        { requestId: `${name}-next`, body: "Check the next distinct source." },
      ] },
    }] };
  }
  function request(id) {
    f.store.command(f.keys.owner, roomId, buildReplyCommand(identity, "room_request_reply",
      { requestId: id, toMemberId: recipientId, workItemId, body: "Verify the pinned source." }));
  }
  const receipt = id => f.store.operationReceipt(f.keys.owner, roomId, id);
  function answer(id) {
    const event = f.store.db.prepare("SELECT body FROM events WHERE room_id=? AND sequence=?").get(roomId, receipt(id).sequence);
    const messageId = JSON.parse(event.body).data.messageId;
    const exact = f.store.replyRequests.selected(agent.secret, roomId, messageId);
    const template = exact.responseActions.find(a => a.arguments.responseOutcome === "answered");
    const { roomId: _roomId, ...args } = template.arguments;
    f.store.command(agent.secret, roomId, buildReplyCommand({ roomId, memberId: recipientId }, template.tool,
      { ...args, requestId: `${id}-answer`, body: "Source checked." }));
  }

  const original = config("old");
  atomicPrivateJson(configPath, original);
  const log = [];
  const pickup = startReloadableCompletionPickup(f.store, configPath, message => log.push(JSON.parse(message)));
  t.after(() => { pickup.stop(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const loaded = log[0];
  assert.equal(loaded.event, "completion_pickup.loaded");
  assert.match(loaded.configDigest, /^[a-f0-9]{64}$/);
  assert.equal(loaded.routes, 1);

  const candidate = config("new");
  candidate.routes[0].requesterId = "other";
  atomicPrivateJson(configPath, candidate);
  pickup.reload();
  assert.equal(log.at(-1).event, "completion_pickup.reload_rejected");
  assert.equal(log.at(-1).configDigest, loaded.configDigest);
  request("old-seed");
  answer("old-seed");
  await setImmediate();
  assert.equal(receipt("old-next").status, "recorded");
  answer("old-next");

  const replacement = config("new");
  atomicPrivateJson(configPath, replacement);
  request("new-seed");
  answer("new-seed");
  await setImmediate();
  assert.equal(receipt("new-next").status, "not_recorded", "saving a plan alone cannot activate it");
  atomicPrivateJson(configPath, { ...replacement, checkpointPath: join(f.directory, "other.json") });
  pickup.reload();
  assert.equal(log.at(-1).code, "checkpoint_path_changed");
  assert.equal(log.at(-1).configDigest, loaded.configDigest);
  atomicPrivateJson(configPath, replacement);
  pickup.reload();
  assert.equal(log.at(-1).event, "completion_pickup.reloaded");
  assert.notEqual(log.at(-1).configDigest, loaded.configDigest);
  await setImmediate();
  assert.equal(receipt("new-next").status, "recorded");
  const applied = receipt("new-next");
  pickup.reload();
  await setImmediate();
  assert.equal(receipt("new-next").eventId, applied.eventId);
  assert.equal(log.filter(row => row.event === "completion_pickup.continued").length, 2);
  assert.ok(!JSON.stringify(log).includes(f.keys.owner));

  answer("new-next");
  request("retry-seed");
  answer("retry-seed");
  await setImmediate();
  const head = f.store.headSequence(roomId);
  const receiptRead = f.store.operationReceipt.bind(f.store);
  const unreadable = new Set(["retry-seed"]);
  let permanentFailure = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(f.store, "operationReceipt", (secret, room, id) => {
    if (permanentFailure && id === "obsolete-seed") {
      throw Object.assign(new Error("Fixture lane remains unavailable"), { code: "storage_unavailable" });
    }
    if (unreadable.delete(id)) {
      throw Object.assign(new Error("Fixture read temporarily unavailable"), { code: "SQLITE_BUSY" });
    }
    return receiptRead(secret, room, id);
  });
  atomicPrivateJson(configPath, config("retry"));
  pickup.reload();
  await setImmediate();
  assert.equal(log.at(-1).code, "SQLITE_BUSY");
  assert.equal(receipt("retry-next").status, "not_recorded");
  assert.equal(f.store.headSequence(roomId), head, "no event arrived that could restart pickup");
  t.mock.timers.tick(1000);
  await setImmediate();
  const recovered = receipt("retry-next");
  assert.equal(recovered.status, "recorded");
  assert.equal(recovered.sequence, head + 1);
  pickup.reload();
  await setImmediate();
  assert.equal(receipt("retry-next").eventId, recovered.eventId);
  assert.equal(f.store.headSequence(roomId), recovered.sequence);

  answer("retry-next");
  request("obsolete-seed");
  answer("obsolete-seed");
  unreadable.add("obsolete-seed");
  atomicPrivateJson(configPath, config("obsolete"));
  pickup.reload();
  await setImmediate();
  assert.equal(log.at(-1).code, "SQLITE_BUSY");
  atomicPrivateJson(configPath, config("retry"));
  pickup.reload();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(receipt("obsolete-next").status, "not_recorded");
  assert.equal(receipt("retry-next").eventId, recovered.eventId);

  const other = config("second"), failing = config("obsolete").routes[0];
  const secondAgent = f.store.identities.create("Second reviewer");
  linkWithProof(f.store, f.keys.owner, roomId, secondAgent, { memberId: "second-reviewer", permissions: [] });
  other.routes.push({ ...other.routes[0], recipientId: "second-reviewer", continuation: failing.continuation });
  permanentFailure = true;
  atomicPrivateJson(configPath, other);
  pickup.reload();
  await setImmediate();
  for (const milliseconds of [1000, 2000, 4000, 8000, 16000, 32000]) {
    t.mock.timers.tick(milliseconds);
    await setImmediate();
  }
  request("second-seed");
  answer("second-seed");
  unreadable.add("second-seed");
  await setImmediate();
  assert.equal(receipt("second-next").status, "not_recorded");
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(receipt("second-next").status, "recorded", "a broken lane does not consume another lane's retry");
});

for (const representation of [undefined, "normalized-current-v1"]) for (const ingress of ["REST", "MCP"]) {
  test(`verified provider stop transfers a queued request and recovery refills once (${representation ?? "legacy"}, ${ingress})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-capacity-handoff-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    const roomId = "commons", requesterId = "owner", recipientId = "primary", workItemId = "qa-capacity";
    const identity = { roomId, memberId: requesterId };
    store.initialize(initialRoom(), representation ? { representation } : {});
    const owner = store.issueAccessKey(roomId, requesterId);
    const primary = store.identities.create("Primary QA");
    const alternate = store.identities.create("Alternate QA");
    linkWithProof(store, owner, roomId, primary, { memberId: recipientId, permissions: ["accept_work"] });
    linkWithProof(store, owner, roomId, alternate, { memberId: "alternate", permissions: ["accept_work", "complete_work"] });
    store.command(owner, roomId, { id: "capacity-work", type: "work.proposed", data: {
      workItemId, title: "Review capacity handoff", definitionOfDone: "Return source evidence.",
      accountableMemberId: requesterId, mode: "read"
    } });
    const after = store.headSequence(roomId);
    const plan = join(directory, "plan.json"), checkpointPath = join(directory, "checkpoint.json");
    const credentialPath = join(directory, "owner.json");
    atomicPrivateJson(credentialPath, { identitySecret: owner });
    atomicPrivateJson(plan, { checkpointPath, routes: [{
      roomId, requesterId, recipientId, workItemId, credentialPath, after,
      capacityHandoff: { sourceOperationId: "capacity-source", replacementOperationId: "capacity-alternate",
        replacementMemberId: "alternate", body: "Review the public setup instructions at the pinned revision." },
      idleRefill: { requestId: "capacity-restored", ...(representation ? { discover: true } : { body: "Review a different installation example." }) }
    }] });
    const source = buildReplyCommand(identity, "room_request_reply", { requestId: "capacity-source",
      toMemberId: recipientId, workItemId, body: "Original private text must not be forwarded." });
    store.command(owner, roomId, source);
    const receiver = createRoomServer({ store });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const origin = `http://127.0.0.1:${receiver.address().port}`;
    const connect = async (secret, scope = workItemId) => {
      const response = await fetch(`${origin}/api/rooms/${roomId}/stream?after=${store.headSequence(roomId)}`, { headers: {
        Authorization: "Bearer " + secret, "X-Project-Room-Receiver-State": "waiting_for_work",
        "X-Project-Room-Receiver-Scope": JSON.stringify({ requesters: [requesterId], workItems: [scope], requests: [] })
      } });
      assert.equal(response.status, 200);
      return response;
    };
    const rearmPrimary = async () => {
      receiver.closeStreams();
      await connect(primary.secret);
    };
    const capacityChange = async (action, requestId, reason) => {
      if (ingress === "MCP") {
        const response = await fetch(origin + "/mcp", {
          method: "POST", headers: { Authorization: "Bearer " + primary.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: {
            name: "wake_" + action, arguments: { roomId, requestId, ...(reason === undefined ? {} : { reason }) }
          } })
        });
        const rpc = await response.json();
        assert.equal(response.status, 200);
        assert.ok(!rpc.error && !rpc.result?.isError, JSON.stringify(rpc));
        assert.equal(rpc.result.structuredContent.receipt.state, action === "pause" ? "paused" : "active");
        return;
      }
      const response = await fetch(`${origin}/api/rooms/${roomId}/agent-pause`, {
        method: "POST", headers: { Authorization: "Bearer " + primary.secret, "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId, memberId: recipientId, reason })
      });
      assert.equal(response.status, 201, await response.text());
    };
    const logs = [];
    const start = () => startCompletionPickup(store, plan, text => logs.push(JSON.parse(text)), receiver);
    let stop = start();
    t.after(async () => {
      stop();
      receiver.closeStreams();
      receiver.closeAllConnections();
      await new Promise(resolve => receiver.close(resolve));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const receipt = id => store.operationReceipt(owner, roomId, id);
    const latest = id => logs.filter(entry => entry.event === id).at(-1)?.state;
    const selected = () => store.replyRequests.selected(owner, roomId, source.data.messageId, { view: "compact" }).request;
    await setImmediate();
    assert.equal(latest("completion_pickup.refill"), "pending_work");
    // Ordinary pause is not evidence about whether the provider ran the task.
    await capacityChange("pause", "manual-stop", "Personal pause");
    await setImmediate();
    assert.equal(latest("completion_pickup.capacity"), "paused");
    assert.equal(selected().status, "open");
    await capacityChange("resume", "manual-resume");
    await capacityChange("pause", "generic-provider-stop", CAPACITY_STOP);
    await setImmediate();
    assert.equal(latest("completion_pickup.capacity"), "awaiting_exact_stop");
    assert.equal(selected().status, "open");
    await capacityChange("resume", "generic-provider-resume");
    await capacityChange("pause", "provider-stop", `${CAPACITY_STOP}:request:${source.data.messageId}`);
    await setImmediate();
    assert.equal(latest("completion_pickup.capacity"), "replacement_unreachable");
    assert.equal(latest("completion_pickup.refill"), "capacity_blocked");
    assert.equal(selected().status, "open");
    const otherScope = await connect(alternate.secret, "other-scope");
    await setImmediate();
    assert.equal(receipt("capacity-alternate").status, "not_recorded");
    await otherScope.body.cancel();
    await connect(alternate.secret);
    await setImmediate();
    assert.equal(receipt("capacity-alternate").status, "recorded");
    assert.equal(receipt("capacity-restored").status, "not_recorded");
    assert.equal(selected().status, "cancelled");
    const next = buildReplyCommand(identity, "room_request_reply", { requestId: "capacity-alternate",
      toMemberId: "alternate", workItemId, body: "Only the ID matters for lookup." });
    const fallback = store.replyRequests.selected(alternate.secret, roomId, next.data.messageId, { view: "compact" });
    assert.match(fallback.page.items[0].message.body, /public setup instructions/);
    assert.doesNotMatch(fallback.page.items[0].message.body, /Original private/);
    const fallbackEvent = receipt("capacity-alternate").eventId;
    await capacityChange("resume", "provider-recovered");
    await setImmediate();
    assert.equal(latest("completion_pickup.refill"), "receiver_unconfirmed");
    const coworkerRequest = buildReplyCommand({ roomId, memberId: "alternate" }, "room_request_reply", {
      requestId: "coworker-private-work", toMemberId: recipientId, body: "A separate coworker request."
    });
    store.command(alternate.secret, roomId, coworkerRequest);
    assert.ok(!store.replyRequests.list(owner, roomId, { direction: "outgoing", status: "open" })
      .requests.some(item => item.id === coworkerRequest.data.messageId));
    await rearmPrimary();
    await setImmediate();
    assert.equal(receipt("capacity-restored").status, "not_recorded", "receiver availability does not override another person's open work");
    assert.equal(latest("completion_pickup.refill"), "pending_work");
    const cancel = buildReplyCommand({ roomId, memberId: "alternate" }, "room_cancel_request", {
      requestId: "coworker-work-withdrawn", requestMessageId: coworkerRequest.data.messageId,
      expectedRequestRevision: 0, reason: "The coworker no longer needs this check."
    });
    const assignedWork = "other-assigned-review";
    store.command(owner, roomId, { id: "other-work-proposal", type: "work.proposed", data: {
      workItemId: assignedWork, title: "Check the existing setup", definitionOfDone: "Return a source observation.",
      accountableMemberId: recipientId, mode: "read"
    } });
    store.command(primary.secret, roomId, { id: "other-work-accept", type: "work.accepted", data: {
      workItemId: assignedWork, expectedRevision: 0
    } });
    store.command(alternate.secret, roomId, cancel);
    await setImmediate();
    assert.equal(receipt("capacity-restored").status, "not_recorded", "an accepted Work Thread elsewhere beats discovery");
    assert.equal(latest("completion_pickup.refill"), "pending_work");
    store.command(primary.secret, roomId, { id: "other-work-start", type: "work.started", data: {
      workItemId: assignedWork, expectedRevision: 1
    } });
    await setImmediate();
    assert.equal(receipt("capacity-restored").status, "not_recorded", "a Work Thread in progress beats discovery");
    store.command(owner, roomId, { id: "other-work-supersede", type: "work.superseded", data: {
      workItemId: assignedWork, expectedRevision: 2, supersededByWorkItemId: workItemId,
      reason: "The current setup work covers this check."
    } });
    await rearmPrimary();
    await setImmediate();
    assert.equal(receipt("capacity-restored").status, "recorded");
    assert.equal(receipt("capacity-alternate").eventId, fallbackEvent);
    const recoveredEvent = receipt("capacity-restored").eventId;
    const fresh = buildReplyCommand(identity, "room_request_reply", { requestId: "capacity-restored",
      toMemberId: recipientId, workItemId, body: "Only the ID matters for lookup." });
    assert.match(store.replyRequests.selected(primary.secret, roomId, fresh.data.messageId).page.items[0].message.body,
      representation ? /one bounded task/ : /different installation example/);
    stop(); stop = start();
    await setImmediate();
    assert.equal(receipt("capacity-restored").eventId, recoveredEvent);
    assert.equal(receipt("capacity-alternate").eventId, fallbackEvent);
    const currentRefills = () => store.replyRequests.list(owner, roomId, { direction: "outgoing", status: "open" })
      .requests.filter(item => item.recipientId === recipientId);
    const settle = requestId => {
      const exact = store.replyRequests.selected(primary.secret, roomId, requestId);
      const { tool, arguments: { roomId: _roomId, ...args } } = exact.responseActions.find(action =>
        action.arguments.responseOutcome === "answered");
      store.command(primary.secret, roomId, buildReplyCommand({ roomId, memberId: recipientId }, tool, {
        ...args, requestId: randomUUID(), body: "Checked the source. No new task needed."
      }));
    };
    const evidenceWork = "new-room-evidence";
    const send = (token, type, data) => store.command(token, roomId, { id: randomUUID(), type, data });
    send(owner, "work.proposed", { workItemId: evidenceWork, title: "Fresh setup observation",
      definitionOfDone: "Reproduce the public setup", accountableMemberId: "alternate", mode: "read",
      ownerDecisionRequired: true, humanDecisionMakerId: requesterId });
    send(alternate.secret, "work.accepted", { workItemId: evidenceWork, expectedRevision: 0 });
    send(alternate.secret, "work.started", { workItemId: evidenceWork, expectedRevision: 1 });
    const resultText = "Verified the updated public example.";
    const message = send(alternate.secret, "message.posted", { messageId: "public-evidence-text", body: resultText, workItemId: evidenceWork });
    const completion = send(alternate.secret, "work.completed", { workItemId: evidenceWork, expectedRevision: 2,
      evidenceKind: "room_text", evidenceMessageId: "public-evidence-text", evidenceMessageEventId: message.event.id,
      evidenceVersion: textVersion(resultText), previousCompletionEventId: null, producerId: "alternate",
      summary: "Verified", nextAction: "None", checksClaimed: ["setup"] });
    await setImmediate();
    assert.deepEqual(currentRefills().map(item => item.id), [fresh.data.messageId], "pending work wins over new evidence");
    settle(fresh.data.messageId);
    await rearmPrimary();
    await setImmediate();
    assert.equal(currentRefills().length, 0, "an unapproved result cannot generate new work");
    const reason = "Exact room evidence accepted.";
    const rationaleId = "public-evidence-decision";
    send(owner, "message.posted", { messageId: rationaleId, body: reason, workItemId: evidenceWork });
    send(owner, "owner.decision_recorded", { workItemId: evidenceWork, expectedRevision: 3,
      decision: "approved", completionEventId: completion.event.id, evidenceVersion: textVersion(resultText),
      reason, sourceMessageId: rationaleId });
    await setImmediate();
    if (representation) {
      const [followup] = currentRefills();
      assert.equal(currentRefills().length, 1);
      const exact = store.replyRequests.selected(primary.secret, roomId, followup.id, { view: "compact" });
      assert.ok(exact.page.items[0].message.body.includes(completion.event.id));
      stop(); stop = start();
      await rearmPrimary();
      await setImmediate();
      assert.deepEqual(currentRefills().map(item => item.id), [followup.id], "reconnect and restart preserve the exact offer");
      assert.match(exact.page.items[0].message.body, /current.next.action is complete/);
      assert.match(exact.page.items[0].message.body, /Do not substitute another source/);
      const readExact = () => store.workResult(primary.secret, roomId, evidenceWork, { completionEventId: completion.event.id });
      assert.equal(readExact().current.next.action, "complete");
      assert.equal(readExact().scope.workVisibility, "room");
      send(owner, "work.superseded", { workItemId: evidenceWork, expectedRevision: 4,
        supersededByWorkItemId: workItemId, reason: "Replaced by the current setup check." });
      assert.equal(readExact().selection.status, "current", "a superseded Work Thread can still have a readable selected result");
      assert.equal(readExact().current.next.action, "superseded", "the investigation preflight rejects the superseded source");
      settle(followup.id);
      await rearmPrimary();
    }
    send(owner, "message.posted", { messageId: "unrelated-conversation", body: "Unrelated discussion" });
    await setImmediate();
    assert.equal(currentRefills().length, 0, "a named task or an already checked result does not recur");
    assert.equal(latest("completion_pickup.refill"), "no_work_ready");
    // An owned run can have a saved result before its first Room progress event.
    const claimed = buildReplyCommand(identity, "room_request_reply", { requestId: "claimed-source",
      toMemberId: recipientId, workItemId, body: "Keep this exact attempt and its saved result." });
    store.command(owner, roomId, claimed);
    const { request } = store.replyRequests.selected(primary.secret, roomId, claimed.data.messageId);
    const run = { requestMessageId: request.id, attemptId: "first-host", expectedRequestRevision: request.revision,
      contextEventId: request.contextEventId };
    store.requestRuns.apply(primary.secret, roomId, { ...run, action: "claim" });
    store.requestRuns.apply(primary.secret, roomId, { ...run, action: "result_ready" });
    atomicPrivateJson(plan, { checkpointPath, routes: [{
      roomId, requesterId, recipientId, workItemId, credentialPath, after,
      capacityHandoff: { sourceOperationId: "claimed-source", replacementOperationId: "claimed-alternate",
        replacementMemberId: "alternate", body: "This replacement must not run." }
    }] });
    stop(); stop = start();
    await capacityChange("pause", "reported-claimed-stop", `${CAPACITY_STOP}:request:${request.id}`);
    await setImmediate();
    assert.equal(latest("completion_pickup.capacity"), "inspect_existing_attempt");
    assert.equal(receipt("claimed-alternate").status, "not_recorded");
    assert.equal(store.replyRequests.selected(owner, roomId, request.id).request.status, "open");

    await capacityChange("resume", "after-claimed-stop");
    const progressed = buildReplyCommand(identity, "room_request_reply", { requestId: "progressed-source",
      toMemberId: recipientId, workItemId, body: "Keep the existing recipient progress." });
    store.command(owner, roomId, progressed);
    const progressId = progressed.data.messageId;
    store.command(primary.secret, roomId, buildReplyCommand({ roomId, memberId: recipientId }, "room_progress_request", {
      requestId: "progress-ack", requestMessageId: progressId, expectedRequestRevision: 0, progress: "acknowledged"
    }));
    atomicPrivateJson(plan, { checkpointPath, routes: [{
      roomId, requesterId, recipientId, workItemId, credentialPath, after,
      capacityHandoff: { sourceOperationId: "progressed-source", replacementOperationId: "progressed-alternate",
        replacementMemberId: "alternate", body: "This replacement must not run." }
    }] });
    stop(); stop = start();
    await capacityChange("pause", "reported-progressed-stop", `${CAPACITY_STOP}:request:${progressId}`);
    await setImmediate();
    assert.equal(latest("completion_pickup.capacity"), "inspect_existing_attempt");
    assert.equal(receipt("progressed-alternate").status, "not_recorded");
    assert.equal(store.replyRequests.selected(owner, roomId, progressId).request.status, "open");

  });
}

for (const representation of [undefined, "normalized-current-v1"]) {
  test(`verified prerequisites distinguish waiting from runnable work (${representation ?? "legacy"})`, t => {
    const store = new RoomStore(":memory:");
    t.after(() => store.close());
    const roomId = "commons", requesterId = "owner", recipientId = "recipient";
    const workItemId = "setup-review", prerequisite = "install-notes", successor = "verify-install";
    store.initialize(initialRoom(), representation ? { representation } : {});
    const owner = store.issueAccessKey(roomId, requesterId);
    const recipient = store.identities.create("Install reviewer");
    linkWithProof(store, owner, roomId, recipient, { memberId: recipientId, permissions: ["accept_work"] });
    const send = (secret, type, data) => store.command(secret, roomId, { id: randomUUID(), type, data });
    const propose = (id, accountableMemberId, dependsOn = []) => send(owner, "work.proposed", {
      workItemId: id, title: id, definitionOfDone: "Return the current installation evidence.",
      accountableMemberId, dependsOn, mode: "read"
    });
    propose(workItemId, requesterId);
    const definePrerequisite = id => {
      propose(id, requesterId);
      if (!representation) store.workClaims.set(roomId, createWork({ id, workItemId: id, title: id },
        { agentId: requesterId, now: store.now() }));
    };
    definePrerequisite(prerequisite);
    propose(successor, recipientId, [prerequisite]);
    send(recipient.secret, "work.accepted", { workItemId: successor, expectedRevision: 0 });
    const route = { roomId, requesterId, recipientId, workItemId, after: 0,
      idleRefill: { requestId: "check-other-source", discover: true } };
    const refill = compileIdleRefill(route);
    const attempt = id => {
      const nextRoute = { ...route, idleRefill: { ...route.idleRefill, requestId: id } };
      return idleRefill(store, { route: nextRoute, secret: owner, refill: compileIdleRefill(nextRoute),
        hasOpenRequest: () => false }, { hasRecoveryReceiver: () => true });
    };
    const current = () => store.workContext(recipient.secret, roomId, successor);
    assert.equal(current().next.action, "wait_prerequisites");
    assert.equal(attempt(refill.id).state, "refill_requested");
    assert.equal(current().next.action, "wait_prerequisites", "discovery preserves the original assignment");
    assert.equal(attempt(refill.id).state, "no_work_ready");

    send(owner, "work.accepted", { workItemId: prerequisite, expectedRevision: 0 });
    send(owner, "work.started", { workItemId: prerequisite, expectedRevision: 1 });
    const body = "Installation notes verified.";
    const evidence = send(owner, "message.posted", { messageId: "install-evidence", body, workItemId: prerequisite });
    send(owner, "work.completed", { workItemId: prerequisite, expectedRevision: 2,
      evidenceKind: "room_text", evidenceMessageId: "install-evidence", evidenceMessageEventId: evidence.event.id,
      evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: requesterId,
      summary: "Verified", nextAction: "Review installation", checksClaimed: ["docs"] });
    if (!representation) store.workClaims.set(roomId, { ...store.workClaims.get(roomId, prerequisite), state: "done" });
    assert.equal(current().next.action, "start");
    assert.equal(attempt("check-after-unblock").state, "pending_work");
    assert.equal(store.operationReceipt(owner, roomId, "check-after-unblock").status, "not_recorded");

    send(owner, "work.superseded", { workItemId: successor, expectedRevision: 1, supersededByWorkItemId: workItemId,
      reason: "Use the new install review." });
    const hidden = "private-install-notes", other = "review-restricted-install";
    definePrerequisite(hidden);
    const coworker = store.identities.create("Installation note author");
    linkWithProof(store, owner, roomId, coworker, { memberId: "author", permissions: ["accept_work"] });
    store.command(owner, roomId, buildReplyCommand({ roomId, memberId: requesterId }, "room_request_reply", {
      requestId: "private-install-review", toMemberId: "author", workItemId: hidden, body: "Verify the private setup."
    }));
    propose(other, recipientId, [hidden]);
    send(recipient.secret, "work.accepted", { workItemId: other, expectedRevision: 0 });
    assert.equal(store.workContext(recipient.secret, roomId, other).dependencies[0].state, "unknown");
    assert.equal(attempt("check-with-private-prerequisite").state, "pending_work");
    assert.equal(store.operationReceipt(owner, roomId, "check-with-private-prerequisite").status, "not_recorded");
  });
}

async function checkCapacityWork(t, representation) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const roomId = "commons", requesterId = "owner", recipientId = "primary", workItemId = "old-work";
  store.initialize(initialRoom(), representation ? { representation } : {});
  const secret = store.issueAccessKey(roomId, requesterId);
  const primary = store.identities.create("Primary agent");
  const replacement = store.identities.create("Replacement agent");
  const verifier = store.identities.create("Independent verifier");
  linkWithProof(store, secret, roomId, primary, { memberId: recipientId, permissions: ["accept_work"] });
  linkWithProof(store, secret, roomId, replacement, { memberId: "replacement", permissions: ["accept_work"] });
  linkWithProof(store, secret, roomId, verifier, { memberId: "verifier", permissions: ["verify"] });
  const propose = id => store.command(secret, roomId, { id: "create-" + id, type: "work.proposed", data: {
    workItemId: id, title: "Original task", definitionOfDone: "Check exact files", accountableMemberId: recipientId,
    verifierMemberId: "verifier", independentVerificationRequired: true, mode: "read"
  } });
  propose(workItemId);
  const route = { roomId, requesterId, recipientId, workItemId, after: store.headSequence(roomId),
    capacityWork: { operationId: "move-unopened-work", replacementMemberId: "replacement",
      replacementWorkItemId: "replacement-work", expectedRevision: 0,
      title: "Check the installation guide", definitionOfDone: "Report a public reproducible check." } };
  const binding = { route, secret, workHandoff: compileCapacityWork(route), hasOpenRequest: () => false };
  const receiver = { hasRecoveryReceiver: request => request.recipientId === "replacement" && request.workItemId === "replacement-work" };
  propose("started-work");
  store.command(primary.secret, roomId, { id: "old-accept", type: "work.accepted", data: { workItemId: "started-work", expectedRevision: 0 } });
  store.command(primary.secret, roomId, { id: "old-start", type: "work.started", data: { workItemId: "started-work", expectedRevision: 1 } });
  if (!representation) {
    propose("stopping-work");
    store.command(secret, roomId, { id: "request-session-stop", type: "session.stop_requested",
      data: { workItemId: "stopping-work", expectedRevision: 0 } });
    assert.equal(store.workContext(secret, roomId, "stopping-work").work.state, "proposed");
  }
  store.wakeQueue.pause(primary.secret, roomId, { requestId: "provider-work-hold", reason: `${CAPACITY_STOP}:work:${workItemId}:0` });
  const originalCommand = store.command.bind(store);
  store.command = (token, room, command) => {
    if (command.type === "message.posted") throw new Error("injected write failure");
    return originalCommand(token, room, command);
  };
  assert.throws(() => capacityWorkHandoff(store, binding, receiver), /injected write failure/);
  store.command = originalCommand;
  assert.equal(store.workContext(secret, roomId, workItemId).work.state, "proposed");
  assert.equal(store.operationReceipt(secret, roomId, "move-unopened-work").status, "not_recorded");
  assert.equal(capacityWorkHandoff(store, binding, receiver).state, "work_handed_off");
  const original = store.workContext(secret, roomId, workItemId);
  assert.equal(original.work.state, "superseded");
  assert.equal(original.next.replacement.workItemId, "replacement-work");
  const next = store.workContext(replacement.secret, roomId, "replacement-work");
  assert.equal(next.work.accountableMemberId, "replacement");
  assert.equal(next.work.verifierMemberId, "verifier");
  assert.equal(next.work.independentVerificationRequired, true);
  assert.equal(next.work.state, "proposed");
  assert.equal(store.operationReceipt(secret, roomId, "move-unopened-work-pickup").status, "recorded");
  const [notice] = store.replyRequests.list(replacement.secret, roomId, { direction: "incoming", status: "open" }).requests;
  assert.equal(notice.workItemId, "replacement-work");
  assert.throws(() => store.command(primary.secret, roomId, { id: "late-primary", type: "work.accepted",
    data: { workItemId, expectedRevision: original.work.revision } }));
  const head = store.headSequence(roomId);
  assert.equal(capacityWorkHandoff(store, binding, receiver).state, "work_handed_off");
  assert.equal(store.headSequence(roomId), head);
  store.wakeQueue.resume(primary.secret, roomId, { requestId: "provider-work-resumed" });
  store.wakeQueue.pause(primary.secret, roomId, { requestId: "provider-started-hold", reason: `${CAPACITY_STOP}:work:started-work:2` });
  const started = { ...route, workItemId: "started-work", capacityWork: { ...route.capacityWork, operationId: "move-started-work", expectedRevision: 2 } };
  assert.equal(capacityWorkHandoff(store, { ...binding, route: started, workHandoff: compileCapacityWork(started) }, receiver).state, "inspect_existing_work");
  if (!representation) {
    store.wakeQueue.resume(primary.secret, roomId, { requestId: "provider-started-resumed" });
    store.wakeQueue.pause(primary.secret, roomId, { requestId: "provider-stopping-hold", reason: `${CAPACITY_STOP}:work:stopping-work:1` });
    const stopping = { ...route, workItemId: "stopping-work",
      capacityWork: { ...route.capacityWork, operationId: "move-stopping-work", expectedRevision: 1 } };
    assert.equal(capacityWorkHandoff(store, { ...binding, route: stopping, workHandoff: compileCapacityWork(stopping) }, receiver).state,
      "inspect_existing_work");
  }
}

test("an unopened legacy Work Thread transfers atomically while a session stop preserves ownership",
  t => checkCapacityWork(t));
test("an unopened normalized Work Thread transfers atomically with independent review",
  t => checkCapacityWork(t, "normalized-current-v1"));
