// telemetry-schema.mjs — FIX-25 (WAVE-300 ranked-fixes burn-down).
//
// THE common JSONL telemetry schema. Shipped as v:1 by FIX-54
// (scripts/room-telemetry-collector.mjs); FIX-25 adopts it across squads.
//
// Every telemetry record is one JSON object per JSONL line with this envelope:
//
//   { "v": 1, "ts": "<ISO-8601>", "kind": "<registered kind>", ...payload }
//
// - `v` is the schema version, pinned at 1. Additive change only: new kinds
//   and new optional payload fields may be added; existing fields are never
//   renamed or removed.
// - `ts` is when the record was emitted (ISO-8601). Emitters that already
//   carried their own timestamp field (FIX-22c's `timestamp`, FIX-55's
//   `generatedAt`) keep it as a legacy alias — `ts` is the common name.
// - `kind` names the record family. Registered kinds:
//     sample     FIX-54 collector window snapshot
//     alarm      FIX-54 metric.surface_degraded transitions
//     checkpoint FIX-54 cursor-checkpoint notices
//     gauge      FIX-22c CI queue-depth sample
//     digest     FIX-55 capacity digest
//     probe      FIX-78 board-read latency probe run
//
// Zero dependencies. `validateRecord` is the conformance gate used by
// tests/telemetry-schema.test.js.

export const SCHEMA_VERSION = 1;

// Required vs optional payload fields per kind. The envelope (v/ts/kind) is
// always required and is checked separately. Extra payload fields are allowed
// (additive evolution); missing required fields fail.
export const KIND_FIELDS = {
  sample: {
    required: ["window", "self"],
    optional: ["sequence"],
    description: "FIX-54 periodic window snapshot of room read health.",
  },
  alarm: {
    required: ["alarm", "active", "reason", "window", "self"],
    optional: [],
    description: "FIX-54 metric.surface_degraded alarm transitions.",
  },
  checkpoint: {
    required: ["path", "window", "self"],
    optional: [],
    description: "FIX-54 cursor-checkpoint notices.",
  },
  gauge: {
    required: ["type", "repo", "interval_s", "queued", "running", "p50_wait_s"],
    optional: ["id", "timestamp", "max_wait_s", "knee"],
    description:
      "FIX-22c CI queue-depth sample. `type` stays 'ci.queue_depth_sample'; " +
      "`timestamp` is the legacy alias of the envelope `ts`.",
  },
  digest: {
    required: ["text", "alerts", "gauges", "generatedAt"],
    optional: [],
    description:
      "FIX-55 capacity digest. `generatedAt` is the legacy alias of the " +
      "envelope `ts`. Note the alerts' inner `kind` field (board_full, " +
      "board_high, ci_knee) is the ALERT kind, a different namespace from " +
      "the envelope `kind`.",
  },
  probe: {
    required: ["target", "slo", "baseline", "ladder", "method"],
    optional: ["verdict"],
    description:
      "FIX-78 board-read latency probe run. `verdict` is attached by the CLI " +
      "after the run; records without it still validate.",
  },
};

export const KINDS = Object.keys(KIND_FIELDS);

/** Build a conforming record: stamps the envelope around a payload. */
export function envelope({ kind, ts = null, ...payload }) {
  if (!KINDS.includes(kind)) throw new Error(`telemetry-schema: unknown kind ${JSON.stringify(kind)}`);
  return {
    v: SCHEMA_VERSION,
    ts: ts || new Date().toISOString(),
    kind,
    ...payload,
  };
}

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function validateRecord(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["record must be a JSON object"] };
  }
  if (record.v !== SCHEMA_VERSION) {
    errors.push(`v must be ${SCHEMA_VERSION}, got ${JSON.stringify(record.v)}`);
  }
  if (!isIsoDateTime(record.ts)) {
    errors.push(`ts must be an ISO-8601 date-time string, got ${JSON.stringify(record.ts)}`);
  }
  const kind = record.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) {
    errors.push(`kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
    return { ok: errors.length === 0, errors };
  }
  for (const field of KIND_FIELDS[kind].required) {
    if (!(field in record)) errors.push(`kind ${JSON.stringify(kind)}: missing required field ${JSON.stringify(field)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate every non-blank line of a JSONL string; returns per-line results. */
export function validateJsonl(text) {
  const results = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      results.push({ line, ok: false, errors: ["not valid JSON"] });
      continue;
    }
    results.push({ line, ...validateRecord(record) });
  }
  return results;
}
