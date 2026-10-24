import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("v1 has no private inbox setup, empty state or mail connection prompts", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="inbox-empty"|id="nav-inbox"|Connect Gmail|Personalize setup/);
  assert.match(html, /id="nav-rooms"/);
});
