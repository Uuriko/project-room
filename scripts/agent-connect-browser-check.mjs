import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, mobile = false) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  page.setDefaultTimeout(8000);
  const errors = [], outside = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  });
  await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#people-panel > summary").click();
  const open = async () => { await page.locator("#connect-agent-button").click(); await page.locator("#agent-connect-dialog").waitFor({ state: "visible" }); };
  const create = async () => { await page.locator("#agent-connect-name").fill("Synthetic Claude"); await page.locator("#agent-create").click(); };
  const config = async () => { await page.locator("#agent-private-details > summary").click(); await page.waitForFunction(() => document.querySelector("#agent-private-config").value.length > 0); return JSON.parse(await page.locator("#agent-private-config").inputValue()); };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/agent-connect-${name}.png` }); };
  return { ...f, page, origin, open, create, config, capture };
}

test("browser owner issues digest-only setup; a real external client imports, reads, rotates and loses access", { timeout: 30000 }, async t => {
  const f = await setup(t), requests = [];
  f.page.on("request", request => { if (request.url().endsWith("/agent-connections") && request.method() === "POST") requests.push(request.postDataJSON()); });
  await f.open(); await f.capture("desktop-form"); await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  await f.capture("desktop-ready"); const config = await f.config();
  assert.equal(JSON.stringify(requests).includes(config.token), false); assert.equal(requests[0].keyHash.length, 64);
  const env = { PATH: process.env.PATH }, directory = join(f.directory, "connection");
  const imported = await new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", "import", directory], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("exit", code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(config));
  });
  assert.equal(imported.code, 0, imported.stderr); assert.equal(JSON.parse(imported.stdout).configurationSaved, true);
  assert.equal(imported.stdout.includes(config.token), false);
  assert.equal(statSync(join(directory, "connection.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "connection.json"))), config);
  const agent = new RoomAgentClient(config), before = f.store.room("commons").sequence;
  assert.equal((await agent.checkConnection()).status, "credential_accepted");
  const work = await agent.workContext("test-handoff"); assert.equal(work.work.id, "test-handoff");
  assert.equal(f.store.room("commons").sequence, before);
  await f.page.locator("#agent-private-details > summary").click();
  await f.page.locator("#agent-connect-done").click();
  await f.page.getByText("Manage connections", { exact: true }).click();
  f.page.on("dialog", dialog => dialog.accept());
  await f.page.getByRole("button", { name: /Replace key/ }).click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const replacement = await f.config();
  await assert.rejects(agent.checkConnection(), { status: 401 });
  const current = new RoomAgentClient(replacement); assert.equal((await current.checkConnection()).memberId, config.memberId);
  await f.page.locator("#agent-connect-done").click(); await f.page.getByRole("button", { name: /Disconnect/ }).click();
  await f.page.getByText("Room access ended.", { exact: true }).waitFor(); await assert.rejects(current.checkConnection(), { status: 401 });
  assert.equal(f.store.room("commons").state.members[config.memberId].active, false);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("named roster fills Muse and Grok Build without creating access", { timeout: 20000 }, async t => {
  const f = await setup(t);
  await f.open();
  await f.page.locator('[data-roster="muse"]').click();
  assert.equal(await f.page.locator("#agent-connect-name").inputValue(), "Muse");
  assert.equal(await f.page.locator("#agent-connect-access").inputValue(), "chat");
  assert.match(await f.page.locator("#agent-roster-hint").innerText(), /has not contributed/);
  await f.page.locator('[data-roster="grok-build"]').click();
  assert.equal(await f.page.locator("#agent-connect-name").inputValue(), "Grok Build");
  assert.equal(await f.page.locator("#agent-connect-access").inputValue(), "contribute");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connections").get().n, 0);
});

test("unknown enrollment survives close and retries the original digest and identity", { timeout: 30000 }, async t => {
  const f = await setup(t), attempts = [];
  await f.page.route("**/agent-connections", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); return route.fulfill({ status: 200, json: {} }); }
    return route.continue();
  });
  await f.open(); await f.create(); await f.page.getByText("Change not confirmed. Retry the original.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#agent-connect-name").isDisabled(), true);
  await f.page.locator("#agent-connect-close").click(); await f.open(); await f.page.locator("#agent-create").click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const config = await f.config();
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connections").get().n, 1);
  assert.equal(f.store.authenticate(config.token).member.id, attempts[0].memberId);
});

test("mobile disclosure stays lightweight, fits the viewport and conceals setup on close", { timeout: 30000 }, async t => {
  const f = await setup(t, true); await f.open(); await f.capture("mobile-form"); await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); await f.capture("mobile-ready");
  const config = await f.config();
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await f.page.locator("#agent-connect-close").click(); await f.open();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
  assert.equal(await f.page.locator("#agent-private-details").evaluate(node => node.open), false);
  assert.equal((await new RoomAgentClient(config).checkConnection()).status, "credential_accepted");
});

test("owned list access denial clears previously revealed setup", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create(); await f.page.locator("#agent-setup").waitFor({ state: "visible" }); await f.config();
  await f.page.locator("#agent-connect-close").click();
  await f.page.route("**/agent-connections", route => route.fulfill({ status: 403, json: { error: { code: "owner_required", message: "Access changed" } } }));
  await f.page.locator("#connect-agent-button").click(); await f.page.locator("#agent-connect-dialog").waitFor({ state: "hidden" });
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), ""); assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
});

test("snapshot access changes conceal a held private key", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create(); await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const config = await f.config();
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId: config.memberId, expectedMemberRevision: 0, permissions: [], active: false
  } });
  await f.page.getByText("Agent access changed. Review its connection.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), ""); assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
});

test("retained setup warns before sign-out; expiry prevents reveal or copy", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create(); await f.page.locator("#agent-setup").waitFor({ state: "visible" }); await f.config();
  await f.page.locator("#agent-connect-close").click();
  let warning;
  f.page.once("dialog", dialog => { warning = dialog.message(); return dialog.dismiss(); });
  await f.page.locator("#signout-button").click(); assert.match(warning, /private setup/);
  await f.open();
  await f.page.evaluate(() => { const now = Date.now(); Date.now = () => now + 31 * 86400000; });
  await f.page.locator("#agent-private-details > summary").click();
  await f.page.getByText("This key expired. Replace it to reconnect.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
});

test("a rotation ahead of an older inactive snapshot keeps the new private setup", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const original = await f.config();
  await f.page.locator("#agent-connect-done").click();
  let frozen, ready;
  const frozenReady = new Promise(resolve => { ready = resolve; });
  await f.page.route(`${f.origin}/api/rooms/commons`, async route => {
    if (!frozen) {
      const result = await (await route.fetch()).json();
      if (result.state.members[original.memberId]?.revision === 1) { frozen = result; ready(); }
      return route.fulfill({ json: result });
    }
    return route.fulfill({ json: frozen });
  });
  const change = (revision, active) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: original.memberId, expectedMemberRevision: revision, permissions: [], active } });
  change(0, false); await frozenReady; change(1, true);
  await f.page.locator("#agent-connect-close").click(); await f.open();
  await f.page.getByText("Manage connections", { exact: true }).click();
  f.page.once("dialog", dialog => dialog.accept());
  await f.page.getByRole("button", { name: /Replace key/ }).click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const replacement = await f.config();
  await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await f.page.locator("#agent-setup").isVisible(), true);
  assert.equal((await new RoomAgentClient(replacement).checkConnection()).memberId, original.memberId);
  assert.equal(f.store.authenticate(replacement.token).member.revision, 2);
});

test("incomplete 2xx enrollment metadata preserves the exact pending retry", { timeout: 30000 }, async t => {
  const f = await setup(t), attempts = [];
  await f.page.route("**/agent-connections", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    const result = await (await route.fetch()).json();
    if (attempts.length === 1) result.receipt.membershipEventId = "";
    if (attempts.length === 2) delete result.connection.memberRevision;
    if (attempts.length === 3) result.connection.expiresAt++;
    return route.fulfill({ json: result });
  });
  await f.open(); await f.create();
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.page.getByText("Change not confirmed. Retry the original.", { exact: true }).waitFor();
    assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
    assert.equal(await f.page.locator("#agent-connect-name").isDisabled(), true);
    await f.page.locator("#agent-create").click();
  }
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  assert.equal(attempts.length, 4); for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
  const config = await f.config(); assert.equal(f.store.authenticate(config.token).member.id, attempts[0].memberId);
});

test("a delayed enrollment receipt cannot restore setup after owner access ends", { timeout: 30000 }, async t => {
  const f = await setup(t); let captured, release;
  const committed = new Promise(resolve => { captured = resolve; }), held = new Promise(resolve => { release = resolve; });
  await f.page.route("**/agent-connections", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); captured(); await held; return route.fulfill({ response });
  });
  await f.open(); await f.create(); await committed;
  const account = f.store.authenticate(f.keys.owner).account;
  f.store.changeAccountAccess(account.id, { expectedRevision: account.revision, active: false, reason: "Synthetic access ended" });
  await f.page.locator("#main").waitFor({ state: "hidden" });
  const response = f.page.waitForResponse(result => result.url().endsWith("/agent-connections") && result.request().method() === "POST");
  release(); await response; await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await f.page.locator("#agent-connect-dialog").isVisible(), false);
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
  assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
});
