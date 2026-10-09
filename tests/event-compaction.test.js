// tests/event-compaction.test.js — WAVE-500 W5 event-compaction prototype (fail-first).
// Pure functions: classifyEvent, compactRun, translateCursor. No DB, no store.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyEvent, compactRun, translateCursor } from "../server/event-compaction.mjs";

let seq = 0;
const ev = (type, data = {}, extra = {}) => {
  seq += 1;
  return { id: `e${seq}`, sequence: seq, room_id: "room-1", type, data, ...extra };
};
const resetSeq = () => { seq = 0; };

const RETAIN_TYPES = [
  "claim.acquired",              // claim-create
  "claim.released",              // claim-settle
  "work.completed",              // claim-settle
  "work.superseded",             // claim-settle
  "member.added",                // membership
  "member.joined_via_invitation",// membership
  "member.access_changed",       // membership
  "member.status_updated",       // membership
  "invitation.created",
  "invitation.accepted",
  "verification.recorded",       // provenance
  "owner.decision_recorded",     // provenance
  "receipt.evidence_withdrawn",  // provenance
];

describe("classifyEvent", () => {
  it("summarizes claim churn and progress notes", () => {
    assert.equal(classifyEvent(ev("work_claim.updated", { claimId: "c1" })), "summarizable");
    assert.equal(classifyEvent(ev("claim.renewed", { claimId: "c1" })), "summarizable");
    assert.equal(classifyEvent(ev("work.blocked", { workItemId: "w1" })), "summarizable");
    assert.equal(classifyEvent(ev("work.blocker_resolved", { workItemId: "w1" })), "summarizable");
  });

  it("retains membership, invites, provenance, claim-create and claim-settle", () => {
    resetSeq();
    for (const type of RETAIN_TYPES) {
      assert.equal(classifyEvent(ev(type)), "retain", `expected retain for ${type}`);
    }
  });

  it("drops wakes and triage hints only after a summary exists for them", () => {
    assert.equal(classifyEvent(ev("wake.register")), "drop-after-summary");
    assert.equal(classifyEvent(ev("triage.hint")), "drop-after-summary");
    assert.equal(classifyEvent(ev("hint.suggested")), "drop-after-summary");
  });

  it("is conservative: unknown or malformed events are retained, never dropped", () => {
    assert.equal(classifyEvent(ev("some.future_type")), "retain");
    assert.equal(classifyEvent(ev(undefined)), "retain");
    assert.equal(classifyEvent({ id: "x", sequence: 1 }), "retain");
    assert.equal(classifyEvent(null), "retain");
  });
});

