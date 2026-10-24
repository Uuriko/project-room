// Composer reconciliation journeys: a send whose response is lost after
// the message landed must not leave the draft claiming an unconfirmed send
// ("Draft kept. Send again to retry.") above the posted message, and an
// edit typed over that stale error must never become a second instruction.
//
// 1. Lost response, unchanged draft: the message arrives via stream/refresh,
//    reconciliation clears the composer and shows the delivery line; the
//    room holds exactly one copy.
// 2. Lost response, edited draft (refresh held back so the edit lands first):
//    reconciliation keeps the edited text as a plain draft, detaches the
//    landed pending command, and drops the retry error; the room still
//    holds exactly one copy until a deliberate second send posts the edit
//    as a fresh message.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function waitForState(page, description, probe, { timeout = 30000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  if (await probe()) return;
  const state = await page.evaluate(() => ({
    input: document.querySelector("#message-input")?.value ?? null,
    status: document.querySelector("#composer-status")?.textContent ?? null,
    delivery: document.querySelector("#message-delivery")?.textContent ?? null,
  })).catch(() => null);
  throw new Error(`Timed out after ${timeout}ms waiting for ${description}. Composer state: ${JSON.stringify(state)}`);
}

async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], outside = [];
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  });
  await page.goto(origin);
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const input = page.locator("#message-input"), send = page.locator("#message-form button[type=submit]");
  const closeStreams = () => server.closeStreams();
  const posted = body => f.store.snapshot(f.keys.owner, "commons").state.messages.filter(message => message.body === body);
  // The first commands request commits server-side, then its response is
  // lost on the wire: the classic D1 choreography.
  const dropFirstSendResponse = async () => {
    let dropped = false;
    await page.route("**/commands", async route => {
      if (!dropped) { dropped = true; await route.fetch(); return route.abort("failed"); }
      return route.continue();
    });
  };
  return { page, input, send, posted, dropFirstSendResponse, closeStreams };
}

test("lost response, unchanged draft: refresh reconciles, composer clears, exactly one message lands", { timeout: 60000 }, async t => {
  const { page, input, send, posted, dropFirstSendResponse } = await setup(t);
  const body = "Deployment summary is ready for review.";
  await dropFirstSendResponse();
  await input.fill(body);
  await send.click();
  await waitForState(page, "the composer to clear once the landed message arrives", async () => (await input.inputValue()) === "");
  await waitForState(page, "the delivery line to replace the kept-draft error", async () => await page.locator("#message-delivery").isVisible());
  assert.match(await page.locator("#message-delivery").textContent(), /Message saved\./);
  assert.doesNotMatch(await page.locator("#composer-status").textContent(), /Draft kept/);
  assert.equal(posted(body).length, 1, "the room holds exactly one copy of the instruction");
});

test("lost response, edited draft: reconciliation detaches the landed send and keeps the edit as a plain draft", { timeout: 120000 }, async t => {
  const { page, input, send, posted, dropFirstSendResponse, closeStreams } = await setup(t);
  const original = "Deployment summary is ready for review.";
  const edited = "Edited: deployment summary is ready, and the rollback plan is attached.";
  // Hold every refresh channel back so the edit is typed while the client
  // still believes the send is unconfirmed — the D1 duplicate window. The
  // stream opened at sign-in is already live, so close it server-side:
  // reconnects and snapshot refreshes are what the held routes intercept.
  let hold = true;
  await page.route("**/stream**", route => hold ? route.abort() : route.continue());
  await page.route(/\/api\/rooms\/commons(\?.*)?$/, route => hold
    ? route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Synthetic refresh hold" } } })
    : route.continue());
  closeStreams();
  await dropFirstSendResponse();
  await input.fill(original);
  await send.click();
  await waitForState(page, "the kept-draft error after the lost response", async () =>
    (await page.locator("#composer-status").textContent()).includes("Draft kept"));
  await input.fill(edited);
  hold = false;
  await waitForState(page, "the delivery line once refresh lands the original message", async () =>
    await page.locator("#message-delivery").isVisible(), { timeout: 60000 });
  assert.equal(await input.inputValue(), edited, "the edited text survives as a plain draft");
  assert.doesNotMatch(await page.locator("#composer-status").textContent(), /Draft kept/,
    "the retry instruction is gone: the composer no longer claims the send failed");
  assert.equal(posted(original).length, 1, "the room holds exactly one copy of the original instruction");
  assert.equal(posted(edited).length, 0, "the edit was not posted as a duplicate");
  // A second, deliberate send now posts the edit as a fresh message.
  await send.click();
  await waitForState(page, "the deliberate follow-up to land", async () => posted(edited).length === 1);
  assert.equal(posted(original).length, 1);
});
