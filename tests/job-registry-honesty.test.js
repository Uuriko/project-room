// JOB-REGISTRY-HONESTY (ATLAS-JOBS-WAKES R-5/R-6/R-7): the job registry's
// recording must not lie by omission.
//  R-5/WP-10: a throwing due-ness probe used to read as "not due"/"disabled"
//     with no record anywhere. A throw now leaves a recorded probeError fact
//     on the job's health row, distinct from a quiet not-due.
//  R-6/WP-5: a failed recordCronTick write used to be a console.error — the
//     visibility system could not see its own memory failing. Failures now
//     increment a durable unrecordedTicks counter surfaced on the view.
//  R-7: every registry job declares a stopTolerance (how long the system
//     tolerates it not running), surfaced on the health rows for the
//     guardian vocabulary to consume. escrow-epochs is the only
//     zero-tolerance ("incident") job: it is the money clock.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOBS, STOP_TOLERANCES, jobByName, jobEnabled, jobNextDue,
  probeErrorFor, setProbeErrorSink, clearProbeErrors
} from "../server/jobs.mjs";
import {
  CRON_JOBS, HEARTBEAT_STORAGE_KEY, UNRECORDED_TICKS_STORAGE_KEY,
  applyProbeError, clearPersistedProbeError, mergeProbeErrorFacts,
  incrementUnrecordedTicks, readUnrecordedTicks, jobHealthView
} from "../cloudflare/job-heartbeat.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "room-job-registry-honesty-"));
  const shimUrl = pathToFileURL(join(dir, "shim.mjs")).href;
  writeFileSync(join(dir, "shim.mjs"), [
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export function httpServerHandler() { return { fetch() { return new Response(null, { status: 500 }); } }; }",
    ""
  ].join("\n"));
  writeFileSync(join(dir, "hook.mjs"), [
    `const shim = ${JSON.stringify(shimUrl)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:node') return { url: shim, shortCircuit: true };",
    "  return nextResolve(specifier, context);",
    "}",
    ""
  ].join("\n"));
  register(pathToFileURL(join(dir, "hook.mjs")).href, import.meta.url);
}
installWorkersShim();
const { ProjectRoom } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);

function memoryStorage(overrides = {}) {
  const map = new Map();
  return {
    map,
    async get(key) { return structuredClone(map.get(key)); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    ...overrides
  };
}

// ---------- R-7: stop tolerance ----------

test("registry: every job declares a stopTolerance from the closed vocabulary", () => {
  assert.deepEqual([...STOP_TOLERANCES].sort(), ["day", "incident", "week"]);
  for (const job of JOBS) {
    assert.ok(STOP_TOLERANCES.includes(job.stopTolerance), `${job.name} must declare a stopTolerance`);
  }
});

test("registry: escrow-epochs is the only zero-tolerance (incident) job; integrity and room-backup tolerate a day", () => {
  assert.equal(jobByName("escrow-epochs").stopTolerance, "incident");
  assert.deepEqual(JOBS.filter(job => job.stopTolerance === "incident").map(job => job.name), ["escrow-epochs"]);
  assert.equal(jobByName("integrity").stopTolerance, "day");
  assert.equal(jobByName("room-backup").stopTolerance, "day");
  for (const job of JOBS) {
    if (["escrow-epochs", "integrity", "room-backup"].includes(job.name)) continue;
    assert.equal(job.stopTolerance, "week", `${job.name} tolerates a week per the map's 24h-stop verdicts`);
  }
});

test("health view rows carry stopTolerance (worker surface)", () => {
  const view = jobHealthView({}, Date.now(), null, null);
  assert.equal(view.jobs.length, CRON_JOBS.length);
  for (const row of view.jobs) {
    assert.ok(STOP_TOLERANCES.includes(row.stopTolerance), `${row.name} row must carry stopTolerance`);
  }
  assert.equal(view.jobs.find(job => job.name === "escrow-epochs").stopTolerance, "incident");
});

// ---------- R-5: probe-error state ----------

