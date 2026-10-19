// Native wake bridge regression (CX4B-WAKE): the macOS shell signals system
// wake by evaluating one JavaScript snippet in the loaded room page. This
// check extracts that exact snippet from RoomWindow.swift and runs it against
// the real page + server, proving the wake behaviors the bridge exists for:
// a valid session revalidates in one bounded pass per wake (no write replay,
// drafts and delivered messages untouched), and a session that died while the
// machine slept loses its stale access instead of coasting on a frozen page.
// It proves the web side of the contract only — WKWebView's own delivery of
// the signal on a real macOS wake is OS-level and is not claimed here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

// The literal script the bridge sends on wake, read out of the Swift source
// so this check can never drift from what macOS actually evaluates.
function bridgeWakeScript() {
  const swift = readFileSync(join(ROOT, "desktop/macos/Sources/ProjectRoomKit/RoomWindow.swift"), "utf8");
  const match = swift.match(/evaluateJavaScript\("((?:[^"\\]|\\.)*PageTransitionEvent(?:[^"\\]|\\.)*)"/);
  assert.ok(match, "the wake observer's evaluateJavaScript snippet is extractable from RoomWindow.swift");
  return match[1].replace(/\\"/g, "\"").replace(/\\n/g, "\n");
}

test("macOS wake signal: bounded revalidation for a live session, stale access dropped for a dead one", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-wake-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "waker", displayName: "Wake Tester", kind: "human", permissions: []
  }));
  const waker = store.issueAccessKey("commons", "waker");
  store.command(waker, "commons", command(T.MESSAGE_POSTED, { body: "seed message posted before sleep" }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/`);
  await signInFixture(page, waker);
  await page.locator("#message-list").getByText("seed message posted before sleep").waitFor();

  // fill() dispatches input without waiting for its asynchronous typing
  // beacon. Drain that user traffic before recording any wake traffic.
  const [typingResponse] = await Promise.all([
    page.waitForResponse(response => response.url() === `${origin}/api/rooms/commons/typing`
      && response.request().method() === "POST", { timeout: 10000 }),
    page.fill("#message-input", "draft that must survive wake")
  ]);
  assert.ok(typingResponse.ok(), "the draft's typing beacon succeeds before the wake ledger starts");
  assert.equal(await typingResponse.finished(), null, "the draft's typing beacon finishes before the wake ledger starts");

  // The room is open and the draft's typing beacon has completed, so every
  // entry below is wake-window traffic. The ledger counts REPLAYABLE writes
  // only: every non-GET request except the ephemeral typing beacon
  // (POST /api/rooms/<id>/typing). That beacon is ambient presence the
  // composer emits autonomously while a draft sits in it (client-throttled
  // to one beat per 4s, src/client.js sendTyping), and on the server it is
  // in-memory only — never persisted, never in the event log
  // (server/typing.mjs) — so a wake can neither replay it nor be charged
  // with it. A re-triggered beat raced this ledger under hosted load
  // (three specimens in the former tests/quarantine.json entry: the typing
  // POST was the only non-GET in the ledger at the wake #1 assertion).
  // The wake itself is still charged with every other write: any replayed
  // send, approval or work execution fails the assertions below.
  const TYPING_PATH = /^\/api\/rooms\/[^/]+\/typing$/;
  const ledger = [];
  page.on("request", request => ledger.push({ method: request.method(), path: new URL(request.url()).pathname }));
  const wakeTraffic = () => ledger.filter(entry => !TYPING_PATH.test(entry.path));
  const sessionGets = () => wakeTraffic().filter(entry => entry.method === "GET" && entry.path === "/api/session").length;
  const writes = () => wakeTraffic().filter(entry => entry.method !== "GET").length;
  const wakeScript = bridgeWakeScript();

  // Two wakes against the live session: exactly one session revalidation
  // each, a fixed bounded set of lifecycle reads, and no write replayed.
  for (const expected of [1, 2]) {
    const before = wakeTraffic().length;
    const restored = page.waitForResponse(response => response.url().endsWith("/api/session")
      && response.request().method() === "GET" && response.ok());
    await page.evaluate(wakeScript);
    await restored;
    await page.waitForTimeout(500);
    assert.equal(sessionGets(), expected, `wake #${expected} revalidates the session exactly once`);
    assert.equal(writes(), 0, `wake #${expected} replays no writes (no duplicate send, approval, or work execution); ledger: ${JSON.stringify(ledger)}`);
    assert.ok(wakeTraffic().length - before <= 16, `wake #${expected} traffic stays bounded (${wakeTraffic().length - before} requests)`);
  }
  assert.equal(await page.locator("#message-input").inputValue(), "draft that must survive wake",
    "the unsent composer draft survives wake revalidation");
  assert.equal(await page.locator("#message-list").getByText("seed message posted before sleep").count(), 1,
    "an already-delivered message is not duplicated by wake");

  // The session dies while the machine sleeps (revoked/expired server-side):
  // the room cookie no longer authenticates. The next wake must drop the
  // stale access, not leave a working-looking room behind.
  const roomCookie = (await page.context().cookies(origin)).find(cookie => cookie.name.endsWith("room_session"));
  assert.ok(roomCookie, "the room session cookie is present before revocation");
  await page.context().clearCookies({ name: roomCookie.name });
  await page.context().addCookies([{ ...roomCookie, value: "revoked-session-token" }]);
  const denied = page.waitForResponse(response => response.url().endsWith("/api/session")
    && response.request().method() === "GET");
  await page.evaluate(wakeScript);
  const deniedResponse = await denied;
  assert.equal(deniedResponse.status(), 401, "the wake revalidation meets the dead session head-on");
  await page.waitForFunction(() => {
    const authPanel = document.querySelector("#auth-panel");
    const identity = document.querySelector("#identity-label")?.textContent ?? "";
    return (authPanel && !authPanel.hidden) || identity === "Not signed in";
  }, null, { timeout: 10000 });
  const staleRead = await page.evaluate(async () => {
    const response = await fetch("/api/rooms/commons", { credentials: "same-origin" });
    return response.status;
  });
  assert.ok([401, 403].includes(staleRead), `no stale room read survives the revoked wake (got ${staleRead})`);
  assert.equal(writes(), 0, "the revoked wake performs no writes either");
  assert.equal(errors.join("\n"), "");
});

