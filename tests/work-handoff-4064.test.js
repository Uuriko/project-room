// Issue #4064: work-handoff contract honesty.
// H1: workHandoff silently truncated files at 64 while next/blockers
//     hard-reject oversize lists.
// H2: envelope completion recorded recipient-asserted checks under the
//     name checksPassed with "machine-checkable" framing, although no
//     declared check is ever evaluated. The receipt now records the
//     assertion as checksAsserted (the relabel branch of #4064).
// H3: verify()'s comment claimed envelopes name their room; envelopes
//     carry no room field. The comment is corrected (pinned below so
//     the overclaim cannot silently return).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { workHandoff, HandoffError, handoffEnvelopeSchema, HandoffEnvelopeJournal } from "../server/work-handoff.mjs";

const NOW = 1729219200000; // 2024-10-18T00:00:00Z
const iso = ms => new Date(ms).toISOString();
const HOUR = 3600 * 1000;
const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof HandoffError && error.code === code);

const file = i => ({ path: `server/file-${i}.mjs`, kind: "code", sha: "a".repeat(40) });
const base = () => ({ id: "handoff-1", from: "quill", to: "grok", at: "2026-09-16T07:00:00Z",
  objective: "Merge the WhatsApp adapter", status: "in_progress", summary: "Adapter built.",
  next: [], blockers: [], files: [file(0)], validation: null });

test("H1: a handoff with more than 64 files is rejected, not truncated", () => {
  const oversize = { ...base(), files: Array.from({ length: 65 }, (_, i) => file(i)) };
  throwsCode(() => workHandoff(oversize), "invalid_work_handoff");
});

test("H1: exactly 64 files still validate; the sibling caps still reject", () => {
  const atCap = workHandoff({ ...base(), files: Array.from({ length: 64 }, (_, i) => file(i)) });
  assert.equal(atCap.files.length, 64);
  throwsCode(() => workHandoff({ ...base(), next: Array.from({ length: 65 }, () => "step") }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), files: "not-a-list" }), "invalid_work_handoff");
});

const makeJournal = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(handoffEnvelopeSchema);
  const store = { db, transaction: fn => fn(), readTransaction: fn => fn(), now: () => NOW };
  return new HandoffEnvelopeJournal(store);
};
const journalFields = () => ({
  to: "agent-b",
  objective: "Summarize the thread and draft a reply",
  inputs: [{ kind: "message", ref: "msg-1", label: "the thread" }],
  authority: { permissions: ["accept_work", "complete_work"], scope: { rooms: ["room-1"] }, expiresAt: iso(NOW + 24 * HOUR) },
  expectedOutput: { kind: "text_result", description: "A draft reply" },
  acceptanceTest: { checks: [{ kind: "work_completed", workId: "work-1" }, { kind: "result_submitted", workId: "work-1" }] },
  termination: { expiresAt: iso(NOW + 24 * HOUR), onExpiry: "release", escalateTo: null },
  provenance: { claimId: null, taskId: "work-1", chain: [] },
});

test("H2: completion records the recipient's assertion as checksAsserted, never as an evaluated checksPassed", () => {
  const journal = makeJournal();
  const { envelopeId } = journal.create("room-1", journalFields(), { from: "agent-a" });
  journal.transition("room-1", envelopeId, "accepted", { by: "agent-b" });
  // work-1 is not completed in any store this journal can read: at the base
  // this completion still succeeded and the receipt called the assertion
  // checksPassed. After the relabel the receipt names it an assertion.
  const done = journal.transition("room-1", envelopeId, "completed",
    { by: "agent-b", checksPassed: ["work_completed", "result_submitted"] });
  const entry = done.history.at(-1);
  assert.equal(entry.status, "completed");
  assert.deepEqual([...entry.checksAsserted], ["work_completed", "result_submitted"]);
  assert.equal(Object.hasOwn(entry, "checksPassed"), false,
    "the receipt must not present an unevaluated assertion as checksPassed");
});

test("H3: verify()'s comment no longer claims envelopes name their room", () => {
  const source = readFileSync(new URL("../server/work-handoff.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /names the envelope id and room/);
  assert.match(source, /carry no room field/);
});
