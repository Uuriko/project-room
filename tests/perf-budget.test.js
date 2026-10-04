// PERF-0: the page-weight budget tool parses its arguments strictly and, when
// Chromium is available, measures a real local page with a sane JSON shape.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { parseArgs, measure, startLocalServer, chromiumAvailable, networkProfileFor, DEFAULT_PAGES } from "../scripts/perf-budget.mjs";

test("perf-budget arguments: defaults, lists and strict errors", () => {
  const defaults = parseArgs([]);
  assert.deepEqual(defaults.pages, [...DEFAULT_PAGES]);
  assert.deepEqual(defaults.viewports, [390, 1280]);
  assert.equal(defaults.cpu, 4);
  assert.equal(defaults.network, "auto");
  assert.equal(defaults.origin, null);
  const custom = parseArgs(["--pages", "/,/about", "--viewport", "390", "--origin", "https://example.test/", "--network", "none"]);
  assert.deepEqual(custom.pages, ["/", "/about"]);
  assert.deepEqual(custom.viewports, [390]);
  assert.equal(custom.origin, "https://example.test");
  assert.equal(custom.network, "none");
  assert.throws(() => parseArgs(["--pages", "about"]), /start with \//);
  assert.throws(() => parseArgs(["--viewport", "wide"]), /widths in px/);
  assert.throws(() => parseArgs(["--origin", "file:///etc"]), /http\(s\) origin/);
  assert.throws(() => parseArgs(["--network", "3g"]), /auto, none, mobile or desktop/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  assert.throws(() => parseArgs(["--out"]), /needs a value/);
});

test("perf-budget network profiles follow the viewport", () => {
  assert.equal(networkProfileFor(390).latency, 150);
  assert.equal(networkProfileFor(1280).latency, 40);
  assert.equal(networkProfileFor(390, "none"), null);
  assert.equal(networkProfileFor(1280, "mobile").latency, 150);
});

test("perf-budget measures /about on a local server", { timeout: 120000 }, async t => {
  if (!chromiumAvailable(chromium)) {
    t.skip("Chromium is not installed (npx playwright install chromium); the browser measurement is skipped");
    return;
  }
  const local = await startLocalServer();
  t.after(() => local.close());
  const [result] = await measure({ origin: local.origin, pages: ["/about"], viewports: [390], executablePath: process.env.ROOM_TEST_CHROMIUM_PATH });
  assert.equal(result.page, "/about");
  assert.equal(result.viewport, 390);
  assert.equal(result.network, "mobile");
  assert.equal(result.status, 200);
  assert.equal(result.failedRequests, 0);
  assert.ok(result.requests >= 1 && result.requests <= 20, `requests ${result.requests}`);
  assert.ok(result.bytes > 1000 && result.bytes < 500_000, `bytes ${result.bytes}`);
  assert.ok(result.domNodes > 10 && result.domNodes < 5000, `domNodes ${result.domNodes}`);
  assert.equal(typeof result.lcpMs, "number");
  assert.ok(result.lcpMs > 0 && result.lcpMs < 30000, `lcpMs ${result.lcpMs}`);
});
