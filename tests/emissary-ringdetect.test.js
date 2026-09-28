// tests/emissary-ringdetect.test.js
// Slice 3 (IB-029): collusion-ring detection pipeline.
// Authoring gate: these tests protect the §K pipeline contract from the
// refined plan (slice-7 acceptance items 33–36: union-find clustering,
// burst synchrony, fan-in hub, multi-signal rule) plus the synthetic
// Wazz-ring fixture contract (IB-002). Credible regressions: broken
// union-find transitivity, burst-window off-by-one, fan-in threshold
// errors, and the §K finding-3 violation (single signal flagging a ring).
// No existing coverage: server/emissary-ringdetect.mjs is new.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clusterEntities,
  detectBursts,
  detectFanIn,
  detectRefunding,
  detectRings,
  formatExclusion,
  ENTITY_ID_PATTERN,
  RING_ID_PATTERN,
  BURST_ID_PATTERN,
} from "../server/emissary-ringdetect.mjs";

const id = (external_id, created_at, extra = {}) => ({
  external_id,
  created_at,
  inviter_member_id: null,
  payout_address: null,
  device_fingerprint: null,
  campaign_id: null,
  ...extra,
});

// Plan item 33: union-find — three externals sharing one payout address
// cluster into one entity; a fourth with a distinct address/inviter/device
// does not.
test("union-find clusters three externals on one shared payout address; a distinct fourth stands alone", () => {
  const out = clusterEntities([
    id("a", 1000, { payout_address: "p1", inviter_member_id: "i-a", device_fingerprint: "d-a" }),
    id("b", 1000, { payout_address: "p1", inviter_member_id: "i-b", device_fingerprint: "d-b" }),
    id("c", 1000, { payout_address: "p1", inviter_member_id: "i-c", device_fingerprint: "d-c" }),
    id("z", 1000, { payout_address: "p9", inviter_member_id: "i-z", device_fingerprint: "d-z" }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].members, ["a", "b", "c"]);
  assert.ok(ENTITY_ID_PATTERN.test(out[0].entity_id));
  assert.deepEqual(out[0].shared, { payout_address: "p1" });
  assert.deepEqual(out[1].members, ["z"]);
});

// Union-find is transitive: A shares a device with B, B shares a payout
// address with C → all three are one entity (funding-key transitive
// closure, §K finding 1).
test("union-find is transitive across different shared attributes", () => {
  const out = clusterEntities([
    id("a", 1000, { device_fingerprint: "d1", payout_address: "pa" }),
    id("b", 1000, { device_fingerprint: "d1", payout_address: "pb" }),
    id("c", 1000, { device_fingerprint: "d9", payout_address: "pb" }),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members, ["a", "b", "c"]);
  assert.equal(out[0].shared.payout_address, undefined); // not shared by ALL
});

// Plan item 34: burst detection — 10 accounts created within seconds of
// each other claiming the same campaign score as a synchronized cluster;
// 10 organic accounts spread over a week do not.
test("burst: 10 creations within seconds flag a synchronized cluster; 10 spread over a week do not", () => {
  const fast = Array.from({ length: 10 }, (_, i) =>
    id(`fast-${i}`, 1_000_000 + i * 400, { campaign_id: "camp-x" }));
  const slow = Array.from({ length: 10 }, (_, i) =>
    id(`slow-${i}`, 1_000_000 + i * 60_480_000, { campaign_id: "camp-y" })); // ~7 days apart
  const bursts = detectBursts([...fast, ...slow], { windowMs: 60_000, minSize: 10 });
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].campaign_id, "camp-x");
  assert.equal(bursts[0].size, 10);
  assert.ok(BURST_ID_PATTERN.test(bursts[0].burst_id));
});

// Plan item 35: fan-in motif — five workers' release receipts converging on
// one payout address flags the hub; distinct addresses flag nothing.
test("fan-in: five workers converging on one payout address flag the hub", () => {
  const mk = (w, hub) => ({ receipt_id: `r-${w}`, kind: "payout", worker_external_id: w, payout_address: hub, created_at: 1000 });
  const hubs = detectFanIn(
    ["w1", "w2", "w3", "w4", "w5"].map((w) => mk(w, "hub-1"))
      .concat(["w6", "w7"].map((w) => mk(w, "hub-2"))),
    [],
    { minWorkers: 5 },
  );
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].hub, "hub-1");
  assert.deepEqual(hubs[0].worker_ids, ["w1", "w2", "w3", "w4", "w5"]);
  assert.equal(hubs[0].worker_count, 5);
});

// Refund loop: a funding edge H -> K where K bankrolls a later campaign's
// identities is the "proceeds fund the next campaign" finding.
test("refund loop: prior hub funding the key of the next campaign is detected", () => {
  const ids = [
    id("k1", 1000, { inviter_member_id: "key-2", campaign_id: "camp-2" }),
    id("k2", 1000, { inviter_member_id: "key-2", campaign_id: "camp-2" }),
    id("k3", 1000, { inviter_member_id: "key-2", campaign_id: "camp-2" }),
    id("old", 500, { payout_address: "hub-old", campaign_id: "camp-1" }),
  ];
  const loops = detectRefunding(
    [{ from_address: "hub-old", to_address: "key-2", created_at: 900 }],
    [{ hub: "hub-new" }],
    ids,
    { minFunded: 3 },
  );
  assert.equal(loops.length, 1);
  assert.equal(loops[0].from_hub, "hub-old");
  assert.equal(loops[0].funding_key, "key-2");
  assert.deepEqual(loops[0].next_campaign_ids, ["camp-2"]);
});

