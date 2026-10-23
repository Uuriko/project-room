// Overview board merge (REV-4394 cure): the snapshot work items and the
// work-claims board are dual registrations of the same work — claim rows
// mirror work-item ids — so the Overview counter unions by id instead of
// adding the two stores. Fail-first: overviewBoardRows does not exist on
// the pre-fix board-ui.js, and the shipped merge read "4 of 4" for the
// fixture-room shape pinned in the first specimen below.
import test from "node:test";
import assert from "node:assert/strict";
import { overviewBoardRows } from "../src/board-ui.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const claim = (id, extra = {}) => ({ id, title: id, state: "unclaimed", owner: null, dependsOn: [], ...extra });

test("dual-registered fixture room: each distinct work counts and lists once", () => {
  // The REV-4394 decomposition of the room-overview browser specimen room:
  // snapshot active work = {test-handoff (proposed), pending-result
  // (completed, awaiting its gate)}, both listed; the claims registry
  // mirrors the results by id, with pending-result delivered (review).
  const claims = [
    claim("native-result", { state: "done", updatedAt: "2026-10-19T12:00:00Z" }),
    claim("approved-result", { state: "done", updatedAt: "2026-10-19T12:00:00Z" }),
    claim("pending-result", { state: "delivered" }),
    claim("starter", { state: "claimed", owner: "owner" })
  ];
  const workIds = new Set(["test-handoff", "pending-result"]);
  const shownWorkIds = new Set(["test-handoff", "pending-result"]);
  const { shown, extraTotal } = overviewBoardRows(claims, NOW, workIds, shownWorkIds);
  assert.deepEqual(shown.map(item => item.id), ["starter"], "only the board-only claim is listed beside the work rows");
  assert.equal(extraTotal, 1, "only the starter adds distinct work beyond the active work set");
  // Counter semantics: 2 listed work rows + 1 board row, of 2 + 1 distinct.
  assert.equal(2 + shown.length, 3);
  assert.equal(2 + extraTotal, 3);
});

test("pure-claim room: a board with no work items counts the board (the '0 of 0' shape)", () => {
  const claims = [
    claim("starter", { state: "claimed", owner: "owner" }),
    claim("ready-one"),
    claim("blocked-one", { dependsOn: ["missing-dep"] }),
    claim("delivered-one", { state: "delivered" }),
    claim("landed-one", { state: "done", updatedAt: "2026-10-19T12:00:00Z" }),
    claim("old-done", { state: "done", updatedAt: "2026-09-20T12:00:00Z" })
  ];
  const { shown, extraTotal } = overviewBoardRows(claims, NOW, new Set(), new Set());
  assert.equal(extraTotal, 4, "ready + claimed + blocked + review count; landed and old-done do not");
  assert.deepEqual(shown.map(item => item.id), ["ready-one", "starter", "blocked-one"], "board rows list in board order, capped at three like the work rows");
});

test("dual-registered work beyond the listed three: listed once as a board row, counted once", () => {
  const claims = [
    claim("w4", { state: "delivered" }),
    claim("solo", { state: "claimed", owner: "owner" })
  ];
  const workIds = new Set(["w1", "w2", "w3", "w4"]);
  const shownWorkIds = new Set(["w1", "w2", "w3"]);
  const { shown, extraTotal } = overviewBoardRows(claims, NOW, workIds, shownWorkIds);
  assert.deepEqual(shown.map(item => item.id), ["solo", "w4"], "w4's work row is not listed, so its board row is the one listing");
  assert.equal(extraTotal, 1, "w4 adds nothing beyond the full active work set; only solo is distinct board work");
  // Counter semantics: 3 listed work rows + 2 board rows, of 4 + 1 distinct.
  assert.equal(3 + shown.length, 5);
  assert.equal(4 + extraTotal, 5);
});

test("no board read yet: the merge adds nothing", () => {
  const { shown, extraTotal } = overviewBoardRows(null, NOW, new Set(["w1"]), new Set(["w1"]));
  assert.deepEqual(shown, []);
  assert.equal(extraTotal, 0);
});
