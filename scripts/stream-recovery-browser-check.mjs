import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { createRoomServer } from "../server/http.mjs";
import { StorageUnavailableError } from "../server/store.mjs";

test("native EventSource reconnects after temporary storage failure without losing identity, unsent draft or selection", { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture(), original = f.store.eventsAfter.bind(f.store);
  let armed = false, failures = 0;
  f.store.eventsAfter = (...args) => {
    if (armed) { armed = false; failures++; throw new StorageUnavailableError(new Error("synthetic driver detail")); }
    return original(...args);
  };
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; let streams = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/stream")) streams++; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  const identity = await page.locator("#identity-label").textContent(), beforeStreams = streams;
  const draft = "An unsent private draft retained through temporary transport failure";
  await page.locator("#message-input").fill(draft);
  await page.locator("#message-input").focus();
  await page.locator("#message-input").evaluate(input => input.setSelectionRange(3, 16));
  const composer = () => page.locator("#message-input").evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }));
  const expected = await composer();
  armed = true;
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connection interrupted"));
  assert.equal(failures, 1);
  assert.equal(await page.locator("#main").isVisible(), true);
  assert.equal(await page.locator("#auth-panel").isVisible(), false);
  assert.equal(await page.locator("#identity-label").textContent(), identity);
  assert.deepEqual(await composer(), expected);
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  assert.ok(streams > beforeStreams, "native EventSource makes an actual reconnect request");
  const id = randomUUID();
  f.store.command(f.keys.owner, "commons", { id, type: "message.posted", data: { messageId: id, body: "Public arrival after native recovery" } });
  await page.locator(`[data-message-record-id="${id}"]`).waitFor({ state: "visible" });
  assert.equal(await page.locator("#identity-label").textContent(), identity);
  assert.deepEqual(await composer(), expected);
  assert.equal(f.store.room("commons").state.messages.some(message => message.body === draft), false);
  assert.deepEqual(errors, []);
});

