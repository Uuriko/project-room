// Audit wave 2 lane 2 (client UI/UX): the guest-upgrade hint and the
// agent first-run step links must stay readable in BOTH themes.
// Regression: .guest-upgrade-hint referenced an undefined --surface-raised,
// so the fallback #f5f5f5 rendered a light box in dark theme with near-white
// text (1.07:1); .link-button and .agent-first-run-steps button referenced an
// undefined --link, falling back to #0066cc (3.12:1 on the dark panel).
// Contract: every var() these rules use must resolve to a defined design
// token, and the resulting text/background pairs must meet WCAG AA 4.5:1 in
// both themes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

function definedTokens() {
  const names = new Set();
  for (const m of css.matchAll(/--[\w-]+(?=\s*:)/g)) names.add(m[0]);
  return names;
}

function ruleBody(selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
  );
  const m = css.match(re);
  assert.ok(m, `rule ${selector} exists in src/styles.css`);
  return m[1];
}

// Resolve var(--name, fallback): the token must be defined; otherwise the
// fallback wins and the rule silently depends on a hardcoded color.
function resolveVar(value, tokens, prop) {
  const m = value.match(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\)/);
  assert.ok(m, `${prop} should use a design token`);
  assert.ok(
    tokens.has(m[1]),
    `${prop} references undefined token ${m[1]} (fallback ${m[2] ?? "none"} would win)`,
  );
  return m[1];
}

function lum(hex) {
  const c = hex.replace("#", "");
  const ch = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function ratio(a, b) {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function themeValue(token, theme) {
  const block = theme === "dark" ? css.match(/:root\s*\{([^}]*)\}/)[1]
    : css.match(/\[data-theme="light"\]\s*\{([^}]*)\}/)[1];
  const m = block.match(new RegExp(token.replace(/-/g, "\\-") + "\\s*:\\s*(#[0-9a-fA-F]{6})"));
  assert.ok(m, `token ${token} defined for ${theme} theme`);
  return m[1];
}

const tokens = definedTokens();

test("guest-upgrade hint background resolves to a defined theme token", () => {
  const body = ruleBody(".guest-upgrade-hint");
  const bg = body.match(/background\s*:\s*([^;]+);/);
  assert.ok(bg, ".guest-upgrade-hint sets a background");
  const token = resolveVar(bg[1], tokens, ".guest-upgrade-hint background");
  for (const theme of ["dark", "light"]) {
    const bgHex = themeValue(token, theme);
    const textHex = themeValue("--text", theme);
    const r = ratio(textHex, bgHex);
    assert.ok(r >= 4.5, `hint text vs background in ${theme} theme: ${r.toFixed(2)}:1 (needs 4.5:1)`);
  }
});

test("guest-upgrade hint link meets 4.5:1 against the hint box in both themes", () => {
  const hintBgToken = resolveVar(
    ruleBody(".guest-upgrade-hint").match(/background\s*:\s*([^;]+);/)[1],
    tokens,
    ".guest-upgrade-hint background",
  );
  const linkToken = resolveVar(
    ruleBody(".link-button").match(/color\s*:\s*([^;]+);/)[1],
    tokens,
    ".link-button color",
  );
  for (const theme of ["dark", "light"]) {
    const r = ratio(themeValue(linkToken, theme), themeValue(hintBgToken, theme));
    assert.ok(r >= 4.5, `hint link vs box in ${theme} theme: ${r.toFixed(2)}:1 (needs 4.5:1)`);
  }
});

test("agent first-run step links meet 4.5:1 against the panel in both themes", () => {
  const linkToken = resolveVar(
    ruleBody(".agent-first-run-steps button").match(/color\s*:\s*([^;]+);/)[1],
    tokens,
    ".agent-first-run-steps button color",
  );
  for (const theme of ["dark", "light"]) {
    const r = ratio(themeValue(linkToken, theme), themeValue("--panel", theme));
    assert.ok(r >= 4.5, `first-run step link vs panel in ${theme} theme: ${r.toFixed(2)}:1 (needs 4.5:1)`);
  }
});
