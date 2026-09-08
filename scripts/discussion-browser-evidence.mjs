// Read-only browser evidence of one explicitly supplied synthetic exercise.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { chromium } from "playwright";

const [manifestPath, prefix] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.match(basename(dirname(resolve(manifestPath))), /^room-discussion-/);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.credentialKind, "synthetic operator-provisioned agent, draft-only");
assert.match(manifest.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const owner = JSON.parse(readFileSync(join(dirname(manifestPath), "owner-private.json"), "utf8"));
assert.equal(owner.origin, manifest.origin);
const output = resolve(prefix), suffixes = ["desktop", "mobile", "mobile-large-text"];
assert.equal([...suffixes.map(s => s + ".png"), "browser.json"].some(s => existsSync(output + "-" + s)), false);
const browser = await chromium.launch({ headless: true }), captures = [], errors = [], outside = [], writes = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== manifest.origin) { outside.push(url.origin); return route.abort(); }
      if (request.method() === "POST" && url.pathname !== "/api/session") { writes.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(manifest.origin); await page.locator("#access-key").fill(owner.token);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const draft = page.locator(".message").filter({ hasText: "Pasted draft · based on revision 0" });
    await draft.waitFor(); assert.equal(await draft.count(), 1);
    const body = await draft.locator(".message-content > p").first().textContent();
    assert.ok(body.trim().length); assert.equal(body.trim().split(/\s+/).length <= 30, true);
    const capture = async name => {
      await draft.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => !document.querySelector("#status").classList.contains("visible"));
      const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(width.document <= width.viewport, "No document overflow");
      const path = output + "-" + name + ".png"; await page.screenshot({ path, fullPage: false });
      captures.push({ path, ...width, draftBody: body });
    };
    await capture(mobile ? "mobile" : "desktop");
    if (mobile) {
      const size = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), size * 2);
      await capture("mobile-large-text");
    }
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(writes, []);
  writeFileSync(output + "-browser.json", JSON.stringify({ captures, errors, outside, writes,
    boundary: "Synthetic read-only owner UI; actual agent draft. 200% root font size, not native browser zoom. No human study or approval." }, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ captures, errors, outside, writes }));
} finally { await browser.close(); }
