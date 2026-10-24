// W4 packager tests: U5 filters, bright-line exclusions end-to-end, cohort
// pooling, amount banding, the six quality gates, and manifest honesty.
import test from "node:test";
import assert from "node:assert/strict";
import { journalEntryHash } from "../server/bounty-escrow.mjs";
import {
  buildDatasetPackage,
  classifyRiskStratum,
  gateJournalIntegrity,
  peopleFromSnapshotTables,
  visibilityFromSnapshotTables,
} from "../server/dataset-package.mjs";

const KEY = "w4-test-key-0123456789abcdef";
const PEOPLE = [
  { names: ["Maria Chen"], handles: ["mariachen-dev"] },
  { names: ["Ken Watanabe"], handles: [] },
];

function ep(recordId, roomId, over = {}) {
  return {
    schema: "work-episode/1",
    recordId,
    surface: "bounty",
    roomId,
    cohort: "external",
    task: { specHash: "sha256:spec", criteriaHash: "sha256:crit", rubricVersion: "r3", rewardMillis: 2500, termsVersion: 1 },
    claim: { claimantRef: "mem_1", claimedAt: "2026-10-01T10:24:31.000Z", leaseHours: 8, deliveryGeneration: 1 },
    delivery: { artefactHash: "sha256:art", artefactKind: "text", submittedAt: "2026-10-01T15:02:11.000Z" },
    verdicts: [{
      rowId: `dr_${recordId}`, subjectId: "mem_1", verifierId: "mem_2", decisionKind: "verify",
      outcome: "accepted", accepted: true, tier: "verified", rubricVersion: "r3", criteriaHash: "sha256:crit",
      criteriaOutcomes: [{ id: "c1", outcome: "pass" }],
      decidedAt: "2026-10-01T16:40:00.000Z", submittedAt: "2026-10-01T15:02:11.000Z",
    }],
    settlement: { journalEntryIds: [`je_${recordId}`], netMillis: 2500, outcome: "paid" },
    dispute: null,
    provenance: { sessionInstanceId: `sess_${recordId}`, authorizingPrincipalId: "mem_3", claimedModelVersion: "claude-x", claimedHarnessVersion: "h2", claimedEnvironment: "cloud", stampSource: "declared" },
    outcomeLabel: null,
    retentionClass: "decision",
    ...over,
  };
}

// Six distinct actors rotate through the alpha room so it clears the cohort.
function alphaEpisodes() {
  const eps = [];
  for (let i = 0; i < 3; i += 1) {
    eps.push(ep(`bounty_a${i}`, "room_alpha_7f3d", {
      claim: { claimantRef: `mem_${1 + i}`, claimedAt: "2026-10-01T10:24:31.000Z", leaseHours: 8, deliveryGeneration: 1 },
      verdicts: [{
        rowId: `dr_a${i}`, subjectId: `mem_${1 + i}`, verifierId: `mem_${4 + i}`, decisionKind: "verify",
        outcome: "accepted", accepted: true, tier: "verified", rubricVersion: "r3", criteriaHash: "sha256:crit",
        criteriaOutcomes: [{ id: "c1", outcome: "pass" }],
        decidedAt: "2026-10-01T16:40:00.000Z", submittedAt: "2026-10-01T15:02:11.000Z",
      }],
    }));
  }
  return eps;
}

const ROOMS = {
  room_alpha_7f3d: { memberCount: 6, surfaceMix: "bounty" },
  room_small_22: { memberCount: 2, surfaceMix: "bounty" },
  room_nda_99: { memberCount: 9, enterpriseNda: true },
  room_priv_55: { memberCount: 8, privateRoom: true },
  room_off_33: { memberCount: 8 },
};

function baseInput(over = {}) {
  return {
    episodes: alphaEpisodes(),
    rooms: ROOMS,
    people: PEOPLE,
    visibility: { unpublishedRooms: new Set(), unpublishedRecords: new Set(), receiptsOffRooms: new Set() },
    key: KEY,
    packageId: "pkg-test-1",
    packageClass: "external",
    tiers: ["R"],
    builtAt: "2026-10-18T00:00:00.000Z",
    ...over,
  };
}

