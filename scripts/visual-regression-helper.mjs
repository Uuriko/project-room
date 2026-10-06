// Q003: shared screenshot-diff helper for the visual regression browser checks.
//
// The gate: committed baseline PNGs under scripts/visual-regression-baselines/
// are compared pixel-for-pixel against a fresh capture on every CI run. A
// diff above MAX_DIFF_PIXEL_RATIO fails the check and writes the actual
// capture plus a diff image to test-results/visual-regression/ (picked up by
// the existing browser-shards artifact upload).
//
// Determinism contract (every check using this helper gets the same):
//   - one fixed viewport (VISUAL_VIEWPORT), deviceScaleFactor 1
//   - prefers-reduced-motion so CSS animations/transitions do not run
//   - animations disabled at capture time; text caret hidden
//   - document.fonts settled before capture (no font-swap flicker)
//   - seeded store data; dynamic regions (timestamps, avatars, live
//     presence) painted over via the `mask` locators before capture —
//     baselines carry the same masks, so the gate never sees them
//
// Regenerating baselines after an intentional UI change:
//   VISUAL_UPDATE_BASELINES=1 node --test scripts/visual-regression-browser-check.mjs
// The update run writes fresh baselines and passes; the next normal run
// diffs against them. Review the baseline diff in the PR like any snapshot.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// One fixed viewport for every visual baseline.
export const VISUAL_VIEWPORT = { width: 1280, height: 800 };

// Fail when more than 1% of pixels differ. The per-pixel color threshold
// (0.2) absorbs subpixel antialiasing noise between identical renders;
// the 1% budget absorbs platform font-hinting drift without hiding a real
// layout break (a moved panel or missing element is far more than 1%).
export const MAX_DIFF_PIXEL_RATIO = 0.01;
export const PIXEL_THRESHOLD = 0.2;

const here = dirname(fileURLToPath(import.meta.url));
export const BASELINE_DIR = join(here, "visual-regression-baselines");
// Under test-results/ so the browser-shards upload-artifact step keeps the
// failure evidence (actual capture + diff image) with the other CI evidence.
export const EVIDENCE_DIR = "test-results/visual-regression";

// Chromium launch options shared by the visual checks. Honors the same
// ROOM_TEST_CHROMIUM_PATH override the other browser checks use.
export function chromiumLaunchOptions() {
  return {
    headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}),
  };
}

// Deterministic browser context for screenshot capture: fixed viewport,
// no device pixel-ratio scaling, reduced motion.
export async function visualContext(browser) {
  return browser.newContext({
    viewport: VISUAL_VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
}

// Settle the page before capture: fonts loaded (no swap flicker), one frame
// after any pending layout. String form: it runs inside the page, so this
// Node-side helper (no browser globals under the lint config) stays clean.
export async function settleForScreenshot(page) {
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  await page.waitForTimeout(100);
}

// Pixel-diff two PNG buffers. Throws on dimension mismatch (a viewport or
// full-page height change is itself a visual regression worth failing on).
export function diffPngBuffers(actual, expected, { threshold = PIXEL_THRESHOLD } = {}) {
  const a = PNG.sync.read(actual);
  const e = PNG.sync.read(expected);
  assert.equal(a.width, e.width, `baseline width mismatch: captured ${a.width}px vs baseline ${e.width}px`);
  assert.equal(a.height, e.height, `baseline height mismatch: captured ${a.height}px vs baseline ${e.height}px`);
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, e.data, diff.data, a.width, a.height, { threshold });
  return { diffPixels, ratio: diffPixels / (a.width * a.height), diffPng: PNG.sync.write(diff) };
}

// Compare one captured PNG buffer against the committed baseline for `name`.
// Pure (no browser): the failing-first detector test calls this directly
// with a deliberately altered buffer. Returns the diff stats on a pass.
// On VISUAL_UPDATE_BASELINES=1 the buffer becomes the new baseline.
export function compareScreenshotBuffer(shot, name, { maxDiffPixelRatio = MAX_DIFF_PIXEL_RATIO } = {}) {
  const baselinePath = join(BASELINE_DIR, `${name}.png`);
  if (process.env.VISUAL_UPDATE_BASELINES === "1") {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(baselinePath, shot);
    return { updated: true, diffPixels: 0, ratio: 0 };
  }
  if (!existsSync(baselinePath)) {
    throw new Error(
      `${name}: no visual baseline at ${baselinePath}. ` +
      "Run once with VISUAL_UPDATE_BASELINES=1 to capture it, review the PNG, then commit it.",
    );
  }
  const { diffPixels, ratio, diffPng } = diffPngBuffers(shot, readFileSync(baselinePath));
  if (ratio > maxDiffPixelRatio) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, `${name}.actual.png`), shot);
    writeFileSync(join(EVIDENCE_DIR, `${name}.diff.png`), diffPng);
    assert.fail(
      `${name}: visual regression — ${diffPixels} pixels differ ` +
      `(${(ratio * 100).toFixed(2)}% of the frame, budget ${(maxDiffPixelRatio * 100).toFixed(2)}%). ` +
      `Actual capture and diff image written to ${EVIDENCE_DIR}/. ` +
      "If the UI change is intentional, re-capture with VISUAL_UPDATE_BASELINES=1 and review the new baseline in the PR.",
    );
  }
  return { diffPixels, ratio };
}

// Capture (full page or one element) and compare against the baseline.
// `mask` is an array of locators painted over before capture — pass the
// dynamic regions (timestamps, avatars, live presence) here. Page-level
// captures default to the full scrollable page so below-the-fold
// regressions are caught too.
export async function assertScreenshotMatches(page, name, { mask = [], element = null, fullPage = true, maxDiffPixelRatio = MAX_DIFF_PIXEL_RATIO } = {}) {
  const target = element ?? page;
  const shot = await target.screenshot({ mask, animations: "disabled", caret: "hide", type: "png", ...(element ? {} : { fullPage }) });
  return compareScreenshotBuffer(shot, name, { maxDiffPixelRatio });
}
