// W4 anonymiser unit tests. The bright-line proofs live here and in
// dataset-package.test.js: every never-licensed category is planted in a
// fixture and proven absent from the output — the line is code, not copy.
import test from "node:test";
import assert from "node:assert/strict";
import {
  anonymiseEpisodeForRows,
  anonymiseEpisodeForText,
  classifyEpisode,
  coarsenTimestamp,
  createPseudonymiser,
  createTextScrubber,
  memberCountBand,
  scanForLeaks,
  shingleOverlap,
  wordShingles,
} from "../server/dataset-anonymise.mjs";

const KEY = "w4-test-key-0123456789abcdef";

function episode(overrides = {}) {
  return {
    schema: "work-episode/1",
    recordId: "pwr_9f2c41aa77bd",
    surface: "public-work",
    roomId: "room_alpha_7f3d",
    cohort: "external",
    task: { specHash: "sha256:spec", criteriaHash: "sha256:crit", rubricVersion: "r3", rewardMillis: 2500, termsVersion: 2 },
    claim: { claimantRef: "mem_maria_81", claimedAt: "2026-10-01T10:24:31.000Z", leaseHours: 8, deliveryGeneration: 1 },
    delivery: { artefactHash: "sha256:art", artefactKind: "text", submittedAt: "2026-10-01T15:02:11.000Z", prUrl: "https://github.com/Uuriko/project-room/pull/4101" },
    verdicts: [{
      rowId: "dr_5511aa", subjectId: "mem_maria_81", verifierId: "mem_ken_22",
      decisionKind: "verify", outcome: "accepted", accepted: true, tier: "verified",
      rubricVersion: "r3", criteriaHash: "sha256:crit",
      criteriaOutcomes: [{ id: "c1", outcome: "pass" }, { id: "c2", outcome: "fail", note: "free text dropped by whitelist" }],
      decidedAt: "2026-10-01T16:40:00.000Z", submittedAt: "2026-10-01T15:02:11.000Z",
      sessionInstanceId: "sess_9911", authorizingPrincipalId: "acct_john_1",
      claimedModelVersion: "claude-x", claimedHarnessVersion: "harness-2",
    }],
    settlement: { journalEntryIds: ["je_1001", "je_1002"], netMillis: 2500, outcome: "paid" },
    dispute: null,
    provenance: { sessionInstanceId: "sess_9911", authorizingPrincipalId: "acct_john_1", claimedModelVersion: "claude-x", claimedHarnessVersion: "harness-2", claimedEnvironment: "cloud", stampSource: "declared" },
    outcomeLabel: null,
    retentionClass: "decision",
    ...overrides,
  };
}

const ctx = (over = {}) => ({
  pseudonymiser: createPseudonymiser({ key: KEY, packageId: "pkg-test" }),
  precision: "day",
  licence: "licensable",
  pooled: false,
  room: { memberCount: 7, surfaceMix: "public-work" },
  ...over,
});

test("pseudonyms are stable within a package, keyed, and never the raw id", () => {
  const a = createPseudonymiser({ key: KEY, packageId: "pkg-a" });
  const b = createPseudonymiser({ key: KEY, packageId: "pkg-b" });
  const c = createPseudonymiser({ key: "another-key-0123456789abcdef", packageId: "pkg-a" });
  assert.equal(a.actor("mem_maria_81"), a.actor("mem_maria_81"));
  assert.notEqual(a.actor("mem_maria_81"), b.actor("mem_maria_81"), "package domain separates");
  assert.notEqual(a.actor("mem_maria_81"), c.actor("mem_maria_81"), "key separates");
  assert.notEqual(a.actor("mem_maria_81"), a.room("mem_maria_81"), "kind domain separates");
  assert.match(a.actor("mem_maria_81"), /^ps_actor_[0-9a-f]{32}$/);
  assert.equal(a.actor(null), null);
  assert.throws(() => createPseudonymiser({ key: "short", packageId: "x" }), /at least 16/);
});

