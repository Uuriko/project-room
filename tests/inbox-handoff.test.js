// Task 23: agent handoff protocol — packet validation, channel constraints,
// and the journal lifecycle, exercised against an in-memory sqlite database.
// The builder raises ServiceError (422/404/409) so the same codes hold in
// unit tests and over HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildHandoffPacket, channelConstraintsOf, inboxHandoffSchema, inboxHandoffStatuses,
  InboxHandoffJournal } from "../server/inbox-handoff.mjs";

const packetFields = (overrides = {}) => ({
  handoffId: "h-1", createdAt: "2026-09-18T00:00:00.000Z", threadId: "thread:1", channel: "email",
  sourceIds: ["src-1", "src-2", "src-1"], sender: { id: "a@example.test", label: "a@example.test" },
  subject: "Kickoff", occurredAt: "2026-09-17T23:00:00.000Z",
  sla: { status: "on_track", targetMs: 86400000, label: "24h", elapsedMs: 3600000,
    awaitingSince: "2026-09-17T23:00:00.000Z", deadlineAt: "2026-09-18T23:00:00.000Z" },
  triage: { action: "needs_human", reasons: ["Uncertain intent"] },
  summary: "They want a kickoff call next week.", openQuestions: ["Which day works?"],
  pendingActions: ["Draft the agenda"], excerpt: "Let us start.",
  from: "owner", to: "claude",
  ...overrides,
});
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected ${code} but nothing threw`);
};

test("a valid packet freezes with a version, deduped source ids, and computed constraints", () => {
  const packet = buildHandoffPacket(packetFields());
  assert.equal(packet.packetVersion, 1);
  assert.deepEqual(packet.sourceIds, ["src-1", "src-2"]);
  assert.ok(Object.isFrozen(packet) && Object.isFrozen(packet.sender) && Object.isFrozen(packet.constraints));
  assert.equal(packet.constraints.channel, "email");
  assert.equal(packet.constraints.known, true);
  assert.equal(packet.constraints.tone, "formal");
  assert.equal(packet.constraints.maxReplyChars, null);
});
test("channel constraints name hard reply limits and stay honest on unknown channels", () => {
  assert.equal(channelConstraintsOf("telegram").maxReplyChars, 4096);
  assert.equal(channelConstraintsOf("telegram").tone, "chat-concise");
  const unknown = channelConstraintsOf("pigeon");
  assert.equal(unknown.known, false);
  assert.ok(unknown.notes.some(n => /confirm.*surface/i.test(n)), "unknown channels demand owner confirmation");
});
test("packet validation rejects bad shapes with invalid_handoff_packet", () => {
  expectCode(() => buildHandoffPacket(packetFields({ threadId: "" })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ sourceIds: [] })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ sender: { id: "x" } })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ triage: { action: "explode", reasons: [] } })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ sla: { status: "eventually" } })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ extra: true })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ summary: "x".repeat(2001) })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ openQuestions: ["a", "b", "c", "d", "e", "f"] })), "invalid_handoff_packet");
  expectCode(() => buildHandoffPacket(packetFields({ to: "not an id!" })), "invalid_handoff_packet");
});
test("optional packet fields default to null", () => {
  const { summary, openQuestions, pendingActions, excerpt, sla } = buildHandoffPacket(packetFields(
    { summary: undefined, openQuestions: undefined, pendingActions: undefined, excerpt: undefined, sla: undefined }));
  assert.equal(summary, null); assert.equal(openQuestions, null); assert.equal(pendingActions, null);
  assert.equal(excerpt, null); assert.equal(sla, null);
});

function journal(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(inboxHandoffSchema);
  const store = { db, transaction: fn => fn(), readTransaction: fn => fn(), now: () => 1729219200000 };
  t.after(() => db.close());
  return new InboxHandoffJournal(store);
}
const fields = (overrides = {}) => {
  const { handoffId, createdAt, ...rest } = packetFields(overrides);
  return rest; // the journal assigns handoffId/createdAt
};

test("the journal creates, dedupes one open handoff per thread, and lists", t => {
  const j = journal(t);
  assert.equal(j.verifySchema(), true);
  const first = j.create("email:abc", fields({ threadId: "thread:1" }), { to: "claude" });
  assert.equal(first.duplicate, false);
  assert.equal(first.receipt.status, "open");
  assert.equal(first.receipt.packet.to, "claude");
  assert.equal(first.receipt.history.length, 1);
  assert.equal(first.receipt.history[0].status, "open");
  const again = j.create("email:abc", fields({ threadId: "thread:1" }), { to: "grokbot" });
  assert.equal(again.duplicate, true, "a second create for the same thread returns the existing receipt");
  assert.equal(again.receipt.handoffId, first.receipt.handoffId);
  j.create("email:abc", fields({ threadId: "thread:2" }), { to: "grokbot" });
  assert.equal(j.list("email:abc").length, 2);
  assert.equal(j.list("email:abc", { status: "open" }).length, 2);
  assert.equal(j.list("email:abc", { status: "completed" }).length, 0);
  expectCode(() => j.list("email:abc", { status: "napping" }), "invalid_handoff_status");
});
test("transitions follow the lifecycle; terminal handoffs are immutable", t => {
  const j = journal(t);
  const { receipt } = j.create("email:abc", fields(), { to: "claude" });
  const accepted = j.transition("email:abc", receipt.handoffId, "accepted", { note: "On it" });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.history[1].note, "On it");
  expectCode(() => j.transition("email:abc", receipt.handoffId, "accepted"), "invalid_handoff_transition");
  const done = j.transition("email:abc", receipt.handoffId, "completed");
  assert.equal(done.status, "completed");
  assert.equal(done.history.length, 3);
  expectCode(() => j.transition("email:abc", receipt.handoffId, "released"), "invalid_handoff_transition");
  expectCode(() => j.transition("email:abc", "nope", "accepted"), "handoff_not_found");
  const { receipt: r2 } = j.create("email:abc", fields({ threadId: "thread:9" }), { to: "claude" });
  expectCode(() => j.transition("email:abc", r2.handoffId, "completed"), "invalid_handoff_transition");
  const released = j.transition("email:abc", r2.handoffId, "released");
  assert.equal(released.status, "released");
  j.verify(); // offline integrity holds over the written rows
});
test("handoffs are scoped to the account", t => {
  const j = journal(t);
  j.create("email:abc", fields(), { to: "claude" });
  assert.equal(j.list("email:def").length, 0);
  expectCode(() => j.create("email:def", fields(), {}), "invalid_handoff_packet"); // no `to`
});