test("a throwing enabled probe is recorded as a probeError fact, not a silent not-due", () => {
  clearProbeErrors();
  const job = { name: "honesty-enabled-throws", enabled() { throw new Error("gate exploded"); } };
  assert.equal(jobEnabled(job, {}, null), false);
  const fact = probeErrorFor("honesty-enabled-throws");
  assert.ok(fact, "the throw must leave a recorded fact");
  assert.equal(fact.probe, "enabled");
  assert.match(fact.error, /gate exploded/);
  assert.equal(fact.count, 1);
  assert.ok(Number.isFinite(fact.at) && Number.isFinite(fact.firstAt));
  // A second throw accumulates on the same fact.
  assert.equal(jobEnabled(job, {}, null), false);
  assert.equal(probeErrorFor("honesty-enabled-throws").count, 2);
  clearProbeErrors();
});

test("a throwing nextDueAt probe is recorded; a later success clears the fact", () => {
  clearProbeErrors();
  let broken = true;
  const job = {
    name: "honesty-due-throws",
    enabled: () => true,
    nextDueAt() { if (broken) throw new Error("due scan exploded"); return 1234; }
  };
  assert.equal(jobNextDue(job, {}, 5000, 0), null);
  const fact = probeErrorFor("honesty-due-throws");
  assert.ok(fact);
  assert.equal(fact.probe, "nextDueAt");
  broken = false;
  assert.equal(jobNextDue(job, {}, 5000, 0), 1234);
  assert.equal(probeErrorFor("honesty-due-throws"), null, "a successful probe evaluation clears the fact");
  clearProbeErrors();
});

test("the probe-error sink is notified of throws and recoveries, and a throwing sink cannot break due-ness", () => {
  clearProbeErrors();
  const events = [];
  setProbeErrorSink(event => events.push(event));
  try {
    let broken = true;
    const job = { name: "honesty-sink", enabled() { if (broken) throw new Error("sink boom"); return true; } };
    assert.equal(jobEnabled(job, {}, null), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].job, "honesty-sink");
    assert.equal(events[0].probe, "enabled");
    broken = false;
    assert.equal(jobEnabled(job, {}, null), true);
    assert.equal(events.length, 2);
    assert.equal(events[1].cleared, true);
  } finally {
    setProbeErrorSink(null);
    clearProbeErrors();
  }
  // A sink that itself throws must never change the wrapper's answer.
  setProbeErrorSink(() => { throw new Error("sink is broken"); });
  try {
    const job = { name: "honesty-sink-throws", enabled() { throw new Error("gate boom"); } };
    assert.equal(jobEnabled(job, {}, null), false);
    assert.ok(probeErrorFor("honesty-sink-throws"));
  } finally {
    setProbeErrorSink(null);
    clearProbeErrors();
  }
});

test("durable probe-error fold: applyProbeError accumulates and redacts; unknown jobs are ignored", () => {
  let stored = applyProbeError({}, { job: "patrol", probe: "nextDueAt", error: "no such table: x token=supersecretvalue123", at: 2000 });
  assert.equal(stored.patrol.count, 1);
  assert.equal(stored.patrol.probe, "nextDueAt");
  assert.ok(!stored.patrol.error.includes("supersecretvalue123"), "error text is redacted before it is persisted");
  stored = applyProbeError(stored, { job: "patrol", probe: "nextDueAt", error: "still broken", at: 3000 });
  assert.equal(stored.patrol.count, 2);
  assert.equal(stored.patrol.firstAt, 2000);
  assert.equal(stored.patrol.at, 3000);
  assert.deepEqual(applyProbeError(stored, { job: "not-a-job", probe: "enabled", error: "x", at: 1 }), stored);
  const cleared = clearPersistedProbeError(stored, "patrol");
  assert.equal(cleared.patrol, undefined);
});

test("health view exposes the recorded probe error on the job row, distinct from its tick state", () => {
  const stored = { patrol: { lastRunAt: 1000, lastSuccessAt: 1000, consecutiveFailures: 0 } };
  const facts = { patrol: { probe: "nextDueAt", error: "due scan exploded", at: 2000, firstAt: 2000, count: 3 } };
  const merged = mergeProbeErrorFacts(stored, facts);
  const row = jobHealthView(merged, 5000, null, null).jobs.find(job => job.name === "patrol");
  assert.ok(row.probeError, "the row must carry the probe error fact");
  assert.equal(row.probeError.probe, "nextDueAt");
  assert.equal(row.probeError.count, 3);
  assert.equal(row.probeError.at, new Date(2000).toISOString());
  // The tick grading is untouched by the fact (precedence is GC-1's).
  assert.equal(row.status, "ok");
});