test("visibility builder mirrors the read model: recorded OFF hides, never-recorded does not", () => {
  const vis = visibilityFromSnapshotTables({
    public_unpublish: [{ kind: "room", target: "room_x" }, { kind: "receipt", target: "rec_1" }],
    room_directory_settings: [{ room_id: "room_y", public_receipts: 0 }, { room_id: "room_z", public_receipts: 1 }],
    room_public_receipts_setting: [{ room_id: "room_w", enabled: 0 }, { room_id: "room_v", enabled: 1 }],
  });
  assert.ok(vis.unpublishedRooms.has("room_x"));
  assert.ok(vis.unpublishedRecords.has("rec_1"));
  assert.ok(vis.receiptsOffRooms.has("room_y") && vis.receiptsOffRooms.has("room_w"));
  assert.ok(!vis.receiptsOffRooms.has("room_z") && !vis.receiptsOffRooms.has("room_v"));
  const people = peopleFromSnapshotTables(
    { accounts: [{ id: "acct_1", display_name: "Maria Chen" }], agent_identities: [{ identity_id: "ai_1", display_name: "Bot" }] },
    { acct_1: ["mariachen-dev"] });
  assert.equal(people.find(p => p.names.includes("Maria Chen")).handles[0], "mariachen-dev");
});

test("U5: receipts-off rooms and unpublished records are dropped before anonymisation", () => {
  const eps = [...alphaEpisodes(), ep("bounty_off", "room_off_33"), ep("bounty_unpub", "room_alpha_7f3d")];
  const visibility = {
    unpublishedRooms: new Set(),
    unpublishedRecords: new Set(["bounty_unpub"]),
    receiptsOffRooms: new Set(["room_off_33"]),
  };
  const { manifest } = buildDatasetPackage(baseInput({ episodes: eps, visibility }));
  assert.equal(manifest.counts.droppedU5, 2);
  assert.equal(manifest.counts.rowsOut, 3);
});

test("bright lines end-to-end: NDA and private rooms never reach an external package", () => {
  const eps = [...alphaEpisodes(), ep("bounty_nda", "room_nda_99"), ep("bounty_priv", "room_priv_55"),
    ep("bounty_dm", "room_alpha_7f3d", { contentClasses: ["dm"] })];
  const ext = buildDatasetPackage(baseInput({ episodes: eps }));
  assert.equal(ext.manifest.counts.rowsOut, 3);
  assert.equal(ext.manifest.counts.droppedBrightLine.B8, 1);
  assert.equal(ext.manifest.counts.droppedBrightLine.B1, 1);
  assert.equal(ext.manifest.counts.droppedBrightLine.B4, 1);
  const internal = buildDatasetPackage(baseInput({ episodes: eps, packageClass: "internal", packageId: "pkg-int" }));
  assert.equal(internal.manifest.counts.rowsOut, 5, "3 public + private + NDA ship internally; the DM episode never does");
  const neverRows = internal.rows.filter(r => r.licence === "never");
  assert.equal(neverRows.length, 2, "internal private/NDA rows are stamped licence:never");
});

test("cohort: a 2-actor room is pooled externally with attributes stripped", () => {
  const small = ep("bounty_small", "room_small_22", {
    claim: { claimantRef: "mem_1", claimedAt: "2026-10-01T10:24:31.000Z", leaseHours: 8, deliveryGeneration: 1 },
    verdicts: [{
      rowId: "dr_small", subjectId: "mem_1", verifierId: "mem_2", decisionKind: "verify", outcome: "accepted",
      accepted: true, tier: "verified", rubricVersion: "r3", criteriaHash: "sha256:crit",
      criteriaOutcomes: [{ id: "c1", outcome: "pass" }], decidedAt: "2026-10-01T16:40:00.000Z", submittedAt: "2026-10-01T15:02:11.000Z",
    }],
    provenance: { sessionInstanceId: "sess_small", authorizingPrincipalId: "mem_2", claimedModelVersion: "claude-x", claimedHarnessVersion: "h2", claimedEnvironment: "cloud", stampSource: "declared" },
  });
  const { rows, manifest } = buildDatasetPackage(baseInput({ episodes: [...alphaEpisodes(), small] }));
  const pooledRow = rows.find(r => r.room.ref === "room_pooled");
  assert.ok(pooledRow);
  assert.equal(pooledRow.room.memberBand, null);
  assert.equal(manifest.counts.pooledEpisodes, 1);
  assert.equal(manifest.gates.find(g => g.id === "GQ-4").status, "pass");
});

