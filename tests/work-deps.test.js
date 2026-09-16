// K002: work dependencies. Pure graph tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { createDepGraph, DepGraphError } from "../server/work-deps.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DepGraphError && error.code === code);

test("dependencies, blockedBy/blocking, and topo order", () => {
  const graph = createDepGraph();
  graph.addDependency("c", "b");
  graph.addDependency("b", "a");
  graph.addItem("lonely");
  assert.deepEqual(graph.blockedBy("c"), ["b"]);
  assert.deepEqual(graph.blocking("b"), ["c"]);
  assert.deepEqual(graph.blocking("a"), ["b"]);
  const order = graph.topoOrder();
  assert.ok(order.indexOf("a") < order.indexOf("b") && order.indexOf("b") < order.indexOf("c"));
  assert.ok(order.includes("lonely"));
  assert.ok(Object.isFrozen(order));
});
test("cycles are refused with a path", () => {
  const graph = createDepGraph();
  graph.addDependency("b", "a");
  graph.addDependency("c", "b");
  throwsCode(() => graph.addDependency("a", "c"), "dependency_cycle");
  // Graph is unchanged after the refused addition.
  assert.deepEqual(graph.blockedBy("a"), []);
  assert.equal(graph.findCycle(), null);
  graph.removeDependency("c", "b");
  assert.deepEqual(graph.blockedBy("c"), []);
});
test("malformed inputs are refused", () => {
  const graph = createDepGraph();
  throwsCode(() => graph.addDependency("a", "a"), "invalid_dep_graph");
  throwsCode(() => graph.addDependency("", "b"), "invalid_dep_graph");
  throwsCode(() => graph.blockedBy("ghost"), "invalid_dep_graph");
});
