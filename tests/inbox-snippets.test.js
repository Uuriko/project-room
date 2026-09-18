// LANE B: snippet library tests (fixture-driven, injected clock).
import test from "node:test";
import assert from "node:assert/strict";
import { createSnippetLibrary, expandBody, parseVariables, SnippetError } from "../server/inbox-snippets.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SnippetError && error.code === code);

const NOW = 1_750_000_000_000;
const lib = () => createSnippetLibrary({ clock: () => NOW });

test("create/get/list with variable metadata", () => {
  const snippets = lib();
  const created = snippets.create({ shortcut: "intro", name: "Intro email", body: "Hi {{name}}, thanks for reaching out!" });
  assert.equal(created.shortcut, "intro");
  assert.deepEqual(created.variables, [{ name: "name", fallback: null }]);
  assert.equal(created.useCount, 0);
  assert.ok(Object.isFrozen(created));
  assert.equal(snippets.get("intro").name, "Intro email");
  assert.equal(snippets.count(), 1);
  throwsCode(() => snippets.create({ shortcut: "intro", name: "dup", body: "x" }), "SNIP_DUPLICATE");
});

test("shortcut validation", () => {
  const snippets = lib();
  for (const bad of ["A", "x", "has space", "UPPER", "semi;colon", "a".repeat(33)]) {
    throwsCode(() => snippets.create({ shortcut: bad, name: "n", body: "b" }), "SNIP_INVALID_INPUT");
  }
  throwsCode(() => snippets.create({ shortcut: "ok-1_a", name: "", body: "b" }), "SNIP_INVALID_INPUT");
  throwsCode(() => snippets.create({ shortcut: "ok2", name: "n", body: "" }), "SNIP_INVALID_INPUT");
});

test("expand substitutes variables, counts uses", () => {
  const snippets = lib();
  snippets.create({ shortcut: "follow", name: "Follow-up", body: "Hi {{name|there}}, circling back on {{topic}}." });
  const first = snippets.expand("follow", { name: "Ada", topic: "the launch" });
  assert.equal(first.expanded, "Hi Ada, circling back on the launch.");
  assert.equal(first.useCount, 1);
  const second = snippets.expand("follow", { topic: "pricing" });
  assert.equal(second.expanded, "Hi there, circling back on pricing.");
  assert.equal(second.useCount, 2);
  // Unknown snippet.
  throwsCode(() => snippets.expand("nope", {}), "SNIP_UNKNOWN_SNIPPET");
});

test("strict mode throws on unknown variables; lenient keeps the placeholder", () => {
  const snippets = lib();
  snippets.create({ shortcut: "dear", name: "n", body: "Dear {{name}}," });
  throwsCode(() => snippets.expand("dear", {}), "SNIP_UNKNOWN_VARIABLE");
  const kept = snippets.expand("dear", {}, { strict: false });
  assert.equal(kept.expanded, "Dear {{name}},");
  // Non-string/number variable values are rejected.
  throwsCode(() => snippets.expand("dear", { name: { x: 1 } }), "SNIP_INVALID_INPUT");
  // Numeric values are stringified.
  snippets.create({ shortcut: "n2", name: "n", body: "Order {{id}} ships." });
  assert.equal(snippets.expand("n2", { id: 42 }).expanded, "Order 42 ships.");
});

test("expandBody is pure and standalone", () => {
  assert.equal(expandBody("a {{x}} b", { x: "y" }), "a y b");
  assert.equal(expandBody("{{greet|hi}}", {}), "hi");
  assert.equal(expandBody("{{  spaced  }}", { spaced: "ok" }), "ok");
  throwsCode(() => expandBody("{{missing}}", {}), "SNIP_UNKNOWN_VARIABLE");
  assert.equal(expandBody("{{missing}}", {}, { strict: false }), "{{missing}}");
  throwsCode(() => expandBody(42, {}), "SNIP_INVALID_INPUT");
  throwsCode(() => expandBody("x", null), "SNIP_INVALID_INPUT");
});

test("parseVariables lists unique variables with fallbacks", () => {
  assert.deepEqual(parseVariables("{{a}} and {{b|x}} and {{a}}"), [
    { name: "a", fallback: null },
    { name: "b", fallback: "x" },
  ]);
  assert.deepEqual(parseVariables("no vars"), []);
});

test("update / remove", () => {
  const snippets = lib();
  snippets.create({ shortcut: "upd", name: "old", body: "old body" });
  const updated = snippets.update("upd", { name: "new", body: "new {{v}} body" });
  assert.equal(updated.name, "new");
  assert.deepEqual(updated.variables, [{ name: "v", fallback: null }]);
  assert.equal(snippets.expand("upd", { v: "V" }).expanded, "new V body");
  throwsCode(() => snippets.update("missing", { name: "n" }), "SNIP_UNKNOWN_SNIPPET");
  const removed = snippets.remove("upd");
  assert.deepEqual(removed, { shortcut: "upd", removed: true });
  throwsCode(() => snippets.get("upd"), "SNIP_UNKNOWN_SNIPPET");
  throwsCode(() => snippets.remove("upd"), "SNIP_UNKNOWN_SNIPPET");
});

test("list orders most-used first; search matches shortcut and name", () => {
  const snippets = lib();
  snippets.create({ shortcut: "beta", name: "Beta release notes", body: "b" });
  snippets.create({ shortcut: "alpha", name: "Alpha intro", body: "a" });
  snippets.expand("beta", {});
  snippets.expand("beta", {});
  snippets.expand("alpha", {});
  assert.deepEqual(snippets.list().map(s => s.shortcut), ["beta", "alpha"]);
  assert.deepEqual(snippets.search("alp").map(s => s.shortcut), ["alpha"]);
  assert.deepEqual(snippets.search("release").map(s => s.shortcut), ["beta"]);
  assert.deepEqual(snippets.search("zzz"), []);
  assert.deepEqual(snippets.search(""), []);
  throwsCode(() => snippets.search(42), "SNIP_INVALID_INPUT");
});
