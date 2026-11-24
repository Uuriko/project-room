import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { startCompletionPickup } from "../server/completion-pickup.mjs";
import { RoomStore } from "../server/store.mjs";
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
  const f = { directory, store: new RoomStore(db) };
  let stop = () => {};
  t.after(() => { stop(); f.store.close(); rmSync(directory, { recursive: true, force: true }); });
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
  request("dot", "dot-other-work");
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

  stop();
  record("claude-second", "claude");
  record("dot-other-work", "dot");
  f.store.close();
  f.store = new RoomStore(db);
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
