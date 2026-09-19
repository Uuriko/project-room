// RC-2026-09-19-062: typed handoff envelopes — validator, builder, and the
// room-scoped journal, exercised against an in-memory sqlite database. The
// journal raises ServiceError (422/404/409) so the codes hold in unit tests
// and over HTTP alike.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handoffEnvelope, startEnvelope, handoffEnvelopeVersion, envelopeStatuses, envelopeTransitions,
  handoffEnvelopeSchema, HandoffEnvelopeJournal, HandoffError } from "../server/work-handoff.mjs";

const NOW = 1729219200000; // 2024-10-18T00:00:00Z
const iso = ms => new Date(ms).toISOString();
const HOUR = 3600 * 1000;

const fields = (overrides = {}) => ({
  to: "agent-b",
  objective: "Summarize the thread and draft a reply",
  inputs: [{ kind: "message", ref: "msg-1", label: "the thread" }],
  authority: { permissions: ["accept_work", "complete_work"], scope: { rooms: ["room-1"] }, expiresAt: iso(NOW + 24 * HOUR) },
  expectedOutput: { kind: "text_result", description: "A draft reply of at most 500 words" },
  acceptanceTest: { checks: [{ kind: "result_submitted", workId: "work-1" }] },
  termination: { expiresAt: iso(NOW + 24 * HOUR), onExpiry: "release", escalateTo: null },
  provenance: { createdBy: "agent-a", claimId: "RC-2026-09-19-062", taskId: "work-1", chain: [] },
  ...overrides,
});
const journalFields = (overrides = {}) => {
  const f = fields(overrides);
  delete f.provenance.createdBy; // the journal stamps createdBy from the sender
  return f;
};
const expectEnvelopeCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const validRecord = (overrides = {}) => handoffEnvelope({ envelopeVersion: handoffEnvelopeVersion,
  id: "he_1", from: "agent-a", createdAt: iso(NOW), ...fields(overrides) });

const makeJournal = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(handoffEnvelopeSchema);
  const store = { db, transaction: fn => fn(), readTransaction: fn => fn(), now: () => NOW };
  return new HandoffEnvelopeJournal(store);
};

// ---- validator ----

test("a complete envelope validates and freezes", () => {
  const envelope = validRecord();
  assert.equal(envelope.envelopeVersion, 1);
  assert.equal(envelope.objective, fields().objective);
  assert.ok(Object.isFrozen(envelope) && Object.isFrozen(envelope.inputs) && Object.isFrozen(envelope.authority)
    && Object.isFrozen(envelope.authority.permissions) && Object.isFrozen(envelope.provenance));
  assert.throws(() => { envelope.objective = "x"; }, TypeError);
});

test("all seven sections are required", () => {
  for (const section of ["objective", "inputs", "authority", "expectedOutput", "acceptanceTest", "termination", "provenance"]) {
    const f = fields(); delete f[section];
    expectEnvelopeCode(() => handoffEnvelope({ envelopeVersion: handoffEnvelopeVersion, id: "he_1",
      from: "agent-a", createdAt: iso(NOW), ...f }), "invalid_handoff_envelope");
  }
});

test("envelope carries only the documented fields", () => {
  expectEnvelopeCode(() => validRecord({ extra: true }), "invalid_handoff_envelope");
});

test("an envelope cannot hand work to its sender", () => {
  const f = fields({ to: "agent-a" });
  expectEnvelopeCode(() => handoffEnvelope({ envelopeVersion: 1, id: "he_1", from: "agent-a",
    createdAt: iso(NOW), ...f }), "invalid_handoff_envelope");
});

test("authority must be a non-empty scoped permission list", () => {
  expectEnvelopeCode(() => validRecord({ authority: { ...fields().authority, permissions: [] } }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ authority: { ...fields().authority, permissions: ["fly"] } }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ authority: { ...fields().authority, scope: { rooms: [], workIds: [] } } }), "invalid_handoff_envelope");
});

