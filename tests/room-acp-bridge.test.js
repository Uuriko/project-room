// room-acp B3: the bridge loop end to end against a real local Room server
// and the scripted fake ACP agent: mention -> one turn -> threaded reply ->
// ack; owner-only by default; mid-turn messages batch into the next turn.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { TurnRecorder, renderTurn, TRAILER_LINES } from "../room-acp/src/render.mjs";
import { AgentHost } from "../room-acp/src/agent-host.mjs";
import { ThreadQueue } from "../room-acp/src/queue.mjs";
import { mayTalk, Bridge, CLAIM_WAKE_REASONS } from "../room-acp/src/bridge.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom, FAKE_AGENT } from "./room-acp-fixture.mjs";

const waitFor = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("timed out waiting");
};

test("render: text plus a bounded tool trailer, never thoughts", () => {
  const recorder = new TurnRecorder();
  recorder.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET" } });
  recorder.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  for (let i = 0; i < 25; i++) recorder.update({ sessionUpdate: "tool_call", toolCallId: `t${i}`, title: `step ${i}`, status: "completed" });
  recorder.update({ sessionUpdate: "tool_call_update", toolCallId: "t0", status: "failed" });
  const out = renderTurn(recorder);
  assert.ok(!out.includes("SECRET"));
  assert.ok(out.startsWith("Done."));
  const trailer = out.split("\n").slice(2);
  assert.equal(trailer.length, TRAILER_LINES);
  assert.equal(trailer[0], "✗ step 0");
  assert.match(trailer.at(-1), /and 16 more tool calls/);
  assert.match(renderTurn(new TurnRecorder(), { error: "boom" }), /turn failed: boom/);
});

test("adapter structured notices stay private while warning-looking model text survives", async t => {
  const host = new AgentHost({ candidate: { command: process.execPath, args: [FAKE_AGENT] }, env: { ...process.env, FAKE_ACP_MODE: "notices" } });
  t.after(() => host.stop());
  await host.start();
  const text = "Warning: this is the requested model reply. Config warning: keep this quotation.";
  const { recorder } = await host.prompt("notice-test", [{ type: "text", text }]);
  assert.equal(renderTurn(recorder), `echo: ${text}`);
  assert.doesNotMatch(renderTurn(recorder), /private-owner|private-project|Under-development/);
  const onlyNotice = new TurnRecorder();
  onlyNotice.update({ sessionUpdate: "notice", severity: "warning", title: "Private warning", description: "/private/config" });
  assert.equal(renderTurn(onlyNotice), "(no reply text)");
});

test("queue: one turn in flight per thread, later items batch", async () => {
  const calls = [];
  let release;
  const queue = new ThreadQueue({ concurrency: 2, run: async (key, batch) => { calls.push([key, batch.map(item => item.messageId)]); if (calls.length === 1) await new Promise(resolve => { release = resolve; }); } });
  queue.push("a", { messageId: "1" });
  queue.push("a", { messageId: "2" });
  queue.push("a", { messageId: "3" });
  assert.equal(queue.push("a", { messageId: "3" }), false);
  queue.push("b", { messageId: "4" });
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  await queue.idle(); await queue.idle();
  assert.deepEqual(calls, [["a", ["1"]], ["b", ["4"]], ["a", ["2", "3"]]]);
});

test("mayTalk: owner and the owner's agents by default; anyone when opted in", () => {
  const members = { owner: { id: "owner", kind: "human" }, guest: { id: "guest", kind: "human" }, helper: { id: "helper", kind: "agent", accountableHumanId: "owner" }, me: { id: "me", kind: "agent", accountableHumanId: "owner" } };
  const base = { members, me: members.me, ownerId: "owner", respondTo: "owner" };
  assert.equal(mayTalk({ ...base, authorId: "owner" }), true);
  assert.equal(mayTalk({ ...base, authorId: "helper" }), true);
  assert.equal(mayTalk({ ...base, authorId: "guest" }), false);
  assert.equal(mayTalk({ ...base, authorId: "me" }), false);
  assert.equal(mayTalk({ ...base, authorId: "guest", respondTo: "anyone" }), true);
});

