// Q003: visual regression (screenshot diff) tests for the key UI pages.
//
// Covers the three surfaces a visitor or member actually sees:
//   1. login/join entry pages — signed-out auth panel, join consent form
//      (live invite), join error state (bogus code)
//   2. signed-in room view — member chrome plus a seeded message list
//   3. message list region — the `#message-list` element on its own, so a
//      message-markup regression cannot hide behind chrome pixels
//
// Each test captures a deterministic screenshot (fixed 1280x800 viewport,
// reduced motion, fonts settled, seeded store data) and diffs it against a
// committed baseline in scripts/visual-regression-baselines/. Dynamic
// regions — message timestamps, avatars, live presence, invite expiry — are
// painted over via mask locators before capture (baselines carry the same
// masks), so the gate only sees intentional visual changes.
//
// A fourth test is the failing-first proof: it captures a real page,
// deliberately alters the pixels, and asserts the gate fails on the altered
// screenshot and passes on the identical one.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import {
  chromiumLaunchOptions,
  visualContext,
  settleForScreenshot,
  assertScreenshotMatches,
  compareScreenshotBuffer,
  diffPngBuffers,
  BASELINE_DIR,
  EVIDENCE_DIR,
  MAX_DIFF_PIXEL_RATIO,
} from "./visual-regression-helper.mjs";

// Dynamic regions, painted over before every capture (baselines too).
// Timestamps/avatars/presence/expiry change run to run; everything else is
// seeded and must stay pixel-identical.
const DYNAMIC_MASK = [
  ".message-time",
  ".grouped-time",
  ".chat-divider", // "New messages · <day>" separator carries the current date
  ".message-avatar",
  ".member-avatar",
  ".presence-member",
  "#join-expiry",
];

// Short on purpose: every message must stay on one rendered line at the
// fixed column width on any platform font, or the #message-list element
// height (and its baseline dimensions) would drift between environments.
const SEED_MESSAGES = [
  "Seed message one.",
  "Seed message two.",
  "Seed message three.",
];

async function startServer(t, { seedMessages = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "visual-regression-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: crypto.randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work"] },
  });
  seedMessages.forEach((body, i) => {
    store.command(ownerKey, "commons", {
      id: crypto.randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: `visual-seed-${i}`, body },
    });
  });
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin, ownerKey };
}

async function mintInvite(origin, ownerKey) {
  const response = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "chat" }),
  });
  const body = await response.json();
  if (response.status !== 201) throw new Error(`invite mint failed (${response.status})`);
  return body.code;
}

async function launchPage(t) {
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(() => browser.close());
  const context = await visualContext(browser);
  t.after(() => context.close());
  return context.newPage();
}

test("login/join entry pages match visual baselines", { timeout: 180000 }, async t => {
  const { origin, ownerKey } = await startServer(t);
  const code = await mintInvite(origin, ownerKey);
  const page = await launchPage(t);
  const mask = DYNAMIC_MASK.map(selector => page.locator(selector));

  async function capture(url, waitFor, name) {
    await page.goto(url);
    await page.locator(waitFor).waitFor({ state: "visible" });
    await settleForScreenshot(page);
    await assertScreenshotMatches(page, name, { mask });
  }

  // Signed-out room page: the login entry point.
  await capture(origin, "#auth-panel", "login-auth-panel");
  // Join page consent form with a live invite.
  await capture(`${origin}/join/${code}`, "#join-consent", "join-consent");
  // Join page error state for a bogus code.
  await capture(`${origin}/join/BOGUS-CODE`, "#join-error", "join-error");
});

