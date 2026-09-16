#!/usr/bin/env node
// What does a visitor actually see and click on first paint?
//
// This exists because I got it badly wrong. I described the first screen from a
// fetched text rendering of the page, which flattens <dialog>, collapsed
// <details> and hidden elements into ordinary prose, and concluded the page threw
// twelve controls at a newcomer. It does not: it hides over a hundred elements by
// default. Acting on that reading would have meant restructuring a screen that was
// already structured correctly.
//
// So: read the markup, not a rendering. This walks index.html, tracks the ancestor
// chain, and separates controls a visitor can actually reach at first paint from
// ones that are suppressed, saying which mechanism suppressed each.
//
// It is a static reader. It does not run the app, so anything JavaScript reveals or
// hides after load is outside what it can see, and the report says so.
//
//   node scripts/first-screen.mjs                 # this repo's index.html
//   node scripts/first-screen.mjs path/to/index.html
//   node scripts/first-screen.mjs --json

import { readFileSync } from "node:fs";

const CONTROLS = new Set(["button", "a", "input", "select", "textarea", "summary"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const attr = (raw, name) => {
  const match = raw.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[2] ?? match[3] ?? match[4] ?? "") : (new RegExp(`\\b${name}\\b`, "i").test(raw) ? "" : null);
};

/**
 * Suppression reasons, most specific first. A control inside a closed <details>
 * is unreachable, but the <summary> that opens it is the control you can click,
 * so summaries are never suppressed by their own details.
 */
function suppressedBy(ancestors, element) {
  if (element.hidden) return "hidden attribute";
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const frame = ancestors[i];
    if (frame.hidden) return `inside hidden <${frame.tag}>`;
    if (frame.tag === "dialog") return "inside <dialog>";
    if (frame.tag === "details" && !frame.open) {
      // The summary of a closed details is the control that opens it, so it is
      // reachable. That only applies when the details is its direct parent; a
      // summary nested deeper inside a closed details is not.
      const directParent = i === ancestors.length - 1;
      if (element.tag === "summary" && directParent) continue;
      return "inside collapsed <details>";
    }
  }
  return null;
}

export function firstScreen(html) {
  const stack = [];
  const visible = [];
  const suppressed = [];
  let hiddenCount = 0;

  TAG.lastIndex = 0;
  let match;
  while ((match = TAG.exec(html))) {
    const [full, closing, rawTag, rawAttrs, selfClose] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const hidden = attr(rawAttrs, "hidden") !== null;
    if (hidden) hiddenCount += 1;

    if (CONTROLS.has(tag)) {
      const reason = suppressedBy(stack, { tag, hidden });
      // Text up to the matching close, good enough for a label on this markup.
      const after = html.slice(match.index + full.length);
      const label = after.slice(0, after.indexOf(`</${tag}`) >= 0 ? after.indexOf(`</${tag}`) : 0)
        .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      const entry = {
        tag,
        id: attr(rawAttrs, "id") ?? null,
        label: label || attr(rawAttrs, "aria-label") || attr(rawAttrs, "placeholder") || "",
        reason
      };
      (reason ? suppressed : visible).push(entry);
    }

    if (!selfClose && !VOID.has(tag)) {
      stack.push({ tag, hidden, open: attr(rawAttrs, "open") !== null });
    }
  }

  return { hiddenCount, visible, suppressed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) ?? new URL("../index.html", import.meta.url).pathname;
  const report = firstScreen(readFileSync(file, "utf8"));
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`First paint, from markup: ${file}\n`);
    console.log(`Reachable controls: ${report.visible.length}`);
    for (const control of report.visible) console.log(`  <${control.tag}> ${control.id ? `#${control.id} ` : ""}${control.label}`);
    console.log(`\nSuppressed: ${report.suppressed.length} (hidden attributes in the file: ${report.hiddenCount})`);
    const byReason = {};
    for (const control of report.suppressed) (byReason[control.reason] ??= []).push(control);
    for (const [reason, controls] of Object.entries(byReason)) console.log(`  ${reason}: ${controls.length}`);
    console.log("\nStatic read of the markup. Anything JavaScript reveals or hides after load is not visible here.");
  }
}
