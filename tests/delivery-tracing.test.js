// R1 delivery-path tracing tests.
// Authoring gate: these protect (1) the OTLP/HTTP JSON export contract that
// standard collectors ingest, (2) W3C traceparent propagation across process
// boundaries, (3) the opt-in default (telemetry OFF unless TELEMETRY=true — a
// performance and privacy invariant), and (4) the no-message-content privacy
// rule. Credible regressions: a changed OTLP shape collectors reject, broken
// traceparent round-trip losing cross-process continuity, tracing defaulting
// on, or message bodies leaking into span attributes.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  DeliveryTracer,
  getTracer,
  resetTracerForTests,
  traceDeliveryPath,
  formatTraceparent,
  parseTraceparent,
  SPAN_NAMES,
  ATTR,
} from "../server/delivery-tracing.mjs";

const ON = { TELEMETRY: "true" };
const OFF = {};

// --- Opt-in behavior ---------------------------------------------------------

test("tracing is off by default: spans are null and nothing is buffered", () => {
  const tracer = new DeliveryTracer(OFF);
  assert.equal(tracer.isEnabled, false);
  const span = tracer.startSpan(SPAN_NAMES.INBOUND, { attributes: { [ATTR.ROOM_ID]: "r1" } });
  span.setAttribute("x", 1).addEvent("e").setStatusOk().end();
  assert.equal(span.ended, true);
  assert.equal(tracer.bufferedSpanCount(), 0);
  assert.equal(span.traceparent(), null);
});

