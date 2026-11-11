// Regression: stale send_back after a bundle-less redelivery
// (Dot seq 24432; Grok seq 24456 task 3).
// A no-PR / no-bundle claim goes delivered -> changes_requested ->
// in_progress (send-back) -> delivered again with a new note. The second
// delivery is a NEW delivery round: the reviewer's needs-me ask must read
// phase "review" for it, not the stale "send_back" left over from the
// first round. On main 1ab906c3 (and on the Flip-B composition) a
// bundle-less finish never advances deliveryGeneration, so the first
// round's changes_requested review (basis generation 0, digest null)
// still reads as current after the redelivery and the queue keeps
// pointing at the send-back call for work that has not been re-reviewed.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { legacyAgentRoom } from "./helpers/legacy-agent-room.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { createWork, claimWork, updateWork, recordReview, hasCurrentReview } from "../server/work-claims.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const WRITER = ["steer", "accept_work", "complete_work", "verify"];

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => Date.parse("2026-10-01T00:00:00Z") });
  t.after(() => store.close());
  const owner = store.identities.create("Owen");
  const worker = store.identities.create("Wanda");
  const reviewer = store.identities.create("Rita");
  legacyAgentRoom(store, owner, { roomId: "board", title: "board", purpose: "redelivery review asks", kind: "personal" });
  linkWithProof(store, owner.secret, "board", worker, { displayName: "Wanda", permissions: WRITER });
  linkWithProof(store, owner.secret, "board", reviewer, { displayName: "Rita", permissions: WRITER });
  const memberOf = identityId => store.db.prepare("SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?").get(identityId, "board").m;
  const ids = { owner: memberOf(owner.identityId), worker: memberOf(worker.identityId), reviewer: memberOf(reviewer.identityId) };
  const now = Date.parse("2026-10-01T01:00:00Z");
  const start = id => {
    let item = createWork({ id, title: `Task ${id}`, tags: [`rev-${ids.reviewer}`] }, { now, agentId: ids.owner });
    item = claimWork(item, ids.worker, { now });
    item = updateWork(item, ids.worker, { state: "in_progress", now });
    store.workClaims.set("board", item);
    return item;
  };
  const askFor = (secret, id) => collectNeedsMe(store, secret, {})?.reviewAsks?.[0]?.top.find(row => row.id === id);
  return { store, reviewer, ids, now, start, askFor };
}

test("bundle-less redelivery after a send-back asks for a fresh review, not the stale send_back", t => {
  const { store, reviewer, ids, now, start, askFor } = setup(t);
  let item = start("task-a");
  // First delivery: no PR, no bundle, just a note (the self-attested shape).
  item = updateWork(item, ids.worker, { state: "delivered", note: "first delivery", now });
  store.workClaims.set("board", item);
  assert.equal(askFor(reviewer.secret, "task-a")?.phase, "review", "first delivery asks for review");

  item = recordReview(item, ids.reviewer, { verdict: "changes_requested", summary: "criterion missing", now });
  store.workClaims.set("board", item);
  const sendBack = askFor(reviewer.secret, "task-a");
  assert.equal(sendBack?.phase, "send_back", "the verdict on the first delivery points at the send-back call");
  assert.deepEqual(sendBack?.nextBody, { state: "in_progress" });

  // The reviewer sends it back; the worker reworks and redelivers with a
  // new note, still with no PR and no bundle.
  item = updateWork(item, ids.reviewer, { state: "in_progress", now, authority: true });
  item = updateWork(item, ids.worker, { state: "delivered", note: "second delivery: criterion addressed", now });
  store.workClaims.set("board", item);

  assert.equal(hasCurrentReview(item, ids.reviewer), false,
    "the first round's changes_requested review is stale on the new delivery");
  const ask = askFor(reviewer.secret, "task-a");
  assert.ok(ask, "the redelivered item must be back in the reviewer's queue");
  assert.equal(ask.phase, "review", "the redelivery asks for a fresh review, not the stale send_back");
  assert.match(ask.next, /\/work-claims\/task-a\/review$/);

  // And the fresh cycle still completes: a new verdict on the new
  // delivery is current, and its send-back phase is live again.
  item = recordReview(item, ids.reviewer, { verdict: "changes_requested", summary: "still missing one piece", now });
  store.workClaims.set("board", item);
  assert.equal(hasCurrentReview(item, ids.reviewer), true,
    "a verdict recorded on the current delivery is current");
  assert.equal(askFor(reviewer.secret, "task-a")?.phase, "send_back",
    "the new verdict points at its own send-back call");
});
