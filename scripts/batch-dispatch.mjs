#!/usr/bin/env node
// batch-dispatch: manifest validator + batch spawn-payload emitter for WAVE-500 coord-cost.
//
// Reads a batch-dispatch manifest {sharedContext, workers:[{id, brief, doneCondition}]},
// validates it, and emits a single batch envelope: the shared context factored out ONCE
// (content-addressed by contextRef) plus N per-worker payloads that carry only the
// contextRef pointer and their delta brief. It does NOT call any spawn API — it prepares
// and validates manifests and measures the context-token savings versus N independent
// spawns (N×(shared+brief) vs shared+N×brief).
//
// Usage:
//   node scripts/batch-dispatch.mjs --manifest <path.json | ->                (stdin with -)
//        [--out <envelope.json>] [--max-brief <chars>] [--max-workers <n>]
//        [--max-shared <chars>] [--strict]
//
// Exit 0: manifest valid; envelope JSON on stdout (or --out), savings report on stderr.
// Exit 2: bad arguments or manifest validation failure (reasons on stderr).
//
// Spec: docs/BATCH-DISPATCH-SPEC.md
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stdin } from "node:process";

const SCHEMA_VERSION = "batch-dispatch/v1";
const ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_ID_LEN = 64;
const MAX_DONE_LEN = 1000;
const MAX_SUMMARY_LEN = 280; // receipt v1 contract (validated here for reference)

const DEFAULTS = {
  maxBrief: 2000,    // briefs are deltas; overflow belongs in sharedContext
  maxWorkers: 100,
  maxShared: 200000, // accident guard
};

/** Rough token estimate: ~4 chars/token for English prose. Documented approximation;
 *  the savings *ratio* is what matters, not the absolute count. */
