import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { rankByCuriosity, sortWorkByCuriosity, viewerHistory } from "../src/curiosity-rank.mjs";
import { createResultsFixture } from "../scripts/results-fixture.mjs";

const HISTORY = [
  { title: "Fix login redirect loop", text: "Users bounce between login and home after SSO." },
  { title: "Fix signup email verification", text: "Verification links expire too fast for new users." },
];

test("sweet-spot work ranks first; routine and noise sink", () => {
  const candidates = [
    { id: "routine", title: "Fix login redirect loop", text: "SSO bounce again on staging." },
    { id: "noise", title: "Bake sourdough bread", text: "Hydration ratios for a starter." },
    { id: "stretch", title: "Fix OAuth token refresh", text: "Refresh tokens expire during long SSO sessions." },
  ];
  const ranked = rankByCuriosity(candidates, HISTORY);
  assert.equal(ranked[0].id, "stretch");
  assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score,
    "scores strictly decrease down the ranking");
  for (const r of ranked) {
    assert.ok(r.score >= 0 && r.score <= 1, "score in [0,1]");
    assert.ok(r.familiarity >= 0 && r.familiarity <= 1, "familiarity in [0,1]");
    assert.equal(typeof r.label, "string");
  }
  assert.equal(ranked.find(r => r.id === "routine").label, "routine — you have done this before");
});

test("ties break deterministically by id", () => {
  const candidates = [
    { id: "b-item", title: "Identical task", text: "Same words here." },
    { id: "a-item", title: "Identical task", text: "Same words here." },
  ];
  const ranked = rankByCuriosity(candidates, HISTORY);
  assert.deepEqual(ranked.map(r => r.id), ["a-item", "b-item"]);
  assert.deepEqual(rankByCuriosity(candidates, HISTORY).map(r => r.id), ["a-item", "b-item"]);
});

test("empty history ranks distinctive items first and says so", () => {
  const candidates = [
    { id: "plain1", title: "Update footer links", text: "Footer links need updating." },
    { id: "plain2", title: "Update footer text", text: "Footer text needs updating." },
    { id: "odd", title: "Quantum knitting patterns", text: "Entangled yarn topologies." },
  ];
  const ranked = rankByCuriosity(candidates, []);
  assert.equal(ranked[0].id, "odd");
  for (const r of ranked) assert.equal(r.label, "unranked — no completed work yet");
});

test("sortWorkByCuriosity keeps item identity and attaches curiosity", () => {
  const items = [
    { id: "x", title: "Fix login redirect loop", definitionOfDone: "No more SSO bounce." },
    { id: "y", title: "Bake sourdough bread", definitionOfDone: "Edible loaf." },
  ];
  const sorted = sortWorkByCuriosity(items, HISTORY);
  assert.equal(sorted.length, 2);
  assert.ok(sorted.every(({ item, curiosity }) => item && curiosity.score !== undefined));
  assert.deepEqual(new Set(sorted.map(({ item }) => item.id)), new Set(["x", "y"]));
});

test("viewerHistory uses only the viewer's own completed work", t => {
  const f = createResultsFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const state = f.state();
  const mine = viewerHistory(state, "producer").map(i => i.id).sort();
  assert.deepEqual(mine, ["approved-result", "native-result"]);
  assert.deepEqual(viewerHistory(state, "reviewer"), []);
  assert.deepEqual(viewerHistory(state, "nobody"), []);
});