test("overlapping wakes: an older wake completion cannot end the newer wake's access", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-wake-overlap-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "waker", displayName: "Wake Tester", kind: "human", permissions: []
  }));
  const waker = store.issueAccessKey("commons", "waker");
  store.command(waker, "commons", command(T.MESSAGE_POSTED, { body: "seed message posted before sleep" }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/`);
  await signInFixture(page, waker);
  await page.locator("#message-list").getByText("seed message posted before sleep").waitFor();
  await page.fill("#message-input", "draft that must survive overlapping wakes");
  const wakeScript = bridgeWakeScript();

  // Hold the first wake's session response in transport (its real 200 is
  // fetched but not delivered), let a second wake restore fully, then
  // release the first. The older restore resumes superseded: restore()
  // returns null, and that cancellation must not be read as wrong-room —
  // the newer wake's access, draft, and room must all survive.
  let release, began, count = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  await page.route("**/api/session", async route => {
    if (route.request().method() === "GET" && ++count === 1) {
      const response = await route.fetch();
      began();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.evaluate(wakeScript);
  await started;
  const newerRestored = page.waitForResponse(response => response.url().endsWith("/api/session")
    && response.request().method() === "GET" && response.ok());
  await page.evaluate(wakeScript);
  await newerRestored;
  await page.waitForTimeout(300);
  release();
  await page.waitForTimeout(500);
  await page.unroute("**/api/session");
  assert.equal((await page.context().request.get(`${origin}/api/session`)).status(), 200,
    "the credential is still valid after the overlapping wakes");
  assert.equal(await page.locator("#main").isVisible(), true,
    "the older cancelled restore must not end the newer wake's access");
  assert.equal(await page.locator("#message-input").inputValue(), "draft that must survive overlapping wakes",
    "the unsent draft survives the overlapping wakes");
  assert.equal(await page.locator("#message-list").getByText("seed message posted before sleep").count(), 1,
    "the delivered message is not duplicated by the overlapping wakes");
  assert.equal(errors.join("\n"), "");
});