test("handoff authority cannot escalate privilege", () => {
  for (const p of ["manage_members", "decide"]) {
    expectEnvelopeCode(() => validRecord({ authority: { ...fields().authority, permissions: ["accept_work", p] } }),
      "invalid_handoff_envelope");
  }
});

test("authority and termination expiries must be after creation", () => {
  expectEnvelopeCode(() => validRecord({ authority: { ...fields().authority, expiresAt: iso(NOW - HOUR) } }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ termination: { ...fields().termination, expiresAt: iso(NOW) } }), "invalid_handoff_envelope");
});

test("escalate on expiry requires an escalation target", () => {
  expectEnvelopeCode(() => validRecord({ termination: { expiresAt: iso(NOW + HOUR), onExpiry: "escalate", escalateTo: null } }),
    "invalid_handoff_envelope");
  const ok = validRecord({ termination: { expiresAt: iso(NOW + HOUR), onExpiry: "escalate", escalateTo: "agent-owner" } });
  assert.equal(ok.termination.escalateTo, "agent-owner");
});

test("acceptance test needs at least one machine-checkable check", () => {
  expectEnvelopeCode(() => validRecord({ acceptanceTest: { checks: [] } }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ acceptanceTest: { checks: [{ kind: "vibes" }] } }), "invalid_handoff_envelope");
  const check = validRecord({ acceptanceTest: { checks: [{ kind: "manual_review", reviewer: "agent-owner" }] } });
  assert.equal(check.acceptanceTest.checks[0].kind, "manual_review");
});

test("inputs are references, not blobs", () => {
  expectEnvelopeCode(() => validRecord({ inputs: [] }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ inputs: [{ kind: "url", ref: "http://example.test/x" }] }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ inputs: [{ kind: "carrier-pigeon", ref: "x" }] }), "invalid_handoff_envelope");
  const ok = validRecord({ inputs: [{ kind: "url", ref: "https://example.test/x" }, { kind: "file", ref: "server/a.mjs", sha: "a".repeat(40) }] });
  assert.equal(ok.inputs.length, 2);
});

test("provenance must name the sender and keep the chain honest", () => {
  expectEnvelopeCode(() => validRecord({ provenance: { ...fields().provenance, createdBy: "agent-b" } }), "invalid_handoff_envelope");
  expectEnvelopeCode(() => validRecord({ provenance: { createdBy: "agent-a", parentEnvelopeId: "he_0", chain: [] } }),
    "invalid_handoff_envelope");
  const ok = validRecord({ provenance: { createdBy: "agent-a", parentEnvelopeId: "he_0", chain: ["he_0"] } });
  assert.deepEqual([...ok.provenance.chain], ["he_0"]);
});

test("startEnvelope builds the skeleton the handing agent fills in", () => {
  const skeleton = startEnvelope({ from: "agent-a", to: "agent-b", objective: "Do the thing" });
  assert.ok(skeleton.id.startsWith("he_"));
  assert.equal(skeleton.provenance.createdBy, "agent-a");
  assert.equal(skeleton.termination.onExpiry, "release");
});

test("the lifecycle covers proposed through the five terminal states", () => {
  assert.deepEqual([...envelopeStatuses], ["proposed", "accepted", "completed", "rejected", "expired", "escalated", "cancelled"]);
  assert.deepEqual([...envelopeTransitions.proposed].sort(), ["accepted", "cancelled", "expired", "rejected"]);
  assert.deepEqual(envelopeTransitions.completed, []);
});

// ---- journal ----