async function startBridge(t, room, { mode = "echo", respondTo = "owner", reservationStepMs = 0, trace, closeIdleSessions = false } = {}) {
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const env = { ...room.env, FAKE_ACP_MODE: mode, FAKE_ACP_DELAY_MS: "4000" };
  if (trace) env.FAKE_ACP_TRACE = trace;
  const bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] }, env, respondTo, closeIdleSessions, waitMs: 3000, cadenceSeconds: 30, log: process.env.RA_DEBUG ? (...a) => console.error("[bridge]", ...a) : () => {} });
  // Inject only the local reply-window clock; real API/lease time is unchanged.
  let reservationClock = Date.now();
  const reserve = bridge.reserveOrdinaryReply.bind(bridge);
  bridge.reserveOrdinaryReply = receipt => { const result = reserve(receipt, reservationClock); reservationClock += reservationStepMs; return result; };
  const advanceReservation = ms => { reservationClock += ms; };
  const done = bridge.run();
  t.after(async () => { bridge.stop(); await done; });
  await waitFor(() => bridge.members && bridge.fencingToken);
  return { bridge, connection, done, advanceReservation };
}

const repliesTo = (room, rootId, memberId) => room.messages().filter(message => message.replyToId === rootId && message.authorId === memberId);

test("bridge releases a finished session and holds a same-thread wake during close", async t => {
  const room = await startRoom(t);
  const trace = joinPath(room.env.ROOM_ACP_HOME, "session-trace.log");
  const { bridge, connection, advanceReservation } = await startBridge(t, room, { mode: "close", trace, closeIdleSessions: true });
  const close = bridge.host.closeIdleSession.bind(bridge.host);
  const { promise: mayClose, resolve: resumeClose } = Promise.withResolvers();
  let closing = false;
  bridge.host.closeIdleSession = async threadKey => {
    closing = true;
    await mayClose;
    await close(threadKey);
  };
  const rootId = room.say("@Coder review the proposed change");
  let saved;
  try {
    await waitFor(() => bridge.stats.acked === 1 && closing);
    saved = bridge.sessionMap.get(rootId);
    assert.ok(saved, "the resumable session ID remains saved");
    advanceReservation(60000);
    room.say("@Coder review the correction too", { replyToId: rootId });
    await waitFor(() => bridge.queue.depth(rootId) === 2);
    assert.equal(repliesTo(room, rootId, connection.memberId).length, 1);
  } finally { resumeClose(); }
  await waitFor(() => bridge.stats.acked === 2);
  await bridge.queue.idle();
  const replies = repliesTo(room, rootId, connection.memberId);
  assert.equal(replies.length, 2);
  assert.match(replies[1].body, /review the correction too/);
  assert.doesNotMatch(replies[1].body, /Thread so far/);
  assert.equal(bridge.sessionMap.get(rootId), saved);
  assert.equal(bridge.host.sessions.size, 0);
  assert.equal(bridge.host.threadOf.size, 0);
  assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n"), [
    "initialize", "session/new", "session/prompt", "session/close", "session/load", "session/prompt", "session/close"
  ]);
});

test("ordinary bridges retain sessions even when the adapter supports close", async t => {
  const room = await startRoom(t);
  const { bridge } = await startBridge(t, room, { mode: "close" });
  const id = room.say("@Coder reply to this thread");
  await waitFor(() => bridge.stats.acked === 1);
  await bridge.queue.idle();
  assert.equal(bridge.host.sessions.get(id), bridge.sessionMap.get(id));
  assert.equal(bridge.host.sessions.size, 1);
});

