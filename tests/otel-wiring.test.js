// R1 delivery-path tracing wiring tests (RC-2026-09-26-966).
//
// Authoring gate: tests/delivery-tracing.test.js owns the tracing MODULE
// (span lifecycle, OTLP shape, traceparent). These tests own the WIRING —
// that the production hot paths actually create the spans when TELEMETRY=true
// and create nothing when it is off. Credible regressions a module test
// cannot catch: a refactor drops or moves a tracing call site (silent
// telemetry death), or the opt-in default breaks so spans buffer in
// production. Privacy invariant: no message body may ever land in a span
// attribute on any wired path.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { SyntheticInboxTransport, FixtureChannelSender } from "../server/inbox-transport.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramConfig } from "../server/channel-adapters/telegram-config.mjs";
import { getTracer, resetTracerForTests, SPAN_NAMES, ATTR } from "../server/delivery-tracing.mjs";

// Enable/disable telemetry around a test via the production singleton path.
// Production code calls getTracer() per call (never at module scope), so
// resetting the singleton plus setting the env var controls enablement.
function telemetry(on) {
  const prior = process.env.TELEMETRY;
  if (on) process.env.TELEMETRY = "true"; else delete process.env.TELEMETRY;
  resetTracerForTests();
  return () => {
    if (prior === undefined) delete process.env.TELEMETRY; else process.env.TELEMETRY = prior;
    resetTracerForTests();
  };
}

const spanNames = () => getTracer().bufferedSpans().map(s => s.name);
const findSpan = name => getTracer().bufferedSpans().find(s => s.name === name);

// No attribute value on any buffered span may contain message content.
function assertNoBodiesLeak(forbidden) {
  for (const span of getTracer().bufferedSpans()) {
    for (const value of Object.values(span.attributes)) {
      if (typeof value === "string") assert.ok(!value.includes(forbidden),
        `span ${span.name} leaked message content in attribute`);
    }
  }
}

// --- Room command path: delivery.log + delivery.fanout -----------------------

function roomSetup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-otel-wiring-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys };
}

test("store.command emits delivery.log and delivery.fanout spans when telemetry is enabled", t => {
  const f = roomSetup(t); t.after(telemetry(true));
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "otel-log-1", body: "the quick brown fox jumps" } });
  const names = spanNames();
  assert.ok(names.includes(SPAN_NAMES.LOG), `expected delivery.log, got ${names}`);
  assert.ok(names.includes(SPAN_NAMES.FANOUT), `expected delivery.fanout, got ${names}`);
  const log = findSpan(SPAN_NAMES.LOG);
  assert.equal(log.attributes[ATTR.ROOM_ID], "commons");
  assert.equal(log.attributes[ATTR.MESSAGE_ID], "otel-log-1");
  assert.equal(log.attributes[ATTR.EVENT_TYPE], T.MESSAGE_POSTED);
  assert.equal(log.attributes[ATTR.OUTCOME], "ok");
  const fanout = findSpan(SPAN_NAMES.FANOUT);
  assert.equal(fanout.attributes[ATTR.ROOM_ID], "commons");
  assert.equal(fanout.attributes[ATTR.MESSAGE_ID], "otel-log-1");
  assertNoBodiesLeak("the quick brown fox jumps");
});

test("store.command emits no spans when telemetry is off", t => {
  const f = roomSetup(t); t.after(telemetry(false));
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "otel-log-2", body: "silent" } });
  assert.equal(getTracer().bufferedSpanCount(), 0);
});

// --- HTTP inbound path: delivery.inbound -------------------------------------

async function httpSetup(t, serverOptions = {}) {
  const f = roomSetup(t);
  const server = createRoomServer({ store: f.store, ...serverOptions });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ...f, origin: `http://127.0.0.1:${server.address().port}` };
}

test("POST /api/rooms/:id/commands emits delivery.inbound when telemetry is enabled", async t => {
  const f = await httpSetup(t); t.after(telemetry(true));
  const response = await fetch(`${f.origin}/api/rooms/commons/commands`, { method: "POST",
    body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: "otel-inbound-1", body: "inbound body stays private" } }),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + f.keys.owner } });
  assert.equal(response.status, 201);
  const inbound = findSpan(SPAN_NAMES.INBOUND);
  assert.ok(inbound, `expected delivery.inbound, got ${spanNames()}`);
  assert.equal(inbound.attributes[ATTR.ROOM_ID], "commons");
  assert.equal(inbound.attributes[ATTR.INGRESS], "api");
  assert.equal(inbound.attributes[ATTR.EVENT_TYPE], T.MESSAGE_POSTED);
  assert.equal(inbound.attributes[ATTR.MESSAGE_ID], "otel-inbound-1");
  assert.equal(inbound.attributes[ATTR.OUTCOME], "ok");
  // The request path also drives the store, so its spans join the same trace
  // keyed by message id.
  assert.ok(findSpan(SPAN_NAMES.LOG), "expected delivery.log from the same request");
  assertNoBodiesLeak("inbound body stays private");
});

