// Emissary slice 3 (IB-029) — ring-detection simulator tests
// (RC-2026-09-28-2905).
//
// Contracts guarded (test-audit gate):
//  1. Fixture honesty: tests/fixtures/wazz-rings.json is labeled synthetic,
//     every node id is SYNTH-*, and no 0x-prefixed 40-hex address appears.
//  2. clusterEntities links nodes sharing an attribute value (payout /
//     inviter / device) and leaves unrelated nodes unlinked.
//  3. detectFanIn fires at the source threshold inside the time window; a
//     later re-seed edge does not void the burst (sliding window).
//  4. detectFanOut mirrors fan_in for the distributor shape.
//  5. detectBursts finds script-driven synchrony and stays silent on the
//     organic control fixture.
//  6. detectRefundLoops finds proceeds returning to a hub; the control has
//     no cycles.
//  7. Multi-signal rule: >=3 distinct co-occurring signals -> finding;
//     1-2 signals -> excluded, never flagged; the honest control yields
//     zero findings; the journal records both findings and exclusions.
//  8. Cluster->hub attribution: a cluster feeding one counterparty adds
//     cluster_link to that hub's signal group.
//  9. Malformed graphs/nodes/edges fail closed with emissary_ring_* codes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clusterEntities,
  detectFanIn,
  detectFanOut,
  detectBursts,
  detectRefundLoops,
  detectRings,
  SYNTH_ID_RE,
  REAL_ADDRESS_RE,
} from "../server/emissary-ringdetect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(here, "fixtures", "wazz-rings.json"), "utf8"));
const F = doc.fixtures;
const RING_OPTS = { minSources: 10, minTargets: 10, fanWindowMs: 90_000, burstWindowMs: 90_000, burstMinCount: 10 };

// --- 1. fixture honesty -----------------------------------------------------

test("fixtures are labeled synthetic and carry no real addresses", () => {
  assert.equal(doc.synthetic, true);
  assert.match(doc.label, /SYNTHETIC/i);
  assert.match(doc.honesty_rule, /never identities/i);
  for (const [name, f] of Object.entries(F)) {
    assert.equal(f.synthetic, true, `${name} must be labeled synthetic`);
    for (const n of f.nodes) assert.match(n.id, SYNTH_ID_RE, `${name}: ${n.id}`);
  }
  const raw = readFileSync(join(here, "fixtures", "wazz-rings.json"), "utf8");
  assert.doesNotMatch(raw, REAL_ADDRESS_RE, "no 0x-prefixed 40-hex address anywhere in the fixture");
});

// --- 2. entity clustering ---------------------------------------------------

test("clusterEntities links nodes sharing payout/inviter/device", () => {
  const clusters = clusterEntities(F.collector_fan_in.nodes, { minSize: 3 });
  const wallets = clusters.find((c) => c.members.some((m) => m.startsWith("SYNTH-W-")));
  assert.ok(wallets, "the 24 farm wallets form one cluster");
  assert.equal(wallets.members.length, 24);
  assert.ok(wallets.via.some((v) => v.startsWith("inviter:SYNTH-INV-01")));
  assert.ok(wallets.via.some((v) => v.startsWith("device:SYNTH-DEV-01")));
});

test("clusterEntities leaves unrelated nodes unlinked", () => {
  const clusters = clusterEntities(F.honest_control.nodes, { minSize: 2 });
  assert.deepEqual(clusters, [], "organic control nodes share no attributes");
});

test("clusterEntities honors minSize", () => {
  const nodes = [
    { id: "SYNTH-A", attributes: { inviter: "SYNTH-INV-9" } },
    { id: "SYNTH-B", attributes: { inviter: "SYNTH-INV-9" } },
    { id: "SYNTH-C", attributes: {} },
  ];
  assert.equal(clusterEntities(nodes, { minSize: 3 }).length, 0);
  assert.equal(clusterEntities(nodes, { minSize: 2 }).length, 1);
});

// --- 3/4. fan-in / fan-out --------------------------------------------------

test("detectFanIn fires on the collector burst shape", () => {
  const hits = detectFanIn(F.collector_fan_in.edges, { minSources: 10, windowMs: 90_000 });
  const coll = hits.find((h) => h.hub === "SYNTH-COLL-01");
  assert.ok(coll, "collector hub detected");
  assert.ok(coll.sources.length >= 24);
  assert.equal(coll.withinWindow, true);
});

test("detectFanIn below the source threshold stays silent", () => {
  const hits = detectFanIn(F.collector_fan_in.edges, { minSources: 100, windowMs: 90_000 });
  assert.deepEqual(hits, []);
});

test("detectFanOut fires on the distributor shape", () => {
  const hits = detectFanOut(F.distributor_fan_out.edges, { minTargets: 10, windowMs: 90_000 });
  const dist = hits.find((h) => h.hub === "SYNTH-DIST-01");
  assert.ok(dist, "distributor hub detected");
  assert.ok(dist.targets.length >= 12);
});

