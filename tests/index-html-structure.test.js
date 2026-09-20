import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// index.html carries hundreds of ids and the whole client addresses it through
// document.querySelector, which returns the first match and reports no problem
// when there are two. A duplicate id is therefore silent: the second element
// never receives its text, its listener or its hidden toggle, and it fails in a
// browser rather than in a test.
//
// The same applies to id references. aria-labelledby pointing at an id nothing
// declares leaves a control with no accessible name, and a <label for> that
// misses stops clicking the label focusing the field. Both survive every
// functional test, because the feature still works for anyone not relying on
// them.
//
// Both invariants held when this was written and neither was enforced. This is
// the cheap gate that keeps it that way. It exists because a single edit of
// mine introduced two duplicate ids in one go.

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

const ID_REFERENCE_ATTRIBUTES = ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-details", "aria-errormessage", "aria-flowto", "for", "list"];

const declaredIds = () => [...html.matchAll(/\sid="([^"]*)"/g)].map(match => match[1]);

test("every id in index.html is unique", () => {
  const ids = declaredIds();
  const seen = new Set();
  const duplicated = new Set();
  for (const id of ids) { if (seen.has(id)) duplicated.add(id); seen.add(id); }
  assert.deepEqual([...duplicated], [], "querySelector silently returns only the first of these");
  assert.ok(ids.length > 400, `expected the full document, found ${ids.length} ids`);
});

test("no id is empty or carries stray whitespace", () => {
  // getElementById and <label for> match the exact string, so a trailing space
  // is a reference that can never resolve.
  assert.deepEqual(declaredIds().filter(id => id !== id.trim() || id === "" || /\s/.test(id)), []);
});

test("every id reference in index.html resolves to an element that exists", () => {
  const ids = new Set(declaredIds());
  const dangling = [];
  for (const attribute of ID_REFERENCE_ATTRIBUTES) {
    for (const match of html.matchAll(new RegExp(`\\s${attribute}="([^"]+)"`, "g"))) {
      for (const reference of match[1].trim().split(/\s+/)) if (!ids.has(reference)) dangling.push(`${attribute}="${reference}"`);
    }
  }
  assert.deepEqual(dangling, [], "these point at ids no element declares");
});

test("the guard actually detects what it claims to", () => {
  // A gate over a document that happens to be clean proves nothing until it has
  // been shown to fail. These run the same logic over planted input.
  const withDuplicate = '<p id="a"></p><p id="b"></p><p id="a"></p>';
  const ids = [...withDuplicate.matchAll(/\sid="([^"]*)"/g)].map(match => match[1]);
  const seen = new Set(); const duplicated = new Set();
  for (const id of ids) { if (seen.has(id)) duplicated.add(id); seen.add(id); }
  assert.deepEqual([...duplicated], ["a"], "a planted duplicate must be found");

  const withDangling = '<h2 id="real">t</h2><section aria-labelledby="missing"></section>';
  const present = new Set([...withDangling.matchAll(/\sid="([^"]*)"/g)].map(match => match[1]));
  const found = [...withDangling.matchAll(/\saria-labelledby="([^"]+)"/g)]
    .flatMap(match => match[1].trim().split(/\s+/)).filter(reference => !present.has(reference));
  assert.deepEqual(found, ["missing"], "a planted dangling reference must be found");
});
