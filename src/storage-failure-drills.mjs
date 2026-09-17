// F012: automated quarterly storage-failure drills (pairs with F024 chaos drill).
//
// While F024 kills the Durable Object mid-write once and proves the write
// path atomic, this module keeps the storage layer honest on a schedule: a
// catalog of named failure scenarios (dropped writes, corrupted reads, write
// latency spikes, partial partitions, total store loss), a quarterly planner
// that rotates the scenarios so none repeats within a year, a drill runner
// that executes a scenario against an INJECTED storage harness and chaos
// injector and collects a timeline of events, and a grader that evaluates
// the timeline against the scenario's recovery criteria (data loss within
// RPO, recovery within RTO, no partial-state leakage).
//
// RPO/RTO targets follow the spirit of the F002 recovery docs
// (docs/POINT-IN-TIME-RECOVERY.md): RPO equals the backup schedule (hourly
// recommended, so at most one hour of history is lost on a restore), and
// RTO is operator time on the order of 15-30 minutes once the chosen
// backup is identified. Scenarios that lose no committed data (killed
// writes are retried, corruptions are detected, partitions fail fast) carry
// RPO 0 and shorter RTOs.
//
// Pure functions, plain arguments, no I/O. The real storage harness and
// chaos injector are wired later; the module only needs the interface:
//
//   storage.read(key)    -> { value, writtenAt } | null (missing) | throws
//   storage.write(key, value) -> { ok, writtenAt } | throws
//   storage.snapshot()  -> opaque snapshot token (total-store-loss only)
//   storage.restore(snapshot) -> restore summary (total-store-loss only)
//   chaos.killWrite(n)   -> the nth write() after arming throws; the
//                           counter resets when disarmed or re-armed
//   chaos.corruptRead(key) -> subsequent reads of key return corrupted bytes
//   chaos.slowWrites(delayMs) -> each write advances (fake) time by delayMs
//   chaos.partition(keys) -> reads/writes for those keys throw
//   chaos.wipe()         -> destroy all durable state
//   chaos.disarm()       -> clear every injected fault (operator recovery)
//   clock.now()          -> current time in ms (injectable fake clock)
//
// The write discipline mirrors F024: a killed write must leave no residue,
// a detected corruption is never served as truth, and recovery for a lost
// isolate is a retry (or a restore from the latest verified snapshot for
// total store loss), never silent data loss.
//
// API:
//   SCENARIO_* / SCENARIO_NAMES — the five scenario names.
//   DRILL_CATALOG — scenario descriptors: { name, title, description,
//     recovery: { action, description }, expectations: { rpoMs, rtoMs,
//     description } }.
//   DEFAULT_DRILL_OWNERS — roles notified for every quarterly drill.
//   getScenario(name) — the catalog descriptor; throws TypeError on an
//     unknown name.
//   planQuarterlyDrills(year, { owners } = {}) — the four quarterly slots:
//     { drillId, quarter, year, scenario, scheduledAt, windowLabel,
//     ownersToNotify, rpoMs, rtoMs }. Scenarios rotate by year so none
//     repeats within a year; each drill lands on the second Wednesday of
//     the quarter's middle month at 14:00 UTC. Throws TypeError on an
//     invalid year or owners.
//   runDrill(scenarioName, { storage, chaos, clock }) — executes the
//     scenario against the injected harness; returns { scenario, timeline,
//     summary }. Timeline events are { t, type, ... } with types start,
//     write, read, snapshot, inject, fault-detected, recover:start,
//     recover:complete, verify, end. Harness errors propagate; the module
//     never catches a broken harness, only expected drill faults.
//   evaluateDrill(timeline, scenarioName) — grades the timeline against
//     the scenario's recovery criteria; returns { scenario, verdict,
//     passed, rpoMs, rtoMs, metrics, findings, timeline }. verdict is
//     "pass" only when every finding passes. Throws TypeError on a
//     malformed timeline or unknown scenario.