// NR-C1 authoring gate: existing client tests own sequence/read coalescing and
// service tests own cursor replay. These real-browser compositions protect the
// distinct final message-ID/content contract across held HTTP and native SSE.
// Expected values are fixture intent, never a production reducer or renderer.
const messageView = messages => messages.map(({ id, body }) => ({ id, body })).sort((a, b) => a.id.localeCompare(b.id));
const assertMessageView = (actual, expected) => assert.deepEqual(messageView(actual), messageView(expected));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const schedule of ["initial-handover", "connected-refresh"]) {
  test(`snapshot-to-stream ${schedule} converges to admitted message identities and content`, { timeout: 30000 }, async t => {
    const f = createAcceptanceFixture(), held = deferred(), release = deferred(), frameArrived = deferred(), startupRead = deferred();
    const trace = [], snapshots = [], frames = [], errors = [], admissions = [];
    const record = (kind, value = {}) => trace.push({ order: trace.length, kind, ...value });
    const admit = (id, type, data) => {
      const receipt = f.store.command(f.keys.owner, "commons", { id, type, data });
      admissions.push({ id: receipt.event.id, sequence: receipt.sequence, type, messageId: data.messageId });
      record("admitted", admissions.at(-1)); return receipt;
    };
    let first;
    if (schedule === "initial-handover") first = admit("nrc1-seed-command", "message.posted", { messageId: "nrc1-seed", body: "Before handover" });
    const server = createRoomServer({ store: f.store, streamInterval: 50 });
    let browser, page, cdp, armed = false, captured = false, heldSequence, targetSequence;
    let finalView, journal;
    const oracleControls = [];
    t.after(async () => {
      release.resolve();
      mkdirSync("test-results", { recursive: true });
      writeFileSync(`test-results/stream-${schedule}.json`, JSON.stringify({ schedule,
        revision: process.env.GITHUB_SHA ?? "local", trace, snapshots, frames, admissions, journal,
        finalView, oracleControls, errors }, null, 2) + "\n");
      await cdp?.detach().catch(() => {}); await browser?.close();
      server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/rooms/commons/stream") record("stream-request", { after: Number(url.searchParams.get("after")) });
    });
    // Observe native frames without replacing EventSource or synthesizing data.
    cdp = await page.context().newCDPSession(page); await cdp.send("Network.enable");
    cdp.on("Network.eventSourceMessageReceived", frame => {
      if (frame.eventName !== "room-event") return;
      const receipt = JSON.parse(frame.data);
      frames.push({ sequence: receipt.sequence, id: receipt.event.id });
      record("native-frame", frames.at(-1));
      if (receipt.sequence === targetSequence) frameArrived.resolve();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.route(/\/api\/rooms\/commons(?:\?.*)?$/, async route => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const requestOrder = trace.length;
      record("snapshot-request");
      const afterStreamOpen = trace.some(entry => entry.kind === "stream-request");
      const response = await route.fetch();
      const snapshot = await response.json();
      const selected = { sequence: snapshot.sequence,
        messages: messageView((snapshot.state?.messages ?? []).filter(message => message.id.startsWith("nrc1-"))) };
      snapshots.push(selected); record("snapshot-captured", selected);
      if (armed && !captured) {
        captured = true; heldSequence = snapshot.sequence; record("snapshot-held", { sequence: heldSequence, requestOrder }); held.resolve();
        await release.promise; record("snapshot-released", { sequence: heldSequence });
      }
      await route.fulfill({ response });
      record("snapshot-delivered", { sequence: snapshot.sequence });
      if (!armed && afterStreamOpen) startupRead.resolve();
    });
    if (schedule === "connected-refresh") {
      await signInFixture(page, f.keys.owner);
      // Connected is announced before the on-open GET; await its actual
      // completion so startup traffic cannot steal the scheduled held read.
      await startupRead.promise;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      record("startup-read-settled");
    }
    const establishedStreams = trace.filter(entry => entry.kind === "stream-request").length;
    armed = true;
    // Initial startup awaits this snapshot before constructing EventSource.
    // The other schedule keeps its established stream open during the read.
    const started = schedule === "initial-handover" ? signInFixture(page, f.keys.owner) : Promise.resolve();
    if (schedule === "connected-refresh") first = admit("nrc1-seed-command", "message.posted", { messageId: "nrc1-seed", body: "Before handover" });
    await held.promise;
    assert.equal(heldSequence, first.sequence);
    if (schedule === "initial-handover") assert.equal(trace.some(entry => entry.kind === "stream-request"), false);
    admit("nrc1-edit-command", "message.edited", { messageId: "nrc1-seed", body: "Newer admitted content", expectedMessageRevision: 0 });
    const latest = admit("nrc1-add-command", "message.posted", { messageId: "nrc1-added", body: "Admitted during handover" });
    targetSequence = latest.sequence;
    if (schedule === "connected-refresh") {
      // Native transport must actually deliver the newer hint before release.
      await frameArrived.promise;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('[data-message-record-id="nrc1-added"]').count(), 0, "the held read has not caught up yet");
    }
    release.resolve(); await started;
    await frameArrived.promise;
    await page.waitForFunction(horizon => {
      const match = document.querySelector("#cursor-label")?.textContent.match(/room event (\d+)/);
      return Number(match?.[1]) >= horizon;
    }, latest.sequence);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    finalView = await page.locator('#message-list [data-message-record-id^="nrc1-"]').evaluateAll(rows => rows.map(row => ({
      id: row.dataset.messageRecordId, body: row.querySelector(".message-body").textContent
    })));
    const expected = [
      { id: "nrc1-seed", body: "Newer admitted content" },
      { id: "nrc1-added", body: "Admitted during handover" }
    ];
    assertMessageView(finalView, expected);
    const caughtUp = snapshots.filter(snapshot => snapshot.sequence >= latest.sequence);
    assert.ok(caughtUp.length > 0, "automatic catch-up fetch reached the admitted horizon");
    for (const snapshot of caughtUp) assertMessageView(snapshot.messages, expected);
    const heldAt = trace.findIndex(entry => entry.kind === "snapshot-held");
    const releasedAt = trace.findIndex(entry => entry.kind === "snapshot-released");
    const frameAt = trace.findIndex(entry => entry.kind === "native-frame" && entry.sequence === latest.sequence);
    assert.ok(heldAt < releasedAt);
    if (schedule === "connected-refresh") {
      const seedFrameAt = trace.findIndex(entry => entry.kind === "native-frame" && entry.id === first.event.id);
      assert.ok(seedFrameAt >= 0 && seedFrameAt < trace[heldAt].requestOrder, "native seed notification owns the held GET");
      assert.ok(heldAt < frameAt && frameAt < releasedAt, "held GET → actual native v2 frame → release stale GET");
      assert.equal(trace.filter(entry => entry.kind === "stream-request").length, establishedStreams, "no reconnect may mask a dropped refresh hint");
    } else {
      const connectedAt = trace.findIndex(entry => entry.kind === "stream-request");
      assert.ok(releasedAt < connectedAt && connectedAt < frameAt, "initial snapshot release → native stream → replay");
      assert.equal(trace[connectedAt].after, first.sequence);
    }
    // Read only the synthetic fixture's admitted journal IDs, not application
    // projections. Event identity is distinct from rendered message identity.
    journal = f.store.db.prepare("SELECT sequence, body FROM events WHERE id IN (?, ?, ?) ORDER BY sequence")
      .all(...admissions.map(item => item.id)).map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
    assert.deepEqual(journal.map(row => ({ id: row.event.id, sequence: row.sequence, type: row.event.type, messageId: row.event.data.messageId })), admissions);
    assert.deepEqual(journal.map(row => [row.event.type, row.event.data.messageId]), [
      ["message.posted", "nrc1-seed"], ["message.edited", "nrc1-seed"], ["message.posted", "nrc1-added"]
    ]);
    // Deliberately corrupt observed copies to prove this independent oracle
    // rejects loss, duplicate identity and stale content. These are oracle
    // controls, not evidence of a baseline product bug or weakened assertions.
    for (const [name, corrupt] of [
      ["dropped identity", finalView.slice(1)],
      ["duplicate identity", [...finalView, finalView[0]]],
      ["stale content", finalView.map(row => row.id === "nrc1-seed" ? { ...row, body: "Before handover" } : row)]
    ]) {
      assert.throws(() => assertMessageView(corrupt, expected), { code: "ERR_ASSERTION" });
      oracleControls.push(name);
    }
    assert.deepEqual(errors, []);
    record("caught-up", { sequence: latest.sequence, messages: messageView(finalView) });
    t.diagnostic(`${schedule}: held ${heldSequence}; native ${latest.sequence}; exact final identities/content; three oracle controls rejected`);
  });
}

