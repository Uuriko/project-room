// F012: quarterly storage-failure drills tests.
//
// Pure unit tests over the module's own API with an injected fake harness
// (fake storage + fake chaos injector + fake clock, in the F024 vocabulary):
// catalog shape, quarterly scheduling rotation, each scenario's pass path,
// pass/fail boundaries for RPO / RTO / partial-state leakage, harness and
// timeline validation errors, and the graded report shape.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DRILL_OWNERS,
  DRILL_CATALOG,
  SCENARIO_CORRUPTED_READS,
  SCENARIO_DROPPED_WRITES,
  SCENARIO_NAMES,
  SCENARIO_PARTIAL_PARTITION,
  SCENARIO_TOTAL_STORE_LOSS,
  SCENARIO_WRITE_LATENCY_SPIKE,
  evaluateDrill,
  getScenario,
  planQuarterlyDrills,
  runDrill
} from "../src/storage-failure-drills.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = 1_757_000_000_000; // fixed injectable clock (ms)

// Injected fake for the storage + chaos + clock harness the module expects.
// The fake clock only moves when the harness moves it (latency injection),
// so every timeline timestamp is deterministic.
function makeHarness() {
  const store = new Map();
  const faults = {
    killAt: Infinity,
    writeCount: 0,
    corrupt: new Set(),
    latencyMs: 0,
    partitioned: new Set()
  };
  const clock = {
    t: START,
    now() {
      return this.t;
    },
    advance(ms) {
      this.t += ms;
    }
  };
  const storage = {
    write(key, value) {
      faults.writeCount += 1;
      if (faults.writeCount >= faults.killAt) {
        faults.killAt = Infinity; // one-shot: the killed write throws once
        throw new Error("chaos: write killed mid-flight");
      }
      if (faults.partitioned.has(key)) {
        throw new Error(`chaos: partition unreachable for ${key}`);
      }
      clock.advance(faults.latencyMs);
      const writtenAt = clock.now();
      store.set(key, { value, writtenAt });
      return { ok: true, writtenAt };
    },
    read(key) {
      if (faults.partitioned.has(key)) {
        throw new Error(`chaos: partition unreachable for ${key}`);
      }
      const row = store.get(key);
      if (row === undefined) return null;
      if (faults.corrupt.has(key)) {
        return { value: `CORRUPTED::${row.value}`, writtenAt: row.writtenAt };
      }
      return { value: row.value, writtenAt: row.writtenAt };
    },
    snapshot() {
      return new Map(store);
    },
    restore(snap) {
      store.clear();
      for (const [k, v] of snap) store.set(k, { value: v.value, writtenAt: v.writtenAt });
      return { restoredKeys: snap.size };
    }
  };
  const chaos = {
    killWrite(n) {
      faults.writeCount = 0;
      faults.killAt = n;
    },
    corruptRead(key) {
      faults.corrupt.add(key);
    },
    slowWrites(ms) {
      faults.latencyMs = ms;
    },
    partition(keys) {
      for (const k of keys) faults.partitioned.add(k);
    },
    wipe() {
      store.clear();
    },
    disarm() {
      faults.killAt = Infinity;
      faults.corrupt.clear();
      faults.latencyMs = 0;
      faults.partitioned.clear();
    }
  };
  return { storage, chaos, clock };
}

const ofType = (timeline, type) => timeline.filter((e) => e.type === type);

