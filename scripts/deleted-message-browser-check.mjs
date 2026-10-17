// Deleted-message rendering (wave finding fix): message.deleted tombstones the
// projection (body=null, deletedAt). Rendering must honor the tombstone - no
// null-body crashes in reply previews, search, request or decision labels, and
// no body-dependent actions on a deleted message. The work-card drafts list is
// covered too: a deleted proposal draft must not count toward "Drafts (n)",
// must not be excerpted, and must never make the room unopenable
// (bug sweep 2026-10-16, CLIENT-CORE Finding 1). Disposable rooms only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { commitMessageRedaction } from "../server/message-redaction.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSearch } from "./room-chrome.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, seedRoom, { pageTimeoutMs = 30000 } = {}) {
  const f = createAcceptanceFixture({ managedProducer: false });
  if (seedRoom) seedRoom(f);
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(pageTimeoutMs); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, []); });
  return { ...f, page };
}

async function post(page, body) {
  await page.locator("#message-input").fill(body);
  await page.locator("#message-form button[type=submit]").click();
  await page.locator("#message-list .message-body", { hasText: body.slice(0, 40) }).first().waitFor({ state: "visible" });
}

test("deleted messages render a tombstone, never crash, and leave search", { timeout: 120000 }, async t => {
  const { page, store, keys } = await setup(t);

  await post(page, "orchids parent note");
  // Reply enters the thread; the composer targets the thread root implicitly.
  await page.locator("#message-list .message", { hasText: "orchids parent note" }).getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  await post(page, "reply about dahlias");
  // A nested reply keeps a visible .reply-preview of its parent inside the thread.
  await page.locator("#message-list .message", { hasText: "reply about dahlias" }).getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#reply-bar").waitFor({ state: "visible" });
  await post(page, "cactus follow-up");

  // Delete the middle message through the command surface (agents/API can delete; the UI cannot).
  const target = store.room("commons").state.messages.find(m => m.body === "reply about dahlias");
  assert.ok(target, "reply message in projection");
  store.command(keys.owner, "commons", { id: randomUUID(), type: "message.deleted",
    data: { messageId: target.id, expectedMessageRevision: target.revision ?? 0, reason: "cleanup" } });

  // The deleted message renders a tombstone with no body-dependent actions.
  const deleted = page.locator("#message-list .message", { has: page.locator(".message-tombstone") });
  await deleted.waitFor({ state: "visible" });
  assert.equal(await deleted.locator(".message-tombstone").textContent(), "Message deleted");
  assert.equal(await deleted.locator(".message-tombstone").evaluate(node => getComputedStyle(node).fontStyle), "italic");
  for (const action of ["work", "decide", "result"])
    assert.equal(await deleted.locator(`[data-message-action="${action}"]`).count(), 0, `no ${action} action on a deleted message`);
  assert.equal(await deleted.getByRole("button", { name: "Reply", exact: true }).count(), 1, "reply stays available");

  // The nested reply's preview names the tombstone instead of slicing a null body.
  const followup = page.locator("#message-list .message", { hasText: "cactus follow-up" });
  await followup.locator(".reply-preview", { hasText: "Message deleted" }).waitFor({ state: "visible" });

  // Replying to the deleted message labels the target without slicing its body.
  await deleted.getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#reply-bar").waitFor({ state: "visible" });
  assert.ok((await page.locator("#reply-context").textContent()).includes("Message deleted"));

  // Back in the room, search no longer touches deleted bodies and still finds live messages.
  await page.locator("#thread-back").click();
  await page.locator("#thread-bar").waitFor({ state: "hidden" });
  await openSearch(page);
  await page.locator("#message-search").fill("dahlias");
  await page.locator("#search-count", { hasText: "0 matches" }).waitFor({ state: "visible" });
  await page.locator("#message-search").fill("cactus");
  await page.locator("#search-count", { hasText: "1 match" }).waitFor({ state: "visible" });
  await page.locator("#message-search").fill("orchids");
  await page.locator("#search-count", { hasText: "1 match" }).waitFor({ state: "visible" });
});

// Seed one work item plus its proposal drafts (the agent handoff flow:
// messages posted with workItemId + packetId at the item's basis revision).
function seedDraftWork(store, keys, { workId, title, author, drafts }) {
  const cmd = (key, type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  cmd(keys.owner, T.WORK_PROPOSED, { workItemId: workId, title,
    definitionOfDone: "Room opens with the live drafts listed", accountableMemberId: "owner", mode: "read" });
  const { revision } = store.room("commons").state.workItems[workId];
  const packetId = randomUUID();
  for (const [id, body] of drafts)
    cmd(keys[author], T.MESSAGE_POSTED, { messageId: id, body, workItemId: workId, packetId, basisRevision: revision });
}

function deleteDraft(store, key, messageId) {
  const target = store.room("commons").state.messages.find(m => m.id === messageId);
  assert.ok(target, `draft ${messageId} in projection`);
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED,
    data: { messageId: target.id, expectedMessageRevision: target.revision ?? 0, reason: "superseded" } });
}