// Live refreshes after a new message re-read only the newest messages
// (`?messages=recent`) and keep the older history already on screen; an edit to
// an older message still reads the full snapshot and shows the edit.
test("a new message refreshes a busy room with the recent window, an old edit with the full snapshot", { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture();
  f.store.roomFlood = { consume() {} };
  const post = (key, body) => { const id = randomUUID(); f.store.command(key, "commons", { id, type: "message.posted", data: { messageId: id, body } }); return id; };
  const ids = [];
  for (let i = 0; i < 130; i++) ids.push(post(f.keys.producer, `history ${i}`));
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], reads = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", async response => {
    const url = new URL(response.url());
    if (url.pathname === "/api/rooms/commons" && response.request().method() === "GET")
      reads.push({ search: url.search, messages: (await response.json().catch(() => null))?.state?.messages?.length });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  await page.locator(`[data-message-record-id="${ids.at(-1)}"]`).waitFor({ state: "visible" });
  const rendered = () => page.locator("[data-message-record-id]").evaluateAll(nodes => nodes.map(node => node.dataset.messageRecordId));
  const before = await rendered();
  // Opening reads in full once; the stream's own open re-reads only the window.
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  assert.equal(reads[0]?.search, "", "opening reads the full snapshot");
  assert.ok(reads.slice(1).every(read => read.search === "?messages=recent"), JSON.stringify(reads));

  const opened = reads.length;
  const arrival = post(f.keys.producer, "a new arrival");
  await page.locator(`[data-message-record-id="${arrival}"]`).waitFor({ state: "visible" });
  await page.waitForFunction(count => document.querySelectorAll("[data-message-record-id]").length >= count, before.length);
  const live = reads.slice(opened);
  // With the server's recent view each read carries 100 messages; a server
  // without it answers in full, and the client uses that as is.
  assert.ok(live.length >= 1 && live.every(read => read.search === "?messages=recent" && [100, reads[0].messages + 1].includes(read.messages)), JSON.stringify(live));
  assert.deepEqual((await rendered()).filter(id => id !== arrival), before, "the history on screen is unchanged apart from the arrival");

  // An edit to the oldest message (outside the window) must still show.
  const oldest = ids[0], edited = reads.length;
  assert.ok(before.includes(oldest), "the oldest message is on screen");
  const fullRead = page.waitForResponse(response => { const url = new URL(response.url());
    return url.pathname === "/api/rooms/commons" && url.search === "" && response.request().method() === "GET"; });
  f.store.command(f.keys.producer, "commons", { id: randomUUID(), type: "message.edited", data: { messageId: oldest, body: "history 0, edited", expectedMessageRevision: 0 } });
  await fullRead;
  await page.locator(`[data-message-record-id="${oldest}"]`, { hasText: "history 0, edited" }).waitFor({ state: "attached" });
  assert.deepEqual(reads.slice(edited).map(read => read.search), [""]);
  assert.deepEqual(errors, []);
});
