// Code map: local parse, incremental rebuild, query, path, hotspots, explain,
// Graphify ingest, and the duplicate-pull rule from the 2026-10-25 findings.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyFiles, assessOverlap, emptyGraph, fileSetSimilarity, graphFromGraphify,
  graphifyPreferred, mapExplain, mapHotspots, mapPath, mapQuery, parseModule, projectMapEnabled
} from "../server/project-map.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/duplicate-pr-pairs.json", import.meta.url), "utf8"));

const helper = "export function helper() { return 1; }\n";
const caller = "import { helper } from \"./a.js\";\nexport function run() { return helper(); }\n";

test("parse keeps an import, a symbol and the call that uses it", () => {
  const parsed = parseModule("b.js", caller);
  assert.deepEqual(parsed.specs.map(entry => entry.spec), ["./a.js"]);
  assert.ok(parsed.symbols.some(symbol => symbol.name === "run" && symbol.kind === "function"));
  assert.ok(parsed.calls.includes("helper"));
  assert.equal(parsed.calls.includes("run"), false);
});

test("a second push skips an unchanged file and refreshes the one that changed", () => {
  const first = applyFiles(emptyGraph("acme/widgets"), {
    repo: "acme/widgets", revision: "a", files: [
      { path: "a.js", source: helper },
      { path: "b.js", source: caller }
    ]
  }, 10);
  assert.equal(first.files["b.js"].imports.includes("a.js"), true);
  const again = applyFiles(first, {
    repo: "acme/widgets", revision: "b", files: [
      { path: "a.js", source: helper },
      { path: "b.js", source: caller.replace("return helper()", "return helper() + 1") }
    ]
  }, 20);
  assert.equal(again.files["a.js"].hash, first.files["a.js"].hash);
  assert.notEqual(again.files["b.js"].hash, first.files["b.js"].hash);
  assert.equal(again.builtAt, 20);
  const dropped = applyFiles(again, { removed: ["b.js"] }, 30);
  assert.equal(dropped.files["b.js"], undefined);
  assert.ok(dropped.files["a.js"]);
});

test("query, path, hotspots and explain follow the import and the call", () => {
  const graph = applyFiles(emptyGraph("acme/widgets"), {
    files: [{ path: "a.js", source: helper }, { path: "b.js", source: caller }, { path: "c.js", source: "export const idle = 1;\n" }]
  });
  const file = mapQuery(graph, "a.js");
  assert.equal(file.kind, "file");
  assert.deepEqual(file.dependents, ["b.js"]);
  assert.ok(file.callers.some(call => call.file === "b.js" && call.symbol === "helper"));
  const symbol = mapQuery(graph, "helper");
  assert.equal(symbol.kind, "symbol");
  assert.ok(symbol.definitions.some(entry => entry.file === "a.js"));
  assert.ok(symbol.callers.some(call => call.file === "b.js"));
  const path = mapPath(graph, "b.js", "helper");
  assert.equal(path.found, true);
  assert.ok(path.nodes.length >= 2);
  assert.equal(path.nodes.at(-1).symbol ?? path.nodes.at(-1).file, path.nodes.at(-1).kind === "symbol" ? "helper" : "a.js");
  const spots = mapHotspots(graph);
  assert.equal(spots[0].path, "a.js");
  assert.ok(spots[0].coupling > spots.find(row => row.path === "c.js").coupling);
  const explained = mapExplain(graph, "a.js");
  assert.match(explained.summary, /neighbors/);
  assert.match(explained.summary, /dependents/);
  assert.equal(explained.hotspotRank, 1);
  assert.equal(mapQuery(graph, "missing.js").found, false);
  assert.equal(mapPath(graph, "missing.js", "a.js").found, false);
});

