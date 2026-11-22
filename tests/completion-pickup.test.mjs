import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { chmodSync, rmSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { RoomClient } from "../room-acp/src/room.mjs";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import { startCompletionPickup } from "../server/completion-pickup.mjs";
import { atomicPrivateJson } from "../room-acp/src/private-files.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test("a settled formal QA opens one scoped investigation, and catch-up cannot reopen it", async t => {
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
  atomicPrivateJson(config,{checkpointPath,routes:[{ roomId, requesterId, recipientId, workItemId, credentialPath, after }]});
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
  stop();
  rmSync(checkpointPath);
  stop=start();
  await setImmediate();
  assert.equal(read().length,2);
  answer(next.id);
  await setImmediate();
  assert.equal(read().length,2);
  assert.deepEqual(log.map(x=>x.event),["completion_pickup.posted"]);
});

for (const ready of [false, true]) {
  test(`a scoped ACP idle report ${ready ? "prioritizes assigned work" : "opens one investigation on a dry queue"}`, async t => {
    const f = createAcceptanceFixture();
    const roomId = "commons", workItemId = "idle-qa-lane", recipientId = "idle-reviewer";
    const agent = f.store.identities.create("Idle reviewer");
    linkWithProof(f.store, f.keys.owner, roomId, agent, { memberId: recipientId, permissions: ["accept_work","verify"] });
    const requesterId = f.store.authenticate(f.keys.owner, roomId).member.id;
    const propose = (id, accountableMemberId) => f.store.command(f.keys.owner, roomId, { id: randomUUID(), type: "work.proposed",
      data: { workItemId: id, title: id, definitionOfDone: "Return scoped read-only evidence.", accountableMemberId, mode: "read" } });
    propose(workItemId, requesterId);
    if (ready) propose("exact-ready-review", recipientId);
    const after = f.store.headSequence(roomId);
    const checkpointPath = join(f.directory, "idle-checkpoint.json"), config = join(f.directory, "idle-pickup.json"),
      credentialPath = join(f.directory, "idle-operator.json");
    chmodSync(f.directory, 0o700);
    atomicPrivateJson(credentialPath, { identitySecret: f.keys.owner });
    atomicPrivateJson(config, { checkpointPath, routes: [{ roomId, requesterId, recipientId, workItemId, credentialPath, after, onIdle: true }] });
    let stop = startCompletionPickup(f.store, config);
    const server = createRoomServer({ store: f.store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      stop();
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    });
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    if (ready) {
      const issued = await fetch(apiBase + "/api/agent-keys", {
        method: "POST", headers: { authorization: "Bearer " + agent.secret, "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["heartbeats:report", "heartbeats:read", "mcp:room:commons"] })
      });
      assert.equal(issued.status, 201);
      const { credential } = await issued.json();
      const restricted = new RoomClient({ apiBase, roomId, memberId: recipientId, credential });
      const hostId = "idle-heartbeat-only";
      const heartbeat = await restricted.heartbeat({ hostId });
      assert.equal(heartbeat.listener.acquired, true);
      const before = f.store.headSequence(roomId);
      await assert.rejects(restricted.reportIdle({ hostId, fencingToken: heartbeat.listener.fencingToken }),
        error => error.status === 403 && error.code === "insufficient_scope");
      assert.equal(f.store.headSequence(roomId), before);
      assert.equal(heartbeat.idlePickupAvailable, undefined);
      assert.equal((await restricted.poll({ hostId, waitMs: 0 })).idlePickupThrough, undefined);
      await restricted.disconnect({ hostId, fencingToken: heartbeat.listener.fencingToken });
    }
    const hostId = "idle-test-host";
    let prompts = 0, loseIdleResponse = ready;
    const bridge = new Bridge({ connection: { apiBase, roomId,
      memberId: recipientId, credential: agent.secret, hostId }, waitMs: 0, minPollIntervalMs: 0,
    env: { ROOM_ACP_HOME: join(f.directory, "receiver") },
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (loseIdleResponse && String(url).endsWith("/api/agent-heartbeats") && JSON.parse(options?.body ?? "{}").idlePickup === true) {
        loseIdleResponse = false;
        await response.text();
        throw new Error("Lost idle response after commit");
      }
      return response;
    },
    host: {
      session: async () => ({ sessionId: "idle-fixture-session", created: true }),
      prompt: async () => {
        prompts++;
        return { stopReason: "end_turn", recorder: { tools: new Map(),
          text: JSON.stringify({ outcome: "answered", body: "Checked the exact authorized evidence." }) } };
      }
    } });
    const list = () => f.store.replyRequests.list(agent.secret, roomId, { direction: "incoming", status: "all" }).requests;
    assert.equal(list().length, 0);
    await bridge.refreshRoom();
    const runTurn = bridge.queue.run;
    let finishCurrentTurn;
    const inFlight = new Promise(resolve => { finishCurrentTurn = resolve; });
    bridge.queue.run = (key, batch) => key === "already-running" ? inFlight : runTurn(key, batch);
    bridge.queue.push("already-running", { signalId: "already-running-signal" });
    await bridge.pollOnce();
    assert.equal(bridge.idlePickupAvailable, true);
    assert.equal(list().length, 0, "a busy receiver does not ask for another turn");
    finishCurrentTurn();
    await bridge.queue.idle();
    if (ready) await assert.rejects(bridge.pollOnce(), error => error.status === 0);
    else await bridge.pollOnce();
    assert.equal(bridge.idlePickupAvailable, true);
    assert.equal(list().length, 1);
    const [request] = list();
    const record = f.store.replyRequests.selected(agent.secret, roomId, request.id);
    const opening = record.page.items.find(item => item.kind === "opened");
    assert.equal(opening.message.body.includes("Room investigation pass."), !ready);
    assert.equal(opening.message.body.includes("Room found a next step"), ready);

    // One exact opening remains while queued, even when a response is lost.
    const observe = () => bridge.room.reportIdle({ hostId, fencingToken: bridge.fencingToken });
    assert.ok(["wake_pending", "request_pending"].includes((await observe()).idlePickup.status));
    assert.equal(list().length, 1);
    await bridge.pollOnce();
    await bridge.queue.idle();
    assert.equal(prompts, 1);
    assert.equal(list()[0].status, "answered");
    stop();
    stop = startCompletionPickup(f.store, config);
    await setImmediate();
    const latest = await observe();
    assert.ok(["replayed", "no_successor"].includes(latest.idlePickup.status), JSON.stringify(latest));
    assert.equal(list().length, 1);
    assert.equal(prompts, 1);
    if (!ready) {
      // A new assignment after the same receiver has already reported idle
      // is discovered on the existing poll, with no timer or fresh host.
      await bridge.pollOnce();
      const idleVersion = bridge.idleReportedVersion;
      const idleThrough = bridge.idleReportedThrough;
      propose("later-exact-work", recipientId);
      await bridge.pollOnce();
      assert.equal(bridge.idleReportedVersion, idleVersion);
      assert.ok(bridge.idleReportedThrough > idleThrough);
      assert.equal(list().length, 2);
      await bridge.pollOnce();
      await bridge.queue.idle();
      assert.equal(prompts, 2);
    }
    const openedCount = ready ? 1 : 2;
    f.store.agentHeartbeats.releaseListenerLease({ agentId: agent.identityId, roomId, fencingToken: bridge.fencingToken });
    await assert.rejects(observe, error => error.code === "stale_listener");
    const nextHost = "idle-test-reconnected";
    const attached = await bridge.room.heartbeat({ hostId: nextHost });
    assert.equal(attached.listener.acquired, true);
    f.store.wakeQueue.pause(f.keys.owner, roomId, { requestId: "pause-idle-fixture", reason: null },
      null, { memberId: recipientId });
    assert.equal((await bridge.room.reportIdle({ hostId: nextHost, fencingToken: attached.listener.fencingToken })).idlePickup.status, "paused");
    f.store.wakeQueue.resume(f.keys.owner, roomId, { requestId: "resume-idle-fixture" }, null, { memberId: recipientId });
    assert.ok(["replayed", "no_successor"].includes((await bridge.room.reportIdle({
      hostId: nextHost, fencingToken: attached.listener.fencingToken
    })).idlePickup.status));
    assert.equal(list().length, openedCount);
  });
}
