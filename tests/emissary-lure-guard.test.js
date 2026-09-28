// Emissary slice 3 (IB-029) — lure-generation abuse guardrails tests
// (RC-2026-09-28-2905).
//
// Contracts guarded (test-audit gate):
//  1. checkDropRateLimit blocks the 11th drop/member/venue/day, leaves
//     other venues unaffected, and reports a future resetsAt.
//  2. checkInviteMintCap blocks the 21st mint/member/day.
//  3. checkIdentityCaps binds on the cross-venue total even when every
//     single venue is under its cap (farm-spread shape).
//  4. detectMirrorDrops flags exact and near-duplicate copy by one issuer
//     across venues; distinct copy per venue and cross-issuer similarity
//     are not flagged.
//  5. rescanStoredArtifacts flags each drift-pattern class on stored
//     artifacts, stays silent on clean copy, surfaces injected-validator
//     violations, and journals findings.
//  6. detectVelocityAnomalies flags a >=4x spike over the member's own
//     baseline and stays silent on steady traffic.
//  7. checkSerialOffenderHistory matches Wazz watchlist SHAPES (roles +
//     evidence grades, never identities), detects repeat offenders from
//     fixture history, and rejects non-synthetic refs — including
//     0x-address-shaped ones.
//  8. Findings-only: no call mutates its input rows, and the module has
//     no network capability by construction.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSyntheticRef,
  checkDropRateLimit,
  checkInviteMintCap,
  checkIdentityCaps,
  detectMirrorDrops,
  rescanStoredArtifacts,
  detectVelocityAnomalies,
  checkSerialOffenderHistory,
  DRIFT_PATTERNS,
  WATCHLIST_SHAPES,
} from "../server/emissary-lure-guard.mjs";

const NOW = 1_786_000_000_000;
const hour = 3_600_000;

const dropRows = (n, { member = "m1", venue = "x", start = NOW - 10 * hour } = {}) =>
  Array.from({ length: n }, (_, i) => ({ issuer_member_id: member, venue, created_at: start + i * 60_000 }));

// --- 1. drop rate limit --------------------------------------------------------

test("the 11th drop in a venue/day is blocked; other venues unaffected", () => {
  const rows = dropRows(10);
  const blocked = checkDropRateLimit(rows, { memberId: "m1", venue: "x", nowMs: NOW });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 10);
  assert.equal(blocked.cap, 10);
  assert.ok(blocked.resetsAt > NOW, "resetsAt is in the future while blocked");

  const other = checkDropRateLimit(rows, { memberId: "m1", venue: "colony", nowMs: NOW });
  assert.equal(other.allowed, true);
  assert.equal(other.used, 0);

  const ninth = checkDropRateLimit(dropRows(9), { memberId: "m1", venue: "x", nowMs: NOW });
  assert.equal(ninth.allowed, true);
});

// --- 2. invite mint cap ---------------------------------------------------------

test("the 21st human-invite mint in a day is blocked", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ issuer_member_id: "m1", minted_at: NOW - 10 * hour + i * 60_000 }));
  const blocked = checkInviteMintCap(rows, { memberId: "m1", nowMs: NOW });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 20);
  const ok = checkInviteMintCap(rows.slice(1), { memberId: "m1", nowMs: NOW });
  assert.equal(ok.allowed, true);
});

// --- 3. identity caps -------------------------------------------------------------

test("cross-venue total binds even when each venue is under its cap", () => {
  const rows = [
    ...dropRows(9, { venue: "x" }),
    ...dropRows(9, { venue: "colony" }),
    ...dropRows(9, { venue: "tantive" }),
  ];
  const caps = checkIdentityCaps(rows, { memberId: "m1", nowMs: NOW, perVenueCap: 10, totalCap: 25 });
  assert.ok(Object.values(caps.perVenue).every((v) => v.allowed), "each venue under its own cap");
  assert.equal(caps.total.used, 27);
  assert.equal(caps.total.allowed, false, "but the identity total binds");
});

// --- 4. mirror drops ---------------------------------------------------------------

