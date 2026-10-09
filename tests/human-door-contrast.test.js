// HD-10 (PRODUCT-200 client craft, human door): every text/background pair on
// the stranger-facing door pages must meet WCAG AA in BOTH themes.
// Audit 2026-10-08 measured 90+ pairs (index door, join.html, about.html,
// docs/agents pages, offers.html, invitation dialog, status toasts) — all
// passed. This test pins the pairs to the actual CSS so a future token or
// rule change that drops a door surface below AA fails loudly instead of
// shipping silent low-contrast text to strangers.
// Slice boundary: board-UI a11y belongs to BU-11, mobile touch to M-07.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesCss = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
const offersCss = readFileSync(join(ROOT, "src", "project-offers.css"), "utf8");
const aboutHtml = readFileSync(join(ROOT, "about.html"), "utf8");
const docsHtml = readFileSync(join(ROOT, "docs", "agents", "index.html"), "utf8");

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

// Extract the token block for a theme from a stylesheet string. The light
// theme inherits every token the [data-theme="light"] block does not
// override, so merge :root underneath it (real CSS cascade).
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
// Resolve var(--x) chains against the theme block.
function resolve(block, value) {
  let v = value, guard = 0;
  while (v.startsWith("var(") && guard++ < 8) {
    const name = v.match(/var\(\s*(--[\w-]+)/)[1];
    v = tokenValue(block, name);
  }
  return v;
}
function hex(block, tokenOrHex) {
  const t = tokenOrHex.trim();
  if (t.startsWith("#")) return t;
  const name = t.startsWith("var(") ? t.match(/var\(\s*(--[\w-]+)/)[1] : t;
  return resolve(block, tokenValue(block, name));
}
function ruleBody(css, selector) {
  const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  assert.ok(m, `rule ${selector} exists`);
  return m[1];
}
function ruleColors(body) {
  const fg = body.match(/(?:^|;)\s*color\s*:\s*([^;]+);/);
  const bg = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+);/);
  assert.ok(fg && bg, "rule sets both color and background");
  return { fg: fg[1].trim(), bg: bg[1].trim() };
}

// [description, fg token-or-hex, bg token-or-hex, AA minimum]
const DOOR_PAIRS = [
  // index.html — static hero (no-JS stranger page) + door chrome
  ["static hero body (muted on page bg)", "--muted", "--bg", 4.5],
  ["static hero title (large)", "--text", "--bg", 3.0],
  ["static hero links", "--blue", "--bg", 4.5],
  ["static hero noscript", "--text", "--bg", 4.5],
  ["primary button label", "--on-accent", "--blue-strong", 4.5],
  ["primary button hover", "--on-accent", "--blue-strong-hover", 4.5],
  ["secondary button", "--text", "--panel-raised", 4.5],
  ["ghost button (page bg)", "--muted", "--bg", 4.5],
  ["ghost button (panel)", "--muted", "--panel", 4.5],
  ["text-button link", "--blue", "--bg", 4.5],
  ["form hint", "--muted", "--bg", 4.5],
  ["connection status", "--muted", "--bg", 4.5],
  ["eyebrow", "--blue", "--bg", 4.5],
  ["brand mark", "--on-accent", "--blue-strong", 4.5],
  ["input text", "--text", "--panel", 4.5],
  ["auth panel title (large)", "--text", "--panel", 3.0],
  ["form label", "--muted", "--panel", 4.5],
  // join.html — invite redemption cards sit on --card
  ["join card label", "--muted", "--card", 4.5],
  ["join card hint", "--muted", "--card", 4.5],
  ["join error title", "--red", "--card", 4.5],
  ["join brand heading", "--text", "--bg", 4.5],
  ["join card body", "--text", "--card", 4.5],
  // invitation dialog (dead-invite / request-access door)
  ["invitation details text (dark)", "--text", "#0d1117", 4.5],
  ["invitation details link (dark)", "--blue", "#0d1117", 4.5],
  ["invitation request feedback ok (dark)", "--green", "#0d1117", 4.5],
  ["invitation request feedback error (dark)", "--red", "#0d1117", 4.5],
  // status toasts (hardcoded dark chrome in both themes)
  ["status toast", "#a7e7cd", "#10271f", 4.5],
  ["status error toast", "#ffb0b0", "#2a1616", 4.5],
];

