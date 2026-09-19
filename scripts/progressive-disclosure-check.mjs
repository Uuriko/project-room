// Consistent progressive disclosure (backlog C7): in-room section disclosures
// share one summary anatomy (chevron, label, trailing chip/note), hit target,
// focus ring - and toggling never moves focus. Disposable rooms only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { fillAccessKey } from "./auth-signin.mjs";
import { openCatchUp, openSettings } from "./room-chrome.mjs";

// In-room section disclosures that still use the shared .section-summary anatomy.
// People is sidebar chrome (`sidebar-label`), not a section summary.
const SHARED = ["#composer-options", "#record-panel", "#decision-section"];

async function setup(t, { mobile = false } = {}) {
  const f = createAcceptanceFixture({ managedProducer: false }), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, f.keys.owner); await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page };
}

test("section summaries share one anatomy: chevron, label, flex row, 44px target", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  for (const id of SHARED) {
    const summary = page.locator(`${id} > summary`);
    await summary.waitFor({ state: "attached" });
    const info = await summary.evaluate(node => {
      const cs = getComputedStyle(node);
      const before = getComputedStyle(node, "::before");
      const label = node.querySelector(".section-label strong");
      return { hasClass: node.classList.contains("section-summary"), display: cs.display,
        minHeight: parseFloat(cs.minHeight), marker: cs.listStyleType,
        chevron: before.content !== "none" && before.borderRightWidth === "2px",
        label: label?.textContent || null, labelFirst: node.firstElementChild === node.querySelector(".section-label") };
    });
    assert.equal(info.hasClass, true, `${id} summary carries .section-summary`);
    assert.equal(info.display, "flex", `${id} summary is a flex row`);
    assert.ok(info.minHeight >= 44, `${id} summary hit target >= 44px`);
    assert.equal(info.marker, "none", `${id} native marker hidden (shared chevron instead)`);
    assert.equal(info.chevron, true, `${id} shows the shared chevron`);
    assert.ok(info.label && info.labelFirst, `${id} label leads the summary`);
  }
  // Live work-options copy is written onto the summary; the shared class stays.
  const work = await page.locator("#work-options > summary").evaluate(node => ({
    hasClass: node.classList.contains("section-summary"),
    label: (node.querySelector(".section-label strong")?.textContent || node.textContent || "").trim() }));
  assert.equal(work.hasClass, true);
  assert.match(work.label, /Review \+ approval|Options|read only/);
});

test("chevron direction reflects open state identically across sections", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  for (const id of SHARED) {
    if (id !== "#composer-options") await openSettings(page, "record-panel");
    const summary = page.locator(`${id} > summary`);
    await summary.evaluate(node => { node.parentElement.open = false; });
    const closedTransform = await summary.evaluate(node => getComputedStyle(node, "::before").transform);
    await summary.evaluate(node => { node.parentElement.open = true; });
    const openTransform = await summary.evaluate(node => getComputedStyle(node, "::before").transform);
    assert.notEqual(openTransform, closedTransform, `${id} chevron rotates on open`);
    await summary.evaluate(node => { node.parentElement.open = false; });
    if (id !== "#composer-options" && await page.locator("#settings-dialog").evaluate(node => node.open)) {
      await page.locator("#settings-close").click();
    }
  }
});

test("keyboard toggling never moves focus off the summary", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  for (const id of ["#composer-options", "#record-panel"]) {
    if (id === "#record-panel") await openSettings(page, "record-panel");
    const summary = page.locator(`${id} > summary`);
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    const wasOpen = await summary.evaluate(node => node.parentElement.open);
    await page.keyboard.press("Enter");
    await page.waitForFunction(([sel, expected]) => document.querySelector(sel).open === expected, [id, !wasOpen]);
    assert.equal(await summary.evaluate(node => document.activeElement === node), true, `${id} keeps focus after Enter`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(([sel, expected]) => document.querySelector(sel).open === expected, [id, wasOpen]);
    assert.equal(await summary.evaluate(node => document.activeElement === node), true, `${id} keeps focus after second Enter`);
  }
});

test("trailing chips align to the summary's right edge", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  await openSettings(page, "record-panel");
  for (const [id, chip] of [["#record-panel", "#event-count"], ["#decision-section", "#decision-count"]]) {
    if (id === "#decision-section") await page.locator("#record-panel").evaluate(node => { node.open = true; });
    const [sum, ch] = await Promise.all([
      page.locator(`${id} > summary`).boundingBox(), page.locator(chip).boundingBox()]);
    assert.ok(sum && ch, `${id} summary and chip render`);
    assert.ok(Math.abs(sum.x + sum.width - (ch.x + ch.width)) < 24, `${id} chip sits at the right edge`);
  }
  await page.locator("#settings-close").click();
  await openCatchUp(page);
  await page.locator("#return-brief-panel").evaluate(node => { node.open = true; });
  const [sum, ch] = await Promise.all([
    page.locator("#rb-history-section > summary").boundingBox(), page.locator("#rb-history-count").boundingBox()]);
  assert.ok(sum && ch, "#rb-history-section summary and chip render");
  assert.ok(Math.abs(sum.x + sum.width - (ch.x + ch.width)) < 24, "#rb-history-section chip sits at the right edge");
});

test("the same anatomy holds on mobile", { timeout: 30000 }, async t => {
  const { page } = await setup(t, { mobile: true });
  for (const id of ["#composer-options", "#record-panel"]) {
    const info = await page.locator(`${id} > summary`).evaluate(node => {
      const cs = getComputedStyle(node);
      return { display: cs.display, minHeight: parseFloat(cs.minHeight), chevron: getComputedStyle(node, "::before").content !== "none" };
    });
    assert.deepEqual(info, { display: "flex", minHeight: 44, chevron: true }, `${id} mobile anatomy`);
  }
});