test("catalog lists the five scenarios with RPO/RTO expectations", () => {
  assert.equal(DRILL_CATALOG.length, 5);
  assert.deepEqual(DRILL_CATALOG.map((s) => s.name), SCENARIO_NAMES);
  assert.equal(new Set(SCENARIO_NAMES).size, 5); // no duplicate names
  for (const s of DRILL_CATALOG) {
    assert.ok(typeof s.title === "string" && s.title.length > 0, `${s.name} title`);
    assert.ok(typeof s.description === "string" && s.description.length > 0, `${s.name} description`);
    assert.ok(typeof s.recovery.action === "string" && s.recovery.action.length > 0, `${s.name} recovery action`);
    assert.ok(Number.isFinite(s.expectations.rpoMs) && s.expectations.rpoMs >= 0, `${s.name} rpoMs`);
    assert.ok(Number.isFinite(s.expectations.rtoMs) && s.expectations.rtoMs > 0, `${s.name} rtoMs`);
  }
  // Spot-check the F002-spirit targets: non-destructive scenarios lose
  // nothing; total loss is bounded by the hourly backup.
  assert.equal(getScenario(SCENARIO_DROPPED_WRITES).expectations.rpoMs, 0);
  assert.equal(getScenario(SCENARIO_CORRUPTED_READS).expectations.rpoMs, 0);
  assert.equal(getScenario(SCENARIO_WRITE_LATENCY_SPIKE).expectations.rpoMs, 0);
  assert.equal(getScenario(SCENARIO_PARTIAL_PARTITION).expectations.rpoMs, 0);
  assert.equal(getScenario(SCENARIO_TOTAL_STORE_LOSS).expectations.rpoMs, HOUR);
  assert.equal(getScenario(SCENARIO_TOTAL_STORE_LOSS).expectations.rtoMs, 30 * MIN);

  assert.equal(getScenario(SCENARIO_DROPPED_WRITES).title, "Dropped writes");
  assert.throws(() => getScenario("nope"), TypeError);
  assert.throws(() => getScenario(""), TypeError);
  assert.throws(() => getScenario(undefined), TypeError);
});

test("planQuarterlyDrills schedules four distinct scenarios on second Wednesdays", () => {
  const plan = planQuarterlyDrills(2026);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((s) => s.quarter), [1, 2, 3, 4]);
  // No repeats within the year.
  assert.equal(new Set(plan.map((s) => s.scenario)).size, 4);
  for (const slot of plan) {
    assert.match(slot.drillId, /^F012-2026-Q[1-4]$/);
    assert.equal(slot.year, 2026);
    assert.ok(SCENARIO_NAMES.includes(slot.scenario), `known scenario ${slot.scenario}`);
    assert.deepEqual(slot.ownersToNotify, DEFAULT_DRILL_OWNERS);
    const scenario = getScenario(slot.scenario);
    assert.equal(slot.rpoMs, scenario.expectations.rpoMs);
    assert.equal(slot.rtoMs, scenario.expectations.rtoMs);
    // Second Wednesday of the quarter's middle month, 14:00 UTC.
    const d = new Date(slot.scheduledAt);
    assert.equal(d.getUTCDay(), 3, `${slot.drillId} is a Wednesday`);
    assert.equal(d.getUTCHours(), 14, `${slot.drillId} at 14:00 UTC`);
    assert.ok(d.getUTCDate() >= 8 && d.getUTCDate() <= 14, `${slot.drillId} is the second Wednesday`);
  }
  // Feb, May, Aug, Nov are the quarter middle months.
  assert.deepEqual(plan.map((s) => new Date(s.scheduledAt).getUTCMonth()), [1, 4, 7, 10]);
  // Slots are chronological.
  for (let i = 1; i < plan.length; i += 1) {
    assert.ok(plan[i].scheduledAt > plan[i - 1].scheduledAt);
  }
});

test("planQuarterlyDrills rotates scenarios by year", () => {
  const a = planQuarterlyDrills(2026).map((s) => s.scenario);
  const b = planQuarterlyDrills(2027).map((s) => s.scenario);
  assert.notDeepEqual(a, b); // 2026 % 5 !== 2027 % 5: different rotation
  // Same rotation offset five years apart (both start at SCENARIO_NAMES[1]).
  assert.deepEqual(a, planQuarterlyDrills(2031).map((s) => s.scenario));
  assert.equal(a[0], SCENARIO_NAMES[2026 % SCENARIO_NAMES.length]);
  // Still no repeats within any rotated year.
  for (const year of [2027, 2028, 2029, 2030]) {
    const scenarios = planQuarterlyDrills(year).map((s) => s.scenario);
    assert.equal(new Set(scenarios).size, 4, `no repeats in ${year}`);
  }
});