test("timestamps coarsen to hour or day; member bands are coarse", () => {
  assert.equal(coarsenTimestamp("2026-10-01T10:24:31.000Z", "hour"), "2026-10-01T10:00:00.000Z");
  assert.equal(coarsenTimestamp("2026-10-01T10:24:31.000Z", "day"), "2026-10-01T00:00:00.000Z");
  assert.equal(coarsenTimestamp(null, "day"), null);
  assert.equal(memberCountBand(2), "2");
  assert.equal(memberCountBand(7), "5-9");
});

test("classification: B4/B9 content classes exclude from every package", () => {
  for (const cls of ["dm", "inbox"]) {
    const v = classifyEpisode(episode({ contentClasses: [cls] }), {}, { packageClass: "internal" });
    assert.equal(v.include, false, cls);
    assert.equal(v.licence, "never");
  }
});

test("classification: B1/B8 exclude external, stamp licence:never internal; B7 excludes both", () => {
  const ep = episode();
  assert.equal(classifyEpisode(ep, { privateRoom: true }, { packageClass: "external" }).include, false);
  const internal = classifyEpisode(ep, { privateRoom: true }, { packageClass: "internal" });
  assert.equal(internal.include, true);
  assert.equal(internal.licence, "never");
  assert.equal(classifyEpisode(ep, { enterpriseNda: true }, { packageClass: "external" }).include, false);
  assert.equal(classifyEpisode(episode({ sensitive: true }), {}, { packageClass: "internal" }).include, false);
  assert.equal(classifyEpisode(ep, {}, { packageClass: "external" }).include, true);
});

test("Tier R: ids pseudonymised, names absent, roles and hashes kept, criteria text dropped", () => {
  const row = anonymiseEpisodeForRows(episode(), ctx());
  const s = JSON.stringify(row);
  for (const raw of ["mem_maria_81", "mem_ken_22", "room_alpha_7f3d", "pwr_9f2c41aa77bd", "je_1001", "sess_9911", "acct_john_1", "github.com"]) {
    assert.ok(!s.includes(raw), `raw value leaked: ${raw}`);
  }
  assert.equal(row.task.specHash, "sha256:spec");
  assert.equal(row.verdicts[0].outcome, "accepted");
  assert.equal(row.verdicts[0].tier, "verified", "tier carried verbatim (GQ-5)");
  assert.deepEqual(row.verdicts[0].criteriaOutcomes, [{ id: "c1", outcome: "pass" }, { id: "c2", outcome: "fail" }]);
  assert.equal(row.claim.claimedAt, "2026-10-01T00:00:00.000Z", "day precision for external");
  assert.equal(row.room.memberBand, "5-9");
  assert.ok(row.delivery.prRef.startsWith("ps_pr_"));
});

test("Tier R: dispute ships structured ruling only (B6)", () => {
  const ep = episode({
    dispute: { outcome: "upheld", reasonCodes: ["criterion-unmet"], deciderRef: "mem_ken_22", openedAt: "2026-10-02T09:00:00.000Z", resolvedAt: "2026-10-03T09:00:00.000Z" },
  });
  const row = anonymiseEpisodeForRows(ep, ctx());
  assert.deepEqual(row.dispute.reasonCodes, ["criterion-unmet"]);
  assert.ok(!("narrative" in row.dispute));
  assert.ok(row.dispute.decider.startsWith("ps_actor_"));
});

test("Tier T scrubber: dictionary names/handles, emails, URLs, phones become placeholders", () => {
  const scrubber = createTextScrubber({
    people: [{ names: ["Maria Chen"], handles: ["mariachen-dev"] }],
  });
  const out = scrubber.scrub(
    "Maria Chen (mariachen-dev) emailed maria.chen@example.com via https://example.com/x or +1 415 555 0132; ask @mariachen-dev or Maria again.");
  assert.ok(!out.includes("Maria"), out);
  assert.ok(!out.includes("mariachen-dev"), out);
  assert.ok(!out.includes("@"), out);
  assert.ok(!out.includes("example.com"), out);
  assert.ok(!out.includes("415"), out);
  assert.ok(out.includes("[EMAIL]") && out.includes("[URL]") && out.includes("[PHONE]"), out);
  const first = out.match(/\[PERSON-\d+\]/g);
  assert.ok(first.length >= 3 && new Set(first).size === 1, "same person, same placeholder within the package");
  assert.ok(!out.includes("Maria"), "bare first-name usage is scrubbed too (name-part dictionary terms)");
});