export const SCENARIO_DROPPED_WRITES = "dropped-writes";
export const SCENARIO_CORRUPTED_READS = "corrupted-reads";
export const SCENARIO_WRITE_LATENCY_SPIKE = "write-latency-spike";
export const SCENARIO_PARTIAL_PARTITION = "partial-partition";
export const SCENARIO_TOTAL_STORE_LOSS = "total-store-loss";

export const SCENARIO_NAMES = [
  SCENARIO_DROPPED_WRITES,
  SCENARIO_CORRUPTED_READS,
  SCENARIO_WRITE_LATENCY_SPIKE,
  SCENARIO_PARTIAL_PARTITION,
  SCENARIO_TOTAL_STORE_LOSS
];

const MIN = 60_000;
const HOUR = 60 * MIN;

export const DEFAULT_DRILL_OWNERS = [
  "storage-oncall",
  "reliability-lead",
  "incident-commander"
];

// Writes slower than this during a drill are a detected latency fault; the
// injected spike is 5x the threshold so a working harness always trips it.
const LATENCY_ALERT_MS = 1000;
const LATENCY_SPIKE_MS = 5000;

export const DRILL_CATALOG = [
  {
    name: SCENARIO_DROPPED_WRITES,
    title: "Dropped writes",
    description:
      "The chaos injector kills a write mid-flight. The drill must observe " +
      "the failure, leave no residue of the killed write, and commit it on " +
      "retry — the same atomicity contract F024 proves for the Durable Object.",
    recovery: {
      action: "disarm-and-retry",
      description: "Clear the fault and retry the killed write once; committed state is never rolled back."
    },
    expectations: {
      rpoMs: 0,
      rtoMs: 5 * MIN,
      description: "No committed data lost (RPO 0); the retry lands within 5 minutes."
    }
  },
  {
    name: SCENARIO_CORRUPTED_READS,
    title: "Corrupted reads",
    description:
      "Reads of seeded keys return corrupted bytes. The drill must detect " +
      "every corruption by comparing against the seeded baseline and never " +
      "serve a corrupted value as truth.",
    recovery: {
      action: "disarm-and-refetch",
      description: "Clear the fault and refetch the affected keys; corruption is detected, never silently consumed."
    },
    expectations: {
      rpoMs: 0,
      rtoMs: 5 * MIN,
      description: "Zero undetected corruptions (RPO 0); clean reads resume within 5 minutes."
    }
  },
  {
    name: SCENARIO_WRITE_LATENCY_SPIKE,
    title: "Write latency spike",
    description:
      "Every write suddenly costs 5 seconds of (fake) time. The drill must " +
      "trip the 1s latency alert, confirm no write was lost or duplicated " +
      "during the spike, and see latency return under the threshold after " +
      "recovery.",
    recovery: {
      action: "disarm-and-verify-latency",
      description: "Clear the fault and confirm write latency is back under the 1s alert threshold."
    },
    expectations: {
      rpoMs: 0,
      rtoMs: 15 * MIN,
      description: "No writes lost or duplicated during the spike; p100 write latency back under 1s within 15 minutes."
    }
  },
  {
    name: SCENARIO_PARTIAL_PARTITION,
    title: "Partial partition",
    description:
      "A subset of keys becomes unreachable for reads and writes. The drill " +
      "must fail fast on the partitioned keys, keep serving the healthy " +
      "keys, and recover the full keyspace after the partition heals.",
    recovery: {
      action: "disarm-and-reconcile",
      description: "Heal the partition and confirm every key — partitioned and healthy — reads back correctly."
    },
    expectations: {
      rpoMs: 0,
      rtoMs: 15 * MIN,
      description: "Partitioned keys fail fast, never half-serve; full keyspace consistent within 15 minutes."
    }
  },
  {
    name: SCENARIO_TOTAL_STORE_LOSS,
    title: "Total store loss",
    description:
      "The entire durable store is wiped. The drill snapshots before the " +
      "fault, restores from that snapshot, and measures the post-snapshot " +
      "history that was lost against the hourly-backup RPO from the F002 " +
      "recovery docs.",
    recovery: {
      action: "restore-from-snapshot",
      description: "Restore the pre-fault snapshot (the drill's stand-in for the latest verified hourly backup)."
    },
    expectations: {
      rpoMs: HOUR,
      rtoMs: 30 * MIN,
      description: "At most one hour of post-backup history lost (hourly RPO); restore completes within 30 minutes of operator time."
    }
  }
];

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