test("planQuarterlyDrills validates year and owners", () => {
  for (const bad of [1999, 2101, 2026.5, NaN, Infinity, "2026", null, undefined, {}]) {
    assert.throws(() => planQuarterlyDrills(bad), TypeError, `year=${String(bad)}`);
  }
  const custom = planQuarterlyDrills(2026, { owners: ["storage-oncall"] });
  assert.deepEqual(custom[0].ownersToNotify, ["storage-oncall"]);
  assert.deepEqual(custom[3].ownersToNotify, ["storage-oncall"]);
  for (const badOwners of [[], [""], ["  "], [42], "storage-oncall", null]) {
    assert.throws(() => planQuarterlyDrills(2026, { owners: badOwners }), TypeError);
  }
  // Owners are copied: mutating one plan's list never touches the defaults.
  const plan = planQuarterlyDrills(2026);
  plan[0].ownersToNotify.push("intruder");
  assert.deepEqual(planQuarterlyDrills(2026)[0].ownersToNotify, DEFAULT_DRILL_OWNERS);
});

test("runDrill executes dropped-writes: kill observed, no residue, retry commits", () => {
  const { timeline, summary, scenario } = runDrill(SCENARIO_DROPPED_WRITES, makeHarness());
  assert.equal(scenario, SCENARIO_DROPPED_WRITES);
  const types = timeline.map((e) => e.type);
  for (const expected of ["start", "inject", "fault-detected", "recover:start", "recover:complete", "verify", "end"]) {
    assert.ok(types.includes(expected), `timeline has ${expected}`);
  }
  const writes = ofType(timeline, "write").filter((w) => w.key === "drill:probe:retry");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].ok, false); // the killed write
  assert.equal(writes[1].ok, true); // the retry after disarm
  // No residue: the key reads back missing right after the kill.
  const reads = ofType(timeline, "read").filter((r) => r.key === "drill:probe:retry");
  assert.ok(reads.some((r) => r.ok && r.value === null), "killed write left no residue");
  const detected = ofType(timeline, "fault-detected")[0];
  assert.equal(detected.kind, "write-killed");
  assert.equal(summary.faultObserved, true);
  assert.equal(summary.writesSucceeded, summary.writesAttempted - 1);

  const report = evaluateDrill(timeline, SCENARIO_DROPPED_WRITES);
  assert.equal(report.verdict, "pass");
  assert.equal(report.passed, true);
  assert.ok(report.findings.every((f) => f.pass), "all findings pass");
});

test("runDrill executes corrupted-reads: every corruption detected, none served", () => {
  const { timeline } = runDrill(SCENARIO_CORRUPTED_READS, makeHarness());
  const detected = ofType(timeline, "fault-detected")[0];
  assert.equal(detected.kind, "corruption-detected");
  assert.equal(detected.keys.length, 2);
  const summary = ofType(timeline, "read").filter((r) => r.corrupted);
  assert.equal(summary.length, 2);
  assert.ok(summary.every((r) => r.detectedCorruption), "every corruption detected");
  const report = evaluateDrill(timeline, SCENARIO_CORRUPTED_READS);
  assert.equal(report.verdict, "pass");
  assert.equal(report.metrics.corruptedReadsDetected, 2);
  assert.equal(report.metrics.partialLeakCount, 0);
});

test("runDrill executes write-latency-spike: alert trips, latency recovers", () => {
  const { timeline, summary } = runDrill(SCENARIO_WRITE_LATENCY_SPIKE, makeHarness());
  assert.equal(summary.maxWriteLatencyMs, 5000);
  const detected = ofType(timeline, "fault-detected")[0];
  assert.equal(detected.kind, "latency-spike");
  assert.equal(detected.maxLatencyMs, 5000);
  assert.equal(detected.thresholdMs, 1000);
  const recovered = ofType(timeline, "recover:complete")[0];
  assert.equal(recovered.recoveredMaxLatencyMs, 0);
  const report = evaluateDrill(timeline, SCENARIO_WRITE_LATENCY_SPIKE);
  assert.equal(report.verdict, "pass");
  assert.equal(report.metrics.dataLossMs, 0);
});

