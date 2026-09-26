// R1: Delivery-path OpenTelemetry-compatible tracing (Photon deep-dive §7, §13).
//
// Opt-in tracing for the room's message-delivery path:
//   inbound → room event log → fan-out → channel bridge send → delivery receipt
//
// Design (mirrors Photon's spectrum-ts telemetry):
// - Default OFF. Set TELEMETRY=true to enable. No overhead when disabled:
//   every method is a no-op returning a null span.
// - Traces delivery-path metadata ONLY (message IDs, timestamps, latencies,
//   outcomes). Message bodies, tokens, and secrets are NEVER recorded.
// - Dependency-free and OTLP-compatible: spans export as OTLP/HTTP JSON so any
//   standard collector (Jaeger, Tempo, Honeycomb, Photon's own) can ingest.
//   W3C Trace Context (traceparent) for propagation across process boundaries.
// - Pure module: no imports from store.mjs/http.mjs, so it can be required
//   anywhere without circular-dependency risk.
//
// Usage:
//   import { getTracer } from "./delivery-tracing.mjs";
//   const tracer = getTracer(); // singleton, reads env once
//   const span = tracer.startSpan("delivery.inbound", { attributes: { "room.id": roomId } });
//   try {
//     ... do work ...
//     span.setAttribute("delivery.outcome", "ok");
//   } catch (err) {
//     span.recordException(err);
//     throw err;
//   } finally {
//     span.end();
//   }
//
// Or the scoped helper:
//   await tracer.trace("delivery.fanout", { "room.id": roomId }, async span => { ... });
//
// Env:
//   TELEMETRY=true                 enable tracing (default: off)
//   OTEL_EXPORTER_OTLP_ENDPOINT    OTLP/HTTP endpoint, e.g. http://localhost:4318/v1/traces
//                                  (default: buffer in memory; flush via tracer.flush())
//   OTEL_SERVICE_NAME              service.name resource attribute (default: project-room)
import { randomBytes } from "node:crypto";

export const SPAN_NAMES = Object.freeze({
  INBOUND: "delivery.inbound",       // message received at ingress (API, webhook, bridge)
  LOG: "delivery.log",               // persisted to the room event log
  FANOUT: "delivery.fanout",         // fanned out to room recipients
  BRIDGE_SEND: "delivery.bridge_send", // sent via a channel bridge (telegram, etc.)
  RECEIPT: "delivery.receipt",       // delivery confirmation received
});

// Attribute keys. Values must be primitives (string/number/boolean) — never
// message bodies, tokens, or secrets.
export const ATTR = Object.freeze({
  ROOM_ID: "room.id",
  MESSAGE_ID: "message.id",
  EVENT_TYPE: "event.type",
  INGRESS: "delivery.ingress",       // api | webhook | bridge | replay
  CHANNEL: "delivery.channel",       // telegram | email | ...
  RECIPIENT_COUNT: "delivery.recipient_count",
  OUTCOME: "delivery.outcome",       // ok | error | dropped | duplicate
  ERROR_CODE: "delivery.error_code",
  RETRY_ATTEMPT: "delivery.retry_attempt",
  DURATION_HINT: "delivery.stage",    // which pipeline stage this span covers
});

const STATUS = Object.freeze({ UNSET: 0, OK: 1, ERROR: 2 });

// --- W3C Trace Context -------------------------------------------------------
const hex = bytes => Buffer.from(bytes).toString("hex");
const newTraceId = () => hex(randomBytes(16)); // 128-bit
const newSpanId = () => hex(randomBytes(8));   // 64-bit

// traceparent: 00-<trace-id>-<span-id>-<flags>
export function formatTraceparent(traceId, spanId, sampled = true) {
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

export function parseTraceparent(header) {
  if (typeof header !== "string") return null;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim());
  if (!m || m[1] !== "00") return null;
  if (m[2] === "0".repeat(32) || m[3] === "0".repeat(16)) return null;
  return { traceId: m[2], spanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 };
}

// --- Span --------------------------------------------------------------------
const validAttrValue = v => ["string", "number", "boolean"].includes(typeof v);

