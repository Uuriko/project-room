// Metric registry freeze (PR-IMPROVE-100 dispositions 07-3 / 08-4 /
// 09-2 / 09-4 / 10-2; spec: cluster-07 lane-10).
//
// Authoring gate:
// 1. The seeded registry at metrics/registry.yaml passes the registry
//    lint (scripts/metric-registry-check.mjs) with zero problems, and
//    carries the freeze-now set: the event taxonomy v1 families, review
//    latency's three clocks, the C04 revenue definitions, and the
//    abuse-rate definitions + the five verdict reason codes.
// 2. Each of the five lint rules fails on a deliberately broken copy
//    of the seeded registry: (1) ratio without denominator,
//    (2) missing first_decision, (3) a report citing an id without its
//    version (or at the wrong version), (4) a definition edit without
//    a version bump, (5) a deleted entry (tombstones must stay).
// 3. Structural guards fail too: duplicate ids and a change_log that
//    does not cover the current version.
//
// The fixtures mutate structured clones of the real seeded registry,
// so the pass case and the fail cases can never drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { lintRegistryData } from "../scripts/metric-registry-check.mjs";

const seeded = parse(readFileSync(new URL("../metrics/registry.yaml", import.meta.url), "utf8"));

function clone() {
  return structuredClone(seeded);
}

function metric(data, id) {
  return data.metrics.find(entry => entry.id === id);
}

test("seeded registry passes the lint with zero problems", () => {
  assert.deepEqual(lintRegistryData(seeded), []);
});

test("seeded registry carries the freeze-now definition set", () => {
  const metricIds = seeded.metrics.map(entry => entry.id);
  // Review Latency v1: the three clocks (cluster-08 lane-05).
  for (const id of ["RL_agent_verdict_wait", "RL_poster_supply_wait", "RL_poster_outcome_wait"]) {
    assert.ok(metricIds.includes(id), `missing review-latency clock ${id}`);
  }
  // C04 revenue definitions, frozen pre-launch (cluster-09 lane-08).
  for (const id of ["C04_host_conversion", "C04_room_expansion", "C04_churn_by_host"]) {
    assert.ok(metricIds.includes(id), `missing C04 definition ${id}`);
  }
  // Abuse rates (cluster-09 lane-05).
  for (const id of ["ABUSE_claim_rejection_rate", "ABUSE_payable_rate", "ABUSE_heldout_divergence", "ABUSE_ring_signal_rate", "ABUSE_repeat_claimant_concentration"]) {
    assert.ok(metricIds.includes(id), `missing abuse definition ${id}`);
  }
  // Event taxonomy v1 families (cluster-10 lane-07): work lifecycle,
  // proof/receipt, money, and the server halves of sync.
  const eventIds = seeded.events.map(entry => entry.id);
  for (const id of ["work.claimed", "work.delivered", "work.verdict_ready", "work.verdict_given", "work.bounced",
    "receipt.issued", "receipt.viewed", "receipt.verified",
    "settlement.initiated", "settlement.completed", "receipt.signing",
    "sync.pull", "sync.bootstrap"]) {
    assert.ok(eventIds.includes(id), `missing taxonomy event ${id}`);
  }
  // Verdict reason codes, frozen before the first open pool.
  assert.deepEqual(
    seeded.verdict_reason_codes.map(entry => entry.code),
    ["FRAUD-SYBIL", "DUPLICATE-COLLUSIVE", "QUALITY-INSUFFICIENT", "SPEC-NONCOMPLIANT", "OTHER"],
  );
  // Every seeded entry is a frozen v1 with a change_log row.
  for (const entry of [...seeded.metrics, ...seeded.events, ...seeded.verdict_reason_codes]) {
    assert.equal(entry.version, 1);
    assert.ok(entry.change_log.some(row => row.version === 1), "missing v1 change_log row");
  }
});

test("rule 1: a ratio metric without a denominator fails", () => {
  const data = clone();
  metric(data, "C04_host_conversion").denominator = "";
  const problems = lintRegistryData(data);
  assert.ok(problems.some(p => p.includes("rule 1")), problems.join("\n"));
});

test("rule 2: a metric without a first_decision fails", () => {
  const data = clone();
  delete metric(data, "RL_agent_verdict_wait").first_decision;
  const problems = lintRegistryData(data);
  assert.ok(problems.some(p => p.includes("rule 2")), problems.join("\n"));
});

test("rule 3: citing an id without its version fails; id@version passes", () => {
  const bare = lintRegistryData(seeded, {
    scanTexts: [{ path: "report.md", text: "Review latency held: RL_agent_verdict_wait rose this week." }],
  });
  assert.ok(bare.some(p => p.includes("rule 3")), bare.join("\n"));

  const wrongVersion = lintRegistryData(seeded, {
    scanTexts: [{ path: "report.md", text: "See RL_agent_verdict_wait@99 for the trend." }],
  });
  assert.ok(wrongVersion.some(p => p.includes("rule 3")), wrongVersion.join("\n"));

  const cited = lintRegistryData(seeded, {
    scanTexts: [{ path: "report.md", text: "Review latency held: RL_agent_verdict_wait@1 and C04_host_conversion@1 are frozen." }],
  });
  assert.deepEqual(cited, []);
});

test("rule 4: editing a frozen definition without a version bump fails", () => {
  const edited = clone();
  metric(edited, "C04_churn_by_host").numerator = "Hosts who clicked cancel in period P.";
  const problems = lintRegistryData(edited, { baseData: seeded });
  assert.ok(problems.some(p => p.includes("rule 4")), problems.join("\n"));

  const bumped = clone();
  const churn = metric(bumped, "C04_churn_by_host");
  churn.numerator = "Hosts who clicked cancel in period P.";
  churn.version = 2;
  churn.change_log.push({ version: 2, date: "2026-10-27", note: "definition change with version bump (fixture)" });
  assert.deepEqual(lintRegistryData(bumped, { baseData: seeded }), []);
});

test("rule 5: deleting an entry fails — tombstones stay", () => {
  const data = clone();
  data.metrics = data.metrics.filter(entry => entry.id !== "ABUSE_ring_signal_rate");
  data.events = data.events.filter(entry => entry.id !== "receipt.viewed");
  const problems = lintRegistryData(data, { baseData: seeded });
  assert.ok(problems.some(p => p.includes("rule 5") && p.includes("ABUSE_ring_signal_rate")), problems.join("\n"));
  assert.ok(problems.some(p => p.includes("rule 5") && p.includes("receipt.viewed")), problems.join("\n"));

  const retired = clone();
  metric(retired, "ABUSE_ring_signal_rate").status = "killed";
  assert.deepEqual(lintRegistryData(retired, { baseData: seeded }), []);
});

test("structural guards: duplicate ids and uncovered versions fail", () => {
  const dup = clone();
  dup.metrics.push(structuredClone(dup.metrics[0]));
  assert.ok(lintRegistryData(dup).some(p => p.includes("duplicate id")));

  const uncovered = clone();
  metric(uncovered, "RL_poster_supply_wait").change_log = [];
  assert.ok(lintRegistryData(uncovered).some(p => p.includes("change_log")));
});
