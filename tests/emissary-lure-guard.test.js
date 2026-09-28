// tests/emissary-lure-guard.test.js
// Slice 3 (IB-029): lure-generation abuse guardrails.
// Authoring gate: these tests protect the guard contracts (mirror-drop
// detection, stored-artifact drift re-scan, drop velocity, invite farming,
// compound escalation, findings-only posture). Credible regressions:
// threshold errors, single-signal escalations (violating the §K compound
// doctrine), and drift-pattern rot. No existing coverage: the module is new.
// The guard reads Slice 2 ledger row shapes (RC-2026-09-28-2873) but never
// imports slice-2 modules, so these tests run on main without PR #1184.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  findMirrorDrops,
  scanArtifactDrift,
  dropVelocity,
  inviteFarming,
  assessLureRisk,
  DROP_DAILY_LIMIT,
  INVITE_DAILY_LIMIT,
} from "../server/emissary-lure-guard.mjs";

const NOW = 1_750_000_000_000;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const drop = (drop_id, issuer_member_id, venue, created_at, extra = {}) => ({
  drop_id,
  room_id: "room-1",
  issuer_member_id,
  venue,
  title: "Agents wanted",
  terms: "Bring your own compute",
  artifact_text: "Join our agent room. Agents earn $DASHA doing real work.",
  artifact_sha256: sha(`artifact-${drop_id}`),
  created_at,
  ...extra,
});

// Duplicate-farming mirrors: the same artifact minted by two members, or by
// one member across venues.
test("mirror drops: same artifact by two members is a mirror; solo drops are not", () => {
  const rows = [
    drop("d1", "mem-a", "x", NOW - 1000, { artifact_sha256: sha("same-copy") }),
    drop("d2", "mem-b", "x", NOW - 2000, { artifact_sha256: sha("same-copy") }),
    drop("d3", "mem-a", "x", NOW - 3000),
  ];
  const mirrors = findMirrorDrops(rows);
  assert.equal(mirrors.length, 1);
  assert.deepEqual(mirrors[0].drop_ids, ["d1", "d2"]);
  assert.deepEqual(mirrors[0].issuers, ["mem-a", "mem-b"]);
  assert.equal(mirrors[0].cross_member, true);
});

test("mirror drops: one member mirroring across venues is a mirror", () => {
  const rows = [
    drop("d1", "mem-a", "x", NOW - 1000, { artifact_sha256: sha("cross-venue") }),
    drop("d2", "mem-a", "colony", NOW - 2000, { artifact_sha256: sha("cross-venue") }),
  ];
  const mirrors = findMirrorDrops(rows);
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].cross_venue, true);
  assert.equal(mirrors[0].cross_member, false);
});

// Stored-artifact drift: earnings-shaped claims in stored copy are flagged.
test("drift scan: quantified payout promises are violations; honest copy is clean", () => {
  const rows = [
    drop("dirty", "mem-a", "x", NOW - 1000, { artifact_text: "Join now — earn up to $500/day guaranteed income!" }),
    drop("clean", "mem-a", "x", NOW - 2000, { artifact_text: "Agents earn $DASHA doing real work. No promises." }),
  ];
  const hits = scanArtifactDrift(rows);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].drop_id, "dirty");
  assert.ok(hits[0].violations.length >= 2, "expected multiple pattern hits");
});

// Velocity: over-cap bursts breach; sustained near-cap across days flags.
test("velocity: 11 drops in 24h breaches the daily cap", () => {
  const rows = Array.from({ length: DROP_DAILY_LIMIT + 1 }, (_, i) =>
    drop(`v-${i}`, "mem-a", "x", NOW - i * 3_600_000));
  const { breached } = dropVelocity(rows, { nowMs: NOW });
  assert.equal(breached.length, 1);
  assert.equal(breached[0].count, DROP_DAILY_LIMIT + 1);
  assert.equal(breached[0].limit, DROP_DAILY_LIMIT);
});

test("velocity: 8/day for 3 days is a sustained near-cap pattern; 2/day is not", () => {
  const DAY = 86_400_000;
  const hot = [];
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 8; i++) hot.push(drop(`h-${day}-${i}`, "mem-hot", "x", NOW - day * DAY - i * 1_000));
  }
  const cold = [];
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 2; i++) cold.push(drop(`c-${day}-${i}`, "mem-cold", "x", NOW - day * DAY - i * 1_000));
  }
  const { sustained } = dropVelocity([...hot, ...cold], { nowMs: NOW });
  assert.equal(sustained.length, 1);
  assert.equal(sustained[0].member_id, "mem-hot");
  assert.equal(sustained[0].days_at_near_cap, 3);
});

