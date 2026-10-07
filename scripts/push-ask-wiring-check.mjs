// The push soft ask is wired into the Notifications panel (lane D2 mobile/PWA
// audit): it appears the first time a mention is shown and supersedes the
// standalone opt-in button while visible. "Turn on" delegates to the
// human-push button's tested subscribe flow.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateVapidKeys } from "../server/web-push.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openCatchUpPanel } from "./room-chrome.mjs";

const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
// Test-only receiver auth secret (16 bytes, base64url): the server validates
// the shape, never the value.
const AUTH_SECRET = "sNM7WSFf2Bk1PuKIK590ig";

test("push soft ask appears with a mention and supersedes the standalone button", { timeout: 90000 }, async t => {
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
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const errors = [];
  const posts = [];
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    // Inject a mention into the real feed: the fixture has no second member
    // to @ the owner, but the wiring under test starts at the rendered feed.
    // The real response is kept (roomId/viewerId/binding) so the client's
    // ownership check passes; only the item list is extended.
    if (url.pathname.endsWith("/notifications") && route.request().method() === "GET") {
      const upstream = await route.fetch();
      const feed = await upstream.json();
      const mention = {
        kind: "mention",
        messageId: "msg-mention-1",
        actorId: "owner",
        at: new Date().toISOString(),
        changes: 1,
        ackState: "none"
      };
      feed.notifications = [mention, ...(feed.notifications ?? [])];
      feed.unread = (feed.unread ?? 0) + 1;
      return route.fulfill({ response: upstream, body: JSON.stringify(feed) });
    }
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
        endpoint: "https://fcm.googleapis.com/fcm/send/browser",
        expirationTime: null,
        keys: { p256dh: ${JSON.stringify(RECEIVER_PUBLIC)}, auth: ${JSON.stringify(AUTH_SECRET)} },
        toJSON() { return { endpoint: this.endpoint, expirationTime: this.expirationTime, keys: this.keys }; }
      };
      navigator.serviceWorker.register = async () => ({
        pushManager: { getSubscription: async () => null, subscribe: async () => subscription }
      });
    })()`
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/human-push")) posts.push(request.postData());
  });

  await page.goto(origin);
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });

  await openCatchUpPanel(page, "notification-panel");
  // The ask converges to visible with the standalone button superseded
  // (the human-push refresh settles after the config fetch).
  await page.waitForFunction(() => {
    const ask = document.querySelector("#push-soft-ask");
    const button = document.querySelector("#human-push-button");
    return ask && !ask.hidden && button && button.hidden;
  });
  assert.equal(await page.locator("#push-soft-ask").getByText("Get a tap on your phone when an agent needs you?").count(), 1);

  // "Turn on" delegates to the existing button flow: permission granted, the
  // subscription is saved, and the ask stands down.
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByText("Mentions and DMs are on for this browser.", { exact: true }).waitFor();
  assert.equal(await page.locator("#push-soft-ask").isHidden(), true);
  assert.equal(posts.length, 1);
  const row = f.store.db.prepare("SELECT endpoint, member_id FROM human_push_subscriptions").get();
  assert.equal(row.endpoint, "https://fcm.googleapis.com/fcm/send/browser");
  assert.equal(row.member_id, "owner");
  assert.deepEqual(errors, []);
});
