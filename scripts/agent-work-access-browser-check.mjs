import { openMemberProfile, ensurePeopleOpen, openComposerOptions } from "./room-chrome.mjs";
// H4: an agent that joins through a room link has no permissions, so it never
// shows up as an assignee. The owner sees "Let them take work" on that agent in
// People, the work form says why the agent is missing, and one click makes it
// assignable. Agents with their own connection key are pointed to Manage
// connections instead, because changing their access retires that key.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("owner lets a link-joined agent take work, then assigns it", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-agent-work-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "linked", displayName: "Linked Agent", kind: "agent", permissions: [] }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "keyed", displayName: "Keyed Agent", kind: "agent", permissions: [] }));

  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });

  const assignees = async () => page.locator("#assignee-select option").evaluateAll(options => options.map(o => o.value).filter(Boolean));
  await openComposerOptions(page); await page.locator("#new-work-button").click();
  await page.locator("#work-dialog").waitFor({ state: "visible" });
  assert.equal((await assignees()).includes("linked"), false);
  assert.match(await page.locator("#assignee-hint").textContent(), /Linked Agent.*can't take work yet/);
  await page.keyboard.press("Escape");

  await ensurePeopleOpen(page);
  const linked = page.locator('#presence-list .presence-member[data-member-record-id="linked"]');
  // A connection-key agent: the list says key_issued, so nothing changes.
  await page.route("**/agent-connections", route => route.request().method() === "GET"
    ? route.fulfill({ json: { connections: [{ memberId: "keyed", status: "key_issued" }] } }) : route.continue());
  const keyed = page.locator('#presence-list .presence-member[data-member-record-id="keyed"]');
  await openMemberProfile(page, "keyed");
  await keyed.locator("[data-member-work]").click();
  await page.getByText(/Keyed Agent connected with its own key/).waitFor();
  assert.deepEqual(store.room("commons").state.members.keyed.permissions, []);
  await openMemberProfile(page, "linked");
  await linked.locator("[data-member-work]").click();
  await page.waitForFunction(() => !document.querySelector('[data-member-work="linked"]'));
  assert.deepEqual(store.room("commons").state.members.linked.permissions, ["accept_work", "complete_work"]);

  await openComposerOptions(page); await page.locator("#new-work-button").click();
  await page.locator("#work-dialog").waitFor({ state: "visible" });
  assert.equal((await assignees()).includes("linked"), true);
  assert.equal(errors.length, 0, errors.join("\n"));
});
