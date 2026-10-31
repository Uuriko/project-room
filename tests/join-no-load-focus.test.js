// MI-011 (Jill master-issues): /join must not seize focus on load.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("renderEnter shows the enter card without moving focus", () => {
  const src = readFileSync(new URL("../src/join.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function renderEnter()"));
  const end = body.indexOf('show("join-enter");');
  const tail = body.slice(end, body.indexOf("\n}", end));
  assert.doesNotMatch(tail, /\.focus\(\)/);
});
