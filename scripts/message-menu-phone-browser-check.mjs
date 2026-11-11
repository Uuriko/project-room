// Phone message menu (R41-1): the per-message "⋯" menu must open where every
// action can be tapped. #725 added `.message-more-up` (open upward near the
// composer) but nothing sets it, so on a phone the menu for the latest message
// opens downward under the Room assistant card and composer, and it pokes out
// past the left edge. Disposable rooms only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t, viewport, mobile, prepare = () => {}) {
  const f = createAcceptanceFixture({ managedProducer: false });
  prepare(f);
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => assert.deepEqual(errors, [], "no page errors"));
  return page;
}

async function post(page, body) {
  await page.locator("#message-input").fill(body);
  await page.locator("#message-form button[type=submit]").click();
  await page.locator("#message-list .message-body", { hasText: body }).first().waitFor({ state: "visible" });
}

// Every visible action in the open menu: on screen, and the element a tap at
// its centre would hit is the action itself (not the composer or a card).
async function blockedActions(page) {
  return page.evaluate(() => {
    const menu = document.querySelector("details.message-more[open] .message-more-menu");
    if (!menu) return ["no open menu"];
    return [...menu.querySelectorAll("button")].filter(b => b.getClientRects().length).flatMap(b => {
      const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, name = b.textContent.trim();
      if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) return [`${name}: off screen (${Math.round(r.left)},${Math.round(r.top)})`];
      const hit = document.elementFromPoint(x, y);
      return hit === b || b.contains(hit) ? [] : [`${name}: covered by ${hit?.id || hit?.className || hit?.tagName}`];
    });
  });
}

for (const [label, viewport, mobile] of [["phone 390", { width: 390, height: 844 }, true], ["desktop 1440", { width: 1440, height: 900 }, false]]) {
  test(`latest message's ⋯ menu is fully tappable (${label})`, { timeout: 60000 }, async t => {
    const page = await setup(t, viewport, mobile);
    for (const body of ["first note", "second note", "latest note"]) await post(page, body);
    const latest = page.locator("#message-list .message", { hasText: "latest note" }).last();
    await latest.locator("summary[aria-label^='More actions']").click();
    await page.locator("details.message-more[open] .message-more-menu").waitFor({ state: "visible" });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100))); // the details "toggle" event is async
    assert.deepEqual(await blockedActions(page), [], "every action in the menu can be tapped");
    // The menu still works: Save from it toggles the message's saved state.
    await page.locator("details.message-more[open] [data-message-action='save']").click();
    await page.locator("#message-list .message", { hasText: "latest note" }).last().locator("[data-message-action='save'][aria-pressed='true']").waitFor({ state: "attached" });
  });
}

// R60-1: your own message's menu now carries Edit and Delete (#2797), so on a
// phone it is taller than the room above or below a message in the middle of
// the timeline. It must still open with every action tappable (Edit and Delete
// are last, so they were the ones hidden under the composer).
test("own mid-timeline message's ⋯ menu is fully tappable (phone 390)", { timeout: 60000 }, async t => {
  const page = await setup(t, { width: 390, height: 844 }, true);
  for (let i = 1; i <= 10; i++) await post(page, `note ${i}`);
  const target = page.locator("#message-list .message", { hasText: "note 6" }).last();
  await page.evaluate(() => {
    const timeline = document.querySelector(".timeline"), rows = [...document.querySelectorAll("#message-list .message")];
    const row = rows.find(r => r.textContent.includes("note 6")), tl = timeline.getBoundingClientRect();
    timeline.scrollTop += row.getBoundingClientRect().top - tl.top - tl.height / 2 + 20;
  });
  await target.locator("summary[aria-label^='More actions']").click();
  await page.locator("details.message-more[open] .message-more-menu").waitFor({ state: "visible" });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
  assert.ok(await page.locator("details.message-more[open] [data-message-action='delete']").count(), "own message offers Delete");
  assert.deepEqual(await blockedActions(page), [], "every action in the menu can be tapped");
});


test('message action names identify author and second while retaining keyboard menu behavior', { timeout: 60000 }, async t => {
  const page = await setup(t, { width: 1440, height: 900 }, false, f => {
    const clock = f.store.now;
    const base = Math.floor(Date.now() / 60000) * 60000;
    for (const [index, body] of ['First named message', 'Second named message'].entries()) {
      f.store.now = () => base + (index + 1) * 1000;
      f.store.command(f.keys.owner, 'commons', { id: `named-cmd-${index}`, type: 'message.posted', data: { messageId: `named-${index}`, body } });
    }
    f.store.now = clock;
  });
  const labels = [];
  for (const index of [0, 1]) {
    const row = page.locator(`[data-message-record-id="named-${index}"]`);
    await row.waitFor({ state: 'visible' });
    const label = await row.locator('.message-more summary').getAttribute('aria-label');
    const author = await row.locator('.message-meta strong').textContent();
    assert.ok(label.includes(author)); assert.ok(label.startsWith('More actions'));
    labels.push(label);
  }
  assert.notEqual(labels[0], labels[1], 'same author within a minute remains distinguishable');
  const menu = page.locator('[data-message-record-id="named-1"] .message-more summary');
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-message-record-id="named-1"] .message-more summary' });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  assert.equal(nodes[0].name.value, labels[1]);
  assert.equal(nodes[0].ignored, false);
  assert.equal(await menu.count(), 1);
  await menu.focus(); await page.keyboard.press('Enter');
  await page.locator('[data-message-record-id="named-1"] .message-more-menu').waitFor({ state: 'visible' });
  await page.locator('[data-message-record-id="named-1"] [data-message-action="save"]').click();
  await page.locator('[data-message-record-id="named-1"] [data-message-action="save"][aria-pressed="true"]').waitFor({ state: 'attached' });
});


test('item action names preserve visible verbs and escape hostile titles in browser DOM', { timeout: 60000 }, async t => {
  const page = await setup(t, { width: 1440, height: 900 }, false);
  const title = 'Repair "door" <img src=x onerror="window.injected=true"> & roof';
  await page.evaluate(async title => {
    const { boardHtml } = await import('/src/board-ui.js');
    const item = { id: 'name-test', title, state: 'unclaimed', owner: null, kind: 'task', files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [] };
    const container = document.createElement('section'); container.id = 'accessible-name-fixture';
    container.innerHTML = boardHtml([item], null, { id: 'viewer', manage: false, owner: false, write: true }, { viewer: { id: 'viewer', kind: 'human', active: true, permissions: ['accept_work'] } }, Date.now(), {});
    document.body.append(container);
  }, title);
  const fixture = page.locator('#accessible-name-fixture');
  const claim = fixture.getByRole('button', { name: `Claim — ${title}`, exact: true });
  assert.equal(await claim.count(), 1);
  assert.equal((await claim.textContent()).trim(), 'Claim');
  assert.equal(await fixture.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
});