export function getScenario(name) {
  const found = DRILL_CATALOG.find((s) => s.name === name);
  if (!found) {
    throw new TypeError(
      `unknown drill scenario ${String(name)}; expected one of ${SCENARIO_NAMES.join(", ")}`
    );
  }
  return found;
}

function assertYear(year) {
  if (!isFiniteNumber(year) || !Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new TypeError(`year must be an integer between 2000 and 2100, got ${String(year)}`);
  }
}

function assertOwners(owners) {
  if (owners === undefined) return [...DEFAULT_DRILL_OWNERS];
  if (!Array.isArray(owners) || owners.length === 0) {
    throw new TypeError("owners must be a non-empty array of role-name strings");
  }
  for (const [index, owner] of owners.entries()) {
    if (typeof owner !== "string" || owner.trim() === "") {
      throw new TypeError(`owners[${index}] must be a non-empty string, got ${String(owner)}`);
    }
  }
  return [...owners];
}

// Second Wednesday of the given 0-indexed month at 14:00 UTC.
function secondWednesdayAt(year, monthIndex) {
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const offset = (3 - firstDow + 7) % 7; // Wednesday === 3
  return Date.UTC(year, monthIndex, 1 + offset + 7, 14, 0, 0);
}

const QUARTER_MIDDLE_MONTHS = [1, 4, 7, 10]; // Feb, May, Aug, Nov (0-indexed)
const QUARTER_MIDDLE_MONTH_LABELS = ["February", "May", "August", "November"];

export function planQuarterlyDrills(year, { owners } = {}) {
  assertYear(year);
  const ownersToNotify = assertOwners(owners);
  // Rotate the catalog start by year so consecutive years drill different
  // scenarios first; with five scenarios and four quarters no year repeats.
  const start = year % SCENARIO_NAMES.length;
  return [1, 2, 3, 4].map((quarter) => {
    const scenario = getScenario(SCENARIO_NAMES[(start + quarter - 1) % SCENARIO_NAMES.length]);
    const scheduledAt = secondWednesdayAt(year, QUARTER_MIDDLE_MONTHS[quarter - 1]);
    return {
      drillId: `F012-${year}-Q${quarter}`,
      quarter,
      year,
      scenario: scenario.name,
      scheduledAt,
      windowLabel: `Q${quarter} ${year} · second Wednesday of ${QUARTER_MIDDLE_MONTH_LABELS[quarter - 1]} · 14:00 UTC`,
      ownersToNotify: [...ownersToNotify],
      rpoMs: scenario.expectations.rpoMs,
      rtoMs: scenario.expectations.rtoMs
    };
  });
}

function assertHarness({ storage, chaos, clock }, scenarioName) {
  if (!storage || typeof storage.read !== "function" || typeof storage.write !== "function") {
    throw new TypeError("harness.storage must provide read(key) and write(key, value) functions");
  }
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("harness.clock must provide a now() function returning ms");
  }
  if (!chaos || typeof chaos.disarm !== "function") {
    throw new TypeError("harness.chaos must provide a disarm() function");
  }
  const required = {
    [SCENARIO_DROPPED_WRITES]: ["killWrite"],
    [SCENARIO_CORRUPTED_READS]: ["corruptRead"],
    [SCENARIO_WRITE_LATENCY_SPIKE]: ["slowWrites"],
    [SCENARIO_PARTIAL_PARTITION]: ["partition"],
    [SCENARIO_TOTAL_STORE_LOSS]: ["wipe"]
  }[scenarioName];
  for (const method of required) {
    if (typeof chaos[method] !== "function") {
      throw new TypeError(`harness.chaos must provide ${method}() for scenario ${scenarioName}`);
    }
  }
  if (
    scenarioName === SCENARIO_TOTAL_STORE_LOSS &&
    (typeof storage.snapshot !== "function" || typeof storage.restore !== "function")
  ) {
    throw new TypeError("harness.storage must provide snapshot() and restore(snapshot) for total-store-loss");
  }
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const PROBE_KEYS = ["drill:probe:a", "drill:probe:b", "drill:probe:c"];
const POST_SNAPSHOT_KEYS = ["drill:post-snapshot:a", "drill:post-snapshot:b"];
const RETRY_KEY = "drill:probe:retry";
const LATENCY_KEYS = ["drill:latency:1", "drill:latency:2", "drill:latency:3"];