test("signed-in room view and message list match visual baselines", { timeout: 180000 }, async t => {
  const { origin, ownerKey } = await startServer(t, { seedMessages: SEED_MESSAGES });
  const page = await launchPage(t);
  const mask = DYNAMIC_MASK.map(selector => page.locator(selector));

  await page.goto(origin);
  await signInFixture(page, ownerKey);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("[data-message-id]").first().waitFor({ state: "visible" });
  // Each message renders one .message-body inside #message-list; the
  // data-message-id attribute also appears on per-message action buttons,
  // so count bodies, not the attribute.
  await page.waitForFunction(
    expected => document.querySelectorAll("#message-list .message-body").length === expected,
    SEED_MESSAGES.length,
  );
  await settleForScreenshot(page);

  // Full room view: member chrome plus the seeded message list.
  await assertScreenshotMatches(page, "room-view", { mask });
  // Message list region on its own: a message-markup regression cannot hide
  // behind chrome pixels.
  await assertScreenshotMatches(page, "message-list", { element: page.locator("#message-list"), mask });
});

// Failing-first proof for the diff gate: a deliberately altered screenshot
// must fail, an identical one must pass. Self-contained — it writes a throwaway
// baseline, exercises the real gate function against real page pixels, and
// cleans up after itself.
test("visual diff detector fails on an altered screenshot, passes on an identical one", { timeout: 180000 }, async t => {
  // The self-test manages VISUAL_UPDATE_BASELINES itself: an outer update
  // run must not flip the altered screenshot into a passing baseline write.
  const outerUpdate = process.env.VISUAL_UPDATE_BASELINES;
  delete process.env.VISUAL_UPDATE_BASELINES;
  t.after(() => {
    if (outerUpdate === undefined) delete process.env.VISUAL_UPDATE_BASELINES;
    else process.env.VISUAL_UPDATE_BASELINES = outerUpdate;
  });
  const { origin } = await startServer(t);
  const page = await launchPage(t);
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await settleForScreenshot(page);
  const shot = await page.screenshot({ animations: "disabled", caret: "hide", type: "png" });

  const baselinePath = join(BASELINE_DIR, "detector-selftest.png");
  const evidenceActual = join(EVIDENCE_DIR, "detector-selftest.actual.png");
  const evidenceDiff = join(EVIDENCE_DIR, "detector-selftest.diff.png");
  t.after(() => {
    for (const path of [baselinePath, evidenceActual, evidenceDiff]) rmSync(path, { force: true });
  });

  // Identical bytes diff to zero.
  assert.equal(diffPngBuffers(shot, shot).diffPixels, 0, "identical screenshots must diff to zero");

  // Register the throwaway baseline, then prove identical passes the gate.
  const previous = process.env.VISUAL_UPDATE_BASELINES;
  process.env.VISUAL_UPDATE_BASELINES = "1";
  try {
    compareScreenshotBuffer(shot, "detector-selftest");
  } finally {
    if (previous === undefined) delete process.env.VISUAL_UPDATE_BASELINES;
    else process.env.VISUAL_UPDATE_BASELINES = previous;
  }
  assert.ok(existsSync(baselinePath), "self-test baseline should have been written");
  const clean = compareScreenshotBuffer(shot, "detector-selftest");
  assert.equal(clean.diffPixels, 0, "identical screenshot must pass the gate");

  // Deliberately alter the screenshot: paint a solid block over real content.
  const png = PNG.sync.read(shot);
  const block = { x: 40, y: 40, w: 400, h: 200 }; // 7.8% of the frame — well over the 1% budget
  for (let y = block.y; y < block.y + block.h; y++) {
    for (let x = block.x; x < block.x + block.w; x++) {
      const idx = ((png.width * y) + x) << 2;
      png.data[idx] = 255; png.data[idx + 1] = 0; png.data[idx + 2] = 255; png.data[idx + 3] = 255;
    }
  }
  const altered = PNG.sync.write(png);
  const alteredDiff = diffPngBuffers(shot, altered);
  assert.ok(
    alteredDiff.ratio > MAX_DIFF_PIXEL_RATIO,
    `altered screenshot should exceed the diff budget, got ${(alteredDiff.ratio * 100).toFixed(2)}%`,
  );
  assert.throws(
    () => compareScreenshotBuffer(altered, "detector-selftest"),
    /visual regression/,
    "altered screenshot must fail the gate",
  );
  assert.ok(existsSync(evidenceActual) && existsSync(evidenceDiff), "failure evidence (actual + diff) should be written");
});