// Same-campaign funding is not a loop: no "next campaign" exists.
test("refund loop: funding within one campaign is not a serial loop", () => {
  const ids = ["a", "b", "c"].map((w) => id(w, 1000, { inviter_member_id: "key-1", campaign_id: "camp-1" }));
  const loops = detectRefunding(
    [{ from_address: "hub-1", to_address: "key-1", created_at: 900 }],
    [{ hub: "hub-1" }],
    [...ids, id("h", 500, { payout_address: "hub-1", campaign_id: "camp-1" })],
    { minFunded: 3 },
  );
  assert.equal(loops.length, 0);
});

// Plan item 36: multi-signal rule — a single signal (shared address only,
// no timing synchrony, no reward concentration) produces NO fraud finding;
// the cluster is journaled as excluded-with-reason. All three signals
// together produce a flagged entity cluster.
test("multi-signal: shared attribute alone never flags; it is journaled excluded-with-reason", () => {
  const ids = ["a", "b", "c"].map((w, i) =>
    id(w, 1_000_000 + i * 86_400_000, { payout_address: "p-shared", campaign_id: "camp-q" }));
  const receipts = ["a", "b", "c"].map((w, i) =>
    ({ receipt_id: `r-${w}`, kind: "payout", worker_external_id: w, payout_address: `own-${i}`, created_at: 2_000_000 }));
  const out = detectRings({ identities: ids, receipts });
  assert.equal(out.flagged.length, 0);
  assert.equal(out.excluded.length, 1);
  assert.match(out.excluded[0].reason, /single-signal exclusion/);
  assert.ok(formatExclusion(out.excluded[0]).includes(out.excluded[0].entity_id));
});

test("multi-signal: cluster + burst + fan-in together flag the ring", () => {
  // Ten accounts, mirroring the plan's burst figure: created within seconds
  // of each other, sharing a payout address, and paid through one hub.
  const ids = Array.from({ length: 10 }, (_, i) =>
    id(`m-${i}`, 1_000_000 + i * 2_000, { payout_address: "hub-pay", campaign_id: "camp-r" }));
  const receipts = Array.from({ length: 10 }, (_, i) =>
    ({ receipt_id: `rr-${i}`, kind: "payout", worker_external_id: `m-${i}`, payout_address: "hub-pay", created_at: 2_000_000 }));
  const out = detectRings({ identities: ids, receipts });
  assert.equal(out.flagged.length, 1);
  assert.ok(RING_ID_PATTERN.test(out.flagged[0].ring_id));
  assert.deepEqual(out.flagged[0].signals, ["reward_concentration", "shared_attribute_cluster", "temporal_synchrony"]);
  assert.equal(out.flagged[0].evidence.members.length, 10);
  assert.equal(out.excluded.length, 0);
});

// Determinism: stable entity and ring ids across runs (journal-friendly).
test("entity and ring ids are deterministic across runs", () => {
  const ids = Array.from({ length: 6 }, (_, i) =>
    id(`d-${i}`, 1_000_000 + i * 2_000, { payout_address: "hub-d", campaign_id: "camp-d" }));
  const receipts = Array.from({ length: 6 }, (_, i) =>
    ({ receipt_id: `rd-${i}`, kind: "payout", worker_external_id: `d-${i}`, payout_address: "hub-d", created_at: 2_000_000 }));
  const a = detectRings({ identities: ids, receipts });
  const b = detectRings({ identities: ids, receipts });
  assert.deepEqual(a.flagged, b.flagged);
  assert.deepEqual(a.entities, b.entities);
});

// Input validation fails closed on malformed events.
test("malformed identity events throw emissary_ring_bad_input", () => {
  const isBadInput = (err) => err instanceof Error && err.code === "emissary_ring_bad_input";
  assert.throws(() => clusterEntities([{ created_at: 1 }]), isBadInput);
  assert.throws(() => detectBursts("nope"), isBadInput);
});

// The detector is pure analysis: it must never perform network I/O.
// Retention bar: this source inspection is the cheapest independent guard
// for the no-exfiltration contract; it survives identifier refactors and
// fails the moment a transport call appears.
test("detector source performs no network I/O", () => {
  const src = readFileSync(new URL("../server/emissary-ringdetect.mjs", import.meta.url), "utf8");
  for (const token of ["fetch(", "http.request", "net.", "WebSocket", "XMLHttpRequest"]) {
    assert.ok(!src.includes(token), `network token present: ${token}`);
  }
});

// Wazz-ring fixtures (IB-002): synthetic rings shaped on the published
// forensic report validate the pipeline end to end; controls exclude.
test("wazz fixtures: synthetic rings flag, organic and single-signal controls exclude", () => {
  const doc = JSON.parse(readFileSync(new URL("./fixtures/wazz-rings.json", import.meta.url), "utf8"));
  assert.equal(doc.synthetic, true, "fixtures must stay labeled synthetic");
  assert.ok(doc.provenance.includes("INVENTED"), "provenance must say the data is invented");
  for (const f of doc.fixtures) {
    const out = detectRings({ identities: f.identities, receipts: f.receipts, funding: f.funding });
    assert.equal(out.flagged.length, f.expected.flagged_rings, `${f.name}: flagged count`);
    assert.equal(out.excluded.length, f.expected.excluded, `${f.name}: excluded count`);
    for (const sig of f.expected.min_signals ?? []) {
      for (const ring of out.flagged) {
        assert.ok(ring.signals.includes(sig), `${f.name}: ring missing signal ${sig}`);
      }
    }
    if (f.expected.exclusion_reason_contains) {
      for (const ex of out.excluded) {
        assert.ok(ex.reason.includes(f.expected.exclusion_reason_contains), `${f.name}: exclusion reason`);
      }
    }
  }
});
