// Slice 6 (integration map #6): pinned versioned rubrics on bounty_records.
//
// Rubrics pin the acceptance criteria at post time (v1), re-pinnable by the
// poster only while PROPOSED. Acceptance verdicts must cite every pinned
// criterion with a pass|fail verdict; arbiters may re-check against the
// pinned version at dispute decision time.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, canonicalRubric, rubricHashOf, defaultRubricFor,
  citationsAgainstRubric, convergeBountyDeployedSchema, bountyEscrowSchema } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";       // poster
const GROK = "id:agent/grokbot";    // worker
const INSTINCT = "id:agent/instinct"; // designated verifier / decider
const CODEX = "id:agent/codex";       // challenger lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const RUBRIC = [
  { criterionId: "correctness", description: "the fix resolves the reported bug" },
  { criterionId: "tests", description: "regression tests cover the fix" },
];
const CITED = [
  { criterionId: "correctness", verdict: "pass" },
  { criterionId: "tests", verdict: "pass" },
];
const ev = () => ({ evidenceUrl: "https://example.com/pr/1", summary: "did the thing" });
const att = citations => ({ at: new Date(nowMs).toISOString(), note: "lgtm", citations });

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const fund = (escrow, b) => escrow.fundBounty(ROOM, b.bountyId, { funder: JILL });
const claim = (escrow, b) => escrow.claimBounty(ROOM, b.bountyId, { claimant: GROK });
const submit = (escrow, b) => escrow.submitWork(ROOM, b.bountyId, { claimant: GROK, evidence: ev() });
const accept = (escrow, b, citations = CITED) =>
  escrow.acceptWork(ROOM, b.bountyId, { acceptor: JILL, verifierAttestation: att(citations) });

test("post pins an explicit rubric at v1 with a stable hash", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC });
  assert.equal(bounty.rubric.version, 1);
  assert.equal(bounty.rubric.hash, rubricHashOf(canonicalRubric(RUBRIC)));
  assert.deepEqual(bounty.rubric.criteria, canonicalRubric(RUBRIC));
  // Canonicalization sorts by criterionId: input order does not matter.
  const shuffled = post(escrow, { rubric: [...RUBRIC].reverse() });
  assert.equal(shuffled.rubric.hash, bounty.rubric.hash);
  assert.deepEqual(shuffled.rubric.criteria, bounty.rubric.criteria);
});

test("post without a rubric pins the default derived v1", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { criteria: "ship the thing" });
  assert.equal(bounty.rubric.version, 1);
  assert.deepEqual(bounty.rubric.criteria, defaultRubricFor("ship the thing"));
  assert.equal(bounty.rubric.hash, rubricHashOf(defaultRubricFor("ship the thing")));
});

test("rubric validation: empty, duplicate ids, bad shapes fail closed", () => {
  const { escrow } = makeEscrow();
  const base = { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) };
  expectCode(() => escrow.postBounty(ROOM, { ...base, rubric: [] }), "invalid_input");
  expectCode(() => escrow.postBounty(ROOM, { ...base, rubric: "nope" }), "invalid_input");
  expectCode(() => escrow.postBounty(ROOM, { ...base,
    rubric: [{ criterionId: "a", description: "x" }, { criterionId: "a", description: "y" }] }), "invalid_input");
  expectCode(() => escrow.postBounty(ROOM, { ...base, rubric: [{ criterionId: "", description: "x" }] }), "invalid_input");
  expectCode(() => escrow.postBounty(ROOM, { ...base, rubric: [{ criterionId: "a", description: "" }] }), "invalid_input");
});