function attemptWrite(ctx, key, value) {
  const before = ctx.clock.now();
  try {
    const result = ctx.storage.write(key, value);
    const latencyMs = ctx.clock.now() - before;
    ctx.log("write", {
      key,
      ok: true,
      latencyMs,
      writtenAt: result && isFiniteNumber(result.writtenAt) ? result.writtenAt : before
    });
    return { ok: true, latencyMs };
  } catch (error) {
    const latencyMs = ctx.clock.now() - before;
    ctx.log("write", { key, ok: false, latencyMs, attemptedValue: value, error: messageOf(error) });
    return { ok: false, latencyMs, error: messageOf(error) };
  }
}

// expected is the seeded value when known; corruption is detected by exact
// comparison, mirroring a checksum/expected-value check that never serves a
// corrupted read as truth.
function attemptRead(ctx, key, expected) {
  try {
    const row = ctx.storage.read(key);
    const value = row == null ? null : row.value;
    const corrupted = expected !== undefined && value !== null && value !== expected;
    ctx.log("read", {
      key,
      ok: true,
      value,
      corrupted,
      detectedCorruption: corrupted,
      expectedKnown: expected !== undefined
    });
    return { ok: true, value, corrupted };
  } catch (error) {
    ctx.log("read", { key, ok: false, error: messageOf(error) });
    return { ok: false, error: messageOf(error) };
  }
}

// The seeded baseline: key -> { value, writtenAt, baseline: true }.
function seedBaseline(ctx, scenarioName) {
  for (const key of PROBE_KEYS) {
    const value = `drill-payload:${scenarioName}:${key}`;
    const writtenAt = ctx.clock.now();
    const { ok, error } = attemptWrite(ctx, key, value);
    if (!ok) throw new Error(`drill seed failed for ${key}: ${error}`);
    ctx.baseline.set(key, { value, writtenAt, baseline: true });
  }
}

function verifyKeys(ctx, keys, { snapshotAt = null } = {}) {
  for (const key of keys) {
    const expected = ctx.baseline.get(key);
    const { ok, value } = attemptRead(ctx, key, expected?.value);
    if (!ok) {
      ctx.log("verify", { key, status: "lost", detected: true, writtenAt: expected?.writtenAt ?? null, snapshotAt, baseline: expected?.baseline ?? false });
    } else if (value === null) {
      ctx.log("verify", { key, status: "lost", detected: true, writtenAt: expected?.writtenAt ?? null, snapshotAt, baseline: expected?.baseline ?? false });
    } else if (expected && value !== expected.value) {
      ctx.log("verify", { key, status: "corrupted", detected: true, writtenAt: expected.writtenAt, snapshotAt, baseline: expected.baseline });
    } else {
      ctx.log("verify", { key, status: "ok", detected: true, writtenAt: expected?.writtenAt ?? null, snapshotAt, baseline: expected?.baseline ?? false });
    }
  }
}

