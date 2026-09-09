// Simulated human tasks against isolated synthetic data; no real user research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`private reminders ${label}: schedule, due clock, privacy, recovery after resolution, keyboard and reflow`, { timeout: 90000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser, at = Date.now(); f.store.now = () => at;
    t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    const errors = [], external = [], writes = [];
    await context.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/reminders")) writes.push(request.postDataJSON()); });
    await page.clock.install({ time: at });
    await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner); await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const card = page.locator('[data-work-record-id="test-handoff"]');
    const open = async () => {
      if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
      await card.getByRole("button", { name: "Remind me", exact: true }).click();
      await page.locator('#reminder-form[aria-busy="false"]').waitFor();
    };
    const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/reminders-${label}-${name}.png` }); };
    const snapshot = () => f.store.snapshot(f.keys.owner, "commons"), initial = snapshot();
    assert.equal(await card.getByRole("button", { name: "Remind me", exact: true }).isVisible(), false);
    assert.equal(await page.locator("#reminder-panel").isVisible(), false);
    await open();
    await page.locator("#reminder-choice").selectOption("custom");
    const dueAt = Math.ceil((at + 120000) / 60000) * 60000;
    const local = await page.evaluate(value => { const d = new Date(value), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }, dueAt);
    await page.locator("#reminder-custom").fill(local);
    assert.match(await page.locator("#reminder-preview").textContent(), /UTC[+−]\d{2}:\d{2}/);
    await capture("schedule");
    await page.locator("#reminder-save").click(); await page.locator("#reminder-dialog").waitFor({ state: "hidden" });
    assert.equal(f.store.reminders.list(f.keys.owner, "commons").reminders[0].dueAt, dueAt);
    assert.equal(f.store.reminders.list(f.keys.guest, "commons").reminders.length, 0);
    assert.deepEqual(snapshot(), initial);
    await page.locator("#return-brief-panel > summary").click();
    await page.locator("#reminder-scheduled").waitFor({ state: "visible" });
    assert.equal(await page.locator("#reminder-scheduled").evaluate(node => node.open), false);
    await page.reload(); await page.locator("#main").waitFor({ state: "visible" });
    if (!await page.locator("#return-brief-panel").evaluate(node => node.open)) await page.locator("#return-brief-panel > summary").click();
    await page.locator("#reminder-scheduled").waitFor({ state: "visible" });
    at = dueAt + 1000; await page.clock.fastForward(240000);
    await page.locator("#reminder-due li").waitFor();
    await page.locator("#reminder-due li").scrollIntoViewIfNeeded();
    await capture("due");
    assert.deepEqual(snapshot(), initial, "time passing and catch-up viewing never acknowledge or change work");

    // Rescheduling stores the instant shown before a ten-minute pause.
    await open(); const shown = await page.locator("#reminder-preview").textContent(), beforePause = at;
    at += 600000; await page.clock.fastForward(600000);
    let drop = true;
    await page.route("**/api/rooms/commons/reminders", async route => {
      if (route.request().method() === "POST" && drop) { drop = false; await route.fetch(); await route.abort("failed"); }
      else await route.continue();
    });
    await page.locator("#reminder-save").click();
    await page.getByText("Save not confirmed. Retry the same request.", { exact: true }).waitFor();
    const attempt = writes.at(-1);
    assert.ok(Math.abs(attempt.dueAt - (beforePause + 3600000)) < 10000, "the displayed instant did not drift with Save time");
    assert.equal(await page.locator("#reminder-preview").textContent(), shown);
    assert.equal(await page.locator("#reminder-choice").isDisabled(), true);
    await page.locator("#reminder-close").click();
    const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type, data });
    send(T.WORK_PROPOSED, { workItemId: "replacement", title: "Replacement plan", definitionOfDone: "A revised agenda", accountableMemberId: "owner", mode: "read" });
    send(T.WORK_SUPERSEDED, { workItemId: "test-handoff", expectedRevision: 0, supersededByWorkItemId: "replacement", reason: "Replanned" });
    await page.locator("#refresh-button").click();
    await page.locator("#reminder-pending button").click();
    await page.locator('#reminder-form[aria-busy="false"]').waitFor();
    await capture("retry");
    await page.locator("#reminder-save").click(); await page.locator("#reminder-dialog").waitFor({ state: "hidden" });
    assert.deepEqual(writes.at(-1), attempt);
    assert.equal(f.store.reminders.list(f.keys.owner, "commons").reminders[0].state, "resolved");
    assert.equal(await page.locator("#reminder-pending li").count(), 0);
    assert.equal(await page.locator("#return-brief-panel > summary").evaluate(node => node === document.activeElement), true, "removed opener falls back to catch-up");

    // With no local active reminder/timer, opening catch-up still finds another device's save.
    if (await page.locator("#return-brief-panel").evaluate(node => node.open)) await page.locator("#return-brief-panel > summary").click();
    const elsewhere = { requestId: randomUUID(), workItemId: "replacement", expectedRevision: 0, action: "schedule", dueAt: at + 3600000 };
    f.store.reminders.mutate(f.keys.owner, "commons", elsewhere);
    await page.locator("#return-brief-panel > summary").click();
    await page.locator("#reminder-scheduled").waitFor({ state: "visible" }); await page.locator("#reminder-scheduled > summary").click();
    await page.locator("#reminder-upcoming button").click(); await page.locator('#reminder-form[aria-busy="false"]').waitFor();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    await page.locator("#reminder-cancel").scrollIntoViewIfNeeded(); await capture("large-text");
    await page.locator("#reminder-cancel").click(); await page.locator("#reminder-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#return-brief-panel > summary").evaluate(node => node === document.activeElement), true);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.locator("#signout-button").click(); await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#reminder-due").textContent(), ""); assert.equal(await page.locator("#reminder-upcoming").textContent(), "");
    assert.equal(await page.locator("#reminder-work-title").textContent(), ""); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
}
