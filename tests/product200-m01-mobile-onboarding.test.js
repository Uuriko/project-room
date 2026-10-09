// PRODUCT-200 M-01 (mobile onboarding): regression guards for the human
// onboarding journey on 390/375px viewports — landing (index.html auth),
// orientation (about.html), first action (join.html invite flow, Rooms panel).
//
// Frictions found in the 2026-10-08 walkthrough:
//  F1. #account-request-access summary ("Request access to a room" — the
//      self-serve door on the signed-in Rooms panel) had no min-height rule,
//      rendering ~24px tall on phones: below the 44px coarse-pointer floor
//      the repo established in #2034. Sibling .account-room-create summary
//      already had the 44px rule; this one was missed.
//  F2. .join-secret-row input (join.html access-key row) used flex:1 with no
//      min-width:0, so the input could not shrink below its intrinsic
//      ~20ch width and pushed the row past the card at <=320px widths /
//      enlarged text. The codebase's own .key-field already used the
//      minmax(0,1fr) pattern for the same overflow class.
// Guards (must stay green):
//  G1. No zoom-trap viewport meta (maximum-scale / user-scalable=no) on any
//      onboarding page.
//  G2. No sub-16px font-size on input/select/textarea rules in the public
//      a11y stylesheet (iOS Safari auto-zooms on focus below 16px).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const a11yCss = readFileSync(join(ROOT, "src", "public-a11y.css"), "utf8");

function ruleBodies(css, selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    "g",
  );
  const out = [];
  for (const m of css.matchAll(re)) out.push(m[1]);
  return out;
}

function minHeightPx(body) {
  const m = body.match(/min-height\s*:\s*([\d.]+)(px|rem)/);
  if (!m) return null;
  return m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}

test("F1: request-access disclosure meets the 44px coarse-pointer floor", () => {
  const bodies = ruleBodies(a11yCss, "#account-request-access summary");
  assert.ok(
    bodies.length > 0,
    "#account-request-access summary needs an explicit rule in src/public-a11y.css",
  );
  const heights = bodies.map(minHeightPx).filter((h) => h !== null);
  assert.ok(
    heights.some((h) => h >= 44),
    `#account-request-access summary min-height must be >= 44px (got ${heights.join(",") || "none"})`,
  );
});

test("F2: join secret input can shrink inside its flex row", () => {
  const bodies = ruleBodies(a11yCss, ".join-secret-row input");
  assert.ok(
    bodies.length > 0,
    ".join-secret-row input rule must exist in src/public-a11y.css",
  );
  assert.ok(
    bodies.some((b) => /min-width\s*:\s*0/.test(b)),
    ".join-secret-row input needs min-width: 0 so the access-key row cannot overflow the card on narrow viewports",
  );
});

test("G1: no zoom-trap viewport meta on onboarding pages", () => {
  for (const page of ["index.html", "join.html", "about.html"]) {
    const html = readFileSync(join(ROOT, page), "utf8");
    const metas = [...html.matchAll(/<meta[^>]*name="viewport"[^>]*>/gi)];
    assert.ok(metas.length > 0, `${page} must keep its viewport meta`);
    for (const m of metas) {
      assert.ok(
        !/maximum-scale|user-scalable\s*=\s*no/i.test(m[0]),
        `${page} viewport must not trap zoom: ${m[0]}`,
      );
    }
  }
});

test("G2: no sub-16px text-entry font-size in the public a11y stylesheet", () => {
  // iOS Safari auto-zooms on focus when an input/select/textarea is < 16px.
  for (const m of a11yCss.matchAll(
    /(input|select|textarea)[^{]*\{([^}]*)\}/g,
  )) {
    const fm = m[2].match(/font-size\s*:\s*([\d.]+)(px|rem)/);
    if (!fm) continue;
    const px = fm[2] === "rem" ? parseFloat(fm[1]) * 16 : parseFloat(fm[1]);
    assert.ok(
      px >= 16,
      `text-entry rule "${m[1]}" sets font-size ${fm[0]} (< 16px zoom trap): ${m[0].slice(0, 80)}`,
    );
  }
});