// Invite farming: repeated cap-hit days signal farming.
test("invite farming: 3 cap-hit days in a week flags; spread-out minting does not", () => {
  const DAY = 86_400_000;
  const invites = [];
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < INVITE_DAILY_LIMIT; i++) {
      invites.push({ attribution_id: `a-f-${day}-${i}`, room_id: "room-1", issuer_member_id: "mem-farmer", minted_at: NOW - day * DAY - i, expires_at: NOW + DAY });
    }
  }
  for (let day = 0; day < 7; day++) {
    invites.push({ attribution_id: `a-o-${day}`, room_id: "room-1", issuer_member_id: "mem-normal", minted_at: NOW - day * DAY, expires_at: NOW + DAY });
  }
  const farming = inviteFarming(invites, { nowMs: NOW });
  assert.equal(farming.length, 1);
  assert.equal(farming[0].member_id, "mem-farmer");
  assert.equal(farming[0].cap_hit_days, 3);
});

// Compound doctrine: single anomalies stay at watch; mirror + drift
// together escalate.
test("assess: drift alone is watch-only; mirror plus drift escalates", () => {
  const driftOnly = assessLureRisk({
    drops: [drop("d1", "mem-a", "x", NOW - 1000, { artifact_text: "earn up to $500/day!" })],
    nowMs: NOW,
  });
  assert.equal(driftOnly.escalations.length, 0);
  assert.ok(driftOnly.watch.some((w) => w.kind === "earnings_drift"));

  const both = assessLureRisk({
    drops: [
      drop("d1", "mem-a", "x", NOW - 1000, { artifact_text: "earn up to $500/day!", artifact_sha256: sha("dup") }),
      drop("d2", "mem-b", "x", NOW - 2000, { artifact_text: "earn up to $500/day!", artifact_sha256: sha("dup") }),
    ],
    nowMs: NOW,
  });
  // One escalation per offending issuer — not per drop, not collapsed across
  // issuers.
  assert.equal(both.escalations.length, 2);
  assert.ok(both.escalations.every((e) => e.kind === "mirror_plus_drift"));
  assert.deepEqual(both.escalations.map((e) => e.issuer_member_id).sort(), ["mem-a", "mem-b"]);
});

test("assess: sustained velocity plus invite farming escalates", () => {
  const DAY = 86_400_000;
  const drops = [];
  const invites = [];
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 8; i++) drops.push(drop(`d-${day}-${i}`, "mem-x", "x", NOW - day * DAY - i));
    for (let i = 0; i < INVITE_DAILY_LIMIT; i++) {
      invites.push({ attribution_id: `a-${day}-${i}`, room_id: "room-1", issuer_member_id: "mem-x", minted_at: NOW - day * DAY - i, expires_at: NOW + DAY });
    }
  }
  const out = assessLureRisk({ drops, invites, nowMs: NOW });
  assert.ok(out.escalations.some((e) => e.kind === "velocity_plus_invite_farming"));
});

test("assess: quiet ledgers produce no watch items and no escalations", () => {
  const out = assessLureRisk({
    drops: [drop("d1", "mem-a", "x", NOW - 1000), drop("d2", "mem-a", "x", NOW - 2000)],
    invites: [],
    nowMs: NOW,
  });
  assert.deepEqual(out.watch, []);
  assert.deepEqual(out.escalations, []);
});

// The guard is findings-only: it must never suspend, demote, or punish —
// no punitive calls anywhere in the module. Tokens are call-shaped so the
// header's plain-English "never suspends" statement does not false-positive.
// Retention bar: this source inspection is the cheapest independent guard
// for the findings-only contract; it fails the moment a punitive call
// appears.
test("guard source is findings-only: no suspension, demotion, or punishment calls", () => {
  const src = readFileSync(new URL("../server/emissary-lure-guard.mjs", import.meta.url), "utf8");
  for (const token of ["suspend(", "demote(", "punish(", "ban(", "revoke(", ".suspend", ".demote"]) {
    assert.ok(!src.includes(token), `punitive token present: ${token}`);
  }
});

// The guard performs no network I/O (same no-exfiltration contract as the
// detector).
test("guard source performs no network I/O", () => {
  const src = readFileSync(new URL("../server/emissary-lure-guard.mjs", import.meta.url), "utf8");
  for (const token of ["fetch(", "http.request", "net.", "WebSocket", "XMLHttpRequest"]) {
    assert.ok(!src.includes(token), `network token present: ${token}`);
  }
});

// Guard thresholds mirror Slice 2's enforced caps (documents the coupling).
test("guard limits mirror slice-2 enforced caps", () => {
  assert.equal(DROP_DAILY_LIMIT, 10);
  assert.equal(INVITE_DAILY_LIMIT, 20);
});
