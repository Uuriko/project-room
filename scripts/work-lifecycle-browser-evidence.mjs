// Inspect an explicitly supplied disposable fixture. No work writes or external requests.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { chromium } from "playwright";

const [manifestPath, prefix] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.match(basename(dirname(resolve(manifestPath))), /^room-work-lifecycle-/);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.credentialKind, "operator-provisioned synthetic agents; not enrollment presets");
assert.match(manifest.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const owner = JSON.parse(readFileSync(join(dirname(manifestPath), "owner-private.json"), "utf8"));
assert.equal(owner.origin, manifest.origin);
const output = resolve(prefix), suffixes = ["desktop-quiet.png", "desktop-evidence.png", "desktop-review.png",
  "mobile-quiet.png", "mobile-large-text.png", "mobile-large-text-review.png", "mobile-large-text-decision.png", "browser.json"];
assert.equal(suffixes.some(suffix => existsSync(output + "-" + suffix)), false, "Never overwrite earlier evidence");
const browser = await chromium.launch({ headless: true }), captures = [], errors = [], outside = [], writes = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== manifest.origin) { outside.push(url.origin); return route.abort(); }
      if (request.method() === "POST" && !["/api/session"].includes(url.pathname)) {
        writes.push(url.pathname); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(manifest.origin); await page.locator("#access-key").fill(owner.token);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const cards = page.locator("[data-work-record-id]");
    assert.equal(await cards.count(), 2);
    for (const participant of manifest.participants) {
      const card = page.locator('[data-work-record-id="' + participant.workItemId + '"]');
      await card.locator('[data-next-step="decide"]').waitFor();
      assert.equal(await card.locator(".work-details").evaluate(node => node.open), false);
    }
    const capture = async (name, fullPage = true) => {
      assert.equal(await page.locator("#auth-panel").isVisible(), false);
      await page.waitForFunction(() => !document.querySelector("#status").classList.contains("visible"));
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.equal(dimensions.scrollWidth <= dimensions.width, true, "No document overflow");
      const path = output + "-" + name + ".png"; await page.screenshot({ path, fullPage });
      captures.push({ path, ...dimensions, workText: await cards.allTextContents() });
    };
    await capture(mobile ? "mobile-quiet" : "desktop-quiet");
    for (const participant of manifest.participants) await page.locator('[data-work-record-id="' + participant.workItemId + '"] .work-details > summary').click();
    if (mobile) {
      const size = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), size * 2);
    }
    await capture(mobile ? "mobile-large-text" : "desktop-evidence");
    const reviewed = page.locator('[data-work-record-id="work-agent-b"]');
    await reviewed.getByText("INDEPENDENT PASS", { exact: true }).scrollIntoViewIfNeeded();
    await capture(mobile ? "mobile-large-text-review" : "desktop-review", false);
    if (mobile) {
      const decision = reviewed.getByRole("button", { name: "Record decision", exact: true });
      await decision.scrollIntoViewIfNeeded();
      const bounds = await decision.boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height);
      await capture("mobile-large-text-decision", false);
    }
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(writes, []);
  const evidence = { origin: manifest.origin, captures, errors, outside, writes,
    boundary: "Synthetic room owner read-only UI inspection. Large-text image uses 200% root font size, not a native browser zoom test. No human approval, evidence fetching or caught-up acknowledgement." };
  writeFileSync(output + "-browser.json", JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ captures: captures.map(({ path, width, scrollWidth }) => ({ path, width, scrollWidth })), errors, outside, writes }));
} finally { await browser.close(); }
