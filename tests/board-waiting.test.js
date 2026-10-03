// The Board's public projection must not drop live work while filtering old
// completions. Existing browser coverage owns the rendered controls/navigation;
// this matrix independently guards classification across dependency states.
import test from "node:test";
import assert from "node:assert/strict";
import { placeClaims } from "../src/board-ui.js";

const now = Date.parse("2026-10-03T00:00:00Z");
const row = (id, extra = {}) => ({
  id, title: id, state: "unclaimed", owner: null, dependsOn: [],
  updatedAt: "2026-10-03T00:00:00Z", ...extra
});
const ids = rows => rows.map(item => item.id).sort();

test("unclaimed work remains in Blocked for every unfinished or unknown prerequisite", () => {
  for (const state of ["unclaimed", "claimed", "in_progress", "blocked", "missing"]) {
    const prerequisite = state === "missing" ? [] : [row("prerequisite", { state, owner: state === "unclaimed" ? null : "worker" })];
    const waiting = row("waiting", { dependsOn: ["prerequisite"] });
    const before = structuredClone([...prerequisite, waiting]);
    const columns = placeClaims(before, now);
    assert.ok(columns.blocked.some(item => item.id === "waiting"), `${state}: waiting task stays visible`);
    assert.ok(!columns.ready.some(item => item.id === "waiting"), `${state}: waiting is not ready`);
    assert.deepEqual(ids(Object.values(columns).flat()), ids(before), `${state}: every live task appears once`);
    assert.deepEqual(before, [...prerequisite, waiting], "projection does not write task state or ownership");
  }
});

test("all prerequisites must finish before Ready, including completions filtered out of the Board", () => {
  const old = row("old", { state: "done", owner: "worker", updatedAt: "2026-09-01T00:00:00Z" });
  const current = row("current", { state: "in_progress", owner: "worker" });
  const waiting = row("waiting", { dependsOn: ["old", "current"] });
  const before = [old, current, waiting];
  assert.deepEqual(ids(placeClaims(before, now).blocked), ["waiting"]);
  const after = [old, { ...current, state: "done" }, waiting];
  const columns = placeClaims(after, now);
  assert.deepEqual(ids(columns.ready), ["waiting"]);
  assert.deepEqual(ids(columns.blocked), []);
  assert.deepEqual(ids(Object.values(columns).flat()), ["current", "waiting"], "only the old completion is filtered out");
  assert.equal(waiting.state, "unclaimed", "Ready is a view, not a persisted task transition");
  assert.equal(waiting.owner, null);
});
