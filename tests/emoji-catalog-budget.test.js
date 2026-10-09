// PRODUCT-200 client-craft slice m-12 (mobile performance + honest loading).
// The emoji catalog ships in the index page's critical module graph
// (app.js -> emoji.js -> emoji-catalog.js): 1870 rows of Object.freeze()
// literals, ~197KB raw / ~39KB gzip, parsed on every first paint on a phone.
// This test pins a mobile byte budget for the catalog file plus behavior
// parity pins (typeahead results, shortcode rendering, catalog grouping)
// so a compaction of the data format cannot silently change behavior.
//
// Fail-first: the budget assertion is RED on the un-compacted file and goes
// green when the catalog is stored compactly with identical semantics.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EMOJI_ROWS, MODIFIER_BASE_RANGES } from "../src/emoji-catalog.js";
import {
  emojiMatches,
  emojiName,
  renderEmojiShortcodes,
  emojiCatalog,
  canonicalReaction,
} from "../src/emoji.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, "..", "src", "emoji-catalog.js");

// Mobile budget: the catalog must stay well under half its historical
// ~197KB so it stops dominating the first-paint module graph on phones.
test("emoji catalog: file stays under the mobile byte budget", () => {
  const bytes = statSync(catalogPath).size;
  assert.ok(
    bytes < 100_000,
    `emoji-catalog.js is ${bytes} bytes; mobile budget is 100000 (was ~197656 before compaction)`
  );
  // Sanity: the budget win must come from a compact encoding, not from
  // dropping rows — parity pins below assert the inventory is intact.
  assert.ok(readFileSync(catalogPath, "utf8").includes("MODIFIER_BASE_RANGES"));
});

test("emoji catalog: inventory intact after compaction", () => {
  assert.equal(EMOJI_ROWS.length, 1870);
  assert.ok(MODIFIER_BASE_RANGES.length > 0);
  // Spot-check a row whose search terms are NOT derivable from the other
  // fields (needs an explicit override in a compact encoding).
  const alien = EMOJI_ROWS.find(row => row[1] === "alien");
  assert.deepEqual(alien, ["👽", "alien", "", "Smileys & Emotion", "alien", "alien ufo alien"]);
  const boom = EMOJI_ROWS.find(row => row[1] === "boom");
  assert.deepEqual(boom, ["💥", "boom", "collision", "Smileys & Emotion", "collision", "collision explode boom collision"]);
  const hundred = EMOJI_ROWS.find(row => row[1] === "100");
  assert.deepEqual(hundred, ["💯", "100", "", "Smileys & Emotion", "hundred points", "hundred points score perfect 100"]);
});

test("emoji catalog: typeahead parity pins", () => {
  const emojis = query => emojiMatches(query, 8).map(match => match.emoji);
  assert.deepEqual(emojis("alien"), ["👽", "👾"]);
  assert.deepEqual(emojis("boom"), ["💥", "🪃", "💣"]);
  assert.deepEqual(emojis("100"), ["💯"]);
  assert.deepEqual(emojis("heart"), ["❤️", "💟", "😍", "😻", "🫶", "❤️‍🔥", "💓", "💗"]);
  // Search-only terms (not in shortcode/description) must keep matching.
  assert.deepEqual(emojis("ufo"), ["👽", "🛸"]);
  assert.deepEqual(emojis("explode"), ["💥"]);
  assert.deepEqual(emojis("zzzznomatch"), []);
});

test("emoji catalog: render and naming parity pins", () => {
  assert.deepEqual(["💯", "👽", "💥", "👍"].map(emojiName),
    ["hundred points", "alien", "collision", "thumbs up"]);
  assert.equal(
    renderEmojiShortcodes("Hello :wave: and :alien: plus :100: and :boom: and :notreal:"),
    "Hello 👋 and 👽 plus 💯 and 💥 and :notreal:"
  );
  assert.deepEqual(
    [canonicalReaction(":alien:"), canonicalReaction(":boom:"), canonicalReaction(":100:")],
    ["👽", "💥", "💯"]
  );
});

test("emoji catalog: picker grouping parity pins", () => {
  const groups = emojiCatalog().map(group => `${group.category}:${group.items.length}`);
  assert.deepEqual(groups, [
    "Smileys & Emotion:166",
    "People & Body:363",
    "Animals & Nature:152",
    "Food & Drink:133",
    "Activities:85",
    "Travel & Places:218",
    "Objects:261",
    "Symbols:223",
    "Flags:269",
  ]);
});
