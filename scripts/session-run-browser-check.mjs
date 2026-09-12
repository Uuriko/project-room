import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { runLocalSession } from "../client/local-session-runner.mjs";

async function setup(t, viewport) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [];
  page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(8000);
  await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const item = () => f.store.room("commons").state.workItems["test-handoff"];
  const send = (type, data = {}) => f.store.command(f.keys.producer, "commons", { id: crypto.randomUUID(), type,
    data: { workItemId: "test-handoff", expectedRevision: item().revision, ...data } });
  const card = page.locator('[data-work-record-id="test-handoff"]');
  return { ...f, page, errors, item, send, card, origin };
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`run ${name}: explicit stop, lost confirmation retry and distinct terminal state`, async t => {
    const f = await setup(t, viewport), { page, card } = f;
    f.send("session.started");
    await card.getByText("Run in progress", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Request stop", exact: true }).click();
    const dialog = page.locator("#action-dialog");
    await dialog.getByText("Request run stop?", { exact: true }).waitFor();
    assert.match(await dialog.textContent(), /may still be running/);
    const requests = [];
    await page.route("**/api/rooms/commons/commands", async route => {
      const input = route.request().postDataJSON();
      if (input.type !== "session.stop_requested") return route.continue();
      requests.push(input); const response = await route.fetch();
      if (requests.length === 1) await route.abort("failed"); else await route.fulfill({ response });
    });
    await dialog.locator('button[type="submit"]').click();
    await dialog.getByRole("button", { name: "Retry original save" }).waitFor();
    await dialog.getByRole("button", { name: "Retry original save" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
    await card.getByText("Stop requested", { exact: true }).waitFor();
    assert.equal(await card.locator('[data-action="stop-run"]').count(), 0);
    assert.equal(f.item().status, "processing");
    mkdirSync("test-results", { recursive: true });
    await card.screenshot({ path: `test-results/session-run-${name}.png` });
    f.send("session.stopped", { status: "failed" });
    await card.getByText("Run failed", { exact: true }).waitFor();
    assert.equal(f.item().state, "proposed");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(f.errors, []);
  });
}

test("browser stop reaches the real local process controller", async t => {
  const f = await setup(t, { width: 1100, height: 850 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const run = runLocalSession({ client: new RoomAgentClient({ origin: f.origin, roomId: "commons", memberId: "producer", token: f.keys.producer }),
    roomId: "commons", memberId: "producer", workItemId: "test-handoff", runId: "browser-run", expectedRevision: f.item().revision,
    command: process.execPath, args: ["-e", "setInterval(()=>{},100)"], cwd: f.directory, maxRuntimeMs: 15000, pollMs: 50, signal: controller.signal });
  await f.card.getByRole("button", { name: "Request stop", exact: true }).click();
  await f.page.locator('#action-dialog button[type="submit"]').click();
  const result = await run;
  assert.equal(result.reason, "room_stop"); assert.equal(result.status, "failed");
  assert.equal(result.recording, "recorded");
  await f.card.getByText("Run failed", { exact: true }).waitFor();
  assert.equal(f.item().state, "proposed"); assert.deepEqual(f.errors, []);
});
