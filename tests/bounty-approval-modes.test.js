// Unit tests for bounty approval modes (server/bounty-escrow.mjs).
//
// approvalMode is chosen at post time: "human" (default — the poster renders
// the acceptance verdict) or "agent" (the designated verifierId, an agent
// lane, renders it). The mode is pinned at fund time and gates both accept
// and reject: only the designated approver may settle the verdict.
//
// Same in-memory store double as tests/bounty-escrow.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, APPROVAL_MODES, convergeBountyDeployedSchema } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const INSTINCT = "id:agent/instinct"; // designated verifier lane
const CODEX = "id:agent/codex";

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// Post -> fund -> claim -> submit, with a chosen approval mode + verifier.
function runToSubmitted(escrow, { approvalMode = "human", verifier = null } = {}) {
  const bounty = post(escrow, { verifierId: verifier, approvalMode });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("approval modes are exactly human and agent", () => {
  assert.deepEqual([...APPROVAL_MODES], ["human", "agent"]);
});

test("human is the default approval mode", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, {});
  assert.equal(bounty.approvalMode, "human");
});

test("agent mode requires a verifierId", () => {
  const { escrow } = makeEscrow();
  expectCode(() => post(escrow, { approvalMode: "agent" }), "invalid_input");
});

test("unknown approvalMode is rejected", () => {
  const { escrow } = makeEscrow();
  expectCode(() => post(escrow, { approvalMode: "bogus" }), "invalid_input");
});

test("agent mode: the poster cannot accept, only the designated verifier", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { approvalMode: "agent", verifier: INSTINCT });
  assert.equal(bounty.approvalMode, "agent");
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() }), "not_authorized");
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: CODEX, verifierAttestation: attest() }), "not_authorized");
  const accepted = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: INSTINCT, verifierAttestation: attest() });
  assert.equal(accepted.bounty.state, "accepted");
  assert.equal(accepted.bounty.approvalMode, "agent");
});

test("human mode: the verifier cannot accept, only the poster", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { approvalMode: "human", verifier: INSTINCT });
  assert.equal(bounty.approvalMode, "human");
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: INSTINCT, verifierAttestation: attest() }), "not_authorized");
  const accepted = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() });
  assert.equal(accepted.bounty.state, "accepted");
});

test("reject follows the approval mode", () => {
  const { escrow } = makeEscrow();
  // Agent mode: the poster cannot reject; the designated verifier can.
  const agentBounty = runToSubmitted(escrow, { approvalMode: "agent", verifier: INSTINCT });
  expectCode(() => escrow.rejectWork(ROOM, agentBounty.bountyId,
    { rejector: JILL, reason: "nope" }), "not_authorized");
  const rejected = escrow.rejectWork(ROOM, agentBounty.bountyId,
    { rejector: INSTINCT, reason: "shoddy work" });
  assert.equal(rejected.settlement.kind, "failed");

  // Human mode: the verifier cannot reject; the poster can.
  const humanBounty = runToSubmitted(escrow, { approvalMode: "human", verifier: INSTINCT });
  expectCode(() => escrow.rejectWork(ROOM, humanBounty.bountyId,
    { rejector: INSTINCT, reason: "nope" }), "not_authorized");
  const rejected2 = escrow.rejectWork(ROOM, humanBounty.bountyId,
    { rejector: JILL, reason: "shoddy work" });
  assert.equal(rejected2.settlement.kind, "failed");
});

test("approval mode survives the full lifecycle unchanged", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { approvalMode: "agent", verifierId: INSTINCT });
  assert.equal(bounty.approvalMode, "agent");
  for (const seen of [
    escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }).bounty,
    escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }).bounty,
    escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence }).bounty,
    escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: INSTINCT, verifierAttestation: attest() }).bounty,
  ]) assert.equal(seen.approvalMode, "agent", `mode drifted at ${seen.state}`);
});

