// Human push is one button behind the browser permission prompt.
// The settings dialog stays free of notification levels and quiet hours.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateVapidKeys } from "../server/web-push.mjs";
import { fillAccessKey } from "./auth-signin.mjs";
import { closeSettings, openCatchUpPanel, openSettings } from "./room-chrome.mjs";

const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`human push ${label}: one mentions-and-DMs button, no settings panel`, { timeout: 90000 }, async t => {
    const f = createAcceptanceFixture();
    const keys = await generateVapidKeys();
    const server = createRoomServer({
      store: f.store,
      streamInterval: 60,
      push: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:push@example.com" }
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeStreams();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce"
    });
    const errors = [];
    const posts = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      return route.continue();
    });
    await context.addInitScript({
      content: `(() => {
        let permission = "default";
        function Notification() {}
        Object.defineProperty(Notification, "permission", { get: () => permission });
        Notification.requestPermission = async () => { permission = "granted"; return "granted"; };
        window.Notification = Notification;
        const subscription = {
          endpoint: "https://push.example.test/browser",
          expirationTime: null,
          keys: { p256dh: ${JSON.stringify(RECEIVER_PUBLIC)}, auth: ${JSON.stringify(AUTH_SECRET)} },
          toJSON() { return { endpoint: this.endpoint, expirationTime: this.expirationTime, keys: this.keys }; }
        };
        navigator.serviceWorker.register = async () => ({
          pushManager: { getSubscription: async () => null, subscribe: async () => subscription }
        });
      })();`
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.method() === "POST" && request.url().includes("/human-push")) posts.push(request.postData());
    });

    const worker = await page.request.get(`${origin}/push-sw.js`);
    assert.equal(worker.status(), 200);

    await page.goto(origin);
    await fillAccessKey(page, f.keys.owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });

    await openSettings(page);
    assert.equal(await page.locator("#settings-dialog #human-push-button").count(), 0);
    assert.equal(await page.locator("#settings-dialog").getByText("Quiet hours").count(), 0);
    assert.equal(await page.locator("#settings-dialog").getByText("mentions_and_dms").count(), 0);
    await closeSettings(page);

    await openCatchUpPanel(page, "notification-panel");
    const button = page.locator("#human-push-button");
    await button.waitFor({ state: "visible" });
    assert.equal(await button.textContent(), "Notify me of mentions and DMs");
    assert.equal(await page.locator("#notification-panel select, #notification-panel input").count(), 0);
    await button.click();
    await page.getByText("Mentions and DMs are on for this browser.", { exact: true }).waitFor();
    assert.equal(await button.isHidden(), true);
    assert.equal(posts.length, 1);
    const sent = JSON.parse(posts[0]);
    assert.deepEqual(Object.keys(sent).sort(), ["endpoint", "expirationTime", "keys"]);
    assert.equal(sent.quietHours, undefined);
    assert.equal(sent.level, undefined);
    const row = f.store.db.prepare("SELECT endpoint, member_id FROM human_push_subscriptions").get();
    assert.equal(row.endpoint, "https://push.example.test/browser");
    assert.equal(row.member_id, "owner");
    assert.deepEqual(errors, []);
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({ path: `test-results/human-push-${label}.png` });
  });
}