test("runDrill executes partial-partition: partitioned keys fail fast, heal clean", () => {
  const { timeline } = runDrill(SCENARIO_PARTIAL_PARTITION, makeHarness());
  const failedReads = ofType(timeline, "read").filter((r) => !r.ok);
  assert.equal(failedReads.length, 2);
  const detected = ofType(timeline, "fault-detected")[0];
  assert.equal(detected.kind, "partition");
  assert.equal(detected.keys.length, 2);
  // The healthy key and the retry key kept working through the partition.
  assert.ok(ofType(timeline, "read").some((r) => r.key === "drill:probe:c" && r.ok));
  const report = evaluateDrill(timeline, SCENARIO_PARTIAL_PARTITION);
  assert.equal(report.verdict, "pass");
});

test("runDrill executes total-store-loss: snapshot restores, post-backup history lost within RPO", () => {
  const { timeline } = runDrill(SCENARIO_TOTAL_STORE_LOSS, makeHarness());
  assert.equal(ofType(timeline, "snapshot").length, 1);
  const detected = ofType(timeline, "fault-detected")[0];
  assert.equal(detected.kind, "total-loss");
  const recovered = ofType(timeline, "recover:complete")[0];
  assert.equal(recovered.restoredKeys, 3);
  const verifies = ofType(timeline, "verify");
  const baseline = verifies.filter((v) => v.baseline);
  assert.ok(baseline.length === 3 && baseline.every((v) => v.status === "ok"), "seeded keys restored");
  const postSnapshot = verifies.filter((v) => !v.baseline);
  assert.ok(postSnapshot.length === 2 && postSnapshot.every((v) => v.status === "lost"), "post-backup writes lost");

  const report = evaluateDrill(timeline, SCENARIO_TOTAL_STORE_LOSS);
  assert.equal(report.verdict, "pass");
  assert.ok(report.metrics.dataLossMs <= report.rpoMs, "loss within hourly RPO");
  assert.deepEqual(report.metrics.lostKeys.sort(), ["drill:post-snapshot:a", "drill:post-snapshot:b"]);
});

test("evaluateDrill fails when data loss exceeds RPO", () => {
  const snapshotAt = 10;
  const timeline = [
    { t: 0, type: "start", scenario: SCENARIO_TOTAL_STORE_LOSS },
    { t: snapshotAt, type: "snapshot", at: snapshotAt, keys: 3 },
    { t: 20, type: "write", key: "post", ok: true, latencyMs: 0, writtenAt: 20 },
    { t: 30, type: "inject", fault: "wipe", params: {} },
    { t: 40, type: "fault-detected", kind: "total-loss", missingKeys: ["a", "b", "c"] },
    { t: 50, type: "recover:start", action: "restore-from-snapshot" },
    { t: 60, type: "recover:complete", restoredKeys: 3 },
    { t: 70, type: "verify", key: "a", status: "ok", detected: true, writtenAt: 5, snapshotAt, baseline: true },
    // Two hours of post-backup history lost: beyond the hourly RPO.
    { t: 71, type: "verify", key: "post", status: "lost", detected: true, writtenAt: snapshotAt + 2 * HOUR, snapshotAt, baseline: false },
    { t: 80, type: "end" }
  ];
  const report = evaluateDrill(timeline, SCENARIO_TOTAL_STORE_LOSS);
  assert.equal(report.verdict, "fail");
  assert.equal(report.passed, false);
  assert.equal(report.metrics.dataLossMs, 2 * HOUR);
  const rpoFinding = report.findings.find((f) => f.check === "data-loss-within-rpo");
  assert.equal(rpoFinding.pass, false);
  // Everything else still passes: the failure is precisely the RPO breach.
  assert.equal(report.findings.filter((f) => f.pass).length, 4);
});