test("create journals a proposed envelope and lists it", () => {
  const journal = makeJournal();
  const receipt = journal.create("room-1", journalFields(), { from: "agent-a" });
  assert.equal(receipt.status, "proposed");
  assert.equal(receipt.roomId, "room-1");
  assert.ok(receipt.envelopeId.startsWith("he_"));
  assert.equal(receipt.envelope.provenance.createdBy, "agent-a");
  assert.deepEqual(receipt.history, [{ status: "proposed", at: iso(NOW), by: "agent-a" }]);
  const listed = journal.list("room-1");
  assert.equal(listed.length, 1);
  assert.deepEqual(journal.list("room-1", { status: "accepted" }), []);
  assert.equal(journal.list("room-1", { to: "agent-b" }).length, 1);
  assert.equal(journal.list("room-1", { to: "agent-z" }).length, 0);
});

test("recipient accepts, completes with named checks; history is append-only", () => {
  const journal = makeJournal();
  const { envelopeId } = journal.create("room-1", journalFields(), { from: "agent-a" });
  const accepted = journal.transition("room-1", envelopeId, "accepted", { by: "agent-b" });
  assert.equal(accepted.status, "accepted");
  const done = journal.transition("room-1", envelopeId, "completed", { by: "agent-b", checksPassed: ["result_submitted"] });
  assert.equal(done.status, "completed");
  assert.deepEqual(done.history.map(h => h.status), ["proposed", "accepted", "completed"]);
  assert.deepEqual(done.history[2].checksPassed, ["result_submitted"]);
});

test("actor rules are enforced: only the recipient accepts/completes, only the sender cancels", () => {
  const journal = makeJournal();
  const { envelopeId } = journal.create("room-1", journalFields(), { from: "agent-a" });
  expectEnvelopeCode(() => journal.transition("room-1", envelopeId, "accepted", { by: "agent-a" }), "envelope_recipient_only");
  expectEnvelopeCode(() => journal.transition("room-1", envelopeId, "cancelled", { by: "agent-b" }), "envelope_sender_only");
  expectEnvelopeCode(() => journal.transition("room-1", envelopeId, "completed", { by: "agent-b", checksPassed: ["result_submitted"] }),
    "invalid_envelope_transition");
  const cancelled = journal.transition("room-1", envelopeId, "cancelled", { by: "agent-a", note: "no longer needed" });
  assert.equal(cancelled.status, "cancelled");
  expectEnvelopeCode(() => journal.transition("room-1", envelopeId, "accepted", { by: "agent-b" }), "invalid_envelope_transition");
});

test("completing requires naming declared acceptance checks", () => {
  const journal = makeJournal();
  const { envelopeId } = journal.create("room-1", journalFields(), { from: "agent-a" });
  journal.transition("room-1", envelopeId, "accepted", { by: "agent-b" });
  expectEnvelopeCode(() => journal.transition("room-1", envelopeId, "completed", { by: "agent-b" }), "envelope_checks_required");
  expectEnvelopeCode(() => journal.transition("room-1", envelopeId, "completed", { by: "agent-b", checksPassed: ["vibes"] }),
    "envelope_unknown_check");
});

test("either party can escalate an accepted envelope", () => {
  const journal = makeJournal();
  const one = journal.create("room-1", journalFields(), { from: "agent-a" }).envelopeId;
  journal.transition("room-1", one, "accepted", { by: "agent-b" });
  assert.equal(journal.transition("room-1", one, "escalated", { by: "agent-b", note: "stuck" }).status, "escalated");
  const two = journal.create("room-1", journalFields(), { from: "agent-a" }).envelopeId;
  journal.transition("room-1", two, "accepted", { by: "agent-b" });
  assert.equal(journal.transition("room-1", two, "escalated", { by: "agent-a" }).status, "escalated");
});