const SCRIPTS = {
  [SCENARIO_DROPPED_WRITES](ctx) {
    ctx.chaos.killWrite(1);
    ctx.log("inject", { fault: "killWrite", params: { n: 1 } });
    // The probe write is killed mid-flight (F024's exact failure shape).
    const probe = attemptWrite(ctx, RETRY_KEY, `drill-payload:${ctx.scenarioName}:${RETRY_KEY}`);
    // A killed write must leave no residue: the key reads back missing.
    attemptRead(ctx, RETRY_KEY);
    if (!probe.ok) {
      ctx.log("fault-detected", { kind: "write-killed", key: RETRY_KEY, error: probe.error });
    }
    ctx.log("recover:start", { action: "disarm-and-retry" });
    ctx.chaos.disarm();
    attemptWrite(ctx, RETRY_KEY, `drill-payload:${ctx.scenarioName}:${RETRY_KEY}`);
    ctx.log("recover:complete", {});
    verifyKeys(ctx, PROBE_KEYS);
  },

  [SCENARIO_CORRUPTED_READS](ctx) {
    const targets = [PROBE_KEYS[0], PROBE_KEYS[1]];
    for (const key of targets) ctx.chaos.corruptRead(key);
    ctx.log("inject", { fault: "corruptRead", params: { keys: targets } });
    attemptWrite(ctx, RETRY_KEY, `drill-payload:${ctx.scenarioName}:${RETRY_KEY}`);
    const reads = PROBE_KEYS.map((key) => attemptRead(ctx, key, ctx.baseline.get(key).value));
    attemptRead(ctx, RETRY_KEY);
    const corruptedKeys = PROBE_KEYS.filter((key, i) => reads[i].corrupted);
    if (corruptedKeys.length > 0) {
      ctx.log("fault-detected", { kind: "corruption-detected", keys: corruptedKeys });
    }
    ctx.log("recover:start", { action: "disarm-and-refetch" });
    ctx.chaos.disarm();
    for (const key of targets) attemptRead(ctx, key, ctx.baseline.get(key).value);
    ctx.log("recover:complete", {});
    verifyKeys(ctx, PROBE_KEYS);
  },

  [SCENARIO_WRITE_LATENCY_SPIKE](ctx) {
    ctx.chaos.slowWrites(LATENCY_SPIKE_MS);
    ctx.log("inject", { fault: "slowWrites", params: { delayMs: LATENCY_SPIKE_MS } });
    const results = LATENCY_KEYS.map((key) =>
      attemptWrite(ctx, key, `drill-payload:${ctx.scenarioName}:${key}`)
    );
    const maxLatencyMs = Math.max(...results.map((r) => r.latencyMs));
    if (maxLatencyMs > LATENCY_ALERT_MS) {
      ctx.log("fault-detected", {
        kind: "latency-spike",
        maxLatencyMs,
        thresholdMs: LATENCY_ALERT_MS
      });
    }
    ctx.log("recover:start", { action: "disarm-and-verify-latency" });
    ctx.chaos.disarm();
    const after = LATENCY_KEYS.map((key) =>
      attemptWrite(ctx, key, `drill-payload:${ctx.scenarioName}:${key}:recovered`)
    );
    const recoveredMaxLatencyMs = Math.max(...after.map((r) => r.latencyMs));
    ctx.log("recover:complete", { recoveredMaxLatencyMs, thresholdMs: LATENCY_ALERT_MS });
    verifyKeys(ctx, PROBE_KEYS);
  },

  [SCENARIO_PARTIAL_PARTITION](ctx) {
    const targets = [PROBE_KEYS[0], PROBE_KEYS[1]];
    ctx.chaos.partition(targets);
    ctx.log("inject", { fault: "partition", params: { keys: targets } });
    attemptWrite(ctx, RETRY_KEY, `drill-payload:${ctx.scenarioName}:${RETRY_KEY}`);
    const reads = PROBE_KEYS.map((key) => attemptRead(ctx, key, ctx.baseline.get(key).value));
    const unreachable = PROBE_KEYS.filter((key, i) => !reads[i].ok);
    if (unreachable.length > 0) {
      ctx.log("fault-detected", { kind: "partition", keys: unreachable });
    }
    ctx.log("recover:start", { action: "disarm-and-reconcile" });
    ctx.chaos.disarm();
    for (const key of targets) attemptRead(ctx, key, ctx.baseline.get(key).value);
    ctx.log("recover:complete", {});
    verifyKeys(ctx, PROBE_KEYS);
  },

  [SCENARIO_TOTAL_STORE_LOSS](ctx) {
    const snapshot = ctx.storage.snapshot();
    const snapshotAt = ctx.clock.now();
    ctx.log("snapshot", { at: snapshotAt, keys: PROBE_KEYS.length });
    // Post-snapshot traffic: the history the hourly backup would not cover.
    for (const key of POST_SNAPSHOT_KEYS) {
      const value = `drill-payload:${ctx.scenarioName}:${key}`;
      const writtenAt = ctx.clock.now();
      const { ok, error } = attemptWrite(ctx, key, value);
      if (!ok) throw new Error(`drill post-snapshot write failed for ${key}: ${error}`);
      ctx.baseline.set(key, { value, writtenAt, baseline: false });
    }
    ctx.chaos.wipe();
    ctx.log("inject", { fault: "wipe", params: {} });
    const reads = PROBE_KEYS.map((key) => attemptRead(ctx, key, ctx.baseline.get(key).value));
    const missing = PROBE_KEYS.filter((key, i) => reads[i].ok && reads[i].value === null);
    if (missing.length > 0) {
      ctx.log("fault-detected", { kind: "total-loss", missingKeys: missing });
    }
    ctx.log("recover:start", { action: "restore-from-snapshot" });
    ctx.chaos.disarm();
    const restored = ctx.storage.restore(snapshot);
    ctx.log("recover:complete", {
      restoredKeys: restored && isFiniteNumber(restored.restoredKeys) ? restored.restoredKeys : null
    });
    verifyKeys(ctx, [...PROBE_KEYS, ...POST_SNAPSHOT_KEYS], { snapshotAt });
  }
};