test("evaluateDrill fails when recovery exceeds RTO", () => {
  const detectedAt = 30;
  const timeline = [
    { t: 0, type: "start", scenario: SCENARIO_DROPPED_WRITES },
    { t: 5, type: "write", key: "drill:probe:a", ok: true, latencyMs: 0, writtenAt: 5 },
    { t: 10, type: "inject", fault: "killWrite", params: { n: 1 } },
    { t: 20, type: "write", key: "drill:probe:retry", ok: false, latencyMs: 0, attemptedValue: "v", error: "killed" },
    { t: detectedAt, type: "fault-detected", kind: "write-killed", key: "drill:probe:retry" },
    { t: 40, type: "recover:start", action: "disarm-and-retry" },
    // Recovery lands 6 minutes after detection: beyond the 5-minute RTO.
    { t: detectedAt + 6 * MIN, type: "recover:complete" },
    { t: detectedAt + 6 * MIN + 1, type: "verify", key: "drill:probe:a", status: "ok", detected: true, writtenAt: 5, baseline: true },
    { t: detectedAt + 6 * MIN + 2, type: "end" }
  ];
  const report = evaluateDrill(timeline, SCENARIO_DROPPED_WRITES);
  assert.equal(report.verdict, "fail");
  assert.equal(report.metrics.recoveryMs, 6 * MIN);
  const rtoFinding = report.findings.find((f) => f.check === "recovery-within-rto");
  assert.equal(rtoFinding.pass, false);
  // Boundary: exactly at the RTO still passes.
  const onTime = timeline.map((e) =>
    e.type === "recover:complete" || e.type === "end" || e.type === "verify"
      ? { ...e, t: e.t - MIN }
      : e
  );
  assert.equal(evaluateDrill(onTime, SCENARIO_DROPPED_WRITES).verdict, "pass");
});

test("evaluateDrill fails on partial-state leakage", () => {
  // Case 1: a corrupted read consumed without detection.
  const silentCorruption = [
    { t: 0, type: "start", scenario: SCENARIO_CORRUPTED_READS },
    { t: 10, type: "inject", fault: "corruptRead", params: { keys: ["a"] } },
    { t: 20, type: "read", key: "a", ok: true, value: "CORRUPTED::x", corrupted: true, detectedCorruption: false, expectedKnown: true },
    { t: 30, type: "fault-detected", kind: "corruption-detected", keys: ["a"] },
    { t: 40, type: "recover:start", action: "disarm-and-refetch" },
    { t: 50, type: "recover:complete" },
    { t: 60, type: "verify", key: "a", status: "ok", detected: true, writtenAt: 5, baseline: true },
    { t: 70, type: "end" }
  ];
  const leaked = evaluateDrill(silentCorruption, SCENARIO_CORRUPTED_READS);
  assert.equal(leaked.verdict, "fail");
  assert.equal(leaked.metrics.partialLeakCount, 1);
  assert.equal(leaked.findings.find((f) => f.check === "no-partial-state-leakage").pass, false);

  // Case 2: a failed write whose value later became readable (partial apply).
  const partialApply = [
    { t: 0, type: "start", scenario: SCENARIO_DROPPED_WRITES },
    { t: 10, type: "write", key: "k", ok: false, latencyMs: 0, attemptedValue: "newval", error: "killed" },
    { t: 20, type: "read", key: "k", ok: true, value: "newval", corrupted: false, detectedCorruption: false, expectedKnown: false },
    { t: 30, type: "fault-detected", kind: "write-killed", key: "k" },
    { t: 40, type: "recover:start", action: "disarm-and-retry" },
    { t: 50, type: "recover:complete" },
    { t: 60, type: "verify", key: "k", status: "ok", detected: true, writtenAt: 50, baseline: true },
    { t: 70, type: "end" }
  ];
  const partial = evaluateDrill(partialApply, SCENARIO_DROPPED_WRITES);
  assert.equal(partial.verdict, "fail");
  assert.equal(partial.metrics.partialLeakCount, 1);
});

