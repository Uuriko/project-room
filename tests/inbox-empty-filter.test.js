// WAVE-500 guild 7 worker C9 (empty states audit, main app views).
// R-27: a filtered-to-nothing empty state must say why AND give the next
// step. "No messages match these filters." names the cause but leaves the
// human with no stated next move; the filter bar sits adjacent, so the
// honest next step is to change the filters.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../archive/deferred-email/src/inbox-ui.js", import.meta.url), "utf8");
const NEXT_STEP = "No messages match these filters. Change the filters to see more messages.";

test("filtered-empty copy states the next step at every site", () => {
  const hits = ui.split(`"${NEXT_STEP}"`).length - 1;
  assert.ok(hits >= 3, `expected the next-step copy at all filtered-empty sites (setter, clearer, loader), found ${hits}`);
});

test("bare filtered-empty copy without a next step is gone", () => {
  assert.ok(!ui.includes('"No messages match these filters."'), "the why-without-a-next-step literal must not remain");
});