test("unique amounts are banded in external packages, kept internally", () => {
  const rich = ep("bounty_rich", "room_alpha_7f3d", {
    settlement: { journalEntryIds: ["je_rich"], netMillis: 777777, outcome: "paid" },
  });
  const ext = buildDatasetPackage(baseInput({ episodes: [...alphaEpisodes(), rich] }));
  const richRow = ext.rows.find(r => r.settlement && r.settlement.netMillis === null);
  assert.ok(richRow && richRow.settlement.netBand === "100k+", "unique amount banded");
  const sharedRow = ext.rows.find(r => r.settlement && r.settlement.netMillis === 2500);
  assert.ok(sharedRow, "amount shared by 3 episodes is not unique and survives");
  const internal = buildDatasetPackage(baseInput({ episodes: [...alphaEpisodes(), rich], packageClass: "internal", packageId: "pkg-int2" }));
  assert.ok(internal.rows.some(r => r.settlement?.netMillis === 777777));
});

test("GQ-1: a valid journal chain passes; a tampered entry fails the package", () => {
  const e1 = { entry_id: "je_1", account_id: "acct_pool", prev_hash: "GENESIS", at: 1000, kind: "hold", bounty_id: "b1", lot_id: "", amount: 100, lot_state: "open", memo: "", actor_kind: "system", actor_id: "keeper" };
  e1.hash = journalEntryHash(e1);
  const e2 = { ...e1, entry_id: "je_2", prev_hash: e1.hash, at: 2000, amount: 100 };
  e2.hash = journalEntryHash(e2);
  assert.equal(gateJournalIntegrity([e1, e2]).status, "pass");
  const tampered = { ...e2, amount: 999 };
  assert.equal(gateJournalIntegrity([e1, tampered]).status, "fail");
  const { manifest } = buildDatasetPackage(baseInput({ journalEntries: [e1, tampered] }));
  assert.equal(manifest.status, "FAILED");
  assert.equal(manifest.gates.find(g => g.id === "GQ-1").status, "fail");
});

test("GQ-2: verdicts without a task/delivery join above the bound fail the package", () => {
  const orphan = ep("bounty_orphan", "room_alpha_7f3d", { task: null, delivery: null });
  const { manifest } = buildDatasetPackage(baseInput({ episodes: [orphan] }));
  assert.equal(manifest.gates.find(g => g.id === "GQ-2").status, "fail");
  assert.equal(manifest.status, "FAILED");
});

test("GQ-3: a dictionary name surviving into output fails the package (honest gate)", () => {
  const leaky = ep("bounty_leak", "room_alpha_7f3d", {
    provenance: { sessionInstanceId: "sess_leak", authorizingPrincipalId: "mem_3", claimedModelVersion: "claude-x", claimedHarnessVersion: "Maria Chen", claimedEnvironment: "cloud", stampSource: "declared" },
  });
  const { manifest } = buildDatasetPackage(baseInput({ episodes: [...alphaEpisodes(), leaky] }));
  assert.equal(manifest.gates.find(g => g.id === "GQ-3").status, "fail");
  assert.equal(manifest.status, "FAILED");
});

