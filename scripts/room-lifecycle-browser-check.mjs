// Simulated human journey against disposable first-party data, not human research.
// Issue #6 A2: an account that administers membership creates a room from Rooms,
// opens it, archives it as its owner (read only afterwards; the switcher shows it
// as a read-only entry, never as a working "Open" button), and a member leaves a
// room from About and no longer finds it.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";

async function setup(t, viewport) {
  const f = createAcceptanceFixture();
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "admin", displayName: "Test admin", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("admin-account"); f.store.bindHumanAccount("commons", "admin", "admin-account");
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
  t.after(() => assert.deepEqual(errors, []));
  const login = async accountId => {
    await page.goto(origin + "/?account=1");
    await fillAccessKey(page, f.store.issueAccountAccessKey(accountId));
    await page.locator('#auth-form button[type="submit"]').click();
    await page.locator("#inbox-panel").waitFor();
  };
  const roomCount = () => f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n;
  return { ...f, page, origin, login, roomCount };
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`room lifecycle ${label}: create from Rooms, archive as owner, archived rooms are read-only switcher entries`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    await f.login("admin-account");
    await page.locator("#nav-rooms").click();
    const commons = page.locator('[data-account-room="commons"]');
    await commons.waitFor();
    assert.equal(await commons.getAttribute("data-room-archived"), "false");
    assert.equal(await commons.locator("small").textContent(), "Personal");
    assert.equal(await commons.locator("span").textContent(), "Open");
    // Create: the form asks for what the room.created event needs and nothing else.
    await page.locator("#account-room-create summary").click();
    await page.locator("#account-room-title").fill("Pilot planning");
    await page.locator("#account-room-purpose").fill("Plan the synthetic pilot together.");
    await page.locator("#account-room-kind").selectOption("organization");
    await page.locator("#account-room-name").fill("Test admin");
    const before = f.roomCount();
    await page.locator("#account-room-submit").click();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await page.locator("#room-title").textContent(), "Pilot planning");
    assert.equal(await page.locator("#room-kind-badge").textContent(), "Organization");
    assert.equal(f.roomCount(), before + 1);
    const created = f.store.db.prepare("SELECT id FROM rooms WHERE json_extract(projection,'$.room.title')='Pilot planning'").get().id;
    assert.equal(f.store.accountForMember(created, "owner").id, "admin-account", "the creator owns the room through the same account");
    assert.equal(f.store.room(created).state.room.kind, "organization");
    assert.equal(await page.locator("#room-archived-note").isHidden(), true);
    assert.equal(await page.locator("#message-input").isDisabled(), false);
    await page.locator("#message-input").fill("First note before archiving.");
    await page.locator('#message-form button[type="submit"]').click();
    await page.locator("#message-list").getByText("First note before archiving.").first().waitFor();
    // Archive: owner only, from About; afterwards the room is read only and says so.
    await openSettings(page, "room-about");
    await page.locator("#room-archive-button").waitFor({ state: "visible" });
    assert.equal(await page.locator("#room-leave-button").isHidden(), true, "the owner cannot leave");
    await page.locator("#room-archive-button").click();
    // The archived note lives in the sidebar, which collapses behind the
    // sidebar toggle on small viewports; open it first the way a mobile
    // reader would before checking the note.
    if (label === "mobile") await page.locator("#sidebar-toggle").click();
    await page.locator("#room-archived-note").waitFor({ state: "visible" });
    assert.match(await page.locator("#room-archived-note").textContent(), /^Archived .+ · read only\. Reading and export stay available; nothing new is recorded\.$/);
    assert.equal(await page.locator("#message-input").isDisabled(), true);
    assert.equal(await page.locator('#message-form button[type="submit"]').isDisabled(), true);
    assert.equal(await page.locator("#new-work-button").isHidden(), true);
    assert.equal(await page.locator("#room-archive-button").isHidden(), true);
    if (label === "mobile") await page.keyboard.press("Escape"); // Close the sidebar again so it cannot cover the room switcher below.
    const state = f.store.room(created).state;
    assert.equal(typeof state.room.archivedAt, "string"); assert.equal(state.room.archivedById, "owner");
    assert.equal(f.store.db.prepare("SELECT archived_at FROM rooms WHERE id=?").get(created).archived_at, state.room.archivedAt);
    const sequence = f.store.room(created).sequence;
    await page.locator("#message-list").getByText("First note before archiving.").first().waitFor();
    // Switcher: the archived room is listed read only, never as a working "Open" button.
    await page.locator("#choose-room").click();
    const row = page.locator(`[data-account-room="${created}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute("data-room-archived"), "true");
    assert.equal(await row.locator("small").textContent(), "Organization · Archived");
    assert.equal(await row.locator("span").textContent(), "Read only");
    assert.equal(await row.getAttribute("aria-label"), "Read archived room Pilot planning");
    assert.equal(await commons.locator("span").textContent(), "Open", "the other room is unchanged");
    await row.click();
    await page.locator("#main").waitFor({ state: "visible" });
    // Same as above: the note lives in the collapsible sidebar on mobile.
    if (label === "mobile") await page.locator("#sidebar-toggle").click();
    await page.locator("#room-archived-note").waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-input").isDisabled(), true);
    await page.locator("#message-list").getByText("First note before archiving.").first().waitFor();
    assert.equal(f.store.room(created).sequence, sequence, "reading an archived room records nothing");
    assert.equal(f.store.room(created).state.room.archivedAt, state.room.archivedAt);
  });
}

test("room lifecycle: a member leaves from About, the room leaves the switcher, and a conversation-only account cannot create rooms", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 1440, height: 1000 }), { page } = f;
  await f.login(f.store.accountForMember("commons", "guest").id);
  await page.locator("#nav-rooms").click();
  const row = page.locator('[data-account-room="commons"]');
  await row.waitFor(); await row.click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#room-kind-badge").textContent(), "Personal", "rooms from before the kind attribute read as personal");
  await openSettings(page, "room-about");
  await page.locator("#room-leave-button").waitFor({ state: "visible" });
  assert.equal(await page.locator("#room-archive-button").isHidden(), true, "only the owner archives");
  const sequence = f.store.room("commons").sequence;
  await page.locator("#room-leave-button").click();
  // Access ends with the leave; the account home lands on Rooms, which no longer lists the room.
  await page.locator("#main").waitFor({ state: "hidden" });
  await page.locator("#account-rooms-panel").waitFor({ state: "visible" });
  assert.equal(f.store.room("commons").state.members.guest.active, false);
  assert.equal(f.store.room("commons").sequence, sequence + 1, "leaving is one recorded access change");
  await page.getByText("No rooms yet.", { exact: true }).waitFor();
  assert.equal(await page.locator("#account-rooms-list button").count(), 0);
  const before = f.roomCount();
  await page.locator("#account-room-create summary").click();
  await page.locator("#account-room-title").fill("Not allowed");
  await page.locator("#account-room-purpose").fill("A guest account cannot spawn rooms.");
  await page.locator("#account-room-name").fill("Guest");
  await page.locator("#account-room-submit").click();
  // Denial copy changed in RC-2026-09-19-080 ("Your first room is free..."): a
  // zero-membership account may create its first room, but this account still
  // holds the left room's binding, so the administration requirement stands.
  await page.getByText("Your first room is free to create, but more rooms need membership administration in one of your rooms.", { exact: true }).waitFor();
  assert.equal(f.roomCount(), before, "no room was created");
  assert.equal(await page.locator("#account-room-title").inputValue(), "Not allowed", "the form keeps what was typed");
});