test("exact duplicate copy across venues by one issuer is flagged", () => {
  const text = "Fresh compute bounties just landed in the room — claim a task, get paid on delivery.";
  const artifacts = [
    { issuer_member_id: "m1", venue: "x", text, created_at: NOW - 3 * hour },
    { issuer_member_id: "m1", venue: "colony", text: text + " ", created_at: NOW - 2 * hour },
    { issuer_member_id: "m1", venue: "tantive", text: "Totally different copy for tantive folks.", created_at: NOW - hour },
  ];
  const findings = detectMirrorDrops(artifacts);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issuer, "m1");
  assert.deepEqual(findings[0].venues, ["colony", "x"]);
  assert.equal(findings[0].similarity, 1);
});

test("near-duplicate copy across venues is flagged; distinct copy is not", () => {
  const base = "New agent bounties are live in the room this week, come earn credits for real tasks";
  const artifacts = [
    { issuer_member_id: "m1", venue: "x", text: base, created_at: NOW - 3 * hour },
    { issuer_member_id: "m1", venue: "sssnack", text: base + " and join the crew", created_at: NOW - 2 * hour },
    { issuer_member_id: "m2", venue: "x", text: base, created_at: NOW - hour },
  ];
  const findings = detectMirrorDrops(artifacts, { similarity: 0.75 });
  assert.equal(findings.length, 1, "only m1's cross-venue pair flags");
  assert.equal(findings[0].issuer, "m1");
  assert.ok(findings[0].similarity >= 0.75 && findings[0].similarity < 1);
});

// --- 5. earnings-drift re-scan -------------------------------------------------------

const driftCases = [
  ["earn up to $500 a week from your couch", "drift_earnings_up_to"],
  ["make $200 per day doing tasks", "drift_earnings_rate"],
  ["guaranteed payout within hours", "drift_guaranteed"],
  ["the passive income stream agents deserve", "drift_passive_income"],
];

for (const [text, name] of driftCases) {
  test(`drift re-scan flags stored artifact matching ${name}`, () => {
    const findings = rescanStoredArtifacts([{ artifact_id: "a1", issuer_member_id: "m1", venue: "x", text }]);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].violations.some((v) => v.name === name));
    assert.equal(findings[0].kind, "earnings_drift");
  });
}

test("drift re-scan stays silent on clean stored copy", () => {
  const findings = rescanStoredArtifacts([
    { artifact_id: "a2", issuer_member_id: "m1", venue: "x", text: "Compute bounties are posted weekly; payouts settle on accepted delivery." },
  ]);
  assert.deepEqual(findings, []);
});

test("injected validators surface their violations and findings journal", () => {
  const journal = [];
  const findings = rescanStoredArtifacts(
    [{ artifact_id: "a3", issuer_member_id: "m1", venue: "x", text: "clean copy, but the injected list hates it" }],
    {
      validators: [{ name: "custom", fn: (t) => (t.includes("hates it") ? ["custom_banned_phrase"] : []) }],
      journal,
    }
  );
  assert.equal(findings.length, 1);
  assert.ok(findings[0].violations.some((v) => v.name === "custom_banned_phrase"));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "earnings_drift");
});

test("DRIFT_PATTERNS is a frozen documented subset, not the canonical list", () => {
  assert.ok(Object.isFrozen(DRIFT_PATTERNS));
  assert.ok(DRIFT_PATTERNS.length >= 4);
});

// --- 6. velocity anomalies ------------------------------------------------------------

test("a 4x spike over the member's own baseline is flagged", () => {
  const events = [];
  for (let w = 1; w <= 4; w++) {
    for (let i = 0; i < 2; i++) events.push({ member_id: "m1", kind: "drop", created_at: NOW - w * hour - i * 1000 });
  }
  for (let i = 0; i < 12; i++) events.push({ member_id: "m1", kind: "drop", created_at: NOW - i * 60_000 });
  const out = detectVelocityAnomalies(events, { nowMs: NOW, windowMs: hour, baselineWindows: 4, ratio: 4 });
  assert.equal(out.length, 1);
  assert.equal(out[0].member, "m1");
  assert.equal(out[0].current, 12);
  assert.ok(out[0].ratio >= 4);
});

test("steady traffic is not a velocity anomaly", () => {
  const events = [];
  for (let w = 0; w <= 4; w++) {
    for (let i = 0; i < 2; i++) events.push({ member_id: "m2", kind: "drop", created_at: NOW - w * hour - i * 1000 });
  }
  const out = detectVelocityAnomalies(events, { nowMs: NOW, windowMs: hour, baselineWindows: 4, ratio: 4 });
  assert.deepEqual(out, []);
});

