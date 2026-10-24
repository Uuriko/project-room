import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml } from "../src/board-ui.js";
import { arrangeFixedColumns, claimAge, claimStateId, readBoardFixedFlag, staleClaim, STALE_CLAIM_MS, writeBoardFixedFlag } from "../src/board-fixed-view.js";

const memory = () => {
  const data = new Map();
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)) };
};

test("fixed board columns stay off until asked, and a later toggle is kept", () => {
  assert.equal(readBoardFixedFlag("", null), false);
  assert.equal(readBoardFixedFlag("?boardfix=1", null), true);
  const storage = memory();
  assert.equal(readBoardFixedFlag("?boardfix=1", storage), true);
  writeBoardFixedFlag(storage, false);
  assert.equal(readBoardFixedFlag("?boardfix=1", storage), false, "a stored choice wins over the query");
});

test("fixed columns pin blocked claims first and keep the other states", () => {
  const ready = { id: "r", state: "unclaimed", title: "Ready" };
  const waiting = { id: "w", state: "unclaimed", title: "Waiting" };
  const blocked = { id: "b", state: "blocked", title: "Blocked" };
  const claimed = { id: "c", state: "claimed", title: "Claimed" };
  const review = { id: "v", state: "delivered", title: "Review" };
  const done = { id: "d", state: "done", title: "Done" };
  const arranged = arrangeFixedColumns({
    ready: [ready], claimed: [claimed], blocked: [waiting, blocked], review: [review], landed: [done]
  });
  assert.deepEqual(arranged.map(([id]) => id), ["needs", "ready", "claimed", "review", "done"]);
  assert.deepEqual(arranged[0][1].map(item => item.id), ["b"]);
  assert.deepEqual(arranged[1][1].map(item => item.id), ["r", "w"]);
  assert.deepEqual(arranged[2][1].map(item => item.id), ["c"]);
  assert.deepEqual(arranged[3][1].map(item => item.id), ["v"]);
  assert.deepEqual(arranged[4][1].map(item => item.id), ["d"]);
});

test("card face reads state and age from the claim, and stale is a real elapsed claim", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  assert.equal(claimStateId({ state: "in_progress" }), "claimed");
  assert.equal(claimStateId({ state: "delivered" }), "review");
  assert.equal(claimStateId({ state: "unclaimed", pullRequest: { url: "https://github.com/acme/demo/pull/3" } }), "review");
  assert.deepEqual(claimAge({ updatedAt: "2026-10-24T11:00:00.000Z" }, now), { unit: "h", count: 1 });
  assert.equal(claimAge({ title: "No clock" }, now), null);
  const fresh = { state: "claimed", claimedAt: new Date(now - 60 * 1000).toISOString() };
  const old = { state: "claimed", claimedAt: new Date(now - STALE_CLAIM_MS).toISOString() };
  assert.equal(staleClaim(fresh, now), false);
  assert.equal(staleClaim(old, now), true);
  assert.equal(staleClaim({ state: "done", claimedAt: old.claimedAt }, now), false);
});

test("the rendered board keeps today's columns until the fixed view is on", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const members = { mara: { displayName: "Mara" } };
  const viewer = { id: "mara", manage: false, owner: false, write: true };
  const items = [
    { id: "ready", title: "Draft the notes", state: "unclaimed", owner: null, dependsOn: [], updatedAt: "2026-10-24T11:30:00.000Z" },
    { id: "held", title: "Wait on the draft", state: "unclaimed", owner: null, dependsOn: ["ready"], updatedAt: "2026-10-24T11:30:00.000Z" },
    { id: "stuck", title: "Needs a person", state: "blocked", owner: "mara", claimedAt: "2026-10-24T10:00:00.000Z", updatedAt: "2026-10-24T10:00:00.000Z" },
    { id: "mine", title: "Write the notes", state: "in_progress", owner: "mara", claimedAt: "2026-10-24T11:00:00.000Z", updatedAt: "2026-10-24T11:00:00.000Z" },
    { id: "old", title: "Stale notes", state: "claimed", owner: "mara", claimedAt: "2026-10-23T12:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z" },
    { id: "review", title: "Check the notes", state: "delivered", owner: "mara", updatedAt: "2026-10-24T11:40:00.000Z" },
    { id: "done", title: "Ship the notes", state: "done", owner: "mara", updatedAt: "2026-10-24T11:50:00.000Z" },
  ];
  const plain = boardHtml(items, null, viewer, members, now);
  assert.match(plain, /id="board-col-landed"/);
  assert.doesNotMatch(plain, /id="board-col-needs"/);
  assert.doesNotMatch(plain, /class="claim-face"/);
  assert.doesNotMatch(plain, /data-boardfix/);
  const fixed = boardHtml(items, null, viewer, members, now, { fixedView: true, fixedToggle: true });
  const needs = fixed.indexOf('id="board-col-needs"');
  const ready = fixed.indexOf('id="board-col-ready"');
  assert.ok(needs !== -1 && ready !== -1 && needs < ready, "Needs you is the first column");
  const needsSection = fixed.slice(needs, ready);
  assert.match(needsSection, /Needs you/);
  assert.match(needsSection, /data-claim-id="stuck"/);
  assert.doesNotMatch(needsSection, /data-claim-id="held"/);
  assert.match(fixed.slice(ready, fixed.indexOf('id="board-col-claimed"')), /data-claim-id="held"/);
  assert.match(fixed, /Mara · Claimed · 1h/);
  assert.match(fixed, /Stale claim/);
  assert.match(fixed, /data-boardfix/);
  assert.match(fixed, /Current columns/);
});
