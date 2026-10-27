// Code map: local parse, incremental rebuild, query, path, hotspots, explain,
// Graphify ingest, and the duplicate-pull rule from the 2026-10-25 findings.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyFiles, assessOverlap, createOverlapContext, emptyGraph, fileSetSimilarity, graphFromGraphify,
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

test("oversized source invalidates stale symbols and reports incomplete reads", () => {
  const first = applyFiles(emptyGraph("acme/widgets"), { files: [{ path: "a.js", source: helper }] }, 10);
  const next = applyFiles(first, { revision: "new", files: [{ path: "a.js", source: "é".repeat(40000) }] }, 20);
  assert.equal(next.files["a.js"], undefined);
  for (const result of [mapQuery(next, "helper"), mapPath(next, "a.js", "helper"), mapExplain(next, "a.js")]) {
    assert.equal(result.engine, "parser");
    assert.equal(result.revision, "new");
    assert.equal(result.builtAt, 20);
    assert.equal(result.truncated, true);
    assert.equal(result.found, false);
  }
  assert.equal(applyFiles(next, { files: [] }).truncated, true);
  assert.equal(parseModule("large.js", " ".repeat(65536) + helper).truncated, true);
});

test("Graphify import bounds nodes, files and edges without claiming completeness", () => {
  const nodes = Array.from({ length: 20001 }, (_, i) => ({ id: String(i), source_file: `f${i}.js`, label: `f${i}`, kind: "file" }));
  const graph = graphFromGraphify({ nodes, links: [] }, { repo: "acme/widgets", revision: "r1", now: 30 });
  assert.equal(Object.keys(graph.files).length, 4000);
  assert.equal(graph.truncated, true);
  const edgeBound = graphFromGraphify({ nodes: nodes.slice(0, 2), links: Array.from({ length: 40001 }, () => ({ source: "0", target: "1", relation: "imports" })) });
  assert.equal(edgeBound.truncated, true);
  assert.deepEqual(edgeBound.files["f0.js"].imports, ["f1.js"]);
  assert.equal(mapQuery(graph, "f0.js").revision, "r1");
});

test("Graphify calls retain their exact target without requiring an imports edge", () => {
  const graph = graphFromGraphify({ graph: { schema_version: 1, graphify_version: "0.9.96" }, nodes: [
    { id: "a", source_file: "a.js", label: "helper" },
    { id: "other", source_file: "other.js", label: "helper" },
    { id: "b", source_file: "b.js", label: "run" }
  ], links: [{ source: "b", target: "a", relation: "calls" }] }, { revision: "exact", now: 40 });
  assert.deepEqual(mapQuery(graph, "a.js").callers, [{ file: "b.js", symbol: "helper" }]);
  assert.deepEqual(mapQuery(graph, "other.js").callers, []);
  assert.equal(mapPath(graph, "b.js", "a.js#helper").found, true);
  for (const result of [mapQuery(graph, "helper"), mapPath(graph, "b.js", "a.js#helper"), mapExplain(graph, "missing")]) {
    assert.equal(result.engine, "graphify");
    assert.equal(result.graphifyVersion, "0.9.96");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.semanticCompleteness, "partial");
    assert.equal(result.revision, "exact");
    assert.equal(result.builtAt, 40);
    assert.equal(result.truncated, false);
  }
});

test("bounded query results and exhausted path depth explicitly report truncation", () => {
  const nodes = Array.from({ length: 202 }, (_, i) => ({ id: String(i), source_file: `f${i}.js`, label: "same" }));
  const graph = graphFromGraphify({ nodes });
  assert.equal(mapQuery(graph, "same").definitions.length, 200);
  assert.equal(mapExplain(graph, "same").truncated, true);
  const chain = graphFromGraphify({ nodes, links: nodes.slice(1).map((_, i) => ({ source: String(i), target: String(i + 1), relation: "imports" })) });
  assert.equal(mapPath(chain, "f0.js", "f201.js").found, false);
  assert.equal(mapPath(chain, "f0.js", "f201.js").truncated, true);
});


