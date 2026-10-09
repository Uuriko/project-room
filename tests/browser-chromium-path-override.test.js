// Worker-33 (guild-06 shard 33): fail-first regression for the hermetic-chromium
// override gap. 83 of 136 browser-check scripts honor ROOM_TEST_CHROMIUM_PATH
// so CI can point playwright at a hermetic chromium build; every
// chromium.launch() in a shard-33 script must too. A launch that ignores the
// env var starts the bundled chromium instead, breaking hermetic runs.
//
// Repro (before fix): notification-feed-browser-check.mjs's second test,
// contribution-journey-check.mjs, and refine-draft-browser-check.mjs each
// launch chromium without the override spread the sibling tests use.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHARD = [
  "scripts/contribution-journey-check.mjs",
  "scripts/notification-feed-browser-check.mjs",
  "scripts/refine-draft-browser-check.mjs",
];

for (const rel of SHARD) {
  test(`${rel}: every chromium.launch honors ROOM_TEST_CHROMIUM_PATH`, () => {
    const src = readFileSync(`${root}/${rel}`, "utf8");
    const launches = [];
    let from = 0;
    for (;;) {
      const idx = src.indexOf("chromium.launch(", from);
      if (idx === -1) break;
      const end = src.indexOf("});", idx);
      assert.ok(end !== -1, "launch call must terminate");
      launches.push(src.slice(idx, end));
      from = end;
    }
    assert.ok(launches.length > 0, "expected at least one chromium.launch");
    for (const [i, call] of launches.entries()) {
      assert.ok(
        call.includes("ROOM_TEST_CHROMIUM_PATH"),
        `launch #${i + 1} ignores ROOM_TEST_CHROMIUM_PATH: ${call.slice(0, 120)}...`
      );
    }
  });
}