class Span {
  constructor(tracer, name, { attributes = {}, parent = null } = {}) {
    this._tracer = tracer;
    this.name = name;
    this.traceId = parent?.traceId ?? newTraceId();
    this.spanId = newSpanId();
    this.parentSpanId = parent?.spanId ?? null;
    this.startTime = Date.now();
    this.startHr = process.hrtime.bigint();
    this.attributes = {};
    for (const [k, v] of Object.entries(attributes)) this.setAttribute(k, v);
    this.events = [];
    this.status = STATUS.UNSET;
    this.ended = false;
  }
  setAttribute(key, value) {
    if (typeof key === "string" && key.length > 0 && validAttrValue(value)) {
      // Defensive: never let a body/token slip into attributes.
      this.attributes[key] = value;
    }
    return this;
  }
  addEvent(name, attributes = {}) {
    if (!this.ended && typeof name === "string") {
      const clean = {};
      for (const [k, v] of Object.entries(attributes)) if (validAttrValue(v)) clean[k] = v;
      this.events.push({ name, time: Date.now(), attributes: clean });
    }
    return this;
  }
  recordException(err) {
    this.status = STATUS.ERROR;
    this.addEvent("exception", {
      "exception.type": err?.name ?? "Error",
      "exception.message": String(err?.message ?? err).slice(0, 512),
    });
    return this;
  }
  setStatusOk() { this.status = STATUS.OK; return this; }
  end() {
    if (this.ended) return this;
    this.ended = true;
    this.endHr = process.hrtime.bigint();
    this.durationMs = Number(this.endHr - this.startHr) / 1e6;
    this._tracer._onSpanEnd(this);
    return this;
  }
  // W3C propagation header for this span.
  traceparent() { return formatTraceparent(this.traceId, this.spanId, true); }
  // OTLP/HTTP JSON encoding of this span.
  toOtlp(serviceName) {
    const attrs = Object.entries(this.attributes).map(([key, v]) => ({
      key, value: typeof v === "string" ? { stringValue: v }
        : typeof v === "boolean" ? { boolValue: v }
        : { intValue: String(Math.trunc(v)) },
    }));
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: String(this.startHr ? BigInt(this.startTime) * 1000000n : 0n),
      endTimeUnixNano: String(BigInt(this.startTime) * 1000000n + BigInt(Math.round((this.durationMs ?? 0) * 1e6))),
      attributes: attrs,
      events: this.events.map(e => ({
        name: e.name,
        timeUnixNano: String(BigInt(e.time) * 1000000n),
        attributes: Object.entries(e.attributes).map(([key, v]) => ({
          key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : { intValue: String(Math.trunc(v)) },
        })),
      })),
      status: this.status === STATUS.ERROR ? { code: 2 } : this.status === STATUS.OK ? { code: 1 } : {},
    };
  }
}

// Null span: every method is a safe no-op. Returned when telemetry is off so
// instrumented code paths pay nothing and need no branching.
class NullSpan {
  constructor(parent = null) {
    this.name = "";
    this.traceId = parent?.traceId ?? null;
    this.spanId = null;
    this.parentSpanId = parent?.spanId ?? null;
    this.ended = false;
  }
  setAttribute() { return this; }
  addEvent() { return this; }
  recordException() { return this; }
  setStatusOk() { return this; }
  end() { this.ended = true; return this; }
  traceparent() { return null; }
  toOtlp() { return null; }
}

// --- Tracer ------------------------------------------------------------------
const readEnv = (env = process.env) => ({
  enabled: env.TELEMETRY === "true" || env.TELEMETRY === "1",
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
  serviceName: env.OTEL_SERVICE_NAME ?? "project-room",
});

export class DeliveryTracer {
  constructor(env = process.env) {
    const cfg = readEnv(env);
    this.enabled = cfg.enabled;
    this.endpoint = cfg.endpoint;
    this.serviceName = cfg.serviceName;
    this._buffer = []; // finished spans awaiting export/flush
  }

  get isEnabled() { return this.enabled; }

  startSpan(name, { attributes, parent } = {}) {
    if (!this.enabled) return new NullSpan(parent ?? null);
    if (typeof name !== "string" || name.length === 0) return new NullSpan(parent ?? null);
    return new Span(this, name, { attributes, parent });
  }

