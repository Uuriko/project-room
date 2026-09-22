// Simulated human journeys in real browsers against isolated, synthetic rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { textVersion } from "../server/text-results.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";
import { makeTestSigner } from "./helpers/signed-evidence.mjs";

// F4: a resubmitted native result shows the reviewer the changed bytes against
// the exact previous version, and states that earlier approval never carries
// over. A first-version result shows no comparison.
test("result diff: resubmitted native results show changed bytes; first versions stay quiet", { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const signEvidence = makeTestSigner(f.store);
  const sendWithEvidence = (actor, type, data) => {
    if (type === T.WORK_COMPLETED && data.evidenceUrl && !data.signedEvidence) data = { ...data, signedEvidence: signEvidence() };
    return send(actor, type, data);
  };
  const item = id => f.store.room("commons").state.workItems[id];
  const completeWithText = (workItemId, body) => {
    const posted = send("producer", T.MESSAGE_POSTED, { messageId: randomUUID(), workItemId, body });
    return sendWithEvidence("producer", T.WORK_COMPLETED, { workItemId, expectedRevision: item(workItemId).revision,
      evidenceKind: "room_text", evidenceMessageId: posted.event.data.messageId, evidenceMessageEventId: posted.event.id,
      evidenceVersion: textVersion(body), previousCompletionEventId: item(workItemId).receipt?.eventId ?? null,
      producerId: "producer", summary: "An exact room result", nextAction: "Review the stored text" });
  };
  const lifecycle = workItemId => {
    send("producer", T.WORK_ACCEPTED, { workItemId, expectedRevision: item(workItemId).revision });
    send("producer", T.WORK_STARTED, { workItemId, expectedRevision: item(workItemId).revision });
  };
  // test-handoff: two versions, the second naming the first.
  lifecycle("test-handoff");
  completeWithText("test-handoff", "Result v1\nline two\nline three");
  send("producer", T.WORK_BLOCKED, { workItemId: "test-handoff", expectedRevision: item("test-handoff").revision, reason: "Reopened for rework", nextAction: "Resume" });
  send("producer", T.WORK_BLOCKER_RESOLVED, { workItemId: "test-handoff", expectedRevision: item("test-handoff").revision, resolution: "Reworked" });
  send("producer", T.WORK_STARTED, { workItemId: "test-handoff", expectedRevision: item("test-handoff").revision });
  completeWithText("test-handoff", "Result v2\nline two\nline three changed");
  // calm-result: a single first version.
  send("owner", T.WORK_PROPOSED, { workItemId: "calm-result", title: "Test: first-version result", definitionOfDone: "One result.", accountableMemberId: "producer", mode: "read" });
  lifecycle("calm-result");
  completeWithText("calm-result", "Only version\nof this result");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); await fillAccessKey(page, f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  // Resubmitted result: the comparison appears with the exact changed rows.
  await page.locator('[data-work-record-id="test-handoff"] [data-read-result]').click();
  await page.locator("#result-dialog").waitFor({ state: "visible" });
  await page.locator("#result-diff").waitFor({ state: "visible" });
  assert.match(await page.locator("#result-body").innerText(), /Result v2/);
  const diff = await page.locator("#result-diff").innerText();
  assert.match(diff, /Resubmitted result/);
  assert.match(diff, /2 lines removed, 2 added/);
  assert.match(diff, /never carries over/);
  assert.match(diff, /- Result v1/);
  assert.match(diff, /\+ Result v2/);
  assert.match(diff, /- line three/);
  assert.match(diff, /\+ line three changed/);
  await page.locator("#close-result").click();
  // First-version result: no comparison box.
  await page.locator('[data-work-record-id="calm-result"] [data-read-result]').click();
  await page.locator("#result-dialog").waitFor({ state: "visible" });
  await page.locator("#result-body").getByText(/Only version/).waitFor();
  assert.equal(await page.locator("#result-diff").isVisible(), false);
  await page.locator("#close-result").click();
  assert.deepEqual(errors, []);
});
