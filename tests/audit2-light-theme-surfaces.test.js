// Audit wave 2 lane 2 (client UI/UX): several components keep hardcoded
// DARK backgrounds while their text follows the theme tokens, so in the
// opt-in light theme the text is unreadable (measured 1.01–2.63:1, needs
// 4.5:1). Contract: each listed selector must have a
// `:root[data-theme="light"]` override that remaps its background to a
// defined theme token. The dark (default) theme is untouched by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

const DARK_SURFACES = [
  ".thread-bar",
  ".search-results",
  ".invitation-details",
  ".new-messages-button",
  ".new-work-form",
  ".handoff-envelopes",
  ".handoff-envelope",
];

function lightOverrides() {
  // Collect every `:root[data-theme="light"] <selector> { ... }` override.
  const found = new Map();
  const re = /:root\[data-theme="light"\]\s*([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    for (const sel of m[1].split(",").map((s) => s.trim())) {
      const norm = sel.replace(/^:root\[data-theme="light"\]\s*/, "");
      found.set(norm, (found.get(norm) ?? "") + m[2]);
    }
  }
  return found;
}

test("hardcoded dark surfaces have light-theme background overrides", () => {
  const overrides = lightOverrides();
  for (const sel of DARK_SURFACES) {
    const body = overrides.get(sel);
    assert.ok(
      body && /background\s*:\s*var\(--[\w-]+\)/.test(body),
      `expected :root[data-theme="light"] ${sel} { background: var(--token) }`,
    );
  }
});

test("hover/active dark backgrounds have light-theme overrides", () => {
  const overrides = lightOverrides();
  for (const sel of [
    ".mention-option:hover",
    ".mention-option.active",
    ".search-results a:hover",
    ".rb-event-link:hover",
  ]) {
    const body = overrides.get(sel);
    assert.ok(
      body && /background\s*:\s*var\(--[\w-]+\)/.test(body),
      `expected :root[data-theme="light"] ${sel} { background: var(--token) }`,
    );
  }
});

test("light-theme surface overrides meet 4.5:1 for text and muted", () => {
  const lightBlock = css.match(/\[data-theme="light"\]\s*\{([^}]*)\}/)[1];
  const tokenHex = (t) => {
    const m = lightBlock.match(new RegExp(t.replace(/-/g, "\\-") + "\\s*:\\s*(#[0-9a-fA-F]{6})"));
    assert.ok(m, `token ${t} defined for light theme`);
    return m[1];
  };
  const lum = (hex) => {
    const c = hex.replace("#", "");
    const ch = (i) => {
      const v = parseInt(c.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const text = tokenHex("--text");
  const muted = tokenHex("--muted");
  for (const bg of ["--panel", "--panel-raised", "--panel-hover"]) {
    const bgHex = tokenHex(bg);
    assert.ok(ratio(text, bgHex) >= 4.5, `light --text on ${bg}: ${ratio(text, bgHex).toFixed(2)}:1`);
    assert.ok(ratio(muted, bgHex) >= 4.5, `light --muted on ${bg}: ${ratio(muted, bgHex).toFixed(2)}:1`);
  }
});