test("a probe error older than the job's last recorded tick is not re-presented (the tick proves the probes ran)", () => {
  const stored = { patrol: { lastRunAt: 9000, lastSuccessAt: 9000, consecutiveFailures: 0 } };
  const facts = { patrol: { probe: "enabled", error: "old boom", at: 2000, firstAt: 2000, count: 1 } };
  const merged = mergeProbeErrorFacts(stored, facts);
  const row = jobHealthView(merged, 10000, null, null).jobs.find(job => job.name === "patrol");
  assert.equal(row.probeError, null);
});

// ---------- R-6: unrecorded-tick counter ----------

test("unrecorded tick counter increments durably, retries a flaky write, and never throws", async () => {
  const storage = memoryStorage();
  assert.equal(await readUnrecordedTicks(storage), 0);
  assert.equal(await incrementUnrecordedTicks(storage), 1);
  assert.equal(await incrementUnrecordedTicks(storage), 2);
  assert.equal(await readUnrecordedTicks(storage), 2);
  assert.equal(storage.map.get(UNRECORDED_TICKS_STORAGE_KEY), 2);

  let failuresLeft = 1;
  const flaky = memoryStorage({
    async put(key, value) {
      if (key === UNRECORDED_TICKS_STORAGE_KEY && failuresLeft > 0) { failuresLeft -= 1; throw new Error("put flaked"); }
      this.map.set(key, structuredClone(value));
    }
  });
  assert.equal(await incrementUnrecordedTicks(flaky), 1, "one retry absorbs a single flaky write");

  const dead = { async get() { throw new Error("storage down"); }, async put() { throw new Error("storage down"); } };
  assert.equal(await incrementUnrecordedTicks(dead), null, "a dead counter write reports null instead of throwing");
  assert.equal(await readUnrecordedTicks(dead), 0);
});

test("recordCronTick counts its own recording failure before rethrowing", async () => {
  const storage = memoryStorage({
    async put(key, value) {
      if (key === HEARTBEAT_STORAGE_KEY) throw new Error("heartbeat put failed");
      this.map.set(key, structuredClone(value));
    }
  });
  const self = {
    ctx: { storage },
    channelDrainOutcomeReported: null,
    channelDrainOutcome: null,
    channelDrainOutcomeHeld: null
  };
  const outcomes = [{ job: "patrol", ok: true, at: Date.now() }];
  await assert.rejects(() => ProjectRoom.prototype.recordCronTick.call(self, outcomes), /heartbeat put failed/);
  assert.equal(storage.map.get(UNRECORDED_TICKS_STORAGE_KEY), 1, "the lost tick record is itself recorded");
  await assert.rejects(() => ProjectRoom.prototype.recordCronTick.call(self, outcomes), /heartbeat put failed/);
  assert.equal(storage.map.get(UNRECORDED_TICKS_STORAGE_KEY), 2);

  // A successful record does not touch the counter.
  const good = memoryStorage();
  const goodSelf = { ctx: { storage: good }, channelDrainOutcomeReported: null, channelDrainOutcome: null, channelDrainOutcomeHeld: null };
  await ProjectRoom.prototype.recordCronTick.call(goodSelf, outcomes);
  assert.equal(good.map.has(UNRECORDED_TICKS_STORAGE_KEY), false);
});

test("health view carries unrecordedTicks at the top level", () => {
  assert.equal(jobHealthView({}, Date.now(), null, null).unrecordedTicks, 0);
  assert.equal(jobHealthView({}, Date.now(), null, null, { unrecordedTicks: 4 }).unrecordedTicks, 4);
  assert.equal(jobHealthView({}, Date.now(), null, null, { unrecordedTicks: -1 }).unrecordedTicks, 0);
});
