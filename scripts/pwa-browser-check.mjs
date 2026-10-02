// Install button and the push soft ask, in Chromium. The ask is absent on
// load and appears only after a needs-you item is handed to the dock.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const pageHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Room</title></head>
<body>
  <div id="account"></div>
  <div id="dock"></div>
  <script type="module">
    import { mountPwaInstall } from "/src/pwa-install.js";
    import { mountPushAsk } from "/src/push-ask.js";
    window.__permissionCalls = 0;
    window.__install = mountPwaInstall({
      account: document.querySelector("#account"),
      firstValue: false,
      userAgent: navigator.userAgent
    });
    window.__ask = mountPushAsk({
      dock: document.querySelector("#dock"),
      ios: false,
      standalone: false,
      permission: () => "default",
      requestPermission: async () => { window.__permissionCalls += 1; return "granted"; }
    });
    window.__ready = true;
  </script>
</body></html>`;

test("install prompt and push soft ask wait for a gesture and a needs-you item", { timeout: 60000 }, async t => {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pageHtml);
      return;
    }
    if (path === "/src/pwa-install.js" || path === "/src/push-ask.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(new URL(`..${path}`, import.meta.url)));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {})
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__ready === true);

  assert.equal(await page.locator("#install-room-button").isHidden(), true);
  assert.equal(await page.locator("#push-soft-ask").isHidden(), true);
  assert.equal(await page.evaluate(() => window.__permissionCalls), 0);

  await page.evaluate(() => window.__install.markFirstValue());
  assert.equal(await page.locator("#install-room-button").isHidden(), true);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt")));
  await page.locator("#install-room-button", { hasText: "Install Room" }).waitFor({ state: "visible" });

  await page.evaluate(() => window.__ask.showFor({ needsMe: false }));
  assert.equal(await page.locator("#push-soft-ask").isHidden(), true);
  await page.evaluate(() => window.__ask.showFor({ needsMe: true }));
  await page.getByText("Get a tap on your phone when an agent needs you?").waitFor();
  assert.equal(await page.evaluate(() => window.__permissionCalls), 0);
  await page.getByRole("button", { name: "Turn on" }).click();
  assert.equal(await page.evaluate(() => window.__permissionCalls), 1);
  assert.equal(await page.locator("#push-soft-ask").isHidden(), true);
  assert.deepEqual(errors, []);
});
