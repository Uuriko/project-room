// W4-51 L3: invite for a purpose. An inviter can point an invitation link at the
// question or result the guest is invited to help with; after joining, the room
// opens on that item. The purpose travels only in the URL fragment (never sent to
// the server), so nothing else in the private room is exported.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("invite for a purpose: link opens the invited work item after join", { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [];

  // 1. The inviter picks a purpose when creating the link.
  const inviterContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const inviter = await inviterContext.newPage();
  inviter.setDefaultTimeout(8000); inviter.on("pageerror", error => errors.push(error.message));
  await inviter.goto(origin);
  await inviter.locator("#access-key").fill(f.keys.owner);
  await inviter.getByRole("button", { name: "Enter room", exact: true }).click();
  await inviter.locator("#main").waitFor({ state: "visible" });
  await inviter.locator("#invite-people-button").click();
  const purpose = inviter.locator("#share-link-purpose");
  await purpose.waitFor();
  const options = await purpose.locator("option").allTextContents();
  assert.ok(options.some(text => text.includes("Test: prepare an agenda")), `purpose picker lists the open question, got: ${options.join(" | ")}`);
  await purpose.selectOption("test-handoff");
  await inviter.locator("#share-link-create").click();
  await inviter.locator("#share-link-result").waitFor({ state: "visible" });
  const url = await inviter.locator("#share-link-url").inputValue();
  assert.ok(url.endsWith("/work/test-handoff"), `link carries the purpose fragment: ${url}`);
  await inviter.locator("#share-purpose-note").waitFor({ state: "visible" });
  assert.match(await inviter.locator("#share-purpose-note").textContent(), /Test: prepare an agenda/);
  await inviterContext.close();

  // 2. The guest joins from that link and lands on the invited item.
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(8000); guest.on("pageerror", error => errors.push(error.message));
  await guest.goto(url);
  await guest.locator("#join-link-name").fill("Purposeful guest");
  await guest.locator("#join-link-submit").click();
  await guest.locator("#main").waitFor({ state: "visible" });
  const card = guest.locator('[data-work-record-id="test-handoff"]');
  await card.waitFor();
  assert.equal(await card.locator(".work-details").evaluate(el => el.open), true, "invited item is opened for the guest");
  assert.match(await guest.locator("#status").textContent(), /prepare an agenda/i);
  await guestContext.close();

  // 3. A stale purpose (item gone) never blocks the join: the room opens with a gentle note.
  const staleToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(f.keys.owner, "commons", { requestId: randomUUID(), linkToken: staleToken, expiresAt: Date.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0 }, null);
  const staleContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const stale = await staleContext.newPage();
  stale.setDefaultTimeout(8000); stale.on("pageerror", error => errors.push(error.message));
  await stale.goto(`${origin}/#join/${staleToken}/work/no-such-item`);
  await stale.locator("#join-link-name").fill("Stale guest");
  await stale.locator("#join-link-submit").click();
  await stale.locator("#main").waitFor({ state: "visible" });
  assert.match(await stale.locator("#status").textContent(), /no longer/i);
  assert.equal(await stale.locator('[data-work-record-id="test-handoff"] .work-details').evaluate(el => el.open), false, "no item force-opened for a stale purpose");
  await staleContext.close();

  // 4. A plain link (no purpose) still joins without opening any item.
  const plainContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const plain = await plainContext.newPage();
  plain.setDefaultTimeout(8000); plain.on("pageerror", error => errors.push(error.message));
  await plain.goto(`${origin}/#join/${f.links.valid}`);
  await plain.locator("#join-link-name").fill("Plain guest");
  await plain.locator("#join-link-submit").click();
  await plain.locator("#main").waitFor({ state: "visible" });
  assert.equal(await plain.locator('[data-work-record-id="test-handoff"] .work-details').evaluate(el => el.open), false, "plain link opens no item");
  await plainContext.close();

  assert.deepEqual(errors, [], "no page errors");
});