test("POST /api/rooms/:id/commands emits no spans when telemetry is off", async t => {
  const f = await httpSetup(t); t.after(telemetry(false));
  const response = await fetch(`${f.origin}/api/rooms/commons/commands`, { method: "POST",
    body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: "otel-inbound-2", body: "silent" } }),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + f.keys.owner } });
  assert.equal(response.status, 201);
  assert.equal(getTracer().bufferedSpanCount(), 0);
});

// --- Inbox transport: delivery.bridge_send + delivery.receipt -----------------

function transportSetup(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const key = f.store.issueAccountAccessKey(f.store.accountForMember("commons", "owner").id);
  const slot = f.store.createAccountSessionSlot();
  f.token = slot.token; f.session = f.store.loginAccountSession(slot.token, key, 0);
  f.apply = request => f.store.inbox.apply(f.token, request, f.session.sessionBinding);
  f.apply({ action: "source.save", requestId: "source", sourceId: "note", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test",
      subject: "Launch", paragraphs: ["A quieter launch?"] } });
  f.apply({ action: "draft.save", requestId: "draft", sourceId: "note", expectedRevision: 0,
    sourceRevision: 1, body: "Sounds good." });
  f.reserve = () => {
    const p = f.store.inbox.sendContext(f.token, "note", f.session.sessionBinding).preview;
    return { action: "send.reserve", requestId: randomUUID(), sourceId: "note",
      sourceRevision: p.sourceRevision, draftRevision: p.draftRevision, previewVersion: p.previewVersion };
  };
  f.driver = () => new SyntheticInboxTransport(f.store.inbox, new FixtureChannelSender({ kind: "synthetic" }));
  return f;
}

test("transport dispatch emits delivery.bridge_send and a nested delivery.receipt when telemetry is enabled", async t => {
  const f = transportSetup(t); t.after(telemetry(true));
  const request = f.reserve(); f.apply(request);
  const send = await f.driver().dispatch(f.token, "note", request.requestId, f.session.sessionBinding);
  assert.equal(send.status, "accepted");
  const bridge = findSpan(SPAN_NAMES.BRIDGE_SEND);
  assert.ok(bridge, `expected delivery.bridge_send, got ${spanNames()}`);
  assert.equal(bridge.attributes[ATTR.CHANNEL], "synthetic");
  assert.equal(bridge.attributes[ATTR.OUTCOME], "ok");
  const receipt = findSpan(SPAN_NAMES.RECEIPT);
  assert.ok(receipt, `expected delivery.receipt, got ${spanNames()}`);
  assert.equal(receipt.attributes[ATTR.CHANNEL], "synthetic");
  assert.equal(receipt.attributes[ATTR.OUTCOME], "accepted");
  assert.equal(receipt.parentSpanId, bridge.spanId, "receipt nests under bridge_send");
  assert.equal(receipt.traceId, bridge.traceId);
  assertNoBodiesLeak("Sounds good.");
});

test("transport dispatch emits no spans when telemetry is off", async t => {
  const f = transportSetup(t); t.after(telemetry(false));
  const request = f.reserve(); f.apply(request);
  const send = await f.driver().dispatch(f.token, "note", request.requestId, f.session.sessionBinding);
  assert.equal(send.status, "accepted");
  assert.equal(getTracer().bufferedSpanCount(), 0);
});

// --- Direct channel send (POST /api/inbox/channel-sends) -----------------------

test("direct channel send emits delivery.bridge_send and delivery.receipt when telemetry is enabled", async t => {
  const f = transportSetup(t); t.after(telemetry(true));
  const stubFetch = async () => ({ ok: true, status: 200,
    json: async () => ({ ok: true, result: { message_id: 42 } }) });
  const server = createRoomServer({ store: f.store, directSendFetch: stubFetch,
    telegram: telegramConfig({ TELEGRAM_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyzABCDE12", TELEGRAM_WEBHOOK_SECRET: "fake-webhook-secret-1234" }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/inbox/channel-sends`, { method: "POST",
    body: JSON.stringify({ channel: "telegram", to: "12345", subject: "otel", body: "direct body stays private" }),
    headers: { "Content-Type": "application/json", Origin: origin,
      Cookie: "account_session=" + f.token, "X-Session-Binding": f.session.sessionBinding, "X-CSRF-Token": f.session.csrf } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).send.status, "sent");
  const bridge = findSpan(SPAN_NAMES.BRIDGE_SEND);
  assert.ok(bridge, `expected delivery.bridge_send, got ${spanNames()}`);
  assert.equal(bridge.attributes[ATTR.CHANNEL], "telegram");
  assert.equal(bridge.attributes[ATTR.OUTCOME], "ok");
  const receipt = findSpan(SPAN_NAMES.RECEIPT);
  assert.ok(receipt, `expected delivery.receipt, got ${spanNames()}`);
  assert.equal(receipt.attributes[ATTR.CHANNEL], "telegram");
  assert.equal(receipt.attributes[ATTR.OUTCOME], "ok");
  assert.equal(receipt.parentSpanId, bridge.spanId, "receipt nests under bridge_send");
  assertNoBodiesLeak("direct body stays private");
});
