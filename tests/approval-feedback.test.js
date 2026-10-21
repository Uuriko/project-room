import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalQueue } from "../server/inbox-approval.mjs";
import { agentFeedbackFeed, needsYouResultCards } from "../server/approval-feedback.mjs";

const codex = { kind: "agent", id: "codex", label: "Codex" };
const other = { kind: "agent", id: "claude", label: "Claude" };
const potter = { kind: "human", id: "potter", label: "Potter" };

function fakeStore() {
  let t = 0, n = 0;
  const q = createApprovalQueue({ clock: () => (t += 1000), id: () => `p${++n}` });
  return { q, store: { collab: { listApprovals: (_roomId, { status } = {}) => q.list({ status }) } } };
}

test("reject reasons and requested edits reach the proposing agent only", () => {
  const { q, store } = fakeStore();
  q.propose("thread:1", { draft: { body: "a" }, byAgent: codex, channel: "email" });
  q.propose("thread:2", { draft: { body: "b" }, byAgent: codex, channel: "email" });
  q.propose("thread:3", { draft: { body: "c" }, byAgent: other, channel: "email" });
  q.reject("p1", { by: potter, reason: "Keep bios under 50 words" });
  q.requestEdits("p2", { by: potter, edits: "Shorter subject" });
  q.reject("p3", { by: potter, reason: "not yours" });
  const feed = agentFeedbackFeed(store, "room", "codex");
  assert.deepEqual(feed.items.map(i => i.text), ["Rejected: Keep bios under 50 words", "Edits requested: Shorter subject"]);
  assert.equal(agentFeedbackFeed(store, "room", "codex", { since: feed.cursor }).items.length, 0);
  assert.throws(() => agentFeedbackFeed(store, "room", ""), TypeError);
});

test("pending drafts become needs-you result cards that say nothing was sent", () => {
  const { q, store } = fakeStore();
  q.propose("thread:1", { draft: { subject: "Kickoff", body: "Tuesday?" }, byAgent: codex, channel: "email" });
  q.propose("thread:2", { draft: { body: "x" }, byAgent: codex, channel: "email" });
  q.approve("p2", { by: potter });
  const cards = needsYouResultCards(store, "room");
  assert.equal(cards.length, 1);
  const { card } = cards[0];
  assert.equal(card.title, "Kickoff");
  assert.equal(card.waitingOn, "owner");
  assert.equal(card.sent, "Nothing sent yet");
  assert.deepEqual([...card.actions], ["approve", "request_edits", "reject"]);
});

test("works on the real durable approval store", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RoomStore } = await import("../server/store.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const dir = mkdtempSync(join(tmpdir(), "rc-feedback-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  try {
    store.initialize(initialRoom("commons"));
    const p = store.collab.proposeDraft("commons", "thread:1", { draft: { body: "hello" }, byAgent: codex, channel: "email" });
    assert.equal(needsYouResultCards(store, "commons").length, 1);
    store.collab.decideApproval("commons", p.proposalId, { decision: "reject", by: potter, reason: "Too formal for this list" });
    assert.equal(agentFeedbackFeed(store, "commons", "codex").items[0].reason, "Too formal for this list");
    assert.equal(needsYouResultCards(store, "commons").length, 0);
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
