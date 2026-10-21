// No-browser sign-in: room login --device prints a link, a signed-in member
// approves it on any device, and login finishes on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { DeviceSignin, normalizeUserCode } from "../server/device-signin.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { main } from "../cli/main.mjs";

async function boot(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return { store, key, origin: `http://127.0.0.1:${server.address().port}` };
}

test("user codes normalize and unknown codes do not resolve", async t => {
  const { store } = await boot(t);
  assert.equal(normalizeUserCode("bcdf ghjk"), "BCDF-GHJK");
  assert.equal(normalizeUserCode("abc"), null);
  const flows = new DeviceSignin(store);
  assert.equal(flows.lookup("ZZZZ-ZZZZ"), null);
  const started = flows.start("commons", "Box Agent");
  assert.equal(flows.poll(started.deviceCode).status, "pending");
  assert.throws(() => flows.start("commons", ""), /name/);
});

test("codes expire after ten minutes", async t => {
  const { store } = await boot(t);
  let clock = 1_000_000;
  const flows = new DeviceSignin(store, { now: () => clock });
  const started = flows.start("commons", "Late Agent");
  clock += 10 * 60 * 1000 + 1;
  assert.equal(flows.poll(started.deviceCode).status, "expired");
  assert.equal(flows.lookup(started.userCode), null);
});

test("room login --device: link, approve on another device, setup finishes on its own", async t => {
  const { key, origin } = await boot(t);
  const root = mkdtempSync(join(tmpdir(), "room-device-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"); mkdirSync(home);
  const env = { ...process.env, HOME: home, PROJECT_ROOM_KEYCHAIN: "0", PATH: "/nonexistent" };
  const progress = [], out = [];
  let approvedPage = null;
  const sleep = async () => {
    if (approvedPage) return;
    const link = /Open (\S+) /.exec(progress[0])[1];
    assert.match(link, /\/device\?code=[A-Z]{4}-[A-Z]{4}$/);
    const shown = await fetch(link.replace(/^https?:\/\/[^/]+/, origin), { headers: { cookie: `room_session=${key}` } });
    assert.match(await shown.text(), /Let Box Agent into room commons\?/);
    const code = new URL(link).searchParams.get("code");
    const approved = await fetch(`${origin}/device`, { method: "POST", headers: { cookie: `room_session=${key}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: `code=${code}` });
    approvedPage = await approved.text();
    assert.equal(approved.status, 200, approvedPage);
  };
  const code = await main(["login", "--device", "--room", `${origin}/rooms/commons`, "--name", "Box Agent"], { env, out: l => out.push(l), progress: l => progress.push(l), sleep });
  assert.equal(code, 0, out.join("\n"));
  assert.match(approvedPage, /approved for room commons/);
  const printed = JSON.parse(out.at(-1));
  assert.equal(printed.status, "connected");
  const pointer = JSON.parse(readFileSync(join(home, ".project-room", "connections", "box-agent", "pointer.json"), "utf8"));
  const saved = readAgentConnection(pointer.configDirectory);
  assert.equal(saved.roomId, "commons");
  assert.equal(out.join("\n").includes(saved.token), false);
  assert.equal(progress.join("\n").includes("dvc_"), false, "the device code never prints");
});

test("approving without a room session or from another origin is refused", async t => {
  const { store, origin } = await boot(t);
  const started = new DeviceSignin(store).start("commons", "X Agent");
  const noSession = await fetch(`${origin}/device`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: `code=${started.userCode}` });
  assert.equal(noSession.status, 401);
  const crossSite = await fetch(`${origin}/device`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: `code=${started.userCode}` });
  assert.equal(crossSite.status, 403);
});
