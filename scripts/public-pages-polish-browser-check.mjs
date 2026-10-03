// Compare pages and the HTML 404: axe serious/critical at 390 and 1280,
// and no Content-Security-Policy console errors on the compare pages.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const pages = ["/about", "/receipts", "/compare/project-room-vs-slack", "/compare/project-room-vs-discord",
  "/compare/agent-collaboration-tool", "/compare/multi-agent-workspace",
  "/compare/ai-agent-coordination", "/compare/project-room-vs-agent-room", "/no-such-page"];
const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

async function serious(page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations
    .filter(item => item.impact === "serious" || item.impact === "critical")
    .map(item => `${item.impact} ${item.id} ${item.nodes.slice(0, 3).map(node => node.target.join(" ")).join(" | ")}`);
}

test("public pages permit only the intended analytics connection and remain axe-clean at 390 and 1280", { timeout: 180000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "public-pages-polish-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Different port is a different origin. A broken CSP reaches a real local
  // sink rather than failing DNS and masquerading as successful CSP denial.
  const redirectedRequests = [];
  const collector = createServer((req, res) => {
    redirectedRequests.push(req.url);
    req.resume(); res.writeHead(204); res.end();
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  const deniedRedirectOrigin = `http://127.0.0.1:${collector.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close();
    collector.closeAllConnections();
    await new Promise(resolve => collector.close(resolve));
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let shots = null;
  try {
    shots = "/opt/cursor/artifacts/screenshots";
    mkdirSync(shots, { recursive: true });
  } catch { shots = null; }
  const context = await browser.newContext();
  await context.addInitScript(() => {
    globalThis.cspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      globalThis.cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  const page = await context.newPage();
  const csp = [];
  const analyticsRequests = [];
  // Simulate the edge-injected script at its already-authorized script origin.
  // Probe destinations are intercepted or local fixtures: no synthetic data
  // reaches analytics or any external service. Chromium enforces the policy.
  await context.route("https://static.cloudflareinsights.com/beacon.min.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `globalThis.rumProbe = fetch('/cdn-cgi/rum?', { method: 'POST', body: 'synthetic-csp-test' })
      .then(response => ({ delivered: true, status: response.status }))
      .catch(() => ({ delivered: false }));`
  }));
  await context.route(/\/(?:cdn-cgi\/rum(?:[/?].*)?|__csp-denied)$/, route => {
    const request = route.request();
    const url = new URL(request.url());
    analyticsRequests.push({ url: url.href, method: request.method() });
    if (url.searchParams.has("redirect")) return route.fulfill({
      status: 307, headers: { location: `${deniedRedirectOrigin}/cdn-cgi/rum` }
    });
    return route.fulfill({ status: 204 });
  });
  page.on("console", message => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) csp.push(message.text());
  });
  for (const path of pages) {
    for (const viewport of viewports) {
      csp.length = 0;
      await page.setViewportSize(viewport);
      const response = await page.goto(origin + path, { waitUntil: "domcontentloaded" });
      assert.equal(response.status(), path === "/no-such-page" ? 404 : 200, `${path} ${viewport.width}`);
      assert.equal(await page.locator("h1").count(), 1, path);
      assert.ok(await page.locator("html").getAttribute("lang"), path);
      assert.ok((await page.title()).length > 0, path);
      if (path !== "/no-such-page") {
        analyticsRequests.length = 0;
        await page.addScriptTag({ url: "https://static.cloudflareinsights.com/beacon.min.js" });
        const result = await page.evaluate(() => globalThis.rumProbe);
        assert.deepEqual(result, { delivered: true, status: 204 }, `${path}@${viewport.width}: injected analytics POST must reach same-origin /cdn-cgi/rum`);
        assert.deepEqual(analyticsRequests, [{ url: `${origin}/cdn-cgi/rum?`, method: "POST" }]);
        assert.deepEqual(csp, [], `${path} ${viewport.width}`);
        // Direct unrelated paths, foreign origins, and foreign redirect targets
        // remain blocked. CSP deliberately ignores path constraints after a
        // redirect; do not claim it confines same-origin redirect destinations.
        for (const target of ["/__csp-denied", "/cdn-cgi/rum/extra", "https://csp-denied.example/cdn-cgi/rum", "/cdn-cgi/rum?redirect=1"]) {
          analyticsRequests.length = 0;
          const violationsBefore = await page.evaluate(() => globalThis.cspViolations.length);
          const blocked = await page.evaluate(async target => {
            try { await fetch(target, { method: "POST", body: "synthetic-csp-test", mode: "no-cors" }); return false; }
            catch { return true; }
          }, target);
          assert.equal(blocked, true, `${path}@${viewport.width}: ${target} must stay blocked`);
          await page.waitForFunction(count => globalThis.cspViolations.length > count, violationsBefore);
          const violations = await page.evaluate(count => globalThis.cspViolations.slice(count), violationsBefore);
          const requested = new URL(target, origin);
          // CSP reports can name the original URL after a redirect to avoid
          // disclosing cross-origin path data. Accept that standard form as
          // well as a target-origin report; delivery is independently checked.
          const reportedUrls = target.includes("redirect=")
            ? [requested.href, requested.origin, deniedRedirectOrigin, `${deniedRedirectOrigin}/cdn-cgi/rum`]
            : [requested.href, requested.origin];
          assert.ok(violations.some(v => v.directive === "connect-src" && reportedUrls.includes(v.blocked)), `${target}: CSP-specific denial, not a network failure`);
          assert.deepEqual(redirectedRequests, [], "no redirect reached the foreign-origin local collector");
          assert.deepEqual(analyticsRequests, target.includes("redirect=")
            ? [{ url: `${origin}/cdn-cgi/rum?redirect=1`, method: "POST" }] : [], target);
        }
      }
      assert.deepEqual(await serious(page), [], `${path} ${viewport.width}`);
      if (shots) {
        const name = `${path.replace(/[^a-z0-9]+/gi, "_")}-${viewport.width}.png`;
        await page.screenshot({ path: join(shots, name), animations: "disabled" });
      }
    }
  }
  await page.goto(origin + "/no-such-page", { waitUntil: "domcontentloaded" });
  await page.locator("a[href='/']").focus();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/about");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/receipts");
});