test("updateRubric re-pins v+1 pre-funding; history is preserved", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC });
  const v2 = [{ criterionId: "correctness", description: "the fix resolves the bug, v2 wording" },
    { criterionId: "tests", description: "regression tests cover the fix" }];
  const updated = escrow.updateRubric(ROOM, bounty.bountyId, { poster: JILL, rubric: v2 }).bounty;
  assert.equal(updated.rubric.version, 2);
  assert.equal(updated.rubric.hash, rubricHashOf(canonicalRubric(v2)));
  // The old version is still readable for arbiter re-checks.
  const v1 = escrow.getRubricVersion(ROOM, bounty.bountyId, 1);
  assert.equal(v1.version, 1);
  assert.equal(v1.hash, rubricHashOf(canonicalRubric(RUBRIC)));
  const current = escrow.getRubricVersion(ROOM, bounty.bountyId);
  assert.equal(current.version, 2);
  // Unchanged rubric is a no-op rejection, not a new version.
  expectCode(() => escrow.updateRubric(ROOM, bounty.bountyId, { poster: JILL, rubric: v2 }), "invalid_input");
});

test("updateRubric is poster-only and frozen once funded", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC });
  expectCode(() => escrow.updateRubric(ROOM, bounty.bountyId, { poster: GROK, rubric: RUBRIC }), "not_authorized");
  fund(escrow, bounty);
  expectCode(() => escrow.updateRubric(ROOM, bounty.bountyId, { poster: JILL, rubric: RUBRIC }), "invalid_state");
});

test("accept requires a citation per pinned criterion with pass|fail verdicts", () => {
  const { escrow } = makeEscrow();
  const run = citations => {
    const b = post(escrow, { rubric: RUBRIC });
    fund(escrow, b); claim(escrow, b); submit(escrow, b);
    return () => escrow.acceptWork(ROOM, b.bountyId, { acceptor: JILL, verifierAttestation: att(citations) });
  };
  expectCode(run(undefined), "missing_citations");
  expectCode(run([]), "missing_citations");
  expectCode(run([{ criterionId: "correctness", verdict: "pass" }]), "missing_citations"); // tests uncited
  expectCode(run([...CITED, { criterionId: "nope", verdict: "pass" }]), "unknown_criterion");
  expectCode(run(CITED.map(c => ({ ...c, verdict: "maybe" }))), "invalid_input");
  // A fail verdict is still a legal citation (the work can be accepted with
  // a recorded fail — the dispute machine is the challenge path).
  const b = post(escrow, { rubric: RUBRIC });
  fund(escrow, b); claim(escrow, b); submit(escrow, b);
  const accepted = escrow.acceptWork(ROOM, b.bountyId, { acceptor: JILL,
    verifierAttestation: att([{ criterionId: "correctness", verdict: "pass" },
      { criterionId: "tests", verdict: "fail" }]) }).bounty;
  assert.deepEqual(accepted.attestation.citations,
    [{ criterionId: "correctness", verdict: "pass" }, { criterionId: "tests", verdict: "fail" }]);
  assert.equal(accepted.attestation.rubricVersion, 1);
  assert.equal(accepted.attestation.rubricHash, accepted.rubric.hash);
});

test("citations cite the version pinned at accept time, not a later re-pin", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC });
  const v2 = [{ criterionId: "correctness", description: "v2" }, { criterionId: "docs", description: "v2 docs" }];
  escrow.updateRubric(ROOM, bounty.bountyId, { poster: JILL, rubric: v2 });
  fund(escrow, bounty); claim(escrow, bounty); submit(escrow, bounty);
  // v1 citations are now stale: the pin is v2.
  expectCode(() => accept(escrow, bounty, CITED), "unknown_criterion");
  const v2cited = [{ criterionId: "correctness", verdict: "pass" }, { criterionId: "docs", verdict: "pass" }];
  const accepted = accept(escrow, bounty, v2cited).bounty;
  assert.equal(accepted.attestation.rubricVersion, 2);
  assert.equal(accepted.attestation.rubricHash, accepted.rubric.hash);
});

test("decideDispute records the arbiter's rubric re-check against the pinned version", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC, verifierId: INSTINCT });
  fund(escrow, bounty); claim(escrow, bounty); submit(escrow, bounty);
  accept(escrow, bounty);
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "shoddy" });
  // The seated decider is the designated verifier (INSTINCT).
  const decided = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["duplicate-work"], rubricCheck: CITED });
  assert.deepEqual(decided.resolution.rubricCheck.citations, CITED);
  assert.equal(decided.resolution.rubricCheck.rubricVersion, 1);
  assert.equal(decided.resolution.rubricCheck.rubricHash, bounty.rubric.hash);
  assert.equal(decided.resolution.rubricCheck.by, INSTINCT);
});

