// WAVE-500 G8-19: focus-visible audit — keyboard focus must stay visible.
//
// Every `outline: none` / `outline: 0` kill in the shipped stylesheets must have
// a genuine replacement: a `:focus`/`:focus-visible` (or a parent
// `:has(...:focus-visible)` / `:focus-within`) rule that restores a visible
// indicator and actually wins the cascade. A 1px border-color-only change does
// NOT count: keyboard users need a ≥2px ring (outline or box-shadow) to locate
// focus.
//
// Fail-first: the composer textarea (`#message-input`, `.composer-row
// textarea`) has `outline: 0` on :focus and only gets a 1px border-color shift
// on its row — invisible-ish for keyboard users. The audit tests fail until the
// `:focus-visible` ring rule lands.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Stylesheets shipped to the browser, in <link> load order (index.html).
const sheets = ["src/styles.css", "src/login-polish.css", "src/board.css", "src/public-a11y.css", "src/human-experience.css"];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function rulesOf(css) {
  const out = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const decls = m[2].split(";").map((d) => d.trim()).filter(Boolean);
    if (selectors.length && !selectors.some((s) => s.startsWith("@"))) out.push({ selectors, decls });
  }
  return out;
}

// All rules in cascade order (sheet load order, then source order).
const all = [];
for (const s of sheets) {
  for (const r of rulesOf(readFileSync(join(root, s), "utf8"))) all.push({ ...r, sheet: s, order: all.length });
}

function declValue(decls, prop) {
  const d = decls.find((x) => x.toLowerCase().startsWith(prop + ":"));
  return d ? d.slice(prop.length + 1).trim() : null;
}

const KILL = /^\s*(none|0)(\s*!important)?\s*$/i;

function isVisibleIndicator(decls) {
  const outline = declValue(decls, "outline");
  if (outline && !KILL.test(outline) && /\d/.test(outline)) return true;
  const shadow = declValue(decls, "box-shadow");
  if (shadow && !/^\s*none/i.test(shadow) && /px/.test(shadow)) return true;
  return false;
}

// Rough CSS specificity [ids, classes+pseudos+attrs, elements] for flat selectors.
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+/g) || []).length;
  const attrs = (sel.match(/\[[^\]]+\]/g) || []).length;
  const pseudos = (sel.match(/::?[\w-]+(\([^)]*\))?/g) || []).length;
  const elements = (sel.replace(/[#.:][\w-]+(\([^)]*\))?|\[[^\]]+\]|::?[\w-]+/g, "").match(/[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes + attrs + pseudos, elements];
}

function cmpSpec(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Normalise a selector to its "base target": strip focus/hover/active
// pseudo-classes so `textarea:focus` and `textarea:focus-visible` both map to
// `textarea`.
function baseTarget(sel) {
  return sel.replace(/:(focus-visible|focus|hover|active|focus-within)/g, "").replace(/\s+/g, " ").trim();
}

function isFocusRule(sel) {
  return /:(focus-visible|focus|focus-within)/.test(sel);
}

// Does rule r (selector s) replace the outline kill on killSel?
// Same element: s's base matches killSel's target (textual containment, i.e.
// the kill selector is at least as specific textually) AND s wins the cascade
// for `outline` (higher specificity, or equal specificity with later order).
// Parent ring: s is `.ancestor:has(... target:focus-visible)` — different
// element, so no cascade conflict with the kill.
function replaces(r, s, killSel, killOrder) {
  if (!isFocusRule(s) || !isVisibleIndicator(r.decls)) return false;
  const sBase = baseTarget(s);
  const killBase = baseTarget(killSel);
  if (sBase === killBase || killBase.includes(sBase)) {
    const c = cmpSpec(specificity(s), specificity(killSel));
    return c > 0 || (c === 0 && r.order > killOrder);
  }
  const has = s.match(/^(.*?):has\((.*)\)$/);
  if (has) {
    const outer = has[1].trim();
    const inner = has[2];
    const killLast = killBase.split(/[\s>+~]+/).filter(Boolean).pop();
    const ancestorOk = killBase === outer || killBase.startsWith(outer + " ") || killBase.startsWith(outer + ">");
    return ancestorOk && inner.includes(killLast) && isFocusRule(inner);
  }
  return false;
}

test("composer textarea keeps a visible keyboard-focus indicator", () => {
  // #message-input is the primary message composer. Its :focus rule kills the
  // outline (borderless design), so there must be a :focus-visible replacement
  // that draws a visible ring — on the textarea itself or on .composer-row.
  const hit = all.find((r) =>
    r.selectors.some(
      (s) =>
        isFocusRule(s) &&
        /composer-row/.test(s) &&
        (/textarea/.test(s) || /:has\(/.test(s)) &&
        isVisibleIndicator(r.decls),
    ),
  );
  assert.ok(
    hit,
    "no visible :focus-visible indicator found for the composer textarea " +
      "(#message-input / .composer-row textarea has outline:0 on :focus)",
  );
});

test("every outline kill has a visible, cascade-winning focus replacement", () => {
  const killers = all.filter((r) => {
    const v = declValue(r.decls, "outline");
    return v && KILL.test(v);
  });
  assert.ok(killers.length > 0, "expected at least one outline kill to audit");
  const gaps = [];
  for (const kill of killers) {
    for (const sel of kill.selectors) {
      const ok = all.some((r) => r !== kill && r.selectors.some((s) => replaces(r, s, sel, kill.order)));
      if (!ok) gaps.push(`${kill.sheet}: ${sel}`);
    }
  }
  assert.deepEqual(gaps, [], `outline kills without a visible focus replacement:\n${gaps.join("\n")}`);
});