test("Tier T scrubber: room terms in free text become [ROOM] (red-team finding)", () => {
  const scrubber = createTextScrubber({ people: [], roomTerms: ["room_big", "Acme Client Room"] });
  const out = scrubber.scrub("Work for the room_big workstream and the Acme Client Room board.");
  assert.ok(!out.includes("room_big") && !out.includes("Acme"), out);
  assert.equal((out.match(/\[ROOM\]/g) ?? []).length, 2, out);
});

test("Tier T builder: memo, history notes and dispute narrative are never emitted; draft artefact withheld (B5/B6)", () => {
  const scrubber = createTextScrubber({ people: [] });
  const ep = episode({
    delivery: { artefactHash: "sha256:art", artefactKind: "text", submittedAt: "2026-10-01T15:02:11.000Z", draft: true },
    texts: {
      spec: "Build the thing.",
      artefact: "DRAFT SECRET TEXT",
      memo: "MEMO SECRET TEXT",
      historyNotes: "NOTE SECRET TEXT",
      disputeNarrative: "NARRATIVE SECRET TEXT",
    },
  });
  const rec = anonymiseEpisodeForText(ep, { ...ctx(), scrubber });
  const s = JSON.stringify(rec);
  for (const secret of ["MEMO SECRET", "NOTE SECRET", "NARRATIVE SECRET", "DRAFT SECRET"]) {
    assert.ok(!s.includes(secret), `never-emitted field leaked: ${secret}`);
  }
  assert.deepEqual(rec.withheldFields, ["artefact:draft"]);
  assert.equal(rec.spec, "Build the thing.");
});

test("scanForLeaks catches raw ids, names, emails and secret shapes; clean output passes", () => {
  const people = [{ names: ["Maria Chen"], handles: ["mariachen-dev"] }];
  assert.equal(scanForLeaks("nothing to see", { people, rawIds: ["pwr_9f2c41aa77bd"] }).length, 0);
  assert.ok(scanForLeaks("see pwr_9f2c41aa77bd", { people, rawIds: ["pwr_9f2c41aa77bd"] }).some(h => h.kind === "raw-id"));
  assert.ok(scanForLeaks("Maria Chen did it", { people }).some(h => h.kind === "person-term"));
  assert.ok(scanForLeaks("a@b.co", { people }).some(h => h.kind === "email"));
  assert.ok(scanForLeaks("tok ghp_abcdefgh12345678", { people }).some(h => h.kind === "secret-shape"));
  // Dates and coarsened timestamps must NOT trip the phone check.
  assert.equal(scanForLeaks("at 2026-10-01T00:00:00.000Z", { people }).filter(h => h.kind === "phone").length, 0);
  // Neither may a >=10-digit run embedded in a hex pseudonym/hash (red-team
  // false positive at package scale) — but a delimited phone still trips it.
  assert.equal(scanForLeaks("ps_actor_1234567890abcdef1234567890ab", { people }).filter(h => h.kind === "phone").length, 0);
  assert.ok(scanForLeaks("call +1 415 555 0132 today", { people }).some(h => h.kind === "phone"));
});

test("shingle overlap: identical text = 1, disjoint text = 0", () => {
  const text = "the quick brown fox jumps over the lazy dog near the river bank today";
  assert.equal(shingleOverlap(text, text), 1);
  assert.equal(shingleOverlap(text, "completely different words about cooking rice and beans"), 0);
  assert.equal(wordShingles("short text").size, 0);
});
