// WAVE-500 G3 worker g3c7 (board & human-side UI bug hunt), 2026-10-11.
// Ask-card style audit (src/human-experience.css): dark-default regressions,
// status-color contrast, 390px layout, keyboard focus. The hunt measured every
// property below against the actual CSS in both themes and found no live
// defect — this test pins those properties so a future change that
// reintroduces any of them fails loudly instead of shipping a broken ask card
// to humans.
//
// Slice boundary: door-page contrast belongs to human-door-contrast.test.js;
// ask-card DOM behavior belongs to the human-experience browser checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesCss = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
const askCss = readFileSync(join(ROOT, "src", "human-experience.css"), "utf8");

// Contrast math mirrors tests/human-door-contrast.test.js.
function lum(hex) {
  const c = hex.replace("#", "");
  const ch = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// Extract the token block for a theme. Light inherits every token its block
// does not override, so merge :root underneath it (real CSS cascade).
function tokenBlock(css, theme) {
  const dark = css.match(/:root\s*\{([^}]*)\}/);
  assert.ok(dark, ":root block exists");
  if (theme === "dark") return dark[1];
  const light = css.match(/\[data-theme="light"\]\s*\{([^}]*)\}/);
  assert.ok(light, '[data-theme="light"] block exists');
  return light[1] + dark[1];
}
function tokenValue(block, name) {
  const m = block.match(new RegExp(name.replace(/-/g, "\\-") + "\\s*:\\s*(#[0-9a-fA-F]{6}|var\\(--[\\w-]+\\))"));
  assert.ok(m, `token ${name} defined in theme block`);
  return m[1];
}
function hexOf(block, name) {
  let v = tokenValue(block, name), guard = 0;
  while (v.startsWith("var(") && guard++ < 8) {
    v = tokenValue(block, v.match(/var\(\s*(--[\w-]+)/)[1]);
  }
  assert.ok(v.startsWith("#"), `${name} resolves to a hex color`);
  return v;
}
function ruleBody(css, selector) {
  const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  assert.ok(m, `rule ${selector} exists`);
  return m[1];
}
// Strip one level of @media blocks (the file nests no deeper).
function stripMedia(css) {
  return css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
}
function mediaBlocks(css, query) {
  const blocks = [];
  const re = new RegExp(`@media\\s*\\(${query}\\)\\s*\\{(?:[^{}]*\\{[^{}]*\\})*[^{}]*\\}`, "g");
  let m;
  while ((m = re.exec(css))) blocks.push(m[0]);
  return blocks;
}

test("ask-card status text meets WCAG AA in both themes", () => {
  // #room-assistant sets no background, so the face inherits the page --bg.
  const face = ruleBody(askCss, ".assistant-face-status");
  assert.match(face, /color\s*:\s*var\(--muted\)/, "default status uses the muted token");
  const amber = askCss.match(/\.assistant-face-status\[data-face-status="not_picked_up"\][^{]*\{([^}]*)\}/);
  assert.ok(amber, "amber override rule for not_picked_up/stalled exists");
  assert.match(amber[1], /color\s*:\s*var\(--amber\)/, "alert statuses use the amber token");
  for (const theme of ["dark", "light"]) {
    const block = tokenBlock(stylesCss, theme);
    const bg = hexOf(block, "--bg");
    for (const token of ["--muted", "--amber"]) {
      const r = ratio(hexOf(block, token), bg);
      assert.ok(r >= 4.5, `${theme}: ${token} on --bg is ${r.toFixed(2)}:1, below WCAG AA 4.5:1`);
    }
  }
});

test("ask-card styles carry no hard-coded colors (dark-default safe)", () => {
  // Dark is the product default; every ask-card color must come from a theme
  // token so the file cannot regress one theme while fixing the other.
  // ID selectors (#ask-room etc.) are not hex colors — match real literals.
  const literals = askCss.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{3}(?![0-9a-fA-F\w])|\brgba?\s*\(|\bhsla?\s*\(/g);
  assert.deepEqual(literals ?? [], [], `hard-coded color literals: ${literals}`);
});

test("ask-card buttons keep a visible keyboard focus indicator", () => {
  const m = stylesCss.match(/button:focus-visible[^{]*\{([^}]*)\}/);
  assert.ok(m, "global button:focus-visible rule exists");
  assert.ok(!/outline\s*:\s*none/.test(m[1]), "keyboard focus outline is not suppressed");
  assert.match(m[1], /outline\s*:\s*2px/, "keyboard focus outline is visible");
  const pressed = ruleBody(askCss, '#ask-room[aria-pressed="true"]');
  assert.match(pressed, /outline\s*:/, "ask toggle keeps its pressed-state outline");
});

test("ask toggle label never wraps mid-word", () => {
  const body = ruleBody(askCss, "#ask-room");
  assert.match(body, /white-space\s*:\s*nowrap/, "#ask-room keeps white-space: nowrap");
});

test("composer grid cannot trap the ask button in a fixed-width track", () => {
  // The ask button is nowrap; if the first composer track were a fixed pixel
  // width, the Options + Ask Room row would overflow into the message field.
  // The cascade winner (last top-level declaration, same specificity) must
  // keep the first track flexible (auto / minmax), never a fixed length.
  const topLevel = stripMedia(stylesCss);
  const decls = [...topLevel.matchAll(/\.composer-row\s*\{[^}]*?grid-template-columns\s*:\s*([^;}]+)/g)];
  assert.ok(decls.length > 0, ".composer-row grid-template-columns is declared");
  const winner = decls[decls.length - 1][1].trim();
  assert.ok(!/^\d+(px|r?em|%)/.test(winner), `first composer track must stay flexible, got "${winner}"`);
  // At phone widths the grid becomes a wrapping flex row, so 390px cannot
  // overflow either.
  const narrow = mediaBlocks(stylesCss, "max-width:\\s*520px");
  assert.ok(
    narrow.some((b) => /\.composer-row\s*\{[^}]*display\s*:\s*flex/.test(b)),
    "a <=520px media query falls .composer-row back to wrapping flex",
  );
});
