// Landing hero golden path (#3548): a logged-out stranger lands on the
// collaboration front door, sees live counters and a real receipt, follows
// the receipt to its public page, and enters through both doors — the
// human door (sign up, land in a first room) and the agent door.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts } from "../server/receipts-live.mjs";

const RECEIPT_TITLE = "Settled work: the landing hero points at a real receipt";

test("landing hero golden path: counters, real receipt, both doors", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "landing-hero-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "publish", type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set("commons", {
    id: "claim-hero", title: RECEIPT_TITLE, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: "2026-10-01T12:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [`sha256:${"ab".repeat(32)}`], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  const receipt = collectPublicReceipts(store).find(item => item.title === RECEIPT_TITLE);
  assert.ok(receipt, "seeded receipt is in the public read model");
  // No githubAuth: this deployment cannot offer GitHub sign-in, and the
  // hero must not present the dead door.
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));

  // The front door: framing, live counters, the real receipt card.
  await page.goto(origin);
  const hero = page.locator("#landing-hero");
  await hero.waitFor({ state: "visible" });
  assert.ok((await hero.locator("#landing-hero-title").textContent())
    .includes("Put AI teammates to work — and prove what they did."));
  assert.equal(await page.locator("#landing-receipt-cta").getAttribute("href"), `/receipts/${receipt.id}`,
    "the primary door goes to the live receipt");
  await page.waitForFunction(() =>
    document.querySelector('[data-landing-counter="receiptsIssued"]')?.textContent === "1");
  assert.equal(await page.locator('[data-landing-counter="resultsVerified"]').textContent(), "1");
  assert.equal(await page.locator('[data-landing-counter="workAvailableNow"]').textContent(), "0");
  assert.equal(await page.locator("#github-signin").isVisible(), false,
    "GitHub door stays hidden while the deployment is unverified");
  const card = page.locator("#landing-receipt-card");
  await card.waitFor({ state: "visible" });
  assert.equal(await card.locator("#landing-receipt-link").textContent(), RECEIPT_TITLE);

  // The card leads to the receipt's own public page.
  await card.locator("#landing-receipt-link").click();
  await page.waitForURL(url => url.pathname === `/receipts/${receipt.id}`);
  assert.ok((await page.locator("body").textContent()).includes(RECEIPT_TITLE));

  // The gallery is linked from the hero.
  await page.goto(origin);
  await page.locator("#landing-hero").waitFor({ state: "visible" });
  await page.locator('.landing-gallery-link a[href="/receipts"]').click();
  await page.waitForURL(url => url.pathname === "/receipts");
  assert.ok((await page.locator("body").textContent()).includes(RECEIPT_TITLE));

  // The agent door reaches the agent sign-in surface.
  await page.goto(origin);
  await page.locator("#landing-hero").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Send your agent to work" }).click();
  await page.waitForURL(url => url.pathname === "/agent-signin");

  // The human door: create an account at the wall and land in a first room.
  await page.goto(origin);
  await page.locator("#landing-hero").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Start a room" }).click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await form.locator('[data-password-mode="signup"]').click();
  await form.locator('[name="email"]').fill("hero-journey@example.invalid");
  await form.locator('[name="password"]').fill("synthetic-hero-password");
  await form.locator('button[type="submit"]').click();
  await page.locator("#auth-panel").waitFor({ state: "hidden" });
  await page.locator("#main").waitFor({ state: "visible" });
  assert.match(page.url(), /[?&]room=personal-/, "signup lands in the first room");
  const session = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(session.authenticated, true);
});
