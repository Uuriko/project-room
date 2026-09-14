// Simulated human journey against disposable first-party data, not human research.
// Issue #6 D6: a redacted message renders "Message redacted" in the room, in reply
// previews and in the composer's reply label, offers no body-dependent actions,
// leaves the in-room search, and the text is gone from the JSONL and readable
// exports the same server serves. Redaction goes through the command surface
// (owner or author; the UI has no redact control, as it has no delete control).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t) {
  const f = createAcceptanceFixture({ managedProducer: false }), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(f.keys.owner); await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, []); });
  return { ...f, page, origin };
}

async function post(page, body) {
  await page.locator("#message-input").fill(body);
  await page.locator("#message-form button[type=submit]").click();
  await page.locator("#message-list .message-body", { hasText: body.slice(0, 40) }).first().waitFor({ state: "visible" });
}

test("a redacted message renders a tombstone, keeps its replies, leaves search, and the exports hold no copy", { timeout: 60000 }, async t => {
  const { page, store, keys, origin } = await setup(t);
  const secret = "peony wording to purge";
  await post(page, secret);
  // A reply enters the thread and keeps a visible .reply-preview of its parent.
  await page.locator("#message-list .message", { hasText: secret }).getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  await post(page, "reply that stays");
  await page.locator("#message-list .message", { hasText: "reply that stays" }).getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#reply-bar").waitFor({ state: "visible" });
  await post(page, "nested follow-up");
  await page.locator("#thread-back").click();
  await page.locator("#thread-bar").waitFor({ state: "hidden" });

  // Redact the parent through the command surface as its author (the owner here).
  const target = store.room("commons").state.messages.find(m => m.body === secret);
  assert.ok(target, "message in projection");
  const receipt = store.command(keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_REDACTED, data: { messageId: target.id } });
  assert.equal(receipt.duplicate, false);

  // The room shows the tombstone with no body-dependent actions; Reply stays.
  const redacted = page.locator("#message-list .message", { has: page.locator(".message-tombstone", { hasText: "Message redacted" }) });
  await redacted.waitFor({ state: "visible" });
  assert.equal(await redacted.locator(".message-tombstone").textContent(), "Message redacted");
  assert.equal(await redacted.locator(".message-tombstone").evaluate(node => getComputedStyle(node).fontStyle), "italic");
  for (const action of ["work", "decide", "result", "pin"])
    assert.equal(await redacted.locator(`[data-message-action="${action}"]`).count(), 0, `no ${action} action on a redacted message`);
  assert.equal(await redacted.getByRole("button", { name: "Reply", exact: true }).count(), 1, "reply stays available");
  assert.equal((await page.locator("#message-list").textContent()).includes(secret), false, "the text is gone from the room");

  // Opening its thread still works: the root is the tombstone, the replies keep their previews of live parents.
  await redacted.getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  await page.locator("#message-list .message-tombstone", { hasText: "Message redacted" }).first().waitFor({ state: "visible" });
  await page.locator("#message-list .message", { hasText: "nested follow-up" }).locator(".reply-preview", { hasText: "reply that stays" }).waitFor({ state: "visible" });
  assert.equal((await page.locator("#message-list").textContent()).includes(secret), false, "the thread view holds no copy either");
  await page.locator("#thread-back").click();
  await page.locator("#thread-bar").waitFor({ state: "hidden" });

  // Search never sees the purged wording; live messages still match.
  await page.locator("#message-search").fill("peony");
  await page.locator("#search-count", { hasText: "0 matches" }).waitFor({ state: "visible" });
  await page.locator("#message-search").fill("stays");
  await page.locator("#search-count", { hasText: "1 match" }).waitFor({ state: "visible" });

  // The same server's exports carry the redaction record and the tombstone, never the text.
  const jsonl = await (await fetch(`${origin}/api/rooms/commons/export`, { headers: { Authorization: `Bearer ${keys.owner}` } })).text();
  assert.equal(jsonl.includes(secret), false);
  const lines = jsonl.trim().split("\n").map(line => JSON.parse(line).event);
  assert.equal(lines.find(e => e.type === T.MESSAGE_POSTED && (e.data.messageId || e.id) === target.id).data.redacted.redactionId, receipt.event.id);
  const html = await (await fetch(`${origin}/api/rooms/commons/export?format=html`, { headers: { Authorization: `Bearer ${keys.owner}` } })).text();
  assert.ok(html.includes("Message redacted")); assert.equal(html.includes(secret), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM message_redactions").get().n, 1);
});