test("overlap requires known matching repositories and duplicate advice stays heuristic", () => {
  const subject = { id: "one", repo: "Acme/Widgets", files: ["a.js", "b.js"] };
  const other = { id: "two", repo: "acme/widgets", files: ["a.js", "b.js"] };
  for (const repo of [undefined, "", "invalid", "other/widgets"]) {
    assert.equal(assessOverlap({ subject, others: [{ ...other, repo }] }), null);
    assert.equal(assessOverlap({ subject: { ...subject, repo }, others: [other] }), null);
  }
  assert.equal(assessOverlap({ subject: { ...subject, repo: undefined }, others: [{ ...other, repo: undefined }] }), null);
  const advice = assessOverlap({ subject, others: [other] });
  assert.equal(advice.duplicate, true);
  assert.match(advice.summary, /^Duplicate: .*may overlap/);
  assert.match(advice.summary, /review the changes to confirm/);
});


test("Graphify extract no-cluster shape resolves callable labels and file nodes", () => {
  const graph = graphFromGraphify({ nodes: [
    { id: "file-a", label: "helper.py", source_file: "src/helper.py", file_type: "code" },
    { id: "fn-a", label: "helper()", source_file: "src/helper.py", _callable: true, file_type: "code" },
    { id: "file-b", label: "main.py", source_file: "src/main.py", file_type: "code" }
  ], edges: [
    { source: "file-b", target: "file-a", relation: "imports_from", confidence: "EXTRACTED" },
    { source: "file-b", target: "fn-a", relation: "calls", confidence: "EXTRACTED" }
  ] });
  const result = mapQuery(graph, "helper");
  assert.equal(result.found, true);
  assert.deepEqual(result.callers, [{ file: "src/main.py", symbol: "helper" }]);
  assert.deepEqual(graph.files["src/helper.py"].symbols.map(s => s.name), ["helper"]);
  assert.deepEqual(mapQuery(graph, "src/helper.py").dependents, ["src/main.py"]);
  assert.equal(result.schemaVersion, null);
  assert.equal(result.semanticCompleteness, "partial");
});


test("imported source scope is bounded and retained on positive and negative reads", () => {
  const scoped = graphFromGraphify({ graph: { source_scope: "server" }, nodes: [], edges: [] });
  for (const result of [mapQuery(scoped, "missing"), mapExplain(scoped, "missing"), mapPath(scoped, "a", "b")]) assert.equal(result.sourceScope, "server");
  assert.equal(mapQuery(graphFromGraphify({ nodes: [], edges: [] }), "missing").sourceScope, null);
  assert.equal(graphFromGraphify({ graph: { source_scope: "x".repeat(301) }, nodes: [], edges: [] }).sourceScope.length, 300);
});


test("request-scoped overlap reuse preserves results and new requests observe changed graph", () => {
  const build = target => graphFromGraphify({ nodes: [
    { id: "a", source_file: "a.js", label: "alpha" },
    { id: "b", source_file: "b.js", label: "beta" },
    { id: "caller", source_file: "caller.js", label: "run" }
  ], edges: [{ source: "caller", target, relation: "calls" }] }, { repo: "acme/widgets" });
  const graph = build("a");
  const claims = ["a.js", "b.js", "caller.js"].map((file, i) => ({ id: String(i), repo: "acme/widgets", files: [file] }));
  const overlapContext = createOverlapContext(graph);
  const cached = claims.map(subject => assessOverlap({ subject, others: claims, graph, overlapContext }));
  const uncached = claims.map(subject => assessOverlap({ subject, others: claims, graph }));
  assert.deepEqual(cached, uncached);
  assert.deepEqual(cached[2].symbols, ["alpha"]);
  const changed = build("b");
  // Even an accidentally retained old context cannot contaminate a new graph.
  const fresh = assessOverlap({ subject: claims[2], others: claims, graph: changed, overlapContext });
  assert.deepEqual(fresh.symbols, ["beta"]);
  assert.equal(assessOverlap({ subject: { ...claims[0], files: [] }, others: claims, graph, overlapContext }), null);
});
