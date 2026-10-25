// Count visible interactive controls on the first room screen, and the time
// from the signed-in navigation until that screen is showing.
//
//   node perf/ui-inventory.mjs before
//   node perf/ui-inventory.mjs after
//
// before: /?start=room, the default room a signed-in stranger gets today.
// after: the front door question, a sign-in stub, then the seeded room.
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const INTERACTIVE = "a[href], button, input, textarea, select, summary, [role='button']";

function signIn(store, accountId) {
  store.createAccount(accountId);
  const key = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return { token: slot.token, binding: session.sessionBinding, csrf: session.csrf };
}

async function serve() {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({
    store: fixture.store,
    githubAuth: { clientId: "inventory-client", clientSecret: "inventory-secret" }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    store: fixture.store,
    async close() {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fixture.store.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  };
}

async function countControls(page) {
  return page.evaluate(selector => {
    const visible = el => {
      for (let node = el; node; node = node.parentElement) {
        if (node.hidden) return false;
        if (node.tagName === "DIALOG" && !node.open) return false;
      }
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(selector)].filter(visible).length;
  }, INTERACTIVE);
}

async function beforeFlow(origin, token) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: "account_session", value: token, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(() => localStorage.setItem("pr-had-account", "1"));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const started = Date.now();
  await page.goto(`${origin}/?start=room`, { waitUntil: "domcontentloaded" });
  await page.locator("#main").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#conversation-title").waitFor({ state: "visible" });
  const room = { ms: Date.now() - started, controls: await countControls(page) };
  await browser.close();
  return room;
}

async function afterFlow(origin, token) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.route("**/api/auth/github/start**", async route => {
    await context.addCookies([{ name: "account_session", value: token, url: origin, httpOnly: true, sameSite: "Strict" }]);
    await route.fulfill({ status: 302, headers: { location: `${origin}/?oauth=login` } });
  });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#front-door-work").waitFor({ state: "visible" });
  await page.locator("#front-door-work").fill("Ship the login fix");
  await page.locator("#github-signin").waitFor({ state: "visible" });
  const started = Date.now();
  await page.locator("#github-signin").click();
  await page.locator("#main").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#conversation-title").waitFor({ state: "visible" });
  const ms = Date.now() - started;
  await page.locator("#message-list").getByText("Connect an agent").waitFor({ state: "visible" });
  await page.locator("#message-list").getByText("Ship the login fix").first().waitFor({ state: "visible" });
  await page.locator("#message-list select").waitFor({ state: "visible" });
  await page.locator("#message-list").getByRole("button", { name: "Copy" }).waitFor({ state: "visible" });
  const controls = await countControls(page);
  await browser.close();
  return { ms, controls };
}

const mode = process.argv[2] || "before";
const room = await serve();
try {
  const session = signIn(room.store, "inventory");
  const result = mode === "after" ? await afterFlow(room.origin, session.token) : await beforeFlow(room.origin, session.token);
  process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`);
} finally {
  await room.close();
}
