// Board triage queue (server/board-triage.mjs, ROOM_BOARD_TRIAGE, off by default).
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, closeWork } from "../server/work-claims.mjs";
import { buildWorkClaimPage } from "../server/work-claim-routes.mjs";
import { boardTriageEnabled, triageClaims, triageNote } from "../server/board-triage.mjs";

const T0 = Date.parse("2026-11-04T10:00:00Z");
const at = m => new Date(T0 + m * 60_000).toISOString();
const page = (items, q, now = T0 + 120 * 60_000) => buildWorkClaimPage(items, "r", "viewer", new URLSearchParams(q), now);

function board() {
  const old = createWork({ id: "old", title: "Old untouched" }, { now: at(0), agentId: "alice" });
  const fresh = createWork({ id: "fresh", title: "Fresh", tags: ["bug"], acceptanceCriteria: ["repro passes"] }, { now: at(30), agentId: "bob" });
  const taken = claimWork(createWork({ id: "taken", title: "Taken" }, { now: at(5), agentId: "alice" }), "carol", { now: at(6) });
  const closed = closeWork(createWork({ id: "gone", title: "Gone" }, { now: at(1), agentId: "alice" }), "alice", { verb: "cancel", now: at(2) });
  return [fresh, taken, old, closed].map(x => x.work ?? x);
}

function withFlag(t, value) {
  const prior = process.env.ROOM_BOARD_TRIAGE;
  if (value === undefined) delete process.env.ROOM_BOARD_TRIAGE; else process.env.ROOM_BOARD_TRIAGE = value;
  t.after(() => { if (prior === undefined) delete process.env.ROOM_BOARD_TRIAGE; else process.env.ROOM_BOARD_TRIAGE = prior; });
}

test("off by default: queue=triage is refused like any unknown queue", t => {
  withFlag(t, undefined);
  assert.equal(boardTriageEnabled(), false);
  assert.throws(() => page(board(), "queue=triage"), err => err.status === 422 || err.statusCode === 422 || /queue=ready/.test(err.message));
});

test("on: untouched open tasks only, oldest first, with a derived triage note", t => {
  withFlag(t, "1");
  const out = page(board(), "queue=triage");
  assert.equal(out.queue, "triage");
  assert.deepEqual(out.claims.map(c => c.id), ["old", "fresh"]);
  assert.equal(out.claims[0].triage.waitingMs, 120 * 60_000);
  assert.deepEqual([...out.claims[0].triage.missing], ["acceptance_criteria", "tags"]);
  assert.deepEqual([...out.claims[1].triage.missing], []);
  assert.equal(out.nextCursor, null);
  assert.deepEqual(page(board(), "queue=triage&limit=1").claims.map(c => c.id), ["old"]);
});

test("any action takes a task out of triage; ready queue is unchanged", t => {
  withFlag(t, "1");
  const items = board();
  const i = items.findIndex(x => x.id === "old");
  items[i] = claimWork(items[i], "dave", { now: at(90) }).work ?? claimWork(items[i], "dave", { now: at(90) });
  assert.deepEqual(page(items, "queue=triage").claims.map(c => c.id), ["fresh"]);
  assert.ok(page(items, "queue=ready").claims.every(c => !("triage" in c)));
});

test("triage refuses state, cursor; unknown queues name both options", t => {
  withFlag(t, "1");
  assert.throws(() => page(board(), "queue=triage&state=unclaimed"));
  assert.throws(() => page(board(), "queue=triage&cursor=abc"));
  assert.throws(() => page(board(), "queue=nope"), /queue=triage/);
});

test("pure helpers: historyOmitted and system-opened tasks", () => {
  const sys = { id: "s", state: "unclaimed", owner: null, history: [{ action: "created", agentId: "system", at: at(0) }], tags: [], acceptanceCriteria: [] };
  assert.deepEqual([...triageNote(sys, T0).missing], ["acceptance_criteria", "tags", "opener"]);
  assert.equal(triageClaims([{ ...sys, historyOmitted: 3 }], T0).length, 0);
});