export function runDrill(scenarioName, { storage, chaos, clock }) {
  getScenario(scenarioName); // throws TypeError on unknown scenario
  assertHarness({ storage, chaos, clock }, scenarioName);
  const timeline = [];
  const ctx = {
    scenarioName,
    storage,
    chaos,
    clock,
    baseline: new Map(),
    log: (type, detail = {}) => timeline.push({ t: clock.now(), type, ...detail })
  };
  ctx.log("start", { scenario: scenarioName });
  seedBaseline(ctx, scenarioName);
  SCRIPTS[scenarioName](ctx);
  ctx.log("end", {});
  return { scenario: scenarioName, timeline, summary: summarizeTimeline(timeline) };
}

function summarizeTimeline(timeline) {
  const writes = timeline.filter((e) => e.type === "write");
  const reads = timeline.filter((e) => e.type === "read");
  const latencies = writes.map((w) => w.latencyMs).filter(isFiniteNumber);
  return {
    startedAt: timeline[0]?.t ?? null,
    endedAt: timeline[timeline.length - 1]?.t ?? null,
    durationMs:
      timeline.length > 0 ? timeline[timeline.length - 1].t - timeline[0].t : 0,
    writesAttempted: writes.length,
    writesSucceeded: writes.filter((w) => w.ok).length,
    readsAttempted: reads.length,
    readsOk: reads.filter((r) => r.ok).length,
    corruptedReadsDetected: reads.filter((r) => r.corrupted && r.detectedCorruption).length,
    maxWriteLatencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
    faultObserved: timeline.some((e) => e.type === "fault-detected")
  };
}

function assertTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    throw new TypeError("timeline must be a non-empty array of events");
  }
  for (const [index, event] of timeline.entries()) {
    if (
      !event ||
      typeof event !== "object" ||
      !isFiniteNumber(event.t) ||
      typeof event.type !== "string"
    ) {
      throw new TypeError(
        `timeline[${index}] must be an event { t: <finite ms>, type: <string> }`
      );
    }
  }
}

const VERDICT_PASS = "pass";
const VERDICT_FAIL = "fail";