describe("compactRun", () => {
  it("compacts a 100-event claim-churn log to <= 20 rows with retained types present", () => {
    resetSeq();
    const events = [];
    const churnClaims = ["c1", "c2", "c3", "c4", "c5"];
    // 80 churn events: work_claim.updated + claim.renewed across 5 claims
    for (let i = 0; i < 80; i++) {
      const claimId = churnClaims[i % churnClaims.length];
      events.push(ev(i % 2 ? "work_claim.updated" : "claim.renewed", { claimId, note: `churn ${i}` }));
    }
    // 12 retained events of varied retain types
    const retainedIds = [];
    const retainSample = ["claim.acquired", "claim.released", "work.completed", "member.added",
      "member.joined_via_invitation", "invitation.created", "verification.recorded",
      "owner.decision_recorded", "work.superseded", "member.access_changed",
      "invitation.accepted", "receipt.evidence_withdrawn"];
    for (const type of retainSample) {
      const e = ev(type, { marker: type });
      retainedIds.push(e.id);
      events.push(e);
    }
    // 8 droppable wake/hint events
    for (let i = 0; i < 8; i++) {
      events.push(ev(i % 2 ? "wake.register" : "triage.hint", { n: i }));
    }
    assert.equal(events.length, 100);

    const { kept, summaries, dropped, cursorMap } = compactRun(events, { maxSeq: events.length });

    assert.ok(kept.length <= 20, `kept ${kept.length} > 20`);
    // every retained event survives verbatim
    for (const id of retainedIds) {
      assert.ok(kept.some((k) => k.id === id), `retained event ${id} missing from kept`);
    }
    // every kept row has a fresh, dense, ascending sequence
    const seqs = kept.map((k) => k.sequence).sort((a, b) => a - b);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    // summaries cover the churn and the dropped hints
    assert.ok(summaries.length >= 2, `expected >= 2 summaries, got ${summaries.length}`);
    assert.equal(dropped.length, 8);
    // cursor map covers every input event; summary rows self-register for resolution
    for (const e of events) {
      assert.ok(e.sequence in cursorMap, `input seq ${e.sequence} missing from cursorMap`);
    }
    for (const s of summaries) {
      assert.equal(cursorMap[s.id], s.sequence, `summary ${s.id} self-entry wrong`);
    }
  });

  it("never drops retain-classified types, even when they are the only input", () => {
    resetSeq();
    const events = RETAIN_TYPES.map((type) => ev(type));
    const { kept, dropped, cursorMap } = compactRun(events, { maxSeq: events.length });
    assert.equal(kept.length, events.length);
    assert.equal(dropped.length, 0);
    for (const e of events) {
      assert.ok(typeof cursorMap[e.sequence] === "number", `retain event seq ${e.sequence} not mapped to a number`);
    }
  });

  it("empty input produces empty output", () => {
    const { kept, summaries, dropped, cursorMap } = compactRun([], { maxSeq: 0 });
    assert.deepEqual(kept, []);
    assert.deepEqual(summaries, []);
    assert.deepEqual(dropped, []);
    assert.deepEqual(cursorMap, {});
  });

  it("kept events keep their original content and gain new dense sequences", () => {
    resetSeq();
    const e1 = ev("claim.acquired", { claimId: "c1" });
    const e2 = ev("message.posted", { messageId: "m1", body: "hello" });
    const { kept } = compactRun([e1, e2], { maxSeq: 2 });
    assert.equal(kept.length, 2);
    assert.equal(kept[0].id, e1.id);
    assert.equal(kept[0].data.claimId, "c1");
    assert.equal(kept[0].sequence, 1);
    assert.equal(kept[1].id, e2.id);
    assert.equal(kept[1].sequence, 2);
  });
});

describe("translateCursor", () => {
  it("round-trips retained events through compactRun", () => {
    resetSeq();
    const events = [
      ev("work_claim.updated", { claimId: "c1" }),
      ev("work_claim.updated", { claimId: "c1" }),
      ev("claim.acquired", { claimId: "c1" }), // old seq 3
      ev("work_claim.updated", { claimId: "c1" }),
      ev("member.added", { memberId: "m9" }),  // old seq 5
    ];
    const { kept, cursorMap } = compactRun(events, { maxSeq: events.length });
    // retained old seq 3 -> kept row, retained old seq 5 -> kept row
    const newFor3 = cursorMap[3];
    const newFor5 = cursorMap[5];
    assert.ok(typeof newFor3 === "number" && typeof newFor5 === "number");
    // cursor at old seq 3 has also seen summarized seqs 1-2, so it resolves to
    // the summary row covering them (at or after the retained row's own seq)
    assert.ok(translateCursor(cursorMap, 3) >= newFor3, "summary row must dominate the cursor");
    // cursor at old seq 5 has seen member.added (new 2) AND the summary row (new 3)
    // covering summarized seqs 1,2,4 — the true position is the summary row
    assert.equal(translateCursor(cursorMap, 5), kept.length);
    // cursor below the run floor stays at 0
    assert.equal(translateCursor(cursorMap, 0), 0);
    // cursor past the end clamps to the last kept sequence
    assert.equal(translateCursor(cursorMap, 9999), kept.length);
  });

  it("maps summarized and dropped events onto their summary row", () => {
    resetSeq();
    const events = [
      ev("wake.register", { n: 1 }),
      ev("work_claim.updated", { claimId: "c1" }),
      ev("claim.acquired", { claimId: "c1" }),
    ];
    const { cursorMap } = compactRun(events, { maxSeq: events.length });
    const translated = translateCursor(cursorMap, 1); // wake -> summary row
    assert.ok(typeof translated === "number" && translated >= 1, `expected numeric row, got ${translated}`);
  });
});
