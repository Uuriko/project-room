// M-11 (PRODUCT-200 client-craft, landscape + tablet): the offers "find work"
// form and result cards use a desktop grid (4-col form, 3-col cards) at every
// width above 760px. On a 768px iPad portrait or an 844px landscape phone that
// squeezes each form column to ~160px — selects and the search input truncate.
// A tablet step (<=1024px) must relax the grid to two columns so the layout
// uses the space, while the phone rule (<=760px, single column) keeps winning
// below 760px.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src", "project-offers.css"), "utf8");

// Extract @media(max-width:Npx) blocks with their source offsets and bodies.
function mediaBlocks() {
  const out = [];
  const re = /@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push({ width: Number(m[1]), start: m.index, body: css.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

function declarationsFor(body, selector) {
  // Collect declaration text for every rule whose selector list contains the
  // exact selector (handles grouped selectors like ".a, .b { ... }").
  const decls = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1].split(",").map((s) => s.trim()).includes(selector)) decls.push(m[2]);
  }
  return decls.join(" ");
}

function gridColumns(body, selector) {
  const decls = declarationsFor(body, selector);
  const m = decls.match(/grid-template-columns\s*:\s*([^;]+);?/);
  return m ? m[1].trim() : null;
}

test("tablet widths (761-1024px) get a two-column find-work grid", () => {
  const blocks = mediaBlocks().filter((b) => b.width > 760 && b.width <= 1024);
  assert.ok(blocks.length > 0, "expected a @media(max-width:<=1024px) tablet block");
  const ok = blocks.some((b) => {
    const form = gridColumns(b.body, ".find-work form");
    const list = gridColumns(b.body, ".find-work ul");
    return form === "1fr 1fr" && list === "repeat(2,minmax(0,1fr))";
  });
  assert.ok(
    ok,
    "tablet block must set .find-work form to 1fr 1fr and .find-work ul to repeat(2,minmax(0,1fr))",
  );
});

test("the phone single-column find-work rule still wins below 760px", () => {
  const blocks = mediaBlocks();
  const tablet = blocks.filter((b) => b.width > 760 && b.width <= 1024);
  const phone = blocks.filter((b) => b.width <= 760);
  assert.ok(tablet.length > 0 && phone.length > 0, "expected both tablet and phone media blocks");
  const phoneSingle = phone.some((b) => {
    const form = gridColumns(b.body, ".find-work form");
    const list = gridColumns(b.body, ".find-work ul");
    return form === "minmax(0,1fr)" && list === "minmax(0,1fr)";
  });
  assert.ok(phoneSingle, "a <=760px block must keep .find-work stacked single-column");
  const latestTablet = Math.max(...tablet.map((b) => b.start));
  const latestPhone = Math.max(...phone.filter((b) => {
    const form = gridColumns(b.body, ".find-work form");
    return form === "minmax(0,1fr)";
  }).map((b) => b.start));
  assert.ok(
    latestPhone > latestTablet,
    "the phone single-column rule must come after the tablet rule so it wins below 760px",
  );
});