test("expiry sweep moves past-due envelopes to expired or escalated", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(handoffEnvelopeSchema);
  const store = { db, transaction: fn => fn(), readTransaction: fn => fn(), now: () => NOW };
  const journal = new HandoffEnvelopeJournal(store);
  const release = journal.create("room-1", journalFields(), { from: "agent-a" }).envelopeId;
  const escalate = journal.create("room-1", journalFields({
    termination: { expiresAt: iso(NOW + 2 * HOUR), onExpiry: "escalate", escalateTo: "agent-owner" },
  }), { from: "agent-a" }).envelopeId;
  const live = journal.create("room-1", journalFields(), { from: "agent-a" }).envelopeId;
  // Backdate two envelopes past their termination: rewrite the stored
  // envelope JSON (the validator forbids creating an already-expired one).
  for (const [id, termination] of [[release, { expiresAt: iso(NOW - HOUR), onExpiry: "release", escalateTo: null }],
      [escalate, { expiresAt: iso(NOW - HOUR), onExpiry: "escalate", escalateTo: "agent-owner" }]]) {
    const row = db.prepare("SELECT envelope FROM handoff_envelopes WHERE envelope_id=?").get(id);
    const envelope = { ...JSON.parse(row.envelope), termination };
    db.prepare("UPDATE handoff_envelopes SET envelope=? WHERE envelope_id=?").run(JSON.stringify(envelope), id);
  }
  const moved = journal.sweepExpired("room-1", { now: NOW });
  assert.deepEqual([...moved.expired], [release]);
  assert.deepEqual([...moved.escalated], [escalate]);
  assert.equal(journal.list("room-1", { status: "proposed" }).length, 1);
  assert.equal(journal.list("room-1", { status: "proposed" })[0].envelopeId, live);
  const escalatedReceipt = journal.list("room-1", { status: "escalated" })[0];
  assert.equal(escalatedReceipt.history.at(-1).escalatedTo, "agent-owner");
  // Manual expiry is system-only.
  expectEnvelopeCode(() => journal.transition("room-1", live, "expired", { by: "agent-a" }), "envelope_expiry_system_only");
});

test("metrics reports the escalation rate over closed envelopes", () => {
  const journal = makeJournal();
  assert.equal(journal.metrics("room-1").escalationRate, null);
  const mk = () => journal.create("room-1", journalFields(), { from: "agent-a" }).envelopeId;
  const done = mk(), esc = mk(), rej = mk(), open = mk();
  journal.transition("room-1", done, "accepted", { by: "agent-b" });
  journal.transition("room-1", done, "completed", { by: "agent-b", checksPassed: ["result_submitted"] });
  journal.transition("room-1", esc, "accepted", { by: "agent-b" });
  journal.transition("room-1", esc, "escalated", { by: "agent-b" });
  journal.transition("room-1", rej, "rejected", { by: "agent-b" });
  const metrics = journal.metrics("room-1");
  assert.equal(metrics.total, 4);
  assert.equal(metrics.closed, 3);
  assert.equal(metrics.byStatus.completed, 1);
  assert.equal(metrics.byStatus.escalated, 1);
  assert.equal(metrics.byStatus.proposed, 1);
  assert.ok(Math.abs(metrics.escalationRate - 1 / 3) < 1e-9, `escalationRate was ${metrics.escalationRate}`);
  void open;
});

test("journal verifySchema accepts the created schema and verify checks integrity", () => {
  const journal = makeJournal();
  assert.equal(journal.verifySchema(), true);
  journal.verify();
  const db2 = new DatabaseSync(":memory:");
  const empty = new HandoffEnvelopeJournal({ db: db2, transaction: fn => fn(), readTransaction: fn => fn(), now: () => NOW });
  assert.equal(empty.verifySchema({ allowAbsent: true }), false);
});

test("unknown envelopes and rooms fail cleanly", () => {
  const journal = makeJournal();
  expectEnvelopeCode(() => journal.transition("room-1", "he_nope", "accepted", { by: "agent-b" }), "envelope_not_found");
  expectEnvelopeCode(() => journal.list("room-1", { status: "bogus" }), "invalid_envelope_status");
  expectEnvelopeCode(() => journal.create("", journalFields(), { from: "agent-a" }), "invalid_envelope_room");
});
