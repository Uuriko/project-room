// COVERAGE CREW lane5: structural integrity tests for src/emoji-catalog.js.
// Authoring gate: this guards the data contract src/emoji.js's module-level
// parser assumes — every row destructures to six strings, extras is a
// space-separated alias list, shortcodes must be unique (emoji.js keeps the
// first alias silently, so a duplicate remaps an alias to the wrong emoji),
// and MODIFIER_BASE_RANGES must parse as hex ranges (a malformed token
// parses to NaN and silently drops modifier bases). The credible regression
// is a hand-edit to this 1,870-row data file introducing a malformed row, a
// duplicate shortcode, or a broken range; existing coverage (tests/emoji.test.js)
// only probes specific known shortcodes and would not fail. These assertions
// are structural — they survive reordering and legitimate catalog additions,
// never restating the inventory.
import test from "node:test";
import assert from "node:assert/strict";
import { EMOJI_ROWS, MODIFIER_BASE_RANGES } from "../src/emoji-catalog.js";

const SHORTCODE = /^[a-z0-9_+-]+$/;

test("emoji catalog: every row is six strings in [emoji, shortcode, extras, category, description, search] order", () => {
  assert.ok(EMOJI_ROWS.length > 0);
  for (const [index, row] of EMOJI_ROWS.entries()) {
    assert.ok(Array.isArray(row) && row.length === 6, `row ${index} must be an array of 6`);
    assert.ok(row.every(field => typeof field === "string"), `row ${index} fields must all be strings`);
    assert.ok(row[0].length > 0, `row ${index} must have a glyph`);
    assert.ok(SHORTCODE.test(row[1]), `row ${index} primary shortcode must be a valid token`);
    assert.ok(row[3].length > 0, `row ${index} must name a category`);
    assert.ok(row[4].length > 0, `row ${index} must have a description`);
    for (const alias of row[2].split(" ").filter(Boolean)) {
      assert.ok(SHORTCODE.test(alias), `row ${index} extra alias "${alias}" must be a valid token`);
    }
  }
});

test("emoji catalog: primary shortcodes and every alias are unique", () => {
  const seen = new Map();
  for (const [index, [, primary, extras]] of EMOJI_ROWS.entries()) {
    for (const alias of [primary, ...extras.split(" ").filter(Boolean)]) {
      assert.ok(!seen.has(alias), `alias "${alias}" duplicated at rows ${seen.get(alias)} and ${index}`);
      seen.set(alias, index);
    }
  }
});

test("emoji catalog: modifier base ranges parse as hex codepoint ranges", () => {
  assert.ok(MODIFIER_BASE_RANGES.length > 0);
  for (const part of MODIFIER_BASE_RANGES.split(",")) {
    assert.match(part, /^[0-9A-F]+(-[0-9A-F]+)?$/i, `range token "${part}" must be hex or hex-hex`);
    const [startHex, endHex] = part.split("-");
    const start = Number.parseInt(startHex, 16);
    const end = endHex === undefined ? start : Number.parseInt(endHex, 16);
    assert.ok(Number.isFinite(start), `range token "${part}" start must parse`);
    assert.ok(Number.isFinite(end) && end >= start, `range token "${part}" end must parse and not precede the start`);
  }
});
