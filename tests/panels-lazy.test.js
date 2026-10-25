// Closed details and closed dialogs stay in the document. The room and the
// browser checks address those fields while the dialog is closed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumAvailable, startLocalServer } from "../scripts/perf-budget.mjs";

async function sample(origin, { park }) {
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage();
  const requests = new Set();
  const errors = [];
  page.on("request", request => requests.add(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  if (!park) {
    const source = readFileSync(new URL("../src/entry.js", import.meta.url), "utf8").replace("\ninstallLazyPanels();\n", "\n");
    await page.route("**/src/entry.js", route => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: source }));
  }
  const started = Date.now();
  const response = await page.goto(`${origin}/`, { waitUntil: "load", timeout: 60000 });
  const loaded = await page.evaluate(() => {
    const doc = globalThis.document;
    return {
      nodes: doc.getElementsByTagName("*").length,
      textareas: doc.getElementsByTagName("textarea").length,
      forms: doc.getElementsByTagName("form").length,
      composer: doc.getElementById("message-input")?.isConnected === true,
      optionsPanel: doc.querySelector("#composer-options .composer-options-panel") !== null,
      later: doc.getElementById("later-count")?.isConnected === true,
      shareStatus: doc.querySelector("#share-link-status") !== null,
      workOptions: doc.getElementById("work-options")?.isConnected === true,
      returnBrief: doc.getElementById("return-brief-panel")?.isConnected === true,
      roomKind: doc.getElementById("room-kind-badge")?.isConnected === true,
      createBefore: doc.getElementById("account-room-create")?.childElementCount ?? 0
    };
  });
  const timeToComposerMs = Date.now() - started;
  const restored = await page.evaluate(() => {
    const doc = globalThis.document;
    const create = doc.getElementById("account-room-create");
    if (create && !create.open) create.open = true;
    const work = doc.getElementById("work-dialog");
    const workBefore = work?.childElementCount ?? 0;
    work?.showModal();
    const result = {
      createAfter: create?.childElementCount ?? 0,
      purpose: doc.getElementById("account-room-purpose")?.isConnected === true,
      workBefore,
      workAfter: work?.childElementCount ?? 0,
      workTitle: doc.getElementById("work-title-input")?.isConnected === true,
      settings: doc.getElementById("settings-dialog")?.childElementCount ?? 0
    };
    work?.close();
    return result;
  });
  const dom = { ...loaded, restored: { createBefore: loaded.createBefore, ...restored } };
  await browser.close();
  return { status: response?.status() ?? 0, requests: requests.size, timeToComposerMs, errors, ...dom };
}

test("closed dialog fields stay connected and the composer stays mounted", { timeout: 120000 }, async t => {
  if (!chromiumAvailable(chromium)) {
    t.skip("Chromium is not installed; panel mount measurement skipped");
    return;
  }
  const local = await startLocalServer();
  t.after(() => local.close());
  const before = await sample(local.origin, { park: false });
  const after = await sample(local.origin, { park: true });
  t.diagnostic(JSON.stringify({ before, after }));
  assert.equal(before.status, 200);
  assert.equal(after.status, 200);
  assert.deepEqual(before.errors, []);
  assert.deepEqual(after.errors, []);
  assert.equal(before.composer, true);
  assert.equal(after.composer, true);
  assert.equal(after.optionsPanel, true, "composer options stay addressable");
  assert.equal(after.later, true, "the Later count stays in the document");
  assert.equal(after.shareStatus, true, "a closed dialog field is still found by id");
  assert.equal(after.workOptions, true, "work options stay addressable while the dialog is closed");
  assert.equal(after.returnBrief, true, "catch-up stays addressable while the dialog is closed");
  assert.equal(after.roomKind, true, "the room kind stays addressable while the dialog is closed");
  assert.equal(after.textareas, before.textareas, `textareas ${after.textareas} vs ${before.textareas}`);
  assert.equal(after.forms, before.forms, `forms ${after.forms} vs ${before.forms}`);
  assert.equal(after.nodes, before.nodes, `nodes ${after.nodes} vs ${before.nodes}`);
  assert.ok(Math.abs(after.requests - before.requests) <= 12, `requests ${after.requests} vs ${before.requests}`);
  assert.ok(after.restored.createBefore > 1, "a closed details form stays mounted");
  assert.equal(after.restored.purpose, true);
  assert.equal(after.restored.workBefore, after.restored.workAfter);
  assert.ok(after.restored.workBefore >= 1, "the work dialog stays mounted while closed");
  assert.equal(after.restored.workTitle, true);
  assert.ok(after.restored.settings > 1, "settings stays mounted");
});