test("pre-mode submitted bounties retain both approvers through read-only refusal, migration and reopen", () => {
  const { escrow, db } = makeEscrow();
  const inherited = Array.from({ length: 4 }, () => runToSubmitted(escrow, { verifier: INSTINCT }));
  db.exec("ALTER TABLE bounty_records DROP COLUMN approval_mode");
  const snapshot = () => ({ schema: db.prepare("SELECT sql FROM sqlite_master WHERE name='bounty_records'").get().sql,
    journal: db.prepare("SELECT * FROM bounty_journal ORDER BY seq").all(),
    records: db.prepare("SELECT * FROM bounty_records ORDER BY bounty_id").all() });
  const before = snapshot();
  const reopened = makeEscrowWithoutGenesis(db);
  db.readOnlyTransaction = true;
  try { assert.throws(() => reopened.listBounties(ROOM), /missing columns: approval_mode/); }
  finally { db.readOnlyTransaction = false; }
  assert.deepEqual(snapshot(), before, "read-only refusal must not migrate or move credits");
  convergeBountyDeployedSchema(db);
  assert.deepEqual(snapshot().journal, before.journal);
  const current = makeEscrowWithoutGenesis(db);
  for (const bounty of inherited) assert.equal(current.getBounty(ROOM, bounty.bountyId).approvalMode, "legacy");
  expectCode(() => current.acceptWork(ROOM, inherited[0].bountyId, { acceptor: GROK, verifierAttestation: attest() }), "not_authorized");
  expectCode(() => current.rejectWork(ROOM, inherited[0].bountyId, { rejector: CODEX, reason: "unrelated" }), "not_authorized");
  assert.equal(current.acceptWork(ROOM, inherited[0].bountyId, { acceptor: INSTINCT, verifierAttestation: attest() }).bounty.state, "accepted");
  assert.equal(current.acceptWork(ROOM, inherited[1].bountyId, { acceptor: JILL, verifierAttestation: attest() }).bounty.state, "accepted");
  assert.equal(current.rejectWork(ROOM, inherited[2].bountyId, { rejector: INSTINCT, reason: "failed" }).settlement.kind, "failed");
  assert.equal(current.rejectWork(ROOM, inherited[3].bountyId, { rejector: JILL, reason: "failed" }).settlement.kind, "failed");
  const human = runToSubmitted(current, { verifier: INSTINCT });
  const agent = runToSubmitted(current, { approvalMode: "agent", verifier: INSTINCT });
  convergeBountyDeployedSchema(db);
  const final = makeEscrowWithoutGenesis(db);
  assert.equal(final.getBounty(ROOM, human.bountyId).approvalMode, "human");
  assert.equal(final.getBounty(ROOM, agent.bountyId).approvalMode, "agent");
  expectCode(() => final.acceptWork(ROOM, human.bountyId, { acceptor: INSTINCT, verifierAttestation: attest() }), "not_authorized");
  expectCode(() => final.rejectWork(ROOM, agent.bountyId, { rejector: JILL, reason: "wrong approver" }), "not_authorized");
  expectCode(() => post(final, { approvalMode: "legacy" }), "invalid_input");
  assert.equal(final.verifyConservation(ROOM).ok, true);
  db.close();
});

function makeEscrowWithoutGenesis(db) {
  const transaction = fn => {
    db.exec("SAVEPOINT approval_migration");
    try { const result = fn(); db.exec("RELEASE approval_migration"); return result; }
    catch (error) { db.exec("ROLLBACK TO approval_migration"); db.exec("RELEASE approval_migration"); throw error; }
  };
  return new BountyEscrow({ db, transaction, readTransaction: transaction }, { now: () => nowMs, allowLegacyStringLanes: true });
}

test("expanding an already explicit two-mode database never rewrites pinned choices", () => {
  const { escrow, db } = makeEscrow();
  const human = runToSubmitted(escrow, { verifier: INSTINCT });
  const agent = runToSubmitted(escrow, { approvalMode: "agent", verifier: INSTINCT });
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='bounty_records'").get().sql
    .replace("DEFAULT 'legacy'", "DEFAULT 'human'").replace("('legacy','human','agent')", "('human','agent')");
  db.exec("ALTER TABLE bounty_records RENAME TO records_two_modes");
  db.exec(ddl);
  db.exec("INSERT INTO bounty_records SELECT * FROM records_two_modes; DROP TABLE records_two_modes");
  const before = db.prepare("SELECT * FROM bounty_records ORDER BY bounty_id").all();
  convergeBountyDeployedSchema(db);
  assert.deepEqual(db.prepare("SELECT * FROM bounty_records ORDER BY bounty_id").all(), before);
  const current = makeEscrowWithoutGenesis(db);
  expectCode(() => current.acceptWork(ROOM, human.bountyId, { acceptor: INSTINCT, verifierAttestation: attest() }), "not_authorized");
  expectCode(() => current.acceptWork(ROOM, agent.bountyId, { acceptor: JILL, verifierAttestation: attest() }), "not_authorized");
  db.close();
});
