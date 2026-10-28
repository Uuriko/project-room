// Simulated human journeys against disposable data; not human research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { ensureSidebarOpen, ensureSidebarClosed, openDirectConversation, messageAction } from "./room-chrome.mjs";

const PRIVATE = "Private discussion must not become a shared work title";
const DRAFT = "Private draft stays with this person";
const PUBLIC = "Discuss the shared launch checklist";
const TITLE = "Prepare the shared launch checklist";

for (const [label, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  test(`private source actions ${label}: room work is explicit and private text is never prefilled`, { timeout: 60000 }, async t => {
    const f = createAcceptanceFixture();
    const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type, data });
    for (const member of Object.values(f.store.room("commons").state.members)) {
      if (!["owner", "producer", "guest"].includes(member.id) && member.active !== false) {
        send(T.MEMBER_ACCESS_CHANGED, { memberId: member.id, expectedMemberRevision: member.revision ?? 0, permissions: member.permissions, active: false });
      }
    }
    f.store.dmConsents.request("commons", "owner", "producer", "Acceptance fixture");
    f.store.dmConsents.decide("commons", "producer", "owner", "approve");
    send(T.MESSAGE_POSTED, { messageId: "private-source", body: PRIVATE, toMemberId: "producer" });
    send(T.MESSAGE_POSTED, { messageId: "public-source", body: PUBLIC });
    const server = createRoomServer({ store: f.store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const errors = [];
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = async key => {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
      page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin); await signInFixture(page, key);
      await page.locator("#main").waitFor({ state: "visible" });
      return page;
    };
    const page = await login(f.keys.owner), guest = await login(f.keys.guest);
    const guestSnapshot = async () => {
      const response = await fetch(`${origin}/api/rooms/commons`, { headers: { Authorization: `Bearer ${f.keys.guest}` } });
      assert.equal(response.status, 200); return response.json();
    };
    assert.equal(JSON.stringify(await guestSnapshot()).includes(PRIVATE), false);
    assert.equal(await guest.locator('[data-message-record-id="private-source"]').count(), 0);
    await openDirectConversation(page, "producer");
    const privateRow = page.locator('[data-message-record-id="private-source"]');
    await privateRow.waitFor({ state: "visible" });
    await privateRow.locator(".message-more > summary").click();
    for (const action of ["work", "decide"]) {
      assert.equal(await privateRow.locator(`[data-message-action="${action}"]`).count(), 0, `${action} cannot promote a private source`);
    }
    await privateRow.locator(".message-more > summary").click();
    // Defensive stale-action check, separate from the visible human journey:
    // an old/injected menu action must not bypass the central source guard.
    for (const action of ["work", "decide"]) {
      await privateRow.evaluate((row, action) => {
        const button = document.createElement("button");
        button.type = "button"; button.dataset.messageAction = action;
        button.dataset.messageId = row.dataset.messageRecordId;
        row.append(button); button.click(); button.remove();
      }, action);
      assert.equal(await page.locator("#work-dialog").isVisible(), false);
      assert.equal(await page.locator("#decision-dialog").isVisible(), false);
    }
    await page.locator("#message-input").fill(DRAFT);
    await page.locator("#new-work-button").click();
    await page.locator("#new-work-form").waitFor({ state: "visible" });
    await page.locator("#work-audience").waitFor({ state: "visible" });
    assert.equal((await page.locator("#work-audience").textContent()).trim(), "Visible to everyone in this room");
    assert.equal(await page.locator("#work-title-input").inputValue(), "");
    assert.equal(await page.locator("#source-message-id").inputValue(), "");
    if (process.env.ROOM_DESIGN_PRIVACY_DIR) {
      mkdirSync(process.env.ROOM_DESIGN_PRIVACY_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.ROOM_DESIGN_PRIVACY_DIR, `private-to-room-work-${label}.png`), fullPage: true });
    }
    await page.locator("#cancel-work-button").click();
    assert.equal(await page.locator("#message-input").inputValue(), DRAFT);
    await page.locator("#new-work-button").click();
    await page.locator("#work-title-input").fill(TITLE);
    await page.locator("#work-done-input").fill("The shared checklist is ready for review.");
    await page.locator("#assignee-select").selectOption("producer");
    await page.locator("#work-options > summary").click();
    await page.locator("#require-verification").uncheck();
    await page.locator("#require-decision").uncheck();
    await page.locator("#create-work-button").click();
    await page.locator("#new-work-form").waitFor({ state: "hidden" });
    const snapshot = await guestSnapshot();
    const work = Object.values(snapshot.state.workItems).find(item => item.title === TITLE);
    assert.ok(work, "third member receives deliberately authored room-wide work");
    assert.equal(work.sourceMessageId, null);
    assert.equal(JSON.stringify(snapshot).includes(PRIVATE), false);
    assert.equal(JSON.stringify(snapshot).includes(DRAFT), false);
    await openDirectConversation(page, "producer");
    assert.equal(await page.locator("#message-input").inputValue(), DRAFT, "creation and return preserve the private draft");
    await ensureSidebarOpen(page);
    await page.locator('#channel-list [data-channel="general"]').click();
    await ensureSidebarClosed(page);
    const publicRow = page.locator('[data-message-record-id="public-source"]');
    await publicRow.waitFor({ state: "visible" });
    await publicRow.locator(".message-more > summary").click();
    for (const action of ["work", "decide"]) assert.equal(await publicRow.locator(`[data-message-action="${action}"]`).isVisible(), true);
    await messageAction(page, "public-source", "work");
    await page.locator("#new-work-form").waitFor({ state: "visible" });
    assert.equal(await page.locator("#work-title-input").inputValue(), PUBLIC);
    assert.equal(await page.locator("#source-message-id").inputValue(), "public-source");
    assert.equal(await page.locator("#work-audience").isVisible(), true);
  });
}
