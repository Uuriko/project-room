// Attempt-before-run heartbeat (integrity-staleness cure, part 1).
//
// Diagnosis (record t-20261101-154): since 2026-10-31T19:00:35Z the
// production integrity run has died inside its own Durable Object
// invocation before recordCronTick committed any outcome, so the stored
// heartbeat kept presenting the 19:00Z success as current — failures 0,
// no error, only the 3x-period staleness line eventually moved. The cure
// commits an attempt for a slow job BEFORE its body runs; a run that
// never reaches the outcome fold leaves attemptOutcome 'uncommitted'
// behind, and the health view grades an uncommitted streak older than
// one period as failing instead of as the previous success.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEARTBEAT_STORAGE_KEY, applyAttempts, applyOutcomes, jobHealthView
} from "../cloudflare/job-heartbeat.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const T0 = 1_800_000_000_000; // arbitrary fixed epoch ms; all clocks below are explicit
const INTEGRITY_PERIOD_MS = 3600_000;

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "room-job-heartbeat-attempt-"));
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

function memoryStorage() {
  const map = new Map();
  return { map, async get(key) { return structuredClone(map.get(key)); }, async put(key, value) { map.set(key, structuredClone(value)); } };
}

function healthyIntegrity(at = T0) {
  return applyOutcomes({}, [{ job: "integrity", ok: true, at, durationMs: 12, summary: { checked: 1 } }]);
}

test("applyAttempts records an attempt without touching run or success fields", () => {
  const before = healthyIntegrity();
  const after = applyAttempts(before, [{ job: "integrity", at: T0 + 60_000 }]);
  assert.equal(after.integrity.lastAttemptAt, T0 + 60_000);
  assert.equal(after.integrity.attemptOutcome, "uncommitted");
  assert.equal(after.integrity.uncommittedAttemptSinceAt, T0 + 60_000);
  assert.equal(after.integrity.lastRunAt, T0, "an attempt is not a run");
  assert.equal(after.integrity.lastSuccessAt, T0, "an attempt must not freshen the success clock");
  assert.equal(after.integrity.consecutiveFailures, 0);
  assert.equal(after.integrity.lastSummaryAt, T0);
});

test("applyAttempts on a never-run job creates no run or success fields", () => {
  const after = applyAttempts({}, [{ job: "integrity", at: T0 }]);
  assert.equal(after.integrity.lastAttemptAt, T0);
  assert.equal(after.integrity.attemptOutcome, "uncommitted");
  assert.equal("lastRunAt" in after.integrity, false);
  assert.equal("lastSuccessAt" in after.integrity, false);
});

test("an uncommitted attempt streak keeps the first attempt's time and the newest attempt's ID", () => {
  let stored = healthyIntegrity();
  stored = applyAttempts(stored, [{ job: "integrity", at: T0 + 60_000, attemptId: "attempt-1" }]);
  stored = applyAttempts(stored, [{ job: "integrity", at: T0 + 120_000, attemptId: "attempt-2" }]);
  assert.equal(stored.integrity.lastAttemptAt, T0 + 120_000, "the latest attempt is the freshest stamp");
  assert.equal(stored.integrity.lastAttemptId, "attempt-2", "the current attempt is the newest one");
  assert.equal(stored.integrity.uncommittedAttemptSinceAt, T0 + 60_000, "the streak still began at the first died attempt");
});