test("Tier T: text package scrubs canaries, requires the manual gate externally, demotes public-verbatim text", () => {
  const publicText = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
  const withText = ep("bounty_text", "room_alpha_7f3d", {
    texts: {
      spec: "Maria Chen asked for the parser fix; reach maria.chen@example.com.",
      verdictReasons: { dr_bounty_text: "Ken Watanabe confirmed the artefact matches the rubric." },
    },
  });
  const verbatim = ep("bounty_verb", "room_alpha_7f3d", { texts: { spec: publicText } });
  const input = baseInput({
    episodes: [...alphaEpisodes(), withText, verbatim],
    tiers: ["R", "T"],
    publicCorpusTexts: [publicText],
  });
  const noReview = buildDatasetPackage(input);
  assert.equal(noReview.manifest.gates.find(g => g.id === "GQ-3").status, "fail",
    "external Tier T without a manual sample review must fail closed");
  assert.equal(noReview.manifest.counts.demotedRowsOnly, 1, "public-verbatim episode demoted to rows-only");
  const required = noReview.auditSample.textReviewRequired;
  assert.ok(required.length >= 1, "the R9 sample names the text records the reviewer must cover");
  const partial = buildDatasetPackage({
    ...input,
    manualReview: { reviewer: "op_reviewer_1", sampledRecordIds: required.slice(1), verdict: "pass" },
  });
  assert.equal(partial.manifest.gates.find(g => g.id === "GQ-3").status, "fail",
    "a review missing a required (risk-sampled) record fails");
  const reviewed = buildDatasetPackage({
    ...input,
    manualReview: { reviewer: "op_reviewer_1", sampledRecordIds: required, verdict: "pass" },
  });
  assert.equal(reviewed.manifest.gates.find(g => g.id === "GQ-3").status, "pass");
  const textOut = reviewed.files.get("text.ndjson");
  assert.ok(!textOut.includes("Maria") && !textOut.includes("Watanabe") && !textOut.includes("example.com"), textOut);
  assert.ok(textOut.includes("[PERSON-1]"), textOut);
  assert.ok(!textOut.includes("foxtrot"), "demoted text must not ship");
});

test("R9 audit sampling: strata from risk signals, high stratum fully sampled, deterministic", () => {
  const selfReview = ep("bounty_selfrev", "room_alpha_7f3d", {
    verdicts: [{
      rowId: "dr_selfrev", subjectId: "mem_1", verifierId: "mem_1", decisionKind: "verify", outcome: "accepted",
      accepted: true, tier: "self_attested", rubricVersion: "r3", criteriaHash: "sha256:crit",
      criteriaOutcomes: [{ id: "c1", outcome: "pass" }], decidedAt: "2026-10-01T16:40:00.000Z", submittedAt: "2026-10-01T15:02:11.000Z",
    }],
  });
  const disputed = ep("bounty_disputed", "room_alpha_7f3d", {
    dispute: { outcome: "dismissed", reasonCodes: ["late"], deciderRef: "mem_9", openedAt: "2026-10-02T09:00:00.000Z", resolvedAt: "2026-10-03T09:00:00.000Z" },
  });
  assert.equal(classifyRiskStratum(selfReview, new Map()), "high");
  assert.equal(classifyRiskStratum(disputed, new Map()), "medium");
  const eps = [...alphaEpisodes(), selfReview, disputed];
  const a = buildDatasetPackage(baseInput({ episodes: eps }));
  const b = buildDatasetPackage(baseInput({ episodes: eps }));
  const sample = a.manifest.auditSample;
  assert.equal(sample.strata.high.episodes, 1, "self-review is the one high-stratum episode");
  assert.equal(sample.strata.high.sampled, 1, "high stratum sampled at 100%");
  assert.ok(sample.strata.medium.episodes >= 1, "the disputed episode lands in a risk stratum");
  assert.deepEqual(a.auditSample.sampledRefs, b.auditSample.sampledRefs, "sample is deterministic across builds");
  assert.ok(a.files.get("DATASHEET.md").includes("Audit sampling"), "datasheet documents the R9 sampling");
});

test("package files: manifest, datasheet and extract log are emitted; build is reproducible (GQ-6)", () => {
  const { files, manifest, extractLog } = buildDatasetPackage(baseInput());
  for (const name of ["rows.ndjson", "manifest.json", "DATASHEET.md", "extract-log.json"]) {
    assert.ok(files.has(name), name);
  }
  assert.equal(manifest.status, "built");
  assert.equal(manifest.gates.find(g => g.id === "GQ-6").status, "pass");
  assert.equal(extractLog.schema, "dataset-extract-log/1");
  assert.ok(files.get("DATASHEET.md").includes("GQ-5"), "datasheet carries gate results");
  const again = buildDatasetPackage(baseInput());
  assert.equal(again.files.get("rows.ndjson"), files.get("rows.ndjson"), "byte-identical rebuild");
});