test("Graphify JSON becomes the same neighbor relationship", () => {
  const graph = graphFromGraphify({
    nodes: [
      { id: "f1", label: "a.js", file: "a.js", kind: "file" },
      { id: "s1", label: "helper", file: "a.js", kind: "function", line: 1 },
      { id: "f2", label: "b.js", file: "b.js", kind: "file" }
    ],
    edges: [
      { from: "f2", to: "f1", kind: "imports" },
      { from: "f2", to: "s1", kind: "calls" }
    ]
  }, { repo: "Acme/Widgets" });
  assert.equal(graph.engine, "graphify");
  assert.equal(graph.repo, "acme/widgets");
  assert.deepEqual(graph.files["b.js"].imports, ["a.js"]);
  assert.ok(graph.files["b.js"].calls.includes("helper"));
  assert.deepEqual(mapQuery(graph, "a.js").dependents, ["b.js"]);

  const networkx = graphFromGraphify({
    nodes: [
      { id: "a.js::helper", label: "helper", source_file: "a.js", source_location: "L1" },
      { id: "b.js::run", label: "run", source_file: "b.js", source_location: "4:1" }
    ],
    links: [
      { source: "b.js::run", target: "a.js::helper", relation: "imports" },
      { source: "b.js::run", target: "a.js::helper", relation: "calls" }
    ]
  }, { repo: "acme/widgets" });
  assert.equal(networkx.files["a.js"].symbols[0].line, 1);
  assert.deepEqual(mapQuery(networkx, "a.js").dependents, ["b.js"]);
  assert.deepEqual(mapQuery(networkx, "helper").callers.map(call => call.file), ["b.js"]);
});

test("the map flag defaults on and Graphify stays off until asked", () => {
  assert.equal(projectMapEnabled({}), true);
  assert.equal(projectMapEnabled({ ROOM_PROJECT_MAP: "off" }), false);
  assert.equal(projectMapEnabled({ ROOM_PROJECT_MAP: "0" }), false);
  assert.equal(graphifyPreferred({}), false);
  assert.equal(graphifyPreferred({ ROOM_PROJECT_MAP_GRAPHIFY: "on" }), true);
});

test("findings duplicate pairs match, and stacked pulls do not", () => {
  const pairs = [];
  for (const group of fixture.duplicates) {
    for (let i = 0; i < group.numbers.length; i += 1) {
      for (let j = i + 1; j < group.numbers.length; j += 1) {
        const sim = fileSetSimilarity(group.files, group.files);
        assert.equal(sim.duplicate, true, `${group.numbers[i]} vs ${group.numbers[j]}`);
        pairs.push([group.numbers[i], group.numbers[j]]);
      }
    }
  }
  assert.ok(pairs.length >= 15, `expected at least 15 duplicate pairs, got ${pairs.length}`);
  const subset = fileSetSimilarity(fixture.subset.smaller.files, fixture.subset.larger.files);
  assert.equal(subset.subset, true);
  assert.ok(subset.jaccard < 0.7);
  assert.equal(subset.duplicate, true);
  for (const [left, right] of fixture.notDuplicates) {
    assert.equal(fileSetSimilarity(left.files, right.files).duplicate, false, `${left.number} vs ${right.number}`);
  }
  const almost = fileSetSimilarity(
    Array.from({ length: 80 }, (_, i) => `src/a${i}.js`),
    [...Array.from({ length: 69 }, (_, i) => `src/a${i}.js`), ...Array.from({ length: 20 }, (_, i) => `src/b${i}.js`)]
  );
  assert.ok(almost.jaccard < 0.7 && almost.jaccard > 0.6);
  assert.equal(almost.duplicate, false);
  assert.equal(fileSetSimilarity(["docs/openapi.yaml", "server/store.mjs"], ["docs/openapi.yaml", "server/http.mjs"]).duplicate, false);
  assert.equal(fileSetSimilarity(["src/only.js"], ["src/only.js"]).duplicate, true);
  assert.equal(fileSetSimilarity(["src/only.js"], ["src/only.js", "src/other.js", "src/third.js"]).duplicate, false);
});

test("symbol overlap across different files is reported once for every counterpart", () => {
  const graph = applyFiles(emptyGraph("acme/widgets"), {
    files: [{ path: "a.js", source: helper }, { path: "b.js", source: caller }]
  });
  const overlap = assessOverlap({
    subject: { id: "caller", title: "Caller", repo: "acme/widgets", files: ["b.js"], state: "claimed" },
    others: [{ id: "owner", title: "Owner", repo: "acme/widgets", files: ["a.js"], state: "claimed" }],
    graph
  });
  assert.equal(overlap.duplicate, false);
  assert.deepEqual(overlap.symbols, ["helper"]);
  assert.match(overlap.summary, /^Overlap: /);
  assert.match(overlap.summary, /helper\(\)/);
  assert.equal(overlap.with[0].label, "Owner");
});