test("a committed outcome — success or failure — resolves the attempt only on an exact ID match", () => {
  let stored = applyAttempts(healthyIntegrity(), [{ job: "integrity", at: T0 + 60_000, attemptId: "attempt-1" }]);
  stored = applyOutcomes(stored, [{ job: "integrity", ok: true, at: T0 + 65_000, attemptId: "attempt-1", durationMs: 9, summary: { checked: 2 } }]);
  assert.equal(stored.integrity.attemptOutcome, "committed");
  assert.equal(stored.integrity.uncommittedAttemptSinceAt, null);
  assert.equal(stored.integrity.lastAttemptAt, T0 + 60_000, "lastAttemptAt stays the attempt's start, not the outcome's");
  assert.equal(stored.integrity.lastSuccessAt, T0 + 65_000);

  let failed = applyAttempts(healthyIntegrity(), [{ job: "integrity", at: T0 + 60_000, attemptId: "attempt-1" }]);
  failed = applyOutcomes(failed, [{ job: "integrity", ok: false, at: T0 + 60_000, attemptId: "attempt-1", error: "boom" }]);
  assert.equal(failed.integrity.attemptOutcome, "committed", "a run that reports failure did commit — it is not a died attempt");
  assert.equal(failed.integrity.consecutiveFailures, 1);

  let unthreaded = applyAttempts(healthyIntegrity(), [{ job: "integrity", at: T0 + 60_000, attemptId: "attempt-1" }]);
  unthreaded = applyOutcomes(unthreaded, [{ job: "integrity", ok: true, at: T0 + 60_000, durationMs: 9, summary: { checked: 2 } }]);
  assert.equal(unthreaded.integrity.attemptOutcome, "uncommitted", "an outcome carrying no attempt ID cannot resolve an attempt");

  let mismatched = applyAttempts(healthyIntegrity(), [{ job: "integrity", at: T0 + 60_000, attemptId: "attempt-1" }]);
  mismatched = applyOutcomes(mismatched, [{ job: "integrity", ok: true, at: T0 + 60_000, attemptId: "attempt-0", durationMs: 9, summary: { checked: 2 } }]);
  assert.equal(mismatched.integrity.attemptOutcome, "uncommitted", "an outcome from a different attempt cannot resolve this one");
  assert.equal(mismatched.integrity.uncommittedAttemptSinceAt, T0 + 60_000);
});

test("an older completion arriving after a newer attempt began leaves the newer attempt intact and uncommitted", () => {
  // Pass 1 commits attempt-1 and its run stays in flight; pass 2 commits
  // attempt-2; only then does pass 1's completion land. The stale
  // completion must not stamp attempt-2 committed or clear the streak.
  let stored = healthyIntegrity();
  stored = applyAttempts(stored, [{ job: "integrity", at: T0 + 60_000, attemptId: "attempt-1" }]);
  stored = applyAttempts(stored, [{ job: "integrity", at: T0 + 120_000, attemptId: "attempt-2" }]);
  stored = applyOutcomes(stored, [{ job: "integrity", ok: true, at: T0 + 60_000, attemptId: "attempt-1", durationMs: 9, summary: { checked: 2 } }]);
  assert.equal(stored.integrity.attemptOutcome, "uncommitted", "the newer attempt was not erased by the older completion");
  assert.equal(stored.integrity.lastAttemptId, "attempt-2");
  assert.equal(stored.integrity.lastAttemptAt, T0 + 120_000, "the newer attempt's start stands");
  assert.equal(stored.integrity.uncommittedAttemptSinceAt, T0 + 60_000, "the unbroken streak still began at attempt-1");
  const died = jobHealthView(stored, T0 + 60_000 + INTEGRITY_PERIOD_MS + 1_000).jobs.find(job => job.name === "integrity");
  assert.equal(died.status, "failing", "the view still grades the uncommitted streak — the stale completion did not silence it");
});

test("jobHealthView grades an uncommitted attempt older than one period as failing, never as the previous success", () => {
  let stored = healthyIntegrity();
  const attemptAt = T0 + 60_000;
  stored = applyAttempts(stored, [{ job: "integrity", at: attemptAt }]);

  const inflight = jobHealthView(stored, attemptAt + 30_000).jobs.find(job => job.name === "integrity");
  assert.equal(inflight.attemptOutcome, "uncommitted", "the attempt is visible immediately");
  assert.equal(inflight.lastAttemptAt, new Date(attemptAt).toISOString());
  assert.equal(inflight.status, "ok", "an attempt still inside its first period may be running");

  const viewAt = attemptAt + INTEGRITY_PERIOD_MS + 1_000; // success age here is 3661s: past one period, short of the 3x stale line
  const died = jobHealthView(stored, viewAt).jobs.find(job => job.name === "integrity");
  assert.equal(died.status, "failing");
  assert.equal(died.consecutiveFailures, 0, "the grade comes from the died attempt, not a falsified failure count");
  assert.equal(died.lastSuccessAt, new Date(T0).toISOString(), "the previous success keeps its real age");
  assert.equal(died.attemptOutcome, "uncommitted");
});

test("jobHealthView distinguishes never-attempted from attempted-and-died", () => {
  const never = jobHealthView({}, T0).jobs.find(job => job.name === "integrity");
  assert.equal(never.lastAttemptAt, null);
  assert.equal(never.attemptOutcome, null);
});

