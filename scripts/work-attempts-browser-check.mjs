// Simulated human journeys against disposable first-party data, not human research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";

async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  return { ...f, page, errors, send };
}

test("attempt ledger: a work card shows attributable attempts with environment and outcome", { timeout: 60000 }, async t => {
  const f = await setup(t), { page, send } = f;
  send(T.WORK_PROPOSED, { workItemId: "attempted-work", title: "Port the digest job", definitionOfDone: "Digest runs green in CI.", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
  const revision = () => f.store.snapshot(f.keys.owner, "commons").state.workItems["attempted-work"].revision;
  send(T.SESSION_STARTED, { workItemId: "attempted-work", expectedRevision: revision(), environment: "ci-runner-2" });
  send(T.SESSION_STOPPED, { workItemId: "attempted-work", expectedRevision: revision(), status: "failed", outputs: ["log:run-1"] });
  send(T.SESSION_STARTED, { workItemId: "attempted-work", expectedRevision: revision(), environment: "local-mac-1" });
  const card = page.locator('[data-work-record-id="attempted-work"]');
  await card.waitFor();
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  const ledger = card.locator("[data-attempt-ledger]");
  await ledger.waitFor();
  const text = await ledger.textContent();
  assert.match(text, /#1 .+ · failed · ci-runner-2/);
  assert.match(text, /#2 .+ · running · local-mac-1/);
  // An untouched card renders no ledger line.
  const plain = page.locator('[data-work-record-id="test-handoff"]');
  if (!await plain.locator(".work-details").evaluate(node => node.open)) await plain.locator(".work-details > summary").click();
  assert.equal(await plain.locator("[data-attempt-ledger]").count(), 0);
  mkdirSync("test-results", { recursive: true });
  await card.screenshot({ path: "test-results/attempts-card.png" });
  assert.deepEqual(f.errors, []);
});