  // Continue a trace from an incoming W3C traceparent header.
  startSpanFromHeader(name, traceparentHeader, { attributes } = {}) {
    const ctx = parseTraceparent(traceparentHeader);
    const parent = ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : null;
    return this.startSpan(name, { attributes, parent });
  }

  // Scoped helper: runs fn(span), ends the span, rethrows on error.
  async trace(name, attributes, fn) {
    if (typeof attributes === "function") { fn = attributes; attributes = {}; }
    const span = this.startSpan(name, { attributes });
    try {
      const result = await fn(span);
      span.setStatusOk();
      return result;
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }

  _onSpanEnd(span) {
    if (!this.enabled) return;
    this._buffer.push(span);
    // Best-effort export; never let telemetry break the request path.
    if (this.endpoint) void this._export().catch(() => {});
  }

  // Finished spans currently buffered (for tests / local inspection).
  bufferedSpans() { return [...this._buffer]; }
  bufferedSpanCount() { return this._buffer.length; }
  clearBuffer() { this._buffer.length = 0; }

  // Build the OTLP/HTTP JSON payload for buffered spans without clearing.
  otlpPayload() {
    const spans = this._buffer.map(s => s.toOtlp(this.serviceName)).filter(Boolean);
    return {
      resourceSpans: spans.length === 0 ? [] : [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] },
        scopeSpans: [{ scope: { name: "project-room.delivery-tracing" }, spans }],
      }],
    };
  }

  // POST buffered spans to the OTLP endpoint, then clear. No-op without endpoint.
  async flush() {
    if (!this.enabled || !this.endpoint || this._buffer.length === 0) return { exported: 0 };
    const result = await this._export();
    return result;
  }

  async _export() {
    const payload = this.otlpPayload();
    const count = this._buffer.length;
    if (count === 0) return { exported: 0 };
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`OTLP export failed: ${res.status}`);
    this._buffer.length = 0;
    return { exported: count };
  }
}

// Singleton: reads env once. Tests should construct DeliveryTracer directly.
let singleton = null;
export function getTracer(env) {
  if (env) return new DeliveryTracer(env);
  if (!singleton) singleton = new DeliveryTracer();
  return singleton;
}
export function resetTracerForTests() { singleton = null; }

// --- Delivery-path helper ------------------------------------------------------
// Traces the canonical five-stage delivery path with one trace ID, so a single
// "where did this reply go?" query returns the whole path. Each stage is a
// child span; stages run via the provided async callbacks. Any stage may be
// skipped by returning { skip: true }.
//
//   const result = await traceDeliveryPath(tracer, {
//     roomId, messageId, ingress: "api",
//   }, {
//     inbound: async span => { ... },
//     log: async span => { ... },
//     fanout: async span => { ... },
//     bridgeSend: async span => { ... },
//     receipt: async span => { ... },
//   });
export async function traceDeliveryPath(tracer, { roomId, messageId, ingress = "api", channel = null } = {}, stages = {}) {
  const base = { [ATTR.ROOM_ID]: roomId, [ATTR.INGRESS]: ingress };
  if (messageId) base[ATTR.MESSAGE_ID] = messageId;
  if (channel) base[ATTR.CHANNEL] = channel;

  const order = [
    ["inbound", SPAN_NAMES.INBOUND],
    ["log", SPAN_NAMES.LOG],
    ["fanout", SPAN_NAMES.FANOUT],
    ["bridgeSend", SPAN_NAMES.BRIDGE_SEND],
    ["receipt", SPAN_NAMES.RECEIPT],
  ];
  const results = {};
  let parent = null;
  for (const [key, name] of order) {
    const fn = stages[key];
    if (typeof fn !== "function") continue;
    const span = tracer.startSpan(name, { attributes: base, parent });
    parent = span;
    try {
      const out = await fn(span);
      if (out && out.skip === true) {
        span.setAttribute(ATTR.OUTCOME, "dropped");
      } else {
        span.setAttribute(ATTR.OUTCOME, "ok");
        span.setStatusOk();
      }
      results[key] = out;
    } catch (err) {
      span.setAttribute(ATTR.OUTCOME, "error");
      span.recordException(err);
      results[key] = { error: err };
      throw err;
    } finally {
      span.end();
    }
  }
  return { traceId: parent?.traceId ?? null, results };
}