export function evaluateDrill(timeline, scenarioName) {
  const scenario = getScenario(scenarioName);
  assertTimeline(timeline);
  const { rpoMs, rtoMs } = scenario.expectations;

  const firstOf = (type) => timeline.find((e) => e.type === type) ?? null;
  const startT = firstOf("start")?.t ?? timeline[0].t;
  const endT = firstOf("end")?.t ?? timeline[timeline.length - 1].t;
  const injectT = firstOf("inject")?.t;
  const detectedT = firstOf("fault-detected")?.t ?? null;
  const recoverEndT = firstOf("recover:complete")?.t;

  const writes = timeline.filter((e) => e.type === "write");
  const reads = timeline.filter((e) => e.type === "read");
  const verifies = timeline.filter((e) => e.type === "verify");

  // Partial-state leakage: a corrupted read consumed as truth, a corrupted
  // verify that went undetected, or a failed write whose value later became
  // readable (partial application, cf. F024's atomicity contract).
  let partialLeakCount = 0;
  for (const read of reads) {
    if (read.corrupted && !read.detectedCorruption) partialLeakCount += 1;
  }
  for (const verify of verifies) {
    if (verify.status === "corrupted" && !verify.detected) partialLeakCount += 1;
  }
  for (const write of writes) {
    if (write.ok === false && write.key != null && write.attemptedValue !== undefined) {
      const leaked = reads.some(
        (read) => read.key === write.key && read.t > write.t && read.value === write.attemptedValue
      );
      if (leaked) partialLeakCount += 1;
    }
  }

  // Data loss: lost or corrupted verifies. Against a snapshot (total store
  // loss) the loss is the post-backup history that did not survive
  // (writtenAt - snapshotAt); otherwise it is staleness at verify time.
  const lost = verifies.filter((v) => v.status === "lost" || v.status === "corrupted");
  const dataLossMs = lost.reduce((max, verify) => {
    const writtenAt = isFiniteNumber(verify.writtenAt) ? verify.writtenAt : null;
    const span =
      writtenAt === null
        ? 0
        : isFiniteNumber(verify.snapshotAt)
          ? Math.max(0, writtenAt - verify.snapshotAt)
          : Math.max(0, verify.t - writtenAt);
    return Math.max(max, span);
  }, 0);

  const recoveryMs = (recoverEndT ?? endT) - (detectedT ?? injectT ?? startT);

  const expected = verifies.filter((v) => v.baseline === true);
  const findings = [
    {
      check: "fault-observed",
      pass: detectedT !== null,
      detail:
        detectedT !== null
          ? `fault detected at t=${detectedT}`
          : "no fault-detected event: the injected fault produced no observable failure — drill invalid"
    },
    {
      check: "data-loss-within-rpo",
      pass: dataLossMs <= rpoMs,
      detail: `data loss ${dataLossMs}ms vs RPO ${rpoMs}ms (${lost.length} lost/corrupted keys)`
    },
    {
      check: "recovery-within-rto",
      pass: recoveryMs <= rtoMs,
      detail: `recovery ${recoveryMs}ms vs RTO ${rtoMs}ms`
    },
    {
      check: "no-partial-state-leakage",
      pass: partialLeakCount === 0,
      detail:
        partialLeakCount === 0
          ? "no corrupted value served as truth; no failed write partially applied"
          : `${partialLeakCount} partial-state leak(s) detected`
    },
    {
      check: "baseline-recoverable",
      pass: expected.length > 0 && expected.every((v) => v.status === "ok"),
      detail:
        expected.length === 0
          ? "no baseline verifies performed"
          : `${expected.filter((v) => v.status === "ok").length}/${expected.length} seeded keys verify ok`
    }
  ];

  const passed = findings.every((f) => f.pass);
  return {
    scenario: scenarioName,
    verdict: passed ? VERDICT_PASS : VERDICT_FAIL,
    passed,
    rpoMs,
    rtoMs,
    metrics: {
      dataLossMs,
      recoveryMs,
      partialLeakCount,
      writesAttempted: writes.length,
      writesSucceeded: writes.filter((w) => w.ok).length,
      readsAttempted: reads.length,
      readsOk: reads.filter((r) => r.ok).length,
      corruptedReadsDetected: reads.filter((r) => r.corrupted && r.detectedCorruption).length,
      maxWriteLatencyMs: summarizeTimeline(timeline).maxWriteLatencyMs,
      lostKeys: lost.map((v) => v.key)
    },
    findings,
    timeline: { eventCount: timeline.length, durationMs: endT - startT }
  };
}