// --- 5. bursts ---------------------------------------------------------------

test("detectBursts finds the 3s collector burst, not the organic control", () => {
  const ring = detectBursts(F.collector_fan_in.edges, { windowMs: 90_000, minCount: 10 });
  assert.ok(ring.length >= 1, "collector burst found");
  assert.ok(ring[0].end - ring[0].start <= 90_000);
  const control = detectBursts(F.honest_control.edges, { windowMs: 90_000, minCount: 10 });
  assert.deepEqual(control, [], "organic control has no bursts");
});

// --- 6. refund loops ----------------------------------------------------------

test("detectRefundLoops finds the collector re-seed cycle", () => {
  const loops = detectRefundLoops(F.collector_fan_in.edges, { maxHops: 4 });
  const back = loops.find((l) => l.hub === "SYNTH-COLL-01");
  assert.ok(back, "proceeds-returning-to-collector loop found");
  assert.deepEqual(back.path, ["SYNTH-COLL-01", "SYNTH-BRIDGE-01", "SYNTH-CASH-01", "SYNTH-COLL-01"]);
});

test("detectRefundLoops finds no cycles in the control fixture", () => {
  assert.deepEqual(detectRefundLoops(F.honest_control.edges, { maxHops: 4 }), []);
});

// --- 7. multi-signal rule -----------------------------------------------------

test("detectRings flags the collector with >=3 signals", () => {
  const journal = [];
  const r = detectRings({ nodes: F.collector_fan_in.nodes, edges: F.collector_fan_in.edges }, { ...RING_OPTS, journal });
  const finding = r.findings.find((x) => x.key === "hub:SYNTH-COLL-01");
  assert.ok(finding, "collector is a finding");
  assert.ok(finding.signals.length >= 3, `signals: ${finding.signals.join(",")}`);
  assert.ok(finding.signals.includes("fan_in"));
  assert.ok(finding.signals.includes("cluster_link"));
  assert.ok(journal.some((j) => j.kind === "finding" && j.key === "hub:SYNTH-COLL-01"));
});

test("detectRings flags the distributor with exactly the fan-out triad", () => {
  const r = detectRings({ nodes: F.distributor_fan_out.nodes, edges: F.distributor_fan_out.edges }, RING_OPTS);
  const finding = r.findings.find((x) => x.key === "hub:SYNTH-DIST-01");
  assert.ok(finding);
  assert.deepEqual(finding.signals, ["burst", "cluster_link", "fan_out"]);
});

test("a single signal never flags: burst-only fixture is excluded, not a finding", () => {
  const journal = [];
  const r = detectRings({ nodes: F.burst_timing.nodes, edges: F.burst_timing.edges }, { ...RING_OPTS, journal });
  assert.deepEqual(r.findings, [], "burst alone never flags");
  assert.ok(r.excluded.length >= 1, "the burst is recorded as excluded");
  assert.ok(r.excluded.every((x) => x.reason === "below multi-signal threshold"));
  assert.ok(journal.some((j) => j.kind === "exclusion"));
});

test("honest control yields zero findings and zero exclusions", () => {
  const r = detectRings({ nodes: F.honest_control.nodes, edges: F.honest_control.edges }, RING_OPTS);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.excluded, []);
});

test("rapid pass-through chain produces no signals at all", () => {
  const r = detectRings({ nodes: F.rapid_pass_through.nodes, edges: F.rapid_pass_through.edges }, RING_OPTS);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.excluded, []);
});

// --- 8. cluster -> hub attribution --------------------------------------------

test("a cluster feeding one hub adds cluster_link to the hub's group", () => {
  const r = detectRings({ nodes: F.deed_selloff_set.nodes, edges: F.deed_selloff_set.edges }, RING_OPTS);
  const finding = r.findings.find((x) => x.key === "hub:SYNTH-POOL-01");
  assert.ok(finding, "pool is a finding");
  assert.ok(finding.signals.includes("cluster_link"), "deed-set cluster attributed to the pool hub");
  assert.ok(finding.signals.includes("fan_in"));
});

// --- 9. fail closed -------------------------------------------------------------

test("malformed inputs fail closed with emissary_ring_* codes", () => {
  const codes = [];
  for (const bad of [
    () => detectRings(null),
    () => detectRings({ nodes: "x", edges: [] }),
    () => detectRings({ nodes: [{ id: 42 }], edges: [] }),
    () => detectRings({ nodes: [], edges: [{ from: "a", to: "b" }] }),
    () => clusterEntities("nope"),
    () => detectFanIn("nope"),
  ]) {
    try {
      bad();
    } catch (e) {
      codes.push(e.code);
    }
  }
  assert.equal(codes.length, 6);
  assert.ok(codes.every((c) => c.startsWith("emissary_ring_")), `codes: ${codes.join(",")}`);
});
