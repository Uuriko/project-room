// Kanban board view for room work (backlog K004).
// Failing-first: the board model carries all four lifecycle columns from
// seeded claim state, the shipped kanban.html shells all four columns, and
// the client only ever offers valid transitions (mirroring
// server/work-claims.mjs TRANSITIONS — the server stays the enforcer; the
// client never invents a move). Rendering is DOM-based (templates +
// textContent), so claim titles cannot break markup by construction.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KANBAN_COLUMNS,
  allowedMoves,
  groupClaims,
  kanbanModel,
  moveButtons,
  moveEndpoint,
} from "../src/work-kanban.js";
import { TRANSITIONS as SERVER_TRANSITIONS } from "../server/work-claims.mjs";

const seed = () => ([
  { id: "k-unclaimed", title: "Unclaimed work", state: "unclaimed", owner: null },
  { id: "k-claimed", title: "Claimed work", state: "claimed", owner: "me" },
  { id: "k-progress", title: "In-progress work", state: "in_progress", owner: "me" },
  { id: "k-done", title: "Done work", state: "done", owner: "me" },
  { id: "k-blocked", title: "Blocked work", state: "blocked", owner: "me" },
]);

test("kanban defines exactly the four lifecycle columns", () => {
  assert.deepEqual([...KANBAN_COLUMNS], ["unclaimed", "claimed", "in_progress", "done"]);
});

test("client transition table matches the server state machine exactly", () => {
  for (const state of ["unclaimed", "claimed", "in_progress", "blocked", "done"]) {
    assert.deepEqual(allowedMoves(state), SERVER_TRANSITIONS[state], `moves from ${state}`);
  }
  assert.deepEqual(allowedMoves("bogus"), []);
});

test("kanbanModel carries all four columns with the seeded claims in the right place", () => {
  const model = kanbanModel(seed(), { viewerId: "me" });
  assert.deepEqual(model.columns.map(c => c.name), ["unclaimed", "claimed", "in_progress", "done"]);
  const byName = Object.fromEntries(model.columns.map(c => [c.name, c.claims.map(i => i.id)]));
  assert.deepEqual(byName.unclaimed, ["k-unclaimed"]);
  assert.deepEqual(byName.claimed, ["k-claimed"]);
  assert.deepEqual(byName.in_progress, ["k-progress"]);
  assert.deepEqual(byName.done, ["k-done"]);
  // Blocked claims ride along separately — never dropped.
  assert.deepEqual(model.blocked.map(c => c.id), ["k-blocked"]);
});

test("groupClaims buckets every claim; unknown states fall back to unclaimed", () => {
  const groups = groupClaims([...seed(), { id: "k-weird", state: "nope" }]);
  assert.deepEqual(groups.unclaimed.map(c => c.id), ["k-unclaimed", "k-weird"]);
  assert.deepEqual(groups.blocked.map(c => c.id), ["k-blocked"]);
});

test("kanban.html shells all four columns, the blocked strip, and the card template", () => {
  const html = readFileSync(new URL("../kanban.html", import.meta.url), "utf8");
  for (const column of KANBAN_COLUMNS) {
    assert.ok(html.includes(`data-column="${column}"`), `column shell ${column}`);
    assert.ok(html.includes(`data-drop-column="${column}"`), `drop zone ${column}`);
  }
  assert.ok(html.includes('data-column="blocked"'), "blocked strip");
  assert.ok(html.includes('id="kanban-card-template"'), "card template");
  assert.ok(html.includes('id="kanban-status"'), "status line");
});

test("move buttons offer only valid transitions for the owner's claims", () => {
  const buttons = (id) => moveButtons(seed().find(c => c.id === id), { viewerId: "me" });
  assert.deepEqual(buttons("k-unclaimed").map(b => b.to), ["claimed"]);
  assert.deepEqual(buttons("k-claimed").map(b => b.to).sort(), ["blocked", "in_progress", "unclaimed"]);
  assert.deepEqual(buttons("k-progress").map(b => b.to).sort(), ["blocked", "claimed", "done"]);
  assert.deepEqual(buttons("k-blocked").map(b => b.to).sort(), ["claimed", "in_progress"]);
  assert.deepEqual(buttons("k-done"), [], "done offers no moves");
});

test("move buttons are hidden for claims the viewer does not own", () => {
  const foreign = { id: "k-foreign", title: "Someone else's", state: "claimed", owner: "other" };
  assert.deepEqual(moveButtons(foreign, { viewerId: "me" }), []);
  assert.deepEqual(moveButtons(foreign, {}), [], "signed-out viewers get no buttons");
});

test("an illegal jump (done -> claimed) is never offered", () => {
  const done = seed().find(c => c.id === "k-done");
  assert.ok(!moveButtons(done, { viewerId: "me" }).some(b => b.to === "claimed"));
  assert.deepEqual(allowedMoves("done"), []);
});

test("claiming routes to the claim endpoint; other moves route to the update endpoint", () => {
  const unclaimed = { id: "k-unclaimed", state: "unclaimed" };
  assert.deepEqual(moveEndpoint("muse-room", unclaimed, "claimed"), {
    path: "/api/rooms/muse-room/work-claims/k-unclaimed/claim",
    method: "POST",
    data: {},
  });
  const progress = { id: "k-progress", state: "claimed" };
  assert.deepEqual(moveEndpoint("muse-room", progress, "in_progress"), {
    path: "/api/rooms/muse-room/work-claims/k-progress/update",
    method: "POST",
    data: { state: "in_progress" },
  });
});