// Sign-in (inside setup) only reaches #main if the first snapshot renders;
// a poisoned work card used to throw during that render and bounce the user
// back to the sign-in panel for good. Reaching these assertions at all is
// the room-opens proof; the rest pins exactly which drafts the card shows.
async function assertDraftCard(page, workId, { live, deletedBody }) {
  const card = page.locator(`#message-list .work-card[data-work-record-id="${workId}"]`);
  await card.waitFor({ state: "visible" });
  // Only the live drafts count toward "Drafts (n)" and are excerpted; the
  // deleted draft is neither counted nor linked from the card.
  await card.locator(".work-drafts summary", { hasText: `Drafts (${live.length})` }).waitFor({ state: "visible" });
  const linked = await card.locator(".work-drafts [data-open-message]").evaluateAll(
    nodes => nodes.map(node => node.getAttribute("data-open-message")).sort());
  assert.deepEqual(linked, live.map(([id]) => id).sort());
  const draftsText = await card.locator(".work-drafts").textContent();
  for (const [, body] of live) assert.ok(draftsText.includes(body), `live draft excerpt renders: ${body}`);
  assert.ok(!draftsText.includes(deletedBody), "deleted draft is not excerpted");
}

// Page budget is 30s file-wide (setup default): sign-in + first render walks
// the full module graph, and on a loaded VM that measures just over the old
// 8s locator default for every test in this file. The failures this file
// guards against NEVER render (pre-fix, #main stays hidden past 30s and the
// auth panel returns), so the wider window still separates "renders slowly"
// from "can never render".
const DRAFT_TEST = { timeout: 120000 };

test("a deleted proposal draft does not poison the work card or lock the room", DRAFT_TEST, async t => {
  const drafts = [["check-draft-1", "alpha draft proposal text"],
    ["check-draft-2", "bravo draft proposal text"], ["check-draft-3", "charlie draft proposal text"]];
  const { page } = await setup(t, ({ store, keys }) => {
    seedDraftWork(store, keys, { workId: "w-draft-check", title: "Draft deletion check", author: "owner", drafts });
    // The author deletes one of three drafts through the command surface
    // (agents/API can delete; the UI cannot).
    deleteDraft(store, keys.owner, "check-draft-1");
  });
  await assertDraftCard(page, "w-draft-check", { live: drafts.slice(1), deletedBody: "alpha draft proposal text" });
});

test("an owner deleting another member's draft does not poison the work card", DRAFT_TEST, async t => {
  const drafts = [["own-draft-1", "delta draft proposal text"],
    ["own-draft-2", "echo draft proposal text"], ["own-draft-3", "foxtrot draft proposal text"]];
  const { page } = await setup(t, ({ store, keys }) => {
    seedDraftWork(store, keys, { workId: "w-draft-owner", title: "Owner draft deletion check", author: "producer", drafts });
    // The room owner (not the author) deletes the producer's first draft.
    deleteDraft(store, keys.owner, "own-draft-1");
  });
  await assertDraftCard(page, "w-draft-owner", { live: drafts.slice(1), deletedBody: "delta draft proposal text" });
});

test("a draft redacted by the account-deletion machinery does not poison the work card", DRAFT_TEST, async t => {
  const drafts = [["redact-draft-1", "golf draft proposal text"],
    ["redact-draft-2", "hotel draft proposal text"], ["redact-draft-3", "india draft proposal text"]];
  const { page } = await setup(t, f => {
    seedDraftWork(f.store, f.keys, { workId: "w-draft-redact", title: "Redacted draft check", author: "producer", drafts });
    // Account deletion redacts the author's messages by calling
    // commitMessageRedaction per message (server/account-deletion.mjs), not
    // through a message.deleted command. Apply it exactly as the deletion
    // executor does, then cold-reopen the store so the served state is
    // rebuilt by replaying the rewritten log.
    commitMessageRedaction(f.store.db, { roomId: "commons", state: f.store.room("commons").state,
      actorId: "producer", at: new Date().toISOString(), messageId: "redact-draft-1", bodiesAtRest: f.store.bodiesAtRest });
    f.store.close();
    f.store = new RoomStore(join(f.directory, "room.sqlite"));
  });
  await assertDraftCard(page, "w-draft-redact", { live: drafts.slice(1), deletedBody: "golf draft proposal text" });
});

test("deleting a work item's only draft is safe (control)", DRAFT_TEST, async t => {
  const { page } = await setup(t, ({ store, keys }) => {
    seedDraftWork(store, keys, { workId: "w-draft-solo", title: "Only draft deletion check", author: "producer",
      drafts: [["solo-draft-1", "juliett draft proposal text"]] });
    // The author deletes the work item's ONLY draft. The Drafts branch needs
    // two or more collected drafts, so this never poisoned the card; the fix
    // must keep the card (and the room) working with zero live drafts.
    deleteDraft(store, keys.producer, "solo-draft-1");
  });
  const card = page.locator("#message-list .work-card[data-work-record-id=\"w-draft-solo\"]");
  await card.waitFor({ state: "visible" });
  assert.equal(await card.locator(".work-drafts").count(), 0, "no Drafts section when no live drafts remain");
  assert.ok(!(await card.textContent()).includes("juliett draft proposal text"), "deleted draft is not excerpted");
});
