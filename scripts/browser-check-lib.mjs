// Shared scaffolding for the *-browser-check.mjs journey scripts: headless
// Chromium launch, page defaults, room-server listen/close, page-error
// collection, fixture sign-in, and screenshots.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { signInFixture } from "./auth-signin.mjs";

// Headless Chromium; overrides (e.g. a CI-provided executablePath) pass through.
export async function launchBrowser(overrides = {}) {
  return chromium.launch({ headless: true, ...overrides });
}

function wirePage(page, { timeout, errors } = {}) {
  if (timeout) page.setDefaultTimeout(timeout);
  if (errors) page.on("pageerror", error => errors.push(error.message));
  return page;
}

// Fresh context + page with the defaults every browser check wants; when
// `errors` is supplied, pageerror messages are collected into it.
export async function contextPage(browser, { viewport = { width: 1280, height: 800 }, timeout = 8000, reducedMotion, mobile = false, errors } = {}) {
  const context = await browser.newContext({
    viewport,
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    ...(reducedMotion ? { reducedMotion } : {})
  });
  return { context, page: wirePage(await context.newPage(), { timeout, errors }) };
}

// A page on the shared browser (no fresh context); optional viewport, timeout
// and page-error collection.
export async function browserPage(browser, { viewport, timeout, errors } = {}) {
  return wirePage(await (viewport ? browser.newPage({ viewport }) : browser.newPage()), { timeout, errors });
}

// A page on an existing context (e.g. when several pages share cookies).
export async function sharedPage(context, { timeout, errors } = {}) {
  return wirePage(await context.newPage(), { timeout, errors });
}

// Listens a room server on an ephemeral loopback port; returns its origin.
export async function listenOrigin(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// The full room-server teardown every browser check runs in t.after.
export async function closeRoomServer(server) {
  server.closeStreams();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

// Signs the fixture key in and waits for the room (or `ready` selector) to render.
export async function signInTo(page, url, key, { signInOptions, ready = "#main" } = {}) {
  await page.goto(url);
  await signInFixture(page, key, signInOptions);
  await page.locator(ready).waitFor({ state: "visible" });
}

// Screenshots into test-results/<name>, creating the directory first.
export async function shot(page, path, options = {}) {
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path, ...options });
}
