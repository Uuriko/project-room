import test from "node:test";
import assert from "node:assert/strict";
import { coordinationLoops } from "../src/work-loops.js";

const item = (over = {}) => ({ id: "w1", ...over });
const message = (id, over = {}) => ({ id, workItemId: "w1", authorId: "a", body: `message ${id}`, ...over });

test("ordinary work with normal discussion yields no signals", () => {
  const messages = [message("1"), message("2", { authorId: "b" }), message("3", { proposal: { packetId: "p", basisRevision: 0 } })];
  assert.deepEqual(coordinationLoops(item(), messages), []);
});

test("two identical drafts on one work item are a duplicate-proposal loop", () => {
  const body = "The same agenda, reposted.";
  const messages = [
    message("1", { proposal: { packetId: "p1", basisRevision: 0 }, body }),
    message("2", { authorId: "b", body: "Looks fine" }),
    message("3", { proposal: { packetId: "p2", basisRevision: 1 }, body: "  The same agenda,\n  reposted. " })
  ];
  const signals = coordinationLoops(item(), messages);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "duplicate_proposals");
  assert.equal(signals[0].count, 2);
  assert.deepEqual(signals[0].messageIds, ["1", "3"]);
});

test("differing drafts and single drafts are not loops", () => {
  const messages = [
    message("1", { proposal: { packetId: "p1", basisRevision: 0 }, body: "First version" }),
    message("2", { proposal: { packetId: "p2", basisRevision: 1 }, body: "Second, revised version" })
  ];
  assert.deepEqual(coordinationLoops(item(), messages), []);
});

test("deleted tombstones never count as duplicate drafts", () => {
  const body = "same";
  const messages = [
    message("1", { proposal: { packetId: "p1", basisRevision: 0 }, body }),
    message("2", { proposal: { packetId: "p2", basisRevision: 0 }, body, deletedAt: 5 })
  ];
  assert.deepEqual(coordinationLoops(item(), messages), []);
});

test("three handoffs without the work advancing are churn", () => {
  const it = item({ handoff: { open: true }, handoffHistory: [{ open: false }, { open: false }] });
  const signals = coordinationLoops(it, []);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "handoff_churn");
  assert.equal(signals[0].count, 3);
  assert.match(signals[0].label, /owner triage/i);
});

test("two handoffs stay below the churn threshold", () => {
  const it = item({ handoff: { open: true }, handoffHistory: [{ open: false }] });
  assert.deepEqual(coordinationLoops(it, []), []);
});

test("four short replies alternating between two members are an ack chain", () => {
  const messages = [
    message("1", { body: "noted" }), message("2", { authorId: "b", body: "thanks" }),
    message("3", { body: "ok" }), message("4", { authorId: "b", body: "ack" })
  ];
  const signals = coordinationLoops(item(), messages);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "ack_chain");
  assert.equal(signals[0].count, 4);
});

test("a chain breaks on a draft, a long message, a third author, or a doubled sender", () => {
  const base = [message("1", { body: "noted" }), message("2", { authorId: "b", body: "thanks" }),
    message("3", { body: "ok" }), message("4", { authorId: "b", body: "ack" })];
  const withDraft = [...base.slice(0, 2), message("x", { proposal: { packetId: "p", basisRevision: 0 }, body: "draft" }), ...base.slice(2)];
  assert.deepEqual(coordinationLoops(item(), withDraft).filter(s => s.kind === "ack_chain"), []);
  const withLong = [...base.slice(0, 3), message("4", { authorId: "b", body: "x".repeat(200) })];
  assert.deepEqual(coordinationLoops(item(), withLong), []);
  const withThird = [message("1", { body: "a" }), message("2", { authorId: "b", body: "b" }),
    message("3", { authorId: "c", body: "c" }), message("4", { authorId: "b", body: "d" })];
  assert.deepEqual(coordinationLoops(item(), withThird), []);
  const doubled = [message("1", { body: "a" }), message("2", { body: "b" }), message("3", { authorId: "b", body: "c" }), message("4", { body: "d" })];
  assert.deepEqual(coordinationLoops(item(), doubled), []);
});

test("only the recent tail matters: an old chain under later substantive messages is not flagged", () => {
  const messages = [
    message("1", { body: "noted" }), message("2", { authorId: "b", body: "thanks" }),
    message("3", { body: "ok" }), message("4", { authorId: "b", body: "ack" }),
    message("5", { body: "Here is the substantive update resolving the question in detail, with the full reasoning, the evidence pointers, and the concrete next step spelled out for review." })
  ];
  assert.deepEqual(coordinationLoops(item(), messages), []);
});

test("superseded work is quiet", () => {
  const it = item({ supersededBy: "w2", handoff: { open: true }, handoffHistory: [{}, {}] });
  assert.deepEqual(coordinationLoops(it, []), []);
});

test("multiple signals can co-fire with deterministic ordering", () => {
  const body = "duplicate draft";
  const messages = [
    message("1", { proposal: { packetId: "p1", basisRevision: 0 }, body }),
    message("2", { proposal: { packetId: "p2", basisRevision: 0 }, body })
  ];
  const it = item({ handoff: { open: true }, handoffHistory: [{}, {}] });
  const signals = coordinationLoops(it, messages);
  assert.deepEqual(signals.map(s => s.kind), ["duplicate_proposals", "handoff_churn"]);
});