test("bridge resumes the saved session when a completed close is unconfirmed", async t => {
  const room = await startRoom(t);
  const trace = joinPath(room.env.ROOM_ACP_HOME, "session-trace.log");
  const { bridge, connection, advanceReservation } = await startBridge(t, room, { mode: "close-unconfirmed", trace, closeIdleSessions: true });
  const id = room.say("@Coder check this proposed change");
  await waitFor(() => bridge.stats.acked === 1);
  await bridge.queue.idle();
  const sessionId = bridge.sessionMap.get(id);
  advanceReservation(60000);
  room.say("@Coder recheck only the changed section", { replyToId: id });
  await waitFor(() => bridge.stats.acked === 2);
  await bridge.queue.idle();
  assert.match(repliesTo(room, id, connection.memberId)[1].body, /^echo: [\s\S]*recheck only/);
  assert.equal(bridge.sessionMap.get(id), sessionId);
  assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n"), [
    "initialize", "session/new", "session/prompt", "session/close", "session/load", "session/prompt", "session/close"
  ]);
});

test("bridge: an owner mention gets one threaded reply, then the wake is acked", async t => {
  const room = await startRoom(t);
  const { bridge, connection, advanceReservation } = await startBridge(t, room);
  const rootId = room.say("@Coder hello there");
  const [reply] = await waitFor(() => { const list = repliesTo(room, rootId, connection.memberId); return list.length ? list : null; });
  assert.match(reply.body, /^echo: /);
  assert.match(reply.body, /hello there/);
  await waitFor(() => bridge.stats.acked === 1);
  // A follow-up in the same thread reuses the session and replies in the same thread.
  advanceReservation(60000); // A second automatic ordinary delivery uses the next window.
  room.say("@Coder again", { replyToId: rootId });
  const list = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length === 2 ? all : null; });
  assert.match(list[1].body, /again/);
  assert.ok(!list[1].body.includes("Thread so far"), "later turns send only the new messages");
  assert.equal(bridge.host.sessions.size, 1);
});

test("bridge: a guest's mention is ignored by default and acked", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room);
  room.f.store.setTalkPolicy(room.ownerKey, "commons", connection.memberId, { policy: "room" });
  const guestKey = room.f.store.issueAccessKey("commons", "guest");
  room.f.store.command(guestKey, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: "g1", body: "@Coder do something" } });
  await waitFor(() => bridge.stats.skipped === 1);
  assert.equal(repliesTo(room, "g1", connection.memberId).length, 0);
});

test("bridge: messages during a slow turn batch into one next turn", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room, { mode: "slow", reservationStepMs: 60000 });
  const rootId = room.say("@Coder first");
  await waitFor(() => bridge.queue.active === 1);
  room.say("@Coder second", { replyToId: rootId });
  room.say("@Coder third", { replyToId: rootId });
  const list = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length === 2 ? all : null; }, 20000);
  assert.match(list[1].body, /second[\s\S]*third/);
  await waitFor(() => bridge.stats.acked === 3);
});

test("bridge: a Board claim assigned to the agent runs one turn and replies as a claim note", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room);
  const call = (path, body) => fetch(room.origin + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${room.ownerKey}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async res => ({ status: res.status, json: await res.json() }));
  const created = await call("/api/rooms/commons/work-claims", { id: "fix-login", title: "Fix the login button", note: "It does nothing on Safari.", assignee: connection.memberId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const claim = await (async () => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const read = await call("/api/rooms/commons/work-claims/fix-login");
      const hit = (read.json.history ?? []).find(entry => entry.agentId === connection.memberId && /^echo: /.test(entry.note ?? ""));
      if (hit) return { read: read.json, hit };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("no claim note");
  })();
  assert.match(claim.hit.note, /Fix the login button/);
  assert.match(claim.hit.note, /Safari/);
  await waitFor(() => bridge.stats.acked >= 1);
  assert.ok(bridge.host.sessions.has("work-claim:fix-login"));
  const thread = await call("/api/rooms/commons/work-claims/fix-login/thread");
  assert.equal(thread.status, 200);
  assert.ok(JSON.stringify(thread.json).includes("echo: "), "the reply shows in the claim thread");
});

test("CLAIM_WAKE_REASONS includes ready_work", () => {
  assert.deepEqual([...CLAIM_WAKE_REASONS], ["assigned", "ready_work"]);
});

