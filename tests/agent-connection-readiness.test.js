import test from "node:test";
import assert from "node:assert/strict";
import { agentConnectionReadiness } from "../src/agent-connection-readiness.js";

const iso = n => new Date(n).toISOString();
const now = Date.parse("2026-11-01T02:00:00Z");
function observation(kind = "dot") {
  return {
    expected: { roomId: "room-one", memberId: "agent-one", hostId: "host-one" },
    observedAfter: now - 1000, now,
    accessObservedAt: now - 80, activationObservedAt: now - 50,
    access: { contractVersion: 1, type: "agent_connection_check", status: "credential_accepted",
      roomId: "room-one", memberId: "agent-one", kind: "agent", scope: "room",
      externalExecution: false, checkedAt: iso(now - 100), expiresAt: null },
    activationPack: { view: "brief", room: { slug: "room-one" }, you: { memberId: "agent-one" }, generatedAt: iso(now - 50) },
    host: { kind, hostId: "host-one", instanceId: "instance-one", roomId: "room-one", memberId: "agent-one",
      mode: "active_session", state: "available", observedAt: iso(now - 20), validUntil: iso(now + 1000) },
  };
}
function background(kind = "dot") {
  const data = observation(kind);
  data.host.mode = "background";
  data.exchange = {
    observedAt: iso(now - 10),
    response: { contractVersion: 1, roomId: "room-one", viewerId: "agent-one", hasMore: false,
      request: { id: "request-one", requesterId: "other-agent", recipientId: "agent-one", status: "answered",
        responseMessageId: "answer-one", terminalEventId: "reply-event", createdAt: iso(now - 800), closedAt: iso(now - 200) },
      current: { recipientAvailable: true },
    },
  };
  data.run = { hostId: "host-one", instanceId: "instance-one", roomId: "room-one", memberId: "agent-one", requestMessageId: "request-one",
    responseMessageId: "answer-one", responseEventId: "reply-event", runId: "run-one", deliveryId: "delivery-one",
    trigger: kind === "dot" ? "room.requested" : "room-wake", idleAt: iso(now - 900),
    deliveredAt: iso(now - 700), startedAt: iso(now - 600), observedAt: iso(now - 10) };
  return data;
}

test("access, usable reads and active sessions remain separate from background execution", () => {
  const input = observation();
  assert.equal(agentConnectionReadiness({ ...input, access: null }).status, "not_connected");
  assert.equal(agentConnectionReadiness({ ...input, activationPack: null }).status, "authenticated");
  assert.equal(agentConnectionReadiness({ ...input, host: null }).status, "usable");
  const active = agentConnectionReadiness(input);
  assert.equal(active.status, "active_session_only");
  assert.equal(active.listening, "not_tested");
  assert.equal(active.execution, "not_tested");
  assert.equal(active.externalExecution, false);
});

test("setup, heartbeat, delivery and a saved manual reply do not prove idle wake", () => {
  const data = background();
  for (const changes of [
    { run: null },
    { exchange: null },
    { run: { ...data.run, trigger: "manual" } },
    { run: { ...data.run, idleAt: data.exchange.response.request.createdAt } },
    { run: { ...data.run, deliveryId: null } },
  ]) {
    const result = agentConnectionReadiness({ ...data, ...changes, installed: true, heartbeat: now, scheduleSaved: true });
    assert.equal(result.status, "background_unverified");
    assert.equal(result.listening, "not_tested");
  }
});

test("Dot and Codex saved replies never imply a verified background run", () => {
  for (const kind of ["dot", "codex"]) {
    const result = agentConnectionReadiness(background(kind));
    assert.equal(result.status, "background_unverified");
    assert.equal(result.listening, "not_tested");
    assert.equal(result.execution, "not_tested");
    assert.equal(result.currentlyAvailable, true);
    assert.equal(result.lastBackgroundProof, null);
    assert.equal(result.backgroundVerification, "unsupported");
    assert.deepEqual(result.savedReply, { requestMessageId: "request-one", responseMessageId: "answer-one",
      responseEventId: "reply-event", at: iso(now - 200) });
  }
});

test("missing or cross-room, cross-member and cross-host observations cannot make a host available", () => {
  const data = background();
  const changes = [
    { expected: { ...data.expected, hostId: undefined } },
    { host: { ...data.host, hostId: "other-host" } },
    { host: { ...data.host, roomId: "other-room" } },
    { host: { ...data.host, memberId: "other-agent" } },
    { host: { ...data.host, instanceId: null } },
    { host: { ...data.host, kind: "unknown" } },
  ];
  for (const change of changes) {
    const result = agentConnectionReadiness({ ...data, ...change });
    assert.equal(result.status, "usable");
    assert.equal(result.currentlyAvailable, false);
  }
});

test("revoked or stale access cannot be revived by any saved reply or run-shaped input", () => {
  const data = background();
  for (const access of [null, { ...data.access, status: "revoked" }, { ...data.access, expiresAt: now },
    { ...data.access, checkedAt: "invalid" }, { ...data.access, checkedAt: undefined },
    { ...data.access, roomId: "other-room" }, { ...data.access, memberId: "other-agent" }]) {
    const result = agentConnectionReadiness({ ...data, access });
    assert.equal(result.status, "not_connected");
    assert.equal(result.currentlyAvailable, false);
    assert.equal(result.listening, "not_tested");
    assert.equal(result.savedReply, null);
  }
});