test("a sibling slow job's success record is unchanged apart from the additive attempt fields", () => {
  const outcome = { job: "retention", ok: true, at: T0 + 5_000, attemptId: "attempt-1", durationMs: 7, summary: { checked: 2 } };
  const baseline = applyOutcomes({}, [outcome]).retention;
  const withAttempt = applyOutcomes(applyAttempts({}, [{ job: "retention", at: T0 + 5_000, attemptId: "attempt-1" }]), [outcome]).retention;
  const stripped = { ...withAttempt };
  delete stripped.lastAttemptAt;
  delete stripped.lastAttemptId;
  delete stripped.attemptOutcome;
  delete stripped.uncommittedAttemptSinceAt;
  assert.deepEqual(stripped, baseline, "every pre-existing field on the success path is identical");
  assert.equal(withAttempt.attemptOutcome, "committed");
});

test("a job that never carries an attempt gains no attempt fields from its outcomes", () => {
  const stored = applyOutcomes({}, [{ job: "land-queue", ok: true, at: T0, durationMs: 3, summary: { checked: 1 } }]);
  assert.equal("lastAttemptAt" in stored["land-queue"], false);
  assert.equal("attemptOutcome" in stored["land-queue"], false);
});

test("recordCronAttempt commits the attempt before the run; a run that never reports leaves the trace", async () => {
  const self = { ctx: { storage: memoryStorage() } };
  await ProjectRoom.prototype.recordCronTick.apply(self, [[{ job: "integrity", ok: true, at: T0, durationMs: 12, summary: { checked: 1 } }]]);
  // The next pass commits the attempt, then the job body is killed inside
  // its invocation: no outcome ever reaches recordCronTick.
  await ProjectRoom.prototype.recordCronAttempt.apply(self, ["integrity"]);
  const stored = await self.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
  assert.equal(stored.integrity.attemptOutcome, "uncommitted");
  assert.ok(Number.isFinite(stored.integrity.lastAttemptAt), "the killed run left an attempt stamp");
  assert.equal(stored.integrity.lastRunAt, T0, "success fields untouched by the attempt");
  assert.equal(stored.integrity.lastSuccessAt, T0);
  assert.equal(stored.integrity.consecutiveFailures, 0);
});

test("recordCronAttempt mints distinct IDs; a stale completion cannot resolve a newer attempt, the matching one can", async () => {
  const self = { ctx: { storage: memoryStorage() } };
  await ProjectRoom.prototype.recordCronTick.apply(self, [[{ job: "integrity", ok: true, at: T0, durationMs: 12, summary: { checked: 1 } }]]);
  const first = await ProjectRoom.prototype.recordCronAttempt.apply(self, ["integrity"]);
  const second = await ProjectRoom.prototype.recordCronAttempt.apply(self, ["integrity"]);
  assert.ok(typeof first.attemptId === "string" && first.attemptId.length > 0, "the attempt commit returns its ID for threading");
  assert.ok(typeof second.attemptId === "string" && second.attemptId.length > 0);
  assert.notEqual(first.attemptId, second.attemptId, "each attempt gets an exact, distinct ID");

  const afterSecondAttempt = await self.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
  const secondAttemptAt = afterSecondAttempt.integrity.lastAttemptAt;
  assert.ok(Number.isFinite(secondAttemptAt));

  // The first run's completion lands late, after the second attempt began.
  await ProjectRoom.prototype.recordCronTick.apply(self, [[{ job: "integrity", ok: true, at: T0 + 1_000, attemptId: first.attemptId, durationMs: 9, summary: { checked: 2 } }]]);
  let stored = await self.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
  assert.equal(stored.integrity.attemptOutcome, "uncommitted", "the stale completion left the newer attempt uncommitted");
  assert.equal(stored.integrity.lastAttemptId, second.attemptId);
  assert.equal(stored.integrity.lastAttemptAt, secondAttemptAt, "the newer attempt's start was not overwritten by the stale completion");

  // The second run's own completion resolves it.
  await ProjectRoom.prototype.recordCronTick.apply(self, [[{ job: "integrity", ok: true, at: T0 + 2_000, attemptId: second.attemptId, durationMs: 9, summary: { checked: 3 } }]]);
  stored = await self.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
  assert.equal(stored.integrity.attemptOutcome, "committed");
  assert.equal(stored.integrity.uncommittedAttemptSinceAt, null);
});
