// #3968 census + regression: the owner-facing publish control for room
// receipts. The projection (#3776) only publishes a room's receipts after
// the owner turns publishing on (room.public_receipts_set); QA Wave C found
// no user-reachable surface for that toggle. This check drives the real UI
// as the room owner: open Settings, expand Permissions, flip "Publish
// receipts from this room on the public receipts page", and prove the
// room's verified receipt appears on the anonymous /receipts page only
// after the flip.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";

const TITLE = "Receipt that publishing reveals";

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "receipts-publish-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.workClaims.set("commons", {
    id: "claim-1", title: TITLE,
    state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: "2026-10-01T12:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [`sha256:${"ab".repeat(32)}`], updatedAt: "2026-10-01T12:00:00.000Z",
  });
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { store, origin, ownerKey, page, errors };
}

const anonReceiptsText = async (origin) => {
  const res = await fetch(`${origin}/receipts`);
  assert.equal(res.status, 200);
  return res.text();
};

test("owner publishes receipts from Settings; the verified receipt reaches /receipts only then", { timeout: 60000 }, async t => {
  const { store, origin, ownerKey, page, errors } = await setup(t);

  // Before any opt-in the anonymous gallery does not carry the receipt.
  assert.ok(!(await anonReceiptsText(origin)).includes(TITLE), "receipt is unpublished before the owner opts in");

  await page.goto(origin + "/?room=commons");
  await signInFixture(page, ownerKey);
  await page.locator("#main:visible, #workspace-nav:visible").first().waitFor({ state: "visible" });

  await openSettings(page, "room-permissions");
  const control = page.locator("#public-receipts-control");
  await control.waitFor({ state: "visible" });
  const box = page.locator("#public-receipts-toggle");
  assert.equal(await box.isChecked(), false, "publishing starts off");

  // Drive it the way QA Wave C did — keyboard only. The pre-fix control
  // snapped back to unchecked the moment it was toggled (the busy re-sync
  // re-derived `checked` from not-yet-landed room state), so the surface
  // read as dead; the box must now hold the owner's choice immediately.
  await box.focus();
  await page.keyboard.press("Space");
  const heldImmediately = await page.evaluate(() => document.querySelector("#public-receipts-toggle")?.checked === true);
  assert.equal(heldImmediately, true, "the toggle holds the owner's choice immediately (no snap-back)");
  // The room state on the server records the opt-in (event-sourced setting).
  await assert.doesNotReject(async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const state = store.room("commons").state;
      if (state.room.publicReceipts?.enabled === true) return;
      if (Date.now() > deadline) throw new Error("room.public_receipts_set never landed");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
  await page.waitForFunction(() => document.querySelector("#public-receipts-toggle")?.checked === true, null, { timeout: 5000 });

  assert.ok((await anonReceiptsText(origin)).includes(TITLE), "receipt is published after the owner opts in");
  assert.deepEqual(errors, []);
});

test("the same Settings toggle controls a paid lot receipt's public visibility", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-publish-lot-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added", data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  // Settle a paid lot: post -> fund -> claim -> submit -> accept -> window -> finalize -> epoch.
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis("commons");
  const bounty = escrow.postBounty("commons", { poster: "owner", title: "Paid lot gallery proof",
    criteria: "C", amount: 10, deadline: new Date(clock + 30 * 86_400_000).toISOString() }).bounty;
  escrow.fundBounty("commons", bounty.bountyId, { funder: "owner" });
  escrow.claimBounty("commons", bounty.bountyId, { claimant: "ada" });
  escrow.submitWork("commons", bounty.bountyId, { claimant: "ada",
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork("commons", bounty.bountyId, { acceptor: "owner",
    verifierAttestation: { at: new Date(clock).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  clock += 72 * 3_600_000 + 1000;
  escrow.finalizeBounty("commons", bounty.bountyId, {});
  escrow.closeEpoch("commons", {});
  const lotId = store.db.prepare("SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' ORDER BY seq LIMIT 1")
    .get("commons", bounty.bountyId)?.lot_id;
  assert.match(lotId ?? "", /^lot_[a-f0-9]{16}$/, "a payout lot exists");

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);

  const lotStatus = async () => (await fetch(`${origin}/receipts/${lotId}`)).status;
  const waitRecorded = async (enabled) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (store.room("commons").state.room.publicReceipts?.enabled === enabled) return;
      if (Date.now() > deadline) throw new Error(`publicReceipts never recorded ${enabled}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };

  // Never recorded: the settled lot stays private. Since #3594 a settled
  // lot is public only with the owner's recorded opt-in
  // (server/public-visibility.mjs): never-recorded, recorded-off, and
  // unreadable all keep the lot private (404). Lot receipts are composed
  // at read time from the journal and served by id — they are never
  // stored rows, so the /receipts list (stored rows only,
  // server/public-read-model.mjs) cannot list them; the toggle's control
  // over a lot is its public visibility, proven here by id.
  assert.equal(await lotStatus(), 404, "never recorded keeps the settled lot private");

  await page.goto(origin + "/?room=commons");
  await signInFixture(page, ownerKey);
  await page.locator("#main:visible, #workspace-nav:visible").first().waitFor({ state: "visible" });
  await openSettings(page, "room-permissions");
  const box = page.locator("#public-receipts-toggle");
  await box.waitFor({ state: "visible" });

  // Record ON: the settled lot is served through the public read and its
  // page names the bounty. Then OFF: the recorded off hides it again.
  // (Re-focus before each press: the busy-disable drops focus from the
  // box after a flight — the focus-retention pattern is the #3793 family;
  // a keyboard user tabs back to the control to flip it again.)
  await box.focus(); await page.keyboard.press("Space");
  await waitRecorded(true);
  assert.equal(await page.evaluate(() => document.querySelector("#public-receipts-toggle")?.checked), true);
  assert.equal(await lotStatus(), 200, "recorded on serves the paid lot receipt");
  const lotPage = await (await fetch(`${origin}/receipts/${lotId}`)).text();
  assert.ok(lotPage.includes("Paid lot gallery proof"), "the lot detail page names the bounty");
  await box.focus(); await page.keyboard.press("Space");
  await waitRecorded(false);
  assert.equal(await lotStatus(), 404, "recorded off hides the paid lot receipt");

  // Back ON from the same surface: the paid lot receipt is served again.
  await box.focus(); await page.keyboard.press("Space");
  await waitRecorded(true);
  assert.equal(await lotStatus(), 200, "the paid lot receipt is public again once publishing is on");
});