// --- 7. serial-offender history hook ----------------------------------------------------

test("candidate roles match watchlist shapes with their evidence grades", () => {
  const r = checkSerialOffenderHistory({
    candidateRoles: [
      { role: "collector_hub", offenderRef: "SYNTH-COLL-01" },
      { role: "distributor", offenderRef: "SYNTH-DIST-01" },
    ],
  });
  assert.equal(r.shapeMatch, true);
  assert.deepEqual(r.matchedRoles, ["collector_hub", "distributor"]);
  assert.equal(r.evidenceGrade, "verified");
  assert.equal(r.repeatOffender, false);
});

test("repeat offender: prior fixture history on the same ref family", () => {
  const journal = [];
  const r = checkSerialOffenderHistory({
    candidateRoles: [{ role: "collector_hub", offenderRef: "SYNTH-COLL-02" }],
    history: [{ offender_ref: "SYNTH-COLL-01", matched_roles: ["collector_hub"], first_seen: NOW - 30 * 86_400_000, last_seen: NOW - 7 * 86_400_000, count: 2 }],
    nowMs: NOW,
    journal,
  });
  assert.equal(r.repeatOffender, true);
  assert.equal(r.priorCount, 2);
  assert.equal(r.firstSeen, NOW - 30 * 86_400_000);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "serial_offender_shape");
});

test("unknown roles do not match; no journal without a shape match", () => {
  const journal = [];
  const r = checkSerialOffenderHistory({
    candidateRoles: [{ role: "honest_broker", offenderRef: "SYNTH-H-01A" }],
    journal,
  });
  assert.equal(r.shapeMatch, false);
  assert.deepEqual(r.matchedRoles, []);
  assert.equal(r.evidenceGrade, null);
  assert.deepEqual(journal, []);
});

test("non-synthetic refs are rejected — including address-shaped ones", () => {
  for (const bad of ["member_123", "0x9d06abcdef0123456789abcdef0123456789abcdef", "", null]) {
    assert.throws(() => assertSyntheticRef(bad), (e) => e.code === "emissary_guard_non_synthetic_ref", `ref: ${bad}`);
  }
  assert.equal(assertSyntheticRef("SYNTH-COLL-01"), "SYNTH-COLL-01");
});

test("history rows with non-synthetic refs are rejected too", () => {
  assert.throws(
    () =>
      checkSerialOffenderHistory({
        candidateRoles: [{ role: "collector_hub", offenderRef: "SYNTH-COLL-01" }],
        history: [{ offender_ref: "0x9d06abcdef0123456789abcdef0123456789abcdef", matched_roles: ["collector_hub"], first_seen: 1, last_seen: 2, count: 1 }],
      }),
    (e) => e.code === "emissary_guard_non_synthetic_ref"
  );
});

test("WATCHLIST_SHAPES carries roles and grades only — no addresses, no identities", () => {
  const roles = WATCHLIST_SHAPES.map((s) => s.role).sort();
  assert.deepEqual(roles, ["cashout_destination", "collector_hub", "distribution_set", "distributor"]);
  assert.ok(WATCHLIST_SHAPES.every((s) => s.evidenceGrade === "verified" || s.evidenceGrade === "reported"));
  const raw = JSON.stringify(WATCHLIST_SHAPES);
  assert.doesNotMatch(raw, /0x[0-9a-fA-F]{40}/, "no full addresses in the shape table");
});

// --- 8. findings-only / purity -----------------------------------------------------------------

test("guard calls never mutate their input rows", () => {
  const rows = dropRows(11);
  const before = JSON.stringify(rows);
  checkDropRateLimit(rows, { memberId: "m1", venue: "x", nowMs: NOW });
  checkInviteMintCap(rows.map((r) => ({ issuer_member_id: r.issuer_member_id, minted_at: r.created_at })), { memberId: "m1", nowMs: NOW });
  checkIdentityCaps(rows, { memberId: "m1", nowMs: NOW });
  assert.equal(JSON.stringify(rows), before);
});

test("the guard module has no network capability by construction", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "server", "emissary-lure-guard.mjs"), "utf8");
  assert.doesNotMatch(src, /\bfetch\s*\(/, "no fetch");
  assert.doesNotMatch(src, /require\(["'](http|https|net)["']\)/, "no http/net requires");
  assert.doesNotMatch(src, /from ["']node:(http|https|net)["']/, "no http/net imports");
});
