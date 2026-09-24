// Jev-harness: the legacy event-sourced work.completed receipt edge.
// jevShadowCompletedReceipt maps the completed work item onto the receipt
// scorer and journals the would-be verdict. Shadow semantics: the
// completion is already accepted — this is measurement, never enforcement.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

test("work.completed journals a shadow receipt with the mapped review policy", async t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const now = Date.now();
  f.store.jevShadowCompletedReceipt({
    roomId: "commons",
    command: { data: {
      workItemId: "test-handoff",
      summary: "Prepared the agenda naming its owner and posted it",
      nextAction: "Owner reviews the agenda",
      evidenceUrl: "https://github.com/Uuriko/project-room/pull/900",
    } },
    incoming: { actorId: "producer", at: new Date(now).toISOString() },
    priorItem: { independentVerificationRequired: true, verifierMemberId: "reviewer",
      updatedAt: new Date(now - 3600_000).toISOString() },
  });
  const entries = f.store.jevShadow.list({ roomId: "commons", gate: "receipt" });
  const entry = entries.find(e => e.path === "work.completed" && e.subject === "test-handoff");
  assert.ok(entry, JSON.stringify(entries.map(e => e.path)));
  // Artifact URL + independent_principal policy + hour-long duration:
  // accept, but under 0.85 → flagged for a human look.
  assert.equal(entry.decision, "accept");
  assert.equal(entry.escalate, true);
  const review = entry.signals.find(s => s.key === "reviewStrength");
  assert.equal(review.value, 0.5); // independent_principal base 1.0, halved: no attestations at completion time
  const evidence = entry.signals.find(s => s.key === "evidence");
  assert.equal(evidence.value, 1); // the receipt text references the artifact URL
});

test("work.completed with a thin receipt escalates, still journaled", async t => {
  const f = createAcceptanceFixture();
  t.after(() => f.store.close());
  const now = Date.now();
  f.store.jevShadowCompletedReceipt({
    roomId: "commons",
    command: { data: { workItemId: "w-thin", summary: "done", nextAction: "none" } },
    incoming: { actorId: "producer", at: new Date(now).toISOString() },
    priorItem: { updatedAt: new Date(now - 5_000).toISOString() }, // done five seconds after the last mutation
  });
  const entry = f.store.jevShadow.list({ roomId: "commons", gate: "receipt" })
    .find(e => e.path === "work.completed" && e.subject === "w-thin");
  assert.ok(entry);
  assert.equal(entry.decision, "escalate");
  assert.equal(entry.escalate, true);
});
