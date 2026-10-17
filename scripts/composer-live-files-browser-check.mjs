// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
// Pins two composer fixes from muse-room QA: another member's file chips
// appear live (12650), and the composer grows with its text (12680).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";

test("composer: live file chips for other members, autosize", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-live-files-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] } });
  const maya = store.issueAccessKey("commons", "maya");
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  const open = async key => {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, key);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  const ownerPage = await open(owner), mayaPage = await open(maya);
  const input = ownerPage.locator("#message-input");

  // 12680: eight pasted lines grow the composer instead of hiding six of them.
  const before = await input.evaluate(el => el.getBoundingClientRect().height);
  await input.fill(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));
  const grown = await input.evaluate(el => ({ height: el.getBoundingClientRect().height, hidden: el.scrollHeight - el.clientHeight }));
  assert.ok(grown.height > before + 40, `composer grows with its text (${before} -> ${grown.height})`);
  await input.fill("");
  assert.ok(await input.evaluate(el => el.getBoundingClientRect().height) <= before + 1, "an empty composer shrinks back");

  // 12650: Maya sees the owner's file chip without reloading.
  await ownerPage.locator("#composer-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await ownerPage.locator(".composer-files .file-chip, #composer-files .file-chip").first().waitFor({ state: "visible" }).catch(() => {});
  await ownerPage.waitForFunction(() => !document.querySelector("[aria-busy='true']#message-form"), null, { timeout: 5000 }).catch(() => {});
  await input.fill("with a file");
  await ownerPage.locator('#message-form button[type="submit"]').click();
  await mayaPage.locator('#message-list [data-download-file]', { hasText: "notes.txt" }).waitFor({ state: "visible", timeout: 10000 });

  // A blocked file type reads as plain copy.
  await ownerPage.locator("#composer-file").setInputFiles({ name: "tool.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await ownerPage.waitForFunction(() => /isn’t allowed/.test(document.querySelector("#composer-status")?.textContent || ""), null, { timeout: 5000 });
  assert.doesNotMatch(await ownerPage.locator("#composer-status").innerText(), /blocked for security/);
  assert.deepEqual(errors, []);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function uploadFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-upload-owner-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const account = store.createAccount("upload-owner");
  store.completeOnboarding(account.id);
  const key = store.issueAccountAccessKey(account.id);
  const slot = store.createAccountSessionSlot();
  const auth = store.loginAccountSession(slot.token, key, 0);
  for (const roomId of ["room-a", "room-b"]) {
    store.createAccountRoom(slot.token, auth.sessionBinding, {
      roomId, title: roomId, purpose: "Synthetic upload ownership", kind: "personal", displayName: "Upload owner"
    });
  }
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/?account=1`);
  await signInFixture(page, key, { returnTo: `${origin}/?room=room-a` });
  await page.locator("#main").waitFor({ state: "visible" });
  const requests = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/files$/.test(new URL(request.url()).pathname)) {
      requests.push({ path: new URL(request.url()).pathname, ...request.postDataJSON() });
    }
  });
  const rows = () => store.db.prepare("SELECT room_id, filename, state, message_id FROM room_attachments ORDER BY created_at, id").all();
  const switchRoom = async () => {
    await clickChrome(page, "#choose-room");
    await page.locator('[data-account-room="room-b"]').click();
    await page.waitForFunction(() => document.querySelector("#room-title")?.textContent === "room-b");
  };
  return { page, store, origin, account, key, requests, rows, switchRoom, errors };
}

const uploadFile = name => ({ name, mimeType: "text/plain", buffer: Buffer.from(`Synthetic ${name}`) });
// Yield across paint after a held response: its JSON/async continuations run
// before the assertions. Each case also completes a fresh upload as a control.
const settleUpload = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function freshUpload(page) {
  await page.locator("#composer-file").setInputFiles(uploadFile("current.txt"));
  await page.waitForFunction(() => [...document.querySelectorAll("#composer-attachments .file-chip")]
    .some(node => node.textContent === "current.txt×"));
}

for (const lateFailure of [false, true]) {
  test(`composer uploads: room switch fences a batch after late ${lateFailure ? "failure" : "success"}`, { timeout: 60000 }, async t => {
    const { page, requests, rows, switchRoom, errors } = await uploadFixture(t);
    const captured = deferred(), release = deferred(), delivered = deferred();
    t.after(() => release.resolve());
    await page.route("**/api/rooms/room-a/files", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      captured.resolve(); await release.promise;
      if (lateFailure) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "storage_unavailable", message: "Old upload failed" } }) });
      else await route.fulfill({ response });
      delivered.resolve();
    });
    await page.locator("#composer-file").setInputFiles([uploadFile("first.txt"), uploadFile("second.txt")]);
    await captured.promise;
    await switchRoom();
    await page.locator("#message-input").fill("Keep this room's draft");
    const status = await page.locator("#composer-status").textContent();
    release.resolve(); await delivered.promise; await settleUpload(page);
    await freshUpload(page);
    assert.deepEqual(requests.map(({ path, filename }) => ({ path, filename })), [
      { path: "/api/rooms/room-a/files", filename: "first.txt" },
      { path: "/api/rooms/room-b/files", filename: "current.txt" }
    ]);
    assert.deepEqual(rows().map(row => [row.room_id, row.filename]), [["room-a", "first.txt"], ["room-b", "current.txt"]]);
    assert.equal(await page.locator("#message-input").inputValue(), "Keep this room's draft");
    assert.equal(await page.locator("#composer-status").textContent(), status, "old errors cannot annotate the replacement draft");
    assert.deepEqual(errors, []);
  });
}

for (const leave of ["room switch", "remove"]) {
  test(`composer uploads: ${leave} during file read prevents staging`, { timeout: 60000 }, async t => {
    const { page, requests, rows, switchRoom, errors } = await uploadFixture(t);
    // Delay the browser File API, not application state or its ownership checks.
    await page.evaluate(() => {
      const read = File.prototype.arrayBuffer;
      window.uploadReadStarted = false;
      File.prototype.arrayBuffer = async function () {
        if (this.name !== "delayed.txt") return read.call(this);
        window.uploadReadStarted = true;
        await new Promise(resolve => { window.releaseUploadRead = resolve; });
        return read.call(this);
      };
    });
    await page.locator("#composer-file").setInputFiles(uploadFile("delayed.txt"));
    await page.waitForFunction(() => window.uploadReadStarted);
    if (leave === "room switch") await switchRoom();
    else await page.getByRole("button", { name: "Remove delayed.txt", exact: true }).click();
    await page.locator("#message-input").fill("Unrelated draft");
    await page.evaluate(() => window.releaseUploadRead()); await settleUpload(page);
    await freshUpload(page);
    assert.deepEqual(requests.map(request => request.filename), ["current.txt"]);
    assert.deepEqual(rows().map(row => [row.room_id, row.filename]), [[leave === "room switch" ? "room-b" : "room-a", "current.txt"]]);
    assert.equal(await page.locator("#message-input").inputValue(), "Unrelated draft");
    assert.deepEqual(errors, []);
  });
}

test("composer uploads: a removed in-flight file cannot report a late error into its draft", { timeout: 60000 }, async t => {
  const { page, requests, rows, errors } = await uploadFixture(t);
  const captured = deferred(), release = deferred(), delivered = deferred();
  t.after(() => release.resolve());
  await page.route("**/api/rooms/room-a/files", async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().filename !== "removed.txt") return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 201);
    captured.resolve(); await release.promise;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "storage_unavailable", message: "Removed upload failed" } }) });
    delivered.resolve();
  });
  await page.locator("#composer-file").setInputFiles(uploadFile("removed.txt"));
  await captured.promise;
  await page.getByRole("button", { name: "Remove removed.txt", exact: true }).click();
  const status = await page.locator("#composer-status").textContent();
  release.resolve(); await delivered.promise; await settleUpload(page);
  await freshUpload(page);
  assert.equal(await page.locator("#composer-status").textContent(), status);
  assert.deepEqual(requests.map(request => request.filename), ["removed.txt", "current.txt"]);
  assert.ok(rows().every(row => row.state === "staged" && row.message_id === null), "removal cannot retract an already staged server mutation or publish it");
  assert.equal(await page.getByRole("button", { name: "Remove removed.txt", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test("composer uploads: an unchanged room stages and commits the complete batch", { timeout: 60000 }, async t => {
  const { page, requests, rows, errors } = await uploadFixture(t);
  await page.locator("#composer-file").setInputFiles([uploadFile("first.txt"), uploadFile("second.txt")]);
  await page.waitForFunction(() => document.querySelector("#composer-attachments")?.textContent === "first.txt×second.txt×");
  await page.locator("#message-input").fill("Both files belong here");
  await page.locator('#message-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("#composer-attachments .file-chip"));
  assert.deepEqual(requests.map(request => request.filename), ["first.txt", "second.txt"]);
  const attachments = rows(); assert.equal(attachments.length, 2);
  assert.ok(attachments.every(row => row.room_id === "room-a" && row.state === "committed" && row.message_id));
  assert.equal(attachments[0].message_id, attachments[1].message_id);
  assert.deepEqual(errors, []);
});

for (const departure of ["logout", "revocation"]) {
  test(`composer uploads: ${departure} fences late upload failures`, { timeout: 60000 }, async t => {
    const { page, store, origin, account, key, requests, rows, errors } = await uploadFixture(t);
    const replacement = store.createAccount("replacement-upload-owner");
    store.completeOnboarding(replacement.id);
    const replacementKey = store.issueAccountAccessKey(replacement.id);
    const slot = store.createAccountSessionSlot();
    const auth = store.loginAccountSession(slot.token, replacementKey, 0);
    store.createAccountRoom(slot.token, auth.sessionBinding, {
      roomId: "room-c", title: "room-c", purpose: "Replacement identity", kind: "personal", displayName: "Replacement owner"
    });
    const captured = deferred(), release = deferred(), delivered = deferred();
    t.after(() => release.resolve());
    await page.route("**/api/rooms/room-a/files", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 201);
      captured.resolve(); await release.promise;
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "session_binding_changed", message: "Old identity ended" } }) });
      delivered.resolve();
    });
    await page.locator("#composer-file").setInputFiles([uploadFile("first.txt"), uploadFile("second.txt")]);
    await captured.promise;
    if (departure === "logout") await clickChrome(page, "#signout-button");
    else store.revokeAccountCredential(account.id, key);
    await page.locator("#main").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#auth-panel")?.getAttribute("aria-busy") !== "true");
    if (departure === "logout") {
      const status = await page.locator("#composer-status").textContent();
      release.resolve(); await delivered.promise; await settleUpload(page);
      assert.deepEqual(requests.map(request => request.filename), ["first.txt"]);
      assert.deepEqual(rows().map(row => [row.room_id, row.filename]), [["room-a", "first.txt"]]);
      assert.equal(await page.locator("#composer-status").textContent(), status, "signed-out drafts cannot receive the old error");
      assert.equal(await page.locator("#main").isVisible(), false);
      assert.deepEqual(errors, []);
      return;
    }

    // Real account credential and refresh APIs, without reloading the document:
    // the old upload continuation must remain alive across the identity change.
    const slotResponse = await page.context().request.get(`${origin}/api/account-session`);
    const browserSlot = await slotResponse.json();
    const login = await page.context().request.post(`${origin}/api/account-session`, {
      headers: { Origin: origin, "X-CSRF-Token": browserSlot.csrf, "X-Session-Binding": browserSlot.sessionBinding },
      data: { accountAccessKey: replacementKey, expectedSessionRevision: browserSlot.sessionRevision }
    });
    assert.equal(login.status(), 201);
    await page.evaluate(() => history.replaceState(null, "", "?room=room-c"));
    await page.locator("#refresh-button").evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector("#room-title")?.textContent === "room-c" && !document.querySelector("#main").hidden);
    await page.locator("#message-input").fill("Replacement account draft");
    const status = await page.locator("#composer-status").textContent();
    release.resolve(); await delivered.promise; await settleUpload(page);
    await freshUpload(page);
    assert.deepEqual(requests.map(({ path, filename }) => ({ path, filename })), [
      { path: "/api/rooms/room-a/files", filename: "first.txt" },
      { path: "/api/rooms/room-c/files", filename: "current.txt" }
    ]);
    assert.deepEqual(rows().map(row => [row.room_id, row.filename]), [["room-a", "first.txt"], ["room-c", "current.txt"]]);
    assert.equal(await page.locator("#message-input").inputValue(), "Replacement account draft");
    assert.equal(await page.locator("#composer-status").textContent(), status);
    assert.deepEqual(errors, []);
  });
}