test("tracer.trace runs the function and returns its value when disabled", async () => {
  const tracer = new DeliveryTracer(OFF);
  const out = await tracer.trace(SPAN_NAMES.LOG, { [ATTR.ROOM_ID]: "r1" }, async span => {
    span.setAttribute("k", "v");
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(tracer.bufferedSpanCount(), 0);
});

test("TELEMETRY=1 also enables tracing", () => {
  assert.equal(new DeliveryTracer({ TELEMETRY: "1" }).isEnabled, true);
});

test("getTracer singleton reads env once; resetTracerForTests clears it", () => {
  resetTracerForTests();
  const a = getTracer(OFF);
  const b = getTracer(ON); // explicit env bypasses the singleton
  assert.equal(a.isEnabled, false);
  assert.equal(b.isEnabled, true);
  resetTracerForTests();
});

// --- Span lifecycle ----------------------------------------------------------

test("enabled tracer creates spans with W3C ids and parent linkage", () => {
  const tracer = new DeliveryTracer(ON);
  const parent = tracer.startSpan(SPAN_NAMES.INBOUND, { attributes: { [ATTR.ROOM_ID]: "r1" } });
  const child = tracer.startSpan(SPAN_NAMES.LOG, { parent });
  assert.match(parent.traceId, /^[0-9a-f]{32}$/);
  assert.match(parent.spanId, /^[0-9a-f]{16}$/);
  assert.equal(child.traceId, parent.traceId);
  assert.equal(child.parentSpanId, parent.spanId);
  assert.equal(parent.parentSpanId, null);
  child.end();
  parent.end();
  assert.equal(tracer.bufferedSpanCount(), 2);
});

test("span records attributes, events, duration, and error status", () => {
  const tracer = new DeliveryTracer(ON);
  const span = tracer.startSpan("delivery.test", { attributes: { [ATTR.OUTCOME]: "ok", n: 3, flag: true } });
  span.addEvent("retry", { [ATTR.RETRY_ATTEMPT]: 2 });
  span.recordException(new TypeError("boom"));
  span.end();
  assert.equal(span.ended, true);
  assert.equal(typeof span.durationMs, "number");
  assert.ok(span.durationMs >= 0);
  assert.equal(span.events.length, 2);
  assert.equal(span.events[0].name, "retry");
  assert.equal(span.events[1].name, "exception");
  // end() is idempotent: no double-buffering
  span.end();
  assert.equal(tracer.bufferedSpanCount(), 1);
});

test("tracer.trace marks ok on success and records exception on throw", async () => {
  const tracer = new DeliveryTracer(ON);
  await tracer.trace("delivery.test", {}, async () => "fine");
  await assert.rejects(tracer.trace("delivery.test", {}, async () => { throw new Error("bad"); }), /bad/);
  const [okSpan, errSpan] = tracer.bufferedSpans();
  assert.equal(okSpan.attributes[ATTR.OUTCOME], undefined); // trace() only sets status, not outcome attr
  assert.equal(errSpan.events[0].name, "exception");
  assert.equal(errSpan.events[0].attributes["exception.message"], "bad");
});

// --- Privacy: no message content in spans -------------------------------------

test("non-primitive attribute values are dropped, never serialized", () => {
  const tracer = new DeliveryTracer(ON);
  const span = tracer.startSpan("delivery.test");
  span.setAttribute("body", { text: "secret message content" });
  span.setAttribute("token", ["array", "not", "allowed"]);
  span.setAttribute("ok", "fine");
  span.end();
  assert.deepEqual(Object.keys(span.attributes), ["ok"]);
  const otlp = span.toOtlp("svc");
  assert.equal(otlp.attributes.length, 1);
  assert.equal(otlp.attributes[0].key, "ok");
});

// --- W3C traceparent ----------------------------------------------------------

test("traceparent formats and parses round-trip", () => {
  const tracer = new DeliveryTracer(ON);
  const span = tracer.startSpan("delivery.test");
  const header = span.traceparent();
  assert.match(header, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const ctx = parseTraceparent(header);
  assert.equal(ctx.traceId, span.traceId);
  assert.equal(ctx.spanId, span.spanId);
  assert.equal(ctx.sampled, true);
  span.end();
});

test("parseTraceparent rejects malformed and all-zero ids", () => {
  assert.equal(parseTraceparent("bogus"), null);
  assert.equal(parseTraceparent(null), null);
  assert.equal(parseTraceparent("00-" + "0".repeat(32) + "-abcdef0123456789-01"), null);
  assert.equal(parseTraceparent("00-abcdef0123456789abcdef0123456789-" + "0".repeat(16) + "-01"), null);
  assert.equal(parseTraceparent("01-abcdef0123456789abcdef0123456789-abcdef0123456789-01"), null); // version 01
});

test("formatTraceparent rejects malformed ids", () => {
  assert.equal(formatTraceparent("short", "abcdef0123456789"), null);
  assert.equal(formatTraceparent("abcdef0123456789abcdef0123456789", "short"), null);
});

test("startSpanFromHeader continues the incoming trace", () => {
  const tracer = new DeliveryTracer(ON);
  const header = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const span = tracer.startSpanFromHeader(SPAN_NAMES.INBOUND, header);
  assert.equal(span.traceId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(span.parentSpanId, "bbbbbbbbbbbbbbbb");
  span.end();
  // Bad header -> fresh trace, no crash
  const fresh = tracer.startSpanFromHeader(SPAN_NAMES.INBOUND, "nope");
  assert.match(fresh.traceId, /^[0-9a-f]{32}$/);
  assert.equal(fresh.parentSpanId, null);
  fresh.end();
});

// --- OTLP export contract -----------------------------------------------------

test("otlpPayload matches OTLP/HTTP JSON shape with service.name resource", () => {
  const tracer = new DeliveryTracer({ ...ON, OTEL_SERVICE_NAME: "room-test" });
  const span = tracer.startSpan(SPAN_NAMES.BRIDGE_SEND, {
    attributes: { [ATTR.CHANNEL]: "telegram", [ATTR.OUTCOME]: "ok" },
  });
  span.end();
  const payload = tracer.otlpPayload();
  assert.equal(payload.resourceSpans.length, 1);
  const rs = payload.resourceSpans[0];
  assert.equal(rs.resource.attributes[0].key, "service.name");
  assert.equal(rs.resource.attributes[0].value.stringValue, "room-test");
  const [otlpSpan] = rs.scopeSpans[0].spans;
  assert.equal(otlpSpan.name, SPAN_NAMES.BRIDGE_SEND);
  assert.equal(otlpSpan.traceId, span.traceId);
  assert.equal(otlpSpan.spanId, span.spanId);
  assert.ok(otlpSpan.attributes.some(a => a.key === ATTR.CHANNEL && a.value.stringValue === "telegram"));
  assert.match(otlpSpan.startTimeUnixNano, /^\d+$/);
  assert.match(otlpSpan.endTimeUnixNano, /^\d+$/);
});

test("flush POSTs OTLP JSON to the configured endpoint and clears the buffer", async () => {
  let received = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => { received = { url: req.url, contentType: req.headers["content-type"], body }; res.writeHead(200); res.end("{}"); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const tracer = new DeliveryTracer({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/v1/traces` });
    tracer.startSpan(SPAN_NAMES.RECEIPT, { attributes: { [ATTR.OUTCOME]: "ok" } }).end();
    assert.equal(tracer.bufferedSpanCount(), 1);
    const result = await tracer.flush();
    assert.equal(result.exported, 1);
    assert.equal(tracer.bufferedSpanCount(), 0);
    assert.equal(received.url, "/v1/traces");
    assert.equal(received.contentType, "application/json");
    const payload = JSON.parse(received.body);
    assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].name, SPAN_NAMES.RECEIPT);
  } finally {
    server.close();
  }
});

test("flush is a no-op without an endpoint", async () => {
  const tracer = new DeliveryTracer(ON);
  tracer.startSpan("delivery.test").end();
  const result = await tracer.flush();
  assert.equal(result.exported, 0);
  assert.equal(tracer.bufferedSpanCount(), 1); // retained for local inspection
});

// --- traceDeliveryPath helper ---------------------------------------------------

test("traceDeliveryPath links all five stages under one trace id", async () => {
  const tracer = new DeliveryTracer(ON);
  const seen = [];
  const { traceId, results } = await traceDeliveryPath(
    tracer,
    { roomId: "room-1", messageId: "msg-9", ingress: "webhook", channel: "telegram" },
    {
      inbound: async span => { seen.push(span.name); },
      log: async span => { seen.push(span.name); },
      fanout: async span => { seen.push(span.name); span.setAttribute(ATTR.RECIPIENT_COUNT, 4); },
      bridgeSend: async span => { seen.push(span.name); },
      receipt: async span => { seen.push(span.name); },
    },
  );
  assert.deepEqual(seen, [SPAN_NAMES.INBOUND, SPAN_NAMES.LOG, SPAN_NAMES.FANOUT, SPAN_NAMES.BRIDGE_SEND, SPAN_NAMES.RECEIPT]);
  assert.match(traceId, /^[0-9a-f]{32}$/);
  const spans = tracer.bufferedSpans();
  assert.equal(spans.length, 5);
  for (const s of spans) {
    assert.equal(s.traceId, traceId);
    assert.equal(s.attributes[ATTR.ROOM_ID], "room-1");
    assert.equal(s.attributes[ATTR.MESSAGE_ID], "msg-9");
    assert.equal(s.attributes[ATTR.OUTCOME], "ok");
  }
  // Parent chain: each stage's parent is the previous stage's span.
  const byName = Object.fromEntries(spans.map(s => [s.name, s]));
  assert.equal(byName[SPAN_NAMES.LOG].parentSpanId, byName[SPAN_NAMES.INBOUND].spanId);
  assert.equal(byName[SPAN_NAMES.FANOUT].parentSpanId, byName[SPAN_NAMES.LOG].spanId);
  assert.equal(byName[SPAN_NAMES.BRIDGE_SEND].parentSpanId, byName[SPAN_NAMES.FANOUT].spanId);
  assert.equal(byName[SPAN_NAMES.RECEIPT].parentSpanId, byName[SPAN_NAMES.BRIDGE_SEND].spanId);
  assert.equal(results.fanout, undefined);
});

test("traceDeliveryPath skips unprovided stages and marks dropped outcomes", async () => {
  const tracer = new DeliveryTracer(ON);
  const { traceId } = await traceDeliveryPath(
    tracer,
    { roomId: "r", ingress: "api" },
    {
      inbound: async () => {},
      bridgeSend: async () => ({ skip: true }),
    },
  );
  const spans = tracer.bufferedSpans();
  assert.equal(spans.length, 2);
  assert.equal(spans[1].attributes[ATTR.OUTCOME], "dropped");
  assert.equal(spans[1].traceId, traceId);
});

test("traceDeliveryPath propagates stage errors and marks them", async () => {
  const tracer = new DeliveryTracer(ON);
  await assert.rejects(
    traceDeliveryPath(tracer, { roomId: "r" }, {
      inbound: async () => {},
      log: async () => { throw new Error("disk full"); },
    }),
    /disk full/,
  );
  const spans = tracer.bufferedSpans();
  assert.equal(spans.length, 2);
  assert.equal(spans[1].attributes[ATTR.OUTCOME], "error");
  assert.equal(spans[1].events[0].name, "exception");
});

test("traceDeliveryPath is a no-op trace when telemetry is off", async () => {
  const tracer = new DeliveryTracer(OFF);
  const { traceId, results } = await traceDeliveryPath(tracer, { roomId: "r" }, {
    inbound: async () => "did-work",
  });
  assert.equal(traceId, null);
  assert.equal(results.inbound, "did-work");
  assert.equal(tracer.bufferedSpanCount(), 0);
});