test("stopped or expired hosts retain a saved reply observation without claiming current background availability", () => {
  const data = background();
  for (const host of [null, { ...data.host, state: "stopped" }, { ...data.host, validUntil: iso(now) },
    { ...data.host, observedAt: iso(now - 1001) }, { ...data.host, observedAt: iso(now + 1) }]) {
    const result = agentConnectionReadiness({ ...data, host });
    assert.equal(result.status, "usable");
    assert.equal(result.currentlyAvailable, false);
    assert.equal(result.listening, "not_tested");
    assert.equal(result.savedReply?.responseMessageId, "answer-one");
  }
});

test("malformed, stale or mismatched context is not a usable authenticated read", () => {
  const data = observation();
  for (const activationPack of [null, {}, { ...data.activationPack, you: null },
    { ...data.activationPack, you: { memberId: "other-agent" } },
    { ...data.activationPack, room: { slug: "other-room" } },
    { ...data.activationPack, generatedAt: "invalid" }]) {
    assert.equal(agentConnectionReadiness({ ...data, activationPack }).status, "authenticated");
  }
  for (const activationObservedAt of [undefined, now - 1001, now + 1]) {
    assert.equal(agentConnectionReadiness({ ...data, activationObservedAt }).status, "authenticated");
  }
});

test("fresh authenticated read receipts do not assume synchronized server and client clocks", () => {
  const data = observation();
  for (const skew of [-60000, 60000]) {
    assert.equal(agentConnectionReadiness({ ...data, activationPack: { ...data.activationPack, generatedAt: iso(now + skew) } }).read, "verified");
  }
  for (const changes of [{ now: undefined }, { observedAfter: -1 }, { observedAfter: now + 1 }]) {
    assert.equal(agentConnectionReadiness({ ...data, ...changes }).status, "not_connected");
  }
});

test("only a fresh same-member selected answered request supplies a saved reply observation", () => {
  const data = background();
  for (const patch of [{ status: "cancelled" }, { status: "declined" }, { recipientId: "other-agent" },
    { requesterId: "agent-one" }, { responseMessageId: null }, { terminalEventId: null }, { closedAt: iso(now - 850) }]) {
    const exchange = { ...data.exchange, response: { ...data.exchange.response, request: { ...data.exchange.response.request, ...patch } } };
    assert.equal(agentConnectionReadiness({ ...data, exchange }).savedReply, null);
  }
  const stopped = { ...data.exchange, response: { ...data.exchange.response, current: { recipientAvailable: false } } };
  assert.equal(agentConnectionReadiness({ ...data, exchange: stopped }).savedReply, null);
  for (const patch of [{ contractVersion: undefined }, { roomId: "other-room" }, { viewerId: "other-agent" }, { hasMore: true }]) {
    const exchange = { ...data.exchange, response: { ...data.exchange.response, ...patch } };
    assert.equal(agentConnectionReadiness({ ...data, exchange }).savedReply, null);
  }
  for (const observedAt of [undefined, iso(now - 1001), iso(now + 1)]) {
    assert.equal(agentConnectionReadiness({ ...data, exchange: { ...data.exchange, observedAt } }).savedReply, null);
  }
});

test("mixed host/server clocks and invented normalization flags cannot claim background verification", () => {
  const data = background();
  data.run.idleAt = iso(now - 900);
  data.run.normalized = true;
  data.run.clockDomain = "room";
  data.run.verified = true;
  assert.equal(agentConnectionReadiness(data).backgroundVerification, "unsupported");
  assert.equal(agentConnectionReadiness(data).lastBackgroundProof, null);
  assert.equal(agentConnectionReadiness(data).execution, "not_tested");
});

test("projection replay is deterministic, immutable and does not copy secrets or room content", () => {
  const input = background();
  input.access.token = "do-not-return";
  input.activationPack.purpose = "private-room-text";
  const before = structuredClone(input);
  const first = agentConnectionReadiness(input);
  assert.deepEqual(agentConnectionReadiness(input), first);
  assert.deepEqual(input, before);
  assert.doesNotMatch(JSON.stringify(first), /do-not-return|private-room-text/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.savedReply), true);
});

test('fresh access receipts remain usable when the server clock differs from the client',()=>{
 for(const skew of [-3600000,3600000]){
  const input=observation();input.accessObservedAt=now-80;
  input.access.checkedAt=iso(now-100+skew);input.access.expiresAt=now+10000+skew;
  input.activationPack.generatedAt=iso(now-50+skew);
  assert.equal(agentConnectionReadiness(input).read,'verified');
 }
});

test('missing and stale access receipts cannot be repaired by a later activation pack',()=>{
 const data=observation();for(const accessObservedAt of [undefined,now-1001,now+1]) {
  const result=agentConnectionReadiness({...data,accessObservedAt});
  assert.equal(result.status,'not_connected');assert.equal(result.read,'not_tested');
 }
});