const OFFERS_PAIRS = [
  ["offers intro copy", "--muted", "--paper", 4.5],
  ["offers eyebrow", "--muted", "--paper", 4.5],
  ["offers body link", "--accent", "--paper", 4.5],
  ["offers h1 (large)", "--ink", "--paper", 3.0],
  ["offers primary button", "--on-accent", "--blue-strong", 4.5],
  ["offers secondary button", "--ink", "--paper", 4.5],
  ["offers card title", "--ink", "--white", 4.5],
  ["offers card summary", "--muted", "--white", 4.5],
  ["offers error text", "--red", "--paper", 4.5],
  ["offers detail status", "--muted", "--paper", 4.5],
];

for (const theme of ["dark", "light"]) {
  test(`human door pairs meet WCAG AA (${theme} theme, src/styles.css)`, () => {
    const block = tokenBlock(stylesCss, theme);
    for (const [desc, fg, bg, min] of DOOR_PAIRS) {
      if (theme === "light" && bg === "#0d1117") continue; // dark-only hardcoded dialog bg
      const r = ratio(hex(block, fg), hex(block, bg));
      assert.ok(r >= min, `${desc}: ${r.toFixed(2)}:1 < ${min}:1 (${theme})`);
    }
  });

  test(`offers page pairs meet WCAG AA (${theme} theme, src/project-offers.css)`, () => {
    const block = tokenBlock(offersCss, theme);
    for (const [desc, fg, bg, min] of OFFERS_PAIRS) {
      const r = ratio(hex(block, fg), hex(block, bg));
      assert.ok(r >= min, `${desc}: ${r.toFixed(2)}:1 < ${min}:1 (${theme})`);
    }
  });
}

test("invitation dialog hardcoded pairs resolve from the actual rules (dark)", () => {
  const block = tokenBlock(stylesCss, "dark");
  const boundary = ruleColors(ruleBody(stylesCss, ".invitation-boundary"));
  let r = ratio(hex(block, boundary.fg), hex(block, boundary.bg));
  assert.ok(r >= 4.5, `.invitation-boundary: ${r.toFixed(2)}:1 < 4.5:1`);
  const details = ruleBody(stylesCss, ".invitation-details").match(/background\s*:\s*([^;]+);/)[1].trim();
  r = ratio(hex(block, "--text"), hex(block, details));
  assert.ok(r >= 4.5, `.invitation-details text: ${r.toFixed(2)}:1 < 4.5:1`);
  for (const sel of [".status", ".status.error"]) {
    const c = ruleColors(ruleBody(stylesCss, sel));
    r = ratio(hex(block, c.fg), hex(block, c.bg));
    assert.ok(r >= 4.5, `${sel}: ${r.toFixed(2)}:1 < 4.5:1`);
  }
});

test("invitation dialog light-theme overrides keep AA", () => {
  const block = tokenBlock(stylesCss, "light");
  // The light overrides are a grouped selector; find the rule that names
  // .invitation-details and read its real background (no hardcoded assumption).
  const override = stylesCss.match(/\[data-theme="light"\][^{]*\.invitation-details[^{]*\{([^}]*)\}/);
  assert.ok(override, "light-theme .invitation-details override exists");
  const bgValue = override[1].match(/background\s*:\s*([^;]+);/)[1].trim();
  for (const [desc, fg] of [["details text", "--text"], ["details link", "--blue"]]) {
    const r = ratio(hex(block, fg), hex(block, bgValue));
    assert.ok(r >= 4.5, `light .invitation-details ${desc}: ${r.toFixed(2)}:1 < 4.5:1`);
  }
});

test("about.html inline tokens do not drift from src/styles.css (both themes)", () => {
  for (const theme of ["dark", "light"]) {
    const cssBlock = tokenBlock(stylesCss, theme);
    const htmlBlock = tokenBlock(aboutHtml, theme);
    for (const token of ["--bg", "--text", "--muted", "--blue", "--blue-strong", "--on-accent"]) {
      assert.equal(
        resolve(htmlBlock, tokenValue(htmlBlock, token)).toLowerCase(),
        resolve(cssBlock, tokenValue(cssBlock, token)).toLowerCase(),
        `about.html ${token} drifted from styles.css (${theme})`,
      );
    }
  }
});

test("docs/agents page pairs meet WCAG AA (dark-only page)", () => {
  const block = tokenBlock(docsHtml, "dark");
  const pairs = [
    ["docs body", "--muted", "--bg", 4.5],
    ["docs headings (large)", "--text", "--bg", 3.0],
    ["docs links", "--blue", "--bg", 4.5],
    ["docs code block", "--text", "#191a20", 4.5],
  ];
  for (const [desc, fg, bg, min] of pairs) {
    const r = ratio(hex(block, fg), hex(block, bg));
    assert.ok(r >= min, `${desc}: ${r.toFixed(2)}:1 < ${min}:1`);
  }
});
