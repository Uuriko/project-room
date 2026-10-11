// Fail-first: default agent avatars per DESIGN SYNC — initials on
// token-colored geometric tiles (SVG, token colors from src/design-tokens.js,
// no faces). Bug classes under test:
// (a) tile color not deterministic per agent,
// (b) initials wrong for emoji/unicode display names,
// (c) missing avatar for agents without display names,
// (d) contrast failures on the dark default.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DARK,
  AVATAR_TILE_BASE,
  AVATAR_TILE_ACCENTS,
  AVATAR_TILE_SHAPES,
  avatarTilePick,
  contrastRatio,
  CONTRAST_PAIRS,
} from "../src/design-tokens.js";
import { avatarInitials } from "../src/member-display-names.js";
import { memberAvatarSvg } from "../src/room-roster.js";

// (b) initials: astral-plane letters must survive (no lone surrogates),
// emoji leads are skipped, missing names fall back to "?".
test("avatarInitials handles emoji, unicode and missing names", () => {
  assert.equal(avatarInitials("Maya (tester)"), "MT");
  assert.equal(avatarInitials("gROK bOT"), "GB");
  assert.equal(avatarInitials("Élodie Dupont"), "ÉD");
  assert.equal(avatarInitials("𝕋esla Bot"), "𝕋B"); // astral T, not a lone surrogate
  assert.equal(avatarInitials("🤖 Helper"), "H"); // emoji word contributes nothing
  assert.equal(avatarInitials("@some-agent"), "S");
  assert.equal(avatarInitials("  "), "?");
  assert.equal(avatarInitials(null), "?");
  assert.equal(avatarInitials(undefined), "?");
  for (const value of ["𝕋esla Bot", "🤖 Helper", "Élodie"]) {
    // Lone (unpaired) surrogates render as replacement chars; a well-formed astral pair is fine.
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(avatarInitials(value)), `lone surrogate in ${value}`);
  }
});

// (a) tile pick is deterministic per agent and drawn from token colors.
test("avatarTilePick is deterministic and token-sourced", () => {
  const first = avatarTilePick("ai_abc123");
  const second = avatarTilePick("ai_abc123");
  assert.deepEqual(second, first);
  assert.ok(Object.values(DARK).includes(first.accent), "accent must be a design token color");
  assert.ok(AVATAR_TILE_ACCENTS.includes(first.accent));
  assert.ok(AVATAR_TILE_SHAPES.includes(first.shape));
  const ids = ["ai_1", "ai_2", "ai_3", "ai_4", "ai_5", "ai_6", "ai_7", "ai_8"];
  const tiles = new Set(ids.map(id => JSON.stringify(avatarTilePick(id))));
  assert.ok(tiles.size > 1, "distinct agents must not all share one tile");
});

// (c) agents without display names still get a tile, never "undefined".
test("memberAvatarSvg renders for nameless agents", () => {
  const svg = memberAvatarSvg({ id: "ai_nameless" });
  assert.ok(svg.startsWith("<svg"), "must be an inline SVG tile");
  assert.ok(svg.includes("?"), "missing name falls back to ?");
  assert.ok(!svg.includes("undefined"), "must never leak undefined");
  assert.equal(memberAvatarSvg({ id: "ai_nameless" }), svg, "deterministic");
});

// SVG tiles carry the initials and stay deterministic per agent.
test("memberAvatarSvg embeds initials and varies per agent", () => {
  const a = memberAvatarSvg({ id: "ai_alpha", displayName: "Alpha Agent" });
  const b = memberAvatarSvg({ id: "ai_beta", displayName: "Beta Agent" });
  assert.ok(a.includes(">AA<"), "initials rendered as SVG text");
  assert.notEqual(a, b, "different agents get different tiles");
  assert.equal(memberAvatarSvg({ id: "ai_alpha", displayName: "Alpha Agent" }), a);
});

// Names with markup must not inject tags into the SVG: initials keep only
// letters/digits, and the text node is XML-escaped regardless.
test("memberAvatarSvg neutralizes markup in display names", () => {
  const svg = memberAvatarSvg({ id: "ai_x", displayName: "<b>&\"'bold" });
  assert.ok(!svg.includes("<b>"), "raw markup must not appear");
  assert.ok(svg.includes(">B<"), "initials still render");
});

// (d) initials on the tile base keep WCAG AA on the dark default, and the
// pair is gated in CONTRAST_PAIRS so CI holds it.
test("avatar tile base keeps initials contrast on dark", () => {
  assert.ok(contrastRatio(DARK["--text"], AVATAR_TILE_BASE) >= 4.5);
  assert.ok(
    CONTRAST_PAIRS.some(([name]) => /avatar/i.test(name)),
    "avatar contrast pair must be in CONTRAST_PAIRS"
  );
});
