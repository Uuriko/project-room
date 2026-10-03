// Operator console (operator.html) against a real server with the operator
// secret configured: status renders, find -> plan shows counts, execute stays
// disabled until the room title is typed, the purge runs, and the token lives
// only in sessionStorage. axe reports no serious or critical issue at 390 px.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { event, EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";
import { confirmationPhrase, describeFailure } from "../src/operator-ui.js";

// A fresh random operator token per run; nothing is checked in.
const TOKEN = randomBytes(24).toString("hex");
const WRONG = randomBytes(24).toString("hex");

function createdRoom(roomId, title) {
  return [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, data: { roomId, ownerId: "owner", title, purpose: "operator console fixture" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
  ];
}

async function setup(t, { width = 1280 } = {}) {
  const previous = process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
  const directory = mkdtempSync(join(tmpdir(), "operator-console-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(createdRoom("qa9-console-leftover", "qa9 console leftover"));
  store.initialize(createdRoom("keep-this-room", "Keep this room"));
  const server = createRoomServer({ store, assetRoot: new URL("../", import.meta.url) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await browser.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ROOM_OPERATOR_TOKEN_SHA256; else process.env.ROOM_OPERATOR_TOKEN_SHA256 = previous;
    assert.deepEqual(errors, []);
  });
  return { page, store, origin };
}

async function connect(page, origin, token = TOKEN) {
  await page.goto(`${origin}/operator.html`);
  await page.locator("#op-token").fill(token);
  await page.locator("#op-token-form button[type=submit]").click();
}

async function planLeftover(page) {
  await page.locator("#op-find-room-id").fill("qa9-");
  await page.locator("#op-find-form button[type=submit]").click();
  await page.locator("#op-find-results li", { hasText: "qa9-console-leftover" }).getByRole("button", { name: /Add room qa9-console-leftover/ }).click();
  await page.locator("#op-reason").fill("Remove console QA leftover");
  await page.locator("#op-plan-button").click();
  await page.locator("#op-plan").waitFor({ state: "visible" });
}

test("status renders, a plan shows counts, and execute needs the typed room title", { timeout: 60000 }, async t => {
  const { page, store, origin } = await setup(t);
  const response = await page.request.get(`${origin}/operator.html`);
  assert.match(response.headers()["x-robots-tag"] ?? "", /noindex/);
  assert.match(response.headers()["content-security-policy"] ?? "", /script-src 'self'/);
  await connect(page, origin);
  await page.locator("#op-message", { hasText: "Connected." }).waitFor();
  assert.match(await page.locator("#op-status").textContent(), /Deployed commit.*unstamped/s);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("roomOperatorToken")), TOKEN);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)).then(text => text.includes(TOKEN)), false);
  assert.equal(await page.evaluate(() => document.cookie), "");

  await planLeftover(page);
  assert.ok(await page.locator("#op-plan-counts tbody tr").count() > 0, "the plan lists table counts");
  assert.match(await page.locator("#op-plan-counts").textContent(), /events\s*delete\s*2/);
  assert.equal(await page.locator("#op-confirm-phrase").textContent(), "qa9 console leftover");
  assert.equal(await page.locator("#op-execute").isDisabled(), true);
  await page.locator("#op-confirm").fill("qa9 console");
  assert.equal(await page.locator("#op-execute").isDisabled(), true);
  assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get("qa9-console-leftover"), "nothing deleted before execute");
  await page.locator("#op-confirm").fill("qa9 console leftover");
  assert.equal(await page.locator("#op-execute").isDisabled(), false);
  await page.locator("#op-execute").click();
  await page.locator("#op-message", { hasText: /^Purged \d+ rows across 1 target\.$/ }).waitFor();
  assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get("qa9-console-leftover"), undefined);
  assert.ok(store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get("keep-this-room"));
  await page.locator("#op-actions tbody tr", { hasText: "execute" }).first().waitFor();

  await page.locator("#op-forget").click();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("roomOperatorToken")), null);
  assert.equal(await page.locator("#op-console").isVisible(), false);
});

test("a wrong token is refused and cleared; the console is axe-clean at 390 px", { timeout: 90000 }, async t => {
  const { page, origin } = await setup(t, { width: 390 });
  await connect(page, origin, WRONG);
  await page.locator("#op-message", { hasText: "not accepted" }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("roomOperatorToken")), null);
  assert.equal(await page.locator("#op-token-form").isVisible(), true);

  await connect(page, origin);
  await page.locator("#op-message", { hasText: "Connected." }).waitFor();
  await planLeftover(page);
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => `${node.tagName}#${node.id}.${node.className} ${Math.round(node.getBoundingClientRect().right)}`).slice(0, 8));
  assert.deepEqual(wide, [], "nothing overflows 390 px");
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = result.violations
    .filter(item => item.impact === "serious" || item.impact === "critical")
    .map(item => `${item.impact} ${item.id} ${item.nodes.slice(0, 3).map(node => node.target.join(" ")).join(" | ")}`);
  assert.deepEqual(serious, []);
});

test("the typed confirmation is the room title for one room, a count phrase otherwise, and failures read plainly", () => {
  const titles = new Map([["r1", "QA room"]]);
  assert.equal(confirmationPhrase([{ kind: "room", id: "r1" }], titles), "QA room");
  assert.equal(confirmationPhrase([{ kind: "room", id: "r2" }], titles), "r2");
  assert.equal(confirmationPhrase([{ kind: "identity", id: "i1" }], titles), "purge 1 target");
  assert.equal(confirmationPhrase([{ kind: "room", id: "r1" }, { kind: "identity", id: "i1" }], titles), "purge 2 targets");
  assert.match(describeFailure(404, null), /not accepted/);
  assert.match(describeFailure(429, null), /Wait a minute/);
  assert.match(describeFailure(409, { error: { code: "plan_changed" } }), /Nothing was deleted/);
  assert.equal(describeFailure(422, { error: { message: "Supply a reason" } }), "Refused (422): Supply a reason");
});