function estTokens(text) {
  return Math.ceil(text.length / 4);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(msg) {
  console.error(`batch-dispatch: ERROR: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { manifest: null, out: null, strict: false, ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`missing value for ${a}`);
      i += 1;
      return v;
    };
    if (a === "--manifest") args.manifest = next();
    else if (a === "--out") args.out = next();
    else if (a === "--max-brief") args.maxBrief = Number(next());
    else if (a === "--max-workers") args.maxWorkers = Number(next());
    else if (a === "--max-shared") args.maxShared = Number(next());
    else if (a === "--strict") args.strict = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else fail(`unknown argument ${a}`);
  }
  if (!args.manifest) fail("missing required --manifest <path.json | ->");
  for (const k of ["maxBrief", "maxWorkers", "maxShared"]) {
    if (!Number.isInteger(args[k]) || args[k] <= 0) fail(`${k} must be a positive integer`);
  }
  return args;
}

function printHelp() {
  console.log(`batch-dispatch ${SCHEMA_VERSION}
Validate a batch-dispatch manifest and emit the batch envelope with the shared
context factored out, plus the estimated context-token savings vs N independent
spawns.

Options:
  --manifest <path | ->   manifest JSON file ("-" reads stdin) [required]
  --out <path>            write envelope JSON to file instead of stdout
  --max-brief <chars>     per-worker brief cap (default ${DEFAULTS.maxBrief})
  --max-workers <n>       worker count cap (default ${DEFAULTS.maxWorkers})
  --max-shared <chars>    sharedContext cap (default ${DEFAULTS.maxShared})
  --strict                report all validation errors, not just the first`);
}

function readManifest(path) {
  let raw;
  try {
    raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read manifest ${path === "-" ? "(stdin)" : path}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`manifest is not valid JSON: ${e.message}`);
  }
  void stdin;
}

/** Returns an array of error strings (empty = valid). */
function validate(manifest, opts) {
  const errors = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be a JSON object {sharedContext, workers:[...]}"];
  }
  const { sharedContext, workers } = manifest;
  if (typeof sharedContext !== "string" || sharedContext.length === 0) {
    errors.push("sharedContext: required non-empty string");
  } else if (sharedContext.length > opts.maxShared) {
    errors.push(`sharedContext: ${sharedContext.length} chars exceeds cap ${opts.maxShared}`);
  }
  if (!Array.isArray(workers) || workers.length === 0) {
    errors.push("workers: required non-empty array");
  } else {
    if (workers.length > opts.maxWorkers) {
      errors.push(`workers: ${workers.length} exceeds cap ${opts.maxWorkers}`);
    }
    const seen = new Set();
    workers.forEach((w, i) => {
      const where = `workers[${i}]`;
      if (w === null || typeof w !== "object" || Array.isArray(w)) {
        errors.push(`${where}: must be an object {id, brief, doneCondition}`);
        return;
      }
      if (typeof w.id !== "string" || !ID_RE.test(w.id) || w.id.length > MAX_ID_LEN) {
        errors.push(`${where}.id: must match ${ID_RE} and be ≤ ${MAX_ID_LEN} chars`);
      } else if (seen.has(w.id)) {
        errors.push(`${where}.id: duplicate worker id "${w.id}"`);
      } else {
        seen.add(w.id);
      }
      if (typeof w.brief !== "string" || w.brief.length === 0) {
        errors.push(`${where}.brief: required non-empty string (the delta only)`);
      } else if (w.brief.length > opts.maxBrief) {
        errors.push(
          `${where}.brief: ${w.brief.length} chars exceeds cap ${opts.maxBrief} — ` +
          "this content belongs in sharedContext, not the per-worker brief"
        );
      }
      if (typeof w.doneCondition !== "string" || w.doneCondition.length === 0) {
        errors.push(`${where}.doneCondition: required non-empty string`);
      } else if (w.doneCondition.length > MAX_DONE_LEN) {
        errors.push(`${where}.doneCondition: exceeds ${MAX_DONE_LEN} chars`);
      }
    });
  }
  return errors;
}

function buildEnvelope(manifest) {
  const contextRef = sha256(manifest.sharedContext);
  const batchId = `batch-${sha256(JSON.stringify(manifest)).slice(0, 12)}`;
  const sharedTokens = estTokens(manifest.sharedContext);
  const payloads = manifest.workers.map((w) => ({
    workerId: w.id,
    contextRef, // pointer, not a copy — the shared context is sent once
    brief: w.brief,
    doneCondition: w.doneCondition,
    schemaVersion: SCHEMA_VERSION,
  }));
  return {
    batchId,
    schemaVersion: SCHEMA_VERSION,
    contextRef,
    sharedContext: {
      ref: contextRef,
      bytes: Buffer.byteLength(manifest.sharedContext, "utf8"),
      estTokens: sharedTokens,
      text: manifest.sharedContext, // emitted ONCE per batch, regardless of N
    },
    payloads,
  };
}

/** Savings model: independent N×(shared+brief) vs batched shared+N×(brief+ref). */
function savingsReport(manifest, envelope) {
  const sharedTokens = envelope.sharedContext.estTokens;
  const refTokens = estTokens(envelope.contextRef);
  const perWorker = manifest.workers.map((w) => ({
    id: w.id,
    briefTokens: estTokens(w.brief),
    doneTokens: estTokens(w.doneCondition),
  }));
  // doneCondition rides in both models, so it cancels out; keep it out of the delta.
  const independent = manifest.workers.length * sharedTokens +
    perWorker.reduce((s, w) => s + w.briefTokens, 0);
  const batched = sharedTokens +
    perWorker.reduce((s, w) => s + w.briefTokens + refTokens, 0);
  const saved = independent - batched;
  return {
    workers: manifest.workers.length,
    sharedContextTokens: sharedTokens,
    refTokensPerWorker: refTokens,
    independentSpawnTokens: independent,
    batchedTokens: batched,
    tokensSaved: saved,
    savingsPct: independent === 0 ? 0 : (saved / independent) * 100,
    turnsBefore: manifest.workers.length, // one coordinator turn per worker
    turnsAfter: 1,                          // one batch action fires all
    avgBriefTokens: perWorker.reduce((s, w) => s + w.briefTokens, 0) / perWorker.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifest);
  const errors = validate(manifest, args);
  if (errors.length > 0) {
    const show = args.strict ? errors : errors.slice(0, 1);
    for (const e of show) console.error(`batch-dispatch: invalid manifest: ${e}`);
    if (!args.strict && errors.length > 1) {
      console.error(`batch-dispatch: ...and ${errors.length - 1} more (use --strict to list all)`);
    }
    console.error(`batch-dispatch: receipt contract reminder — receipt summary ≤ ${MAX_SUMMARY_LEN} chars (spec §6)`);
    process.exit(2);
  }

  const envelope = buildEnvelope(manifest);
  const report = savingsReport(manifest, envelope);

  const out = JSON.stringify({ envelope, savings: report }, null, 2);
  if (args.out) {
    try {
      writeFileSync(args.out, out);
    } catch (e) {
      fail(`cannot write --out ${args.out}: ${e.message}`);
    }
  } else {
    console.log(out);
  }

  const r = report;
  console.error(
    `batch-dispatch: OK — ${r.workers} workers, batch ${envelope.batchId}\n` +
    `  context: independent=${r.independentSpawnTokens}t batched=${r.batchedTokens}t ` +
    `saved=${r.tokensSaved}t (${r.savingsPct.toFixed(1)}%)\n` +
    `  turns: ${r.turnsBefore} sequential → ${r.turnsAfter} batch action`
  );
}

main();
