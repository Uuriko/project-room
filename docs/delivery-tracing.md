# Delivery-path tracing (R1)

Opt-in OpenTelemetry-compatible tracing for the room's message-delivery path,
from the Photon deep-dive (§7, §13 R1).

## What it does

Traces a message through five stages:

```
delivery.inbound → delivery.log → delivery.fanout → delivery.bridge_send → delivery.receipt
```

Each stage is a span with W3C Trace Context propagation. A single "where did
this reply go?" query returns the whole path: ingress point, processing
latency, fan-out count, bridge send outcome, and delivery receipt.

## Enabling

Tracing is **off by default**. To enable:

```bash
TELEMETRY=true
```

Optional:

```bash
# OTLP/HTTP endpoint (any standard collector: Jaeger, Tempo, Honeycomb)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
# Service name in traces (default: project-room)
OTEL_SERVICE_NAME=project-room
```

Without an endpoint, spans buffer in memory for local inspection
(`tracer.bufferedSpans()`). With an endpoint, spans POST as OTLP/HTTP JSON.

## What is traced (and what is not)

**Traced:** message IDs, room IDs, ingress source (`api`/`webhook`/`bridge`),
channel name, recipient counts, per-stage latency, outcomes
(`ok`/`error`/`dropped`/`duplicate`), retry attempts, error codes.

**Never traced:** message bodies, tokens, secrets, or any non-primitive
attribute value. The tracer drops non-string/number/boolean attributes
silently.

## Usage

```js
import { getTracer, traceDeliveryPath, SPAN_NAMES, ATTR } from "./server/delivery-tracing.mjs";

const tracer = getTracer(); // singleton, reads env once

// Manual spans:
const span = tracer.startSpan(SPAN_NAMES.INBOUND, {
  attributes: { [ATTR.ROOM_ID]: roomId, [ATTR.INGRESS]: "webhook" },
});
try {
  // ... handle inbound ...
  span.setAttribute(ATTR.OUTCOME, "ok");
} catch (err) {
  span.recordException(err);
  throw err;
} finally {
  span.end();
}

// Or trace the full five-stage path with one trace ID:
const { traceId } = await traceDeliveryPath(
  tracer,
  { roomId, messageId, ingress: "api", channel: "telegram" },
  {
    inbound: async span => { /* parse + validate */ },
    log: async span => { /* persist to event log */ },
    fanout: async span => { /* fan out to recipients */ },
    bridgeSend: async span => { /* send via bridge */ },
    receipt: async span => { /* await delivery receipt */ },
  },
);
// Skip a stage by omitting it or returning { skip: true }.
```

Cross-process propagation: pass `span.traceparent()` as the
`traceparent` header; the receiver continues with
`tracer.startSpanFromHeader(name, header)`.

## Design notes

- **Dependency-free.** No `@opentelemetry/*` packages; the module emits
  standard OTLP/HTTP JSON and W3C `traceparent` so any collector works.
- **Zero overhead when off.** Disabled tracers return null spans; every
  method is a no-op. Instrumented code needs no `if (enabled)` branches.
- **Pure module.** No imports from `store.mjs`/`http.mjs`, so it can be
  required anywhere without circular-dependency risk.
- **Best-effort export.** Export failures never throw into the request
  path; spans stay buffered for retry via `flush()`.

## Answering "where did this reply go?"

With spans in your collector, filter by `message.id`:

```
trace where attributes["message.id"] = "<id>"
```

You'll see the five stages, each with duration and outcome. A missing
`delivery.receipt` span means the bridge send never confirmed. A
`delivery.fanout` span with `delivery.recipient_count: 0` means no
recipients matched.
