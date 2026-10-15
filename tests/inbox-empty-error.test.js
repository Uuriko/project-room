// WAVE-500 guild 7 worker C9 (empty states audit, main app views).
// R-27: an empty state must be true for this viewer. A failed load is not an
// empty inbox: when api.list() throws, #inbox-empty ("Your inbox is empty...")
// must not sit under the "Couldn't load inbox. Try again." error whisper
// claiming we know there is nothing here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../src/inbox-ui.js", import.meta.url), "utf8");

test("load() hides the empty note on a failed inbox read", () => {
  assert.ok(
    ui.includes('text("#inbox-status", errorText(error)); $("#inbox-empty").hidden = true;'),
    "load()'s error path must hide #inbox-empty so a failed load never claims the inbox is empty"
  );
});