test("decideDispute rejects a rubric re-check citing an unknown criterion", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC, verifierId: INSTINCT });
  fund(escrow, bounty); claim(escrow, bounty); submit(escrow, bounty);
  accept(escrow, bounty);
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "shoddy" });
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["duplicate-work"],
      rubricCheck: [{ criterionId: "nope", verdict: "pass" }] }), "unknown_criterion");
  // ...and omitting the re-check entirely still rules fine.
  const decided = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["duplicate-work"] });
  assert.equal(decided.resolution.rubricCheck, undefined);
});

test("citationsAgainstRubric is order-insensitive and freezes its output", () => {
  const rubric = { version: 3, hash: "abc", criteria: canonicalRubric(RUBRIC) };
  const out = citationsAgainstRubric([...CITED].reverse(), rubric);
  assert.deepEqual([...out].sort((a, b) => a.criterionId < b.criterionId ? -1 : 1), CITED);
  assert.ok(Object.isFrozen(out));
});

test("convergence backfills v1 pins onto legacy bounty rows and keeps verifySchema green", () => {
  // Simulate a pre-slice-6 database: the old bounty_records DDL (no rubric
  // columns), one legacy bounty row, plus the current journal DDL so only
  // bounty_records drifts. Chunks are dropped the same way the module
  // splits them, so no partial DDL survives.
  const legacySchema = bountyEscrowSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
    .filter(sql => !sql.includes("bounty_rubric_versions"))
    .map(sql => sql
      .replace("    rubric_json TEXT,\n", "")
      .replace("    rubric_hash TEXT,\n", "")
      .replace("    rubric_version INTEGER,\n", ""))
    .join(";\n") + ";";
  const db = new DatabaseSync(":memory:");
  db.exec(legacySchema);
  const at = new Date(nowMs).toISOString();
  db.prepare(`INSERT INTO bounty_records (bounty_id, room_id, title, criteria, amount_millis, poster,
      state, state_changed_ms, deadline_ms, created_at, updated_at)
    VALUES ('ROOM-1', ?, 'T', 'legacy criteria text', 10000, ?, 'funded', ?, ?, ?, ?)`)
    .run(ROOM, JILL, nowMs, nowMs + 3_600_000, at, at);
  convergeBountyDeployedSchema(db);
  // The legacy row got the default derived v1 pin, recorded in history.
  const row = db.prepare("SELECT rubric_json, rubric_hash, rubric_version FROM bounty_records WHERE bounty_id='ROOM-1'").get();
  assert.equal(row.rubric_version, 1);
  assert.deepEqual(JSON.parse(row.rubric_json), defaultRubricFor("legacy criteria text"));
  assert.equal(row.rubric_hash, rubricHashOf(defaultRubricFor("legacy criteria text")));
  const hist = db.prepare("SELECT version, rubric_hash FROM bounty_rubric_versions WHERE bounty_id='ROOM-1'").all();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].version, 1);
  // The rebuilt table's index survived, and the strict DDL check passes.
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='bounty_records_room'").get();
  assert.ok(idx, "bounty_records_room index recreated");
  const transaction = fn => fn();
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction }, { now: () => nowMs });
  assert.equal(escrow.verifySchema(), true);
  // The converged legacy bounty accepts against its backfilled pin.
  const bounty = escrow.getBounty(ROOM, "ROOM-1");
  assert.equal(bounty.rubric.version, 1);
  assert.deepEqual(bounty.rubric.criteria, defaultRubricFor("legacy criteria text"));
});

test("convergence is a no-op on an already-converged database", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow, { rubric: RUBRIC });
  convergeBountyDeployedSchema(db);
  convergeBountyDeployedSchema(db);
  assert.equal(escrow.verifySchema(), true);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).rubric.hash, bounty.rubric.hash);
});