test("evaluateDrill fails a drill whose fault was never observed", () => {
  const timeline = [
    { t: 0, type: "start", scenario: SCENARIO_DROPPED_WRITES },
    { t: 10, type: "inject", fault: "killWrite", params: { n: 1 } },
    // No fault-detected event: the injector never actually faulted.
    { t: 20, type: "write", key: "k", ok: true, latencyMs: 0, writtenAt: 20 },
    { t: 30, type: "recover:start", action: "disarm-and-retry" },
    { t: 40, type: "recover:complete" },
    { t: 50, type: "verify", key: "k", status: "ok", detected: true, writtenAt: 20, baseline: true },
    { t: 60, type: "end" }
  ];
  const report = evaluateDrill(timeline, SCENARIO_DROPPED_WRITES);
  assert.equal(report.verdict, "fail");
  assert.equal(report.findings.find((f) => f.check === "fault-observed").pass, false);
});

test("runDrill and evaluateDrill validate their inputs", () => {
  const harness = makeHarness();
  assert.throws(() => runDrill("nope", harness), TypeError);
  assert.throws(() => runDrill(SCENARIO_DROPPED_WRITES, {}), TypeError);
  assert.throws(() => runDrill(SCENARIO_DROPPED_WRITES, { ...harness, storage: null }), TypeError);
  assert.throws(() => runDrill(SCENARIO_DROPPED_WRITES, { ...harness, storage: {} }), TypeError);
  assert.throws(() => runDrill(SCENARIO_DROPPED_WRITES, { ...harness, clock: null }), TypeError);
  assert.throws(() => runDrill(SCENARIO_DROPPED_WRITES, { ...harness, chaos: {} }), TypeError);
  // The scenario's chaos method must exist on the injector.
  assert.throws(
    () => runDrill(SCENARIO_DROPPED_WRITES, { ...harness, chaos: { disarm() {} } }),
    TypeError
  );
  // Total store loss needs the snapshot/restore storage surface.
  const { snapshot: _s, restore: _r, ...noSnapshot } = harness.storage;
  assert.throws(
    () => runDrill(SCENARIO_TOTAL_STORE_LOSS, { ...harness, storage: noSnapshot }),
    TypeError
  );

  const good = runDrill(SCENARIO_DROPPED_WRITES, makeHarness()).timeline;
  assert.throws(() => evaluateDrill("nope", good), TypeError);
  assert.throws(() => evaluateDrill(null, SCENARIO_DROPPED_WRITES), TypeError);
  assert.throws(() => evaluateDrill([], SCENARIO_DROPPED_WRITES), TypeError);
  assert.throws(() => evaluateDrill("not-an-array", SCENARIO_DROPPED_WRITES), TypeError);
  assert.throws(
    () => evaluateDrill([{ type: "start" }], SCENARIO_DROPPED_WRITES),
    TypeError
  );
  assert.throws(
    () => evaluateDrill([{ t: NaN, type: "start" }], SCENARIO_DROPPED_WRITES),
    TypeError
  );
});

test("graded report carries the full drill verdict shape", () => {
  const { timeline } = runDrill(SCENARIO_PARTIAL_PARTITION, makeHarness());
  const report = evaluateDrill(timeline, SCENARIO_PARTIAL_PARTITION);
  assert.equal(report.scenario, SCENARIO_PARTIAL_PARTITION);
  assert.equal(report.verdict, "pass");
  assert.equal(report.passed, true);
  assert.equal(report.rpoMs, 0);
  assert.equal(report.rtoMs, 15 * MIN);
  for (const key of [
    "dataLossMs",
    "recoveryMs",
    "partialLeakCount",
    "writesAttempted",
    "writesSucceeded",
    "readsAttempted",
    "readsOk",
    "corruptedReadsDetected",
    "maxWriteLatencyMs",
    "lostKeys"
  ]) {
    assert.ok(key in report.metrics, `metrics.${key}`);
  }
  assert.deepEqual(report.metrics.lostKeys, []);
  assert.equal(report.findings.length, 5);
  assert.deepEqual(
    report.findings.map((f) => f.check),
    ["fault-observed", "data-loss-within-rpo", "recovery-within-rto", "no-partial-state-leakage", "baseline-recoverable"]
  );
  assert.ok(report.findings.every((f) => typeof f.detail === "string" && f.detail.length > 0));
  assert.ok(report.timeline.eventCount > 0);
  assert.ok(report.timeline.durationMs >= 0);
});