test("bridge: a ready_work wake after a prerequisite is done starts the assigned dependent", async t => {
  const room = await startRoom(t);
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const identityHeaders = { authorization: `Bearer ${connection.identitySecret}`, "content-type": "application/json" };
  const beat = await fetch(`${room.origin}/api/agent-heartbeats`, {
    method: "POST", headers: identityHeaders,
    body: JSON.stringify({ hostId: connection.hostId, mode: "pull-only" })
  });
  assert.equal(beat.status, 200, await beat.text());
  const asOwner = (path, body, method = "POST") => fetch(room.origin + path, {
    method, headers: { authorization: `Bearer ${room.ownerKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  }).then(async res => ({ status: res.status, json: await res.json() }));
  const prereq = await asOwner("/api/rooms/commons/work-claims", { id: "prereq", title: "Prerequisite", reviewPolicy: "self_attested" });
  assert.equal(prereq.status, 201, JSON.stringify(prereq.json));
  const claimed = await asOwner("/api/rooms/commons/work-claims/prereq/claim", {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  const started = await asOwner("/api/rooms/commons/work-claims/prereq/update", { state: "in_progress" });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const dependent = await asOwner("/api/rooms/commons/work-claims", {
    id: "follow-on", title: "Follow-on work", reviewPolicy: "self_attested",
    dependsOn: ["prereq"], assignee: connection.memberId
  });
  assert.equal(dependent.status, 201, JSON.stringify(dependent.json));
  const pending = await fetch(`${room.origin}/api/agent-wakes/poll?hostId=${encodeURIComponent(connection.hostId)}&waitMs=0`, {
    headers: { authorization: `Bearer ${connection.identitySecret}` }
  }).then(async res => ({ status: res.status, json: await res.json() }));
  assert.equal(pending.status, 200);
  const assigned = (pending.json.pendingWakes ?? []).filter(wake => wake.reason === "assigned");
  assert.ok(assigned.length >= 1, JSON.stringify(pending.json));
  const acked = await fetch(`${room.origin}/api/agent-heartbeats/ack`, {
    method: "POST", headers: identityHeaders, body: JSON.stringify({ signalIds: assigned.map(wake => wake.signalId) })
  });
  assert.equal(acked.status, 200, await acked.text());
  const done = await asOwner("/api/rooms/commons/work-claims/prereq/update", { state: "done", note: "prerequisite complete" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.state, "done");
  const ready = await fetch(`${room.origin}/api/agent-wakes/poll?hostId=${encodeURIComponent(connection.hostId)}&waitMs=0`, {
    headers: { authorization: `Bearer ${connection.identitySecret}` }
  }).then(res => res.json());
  const readyWakes = (ready.pendingWakes ?? []).filter(wake => wake.reason === "ready_work");
  assert.equal(readyWakes.length, 1, JSON.stringify(ready));
  assert.equal(readyWakes[0].workClaim, "follow-on");

  const env = { ...room.env, FAKE_ACP_MODE: "echo", FAKE_ACP_DELAY_MS: "4000" };
  const bridge = new Bridge({
    connection,
    candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] },
    env, respondTo: "owner", waitMs: 3000, cadenceSeconds: 30,
    log: process.env.RA_DEBUG ? (...a) => console.error("[bridge]", ...a) : () => {}
  });
  const running = bridge.run();
  t.after(async () => { bridge.stop(); await running; });
  const claim = await (async () => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const read = await asOwner("/api/rooms/commons/work-claims/follow-on", undefined, "GET");
      const hit = (read.json.history ?? []).find(entry => entry.agentId === connection.memberId && /^echo: /.test(entry.note ?? ""));
      if (hit) return { read: read.json, hit };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("no claim note from ready_work wake");
  })();
  assert.match(claim.hit.note, /Follow-on work/);
  await waitFor(() => bridge.stats.acked >= 1);
  assert.ok(bridge.host.sessions.has("work-claim:follow-on"));
});
