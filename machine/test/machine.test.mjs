import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { spawnContext, runCommand } from "../lib/spawn.mjs";
import { isSafeFileName } from "../lib/tools.mjs";
import { saveConfig, defaultConfig } from "../lib/config.mjs";
import { readSecret } from "../lib/secrets.mjs";
import { MachineDaemon } from "../lib/daemon.mjs";
import { enroll } from "../lib/enroll.mjs";
import { doctorReport } from "../lib/doctor.mjs";
import { applySystemChanges, revertSystemChanges } from "../lib/system.mjs";
import { startGuest, prepareGolden } from "../lib/vms.mjs";
import { saveSecret } from "../lib/secrets.mjs";
import { requestApproval, takeApproval } from "../lib/approvals.mjs";
import { readManifest } from "../lib/recording.mjs";
import { startFakeRelay } from "./fake-relay.mjs";

const fakes = fileURLToPath(new URL("../fakes/", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));

function homeDir() {
  const home = mkdtempSync(join(tmpdir(), "room-machine-"));
  writeFileSync(join(home, "argv-log"), "");
  writeFileSync(join(home, "env-log"), "");
  return home;
}

function machineEnv(home, extra = {}) {
  return {
    PATH: `${fakes}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    LC_ALL: "C",
    USER: "room",
    LOGNAME: "room",
    TERM: "dumb",
    ROOM_MACHINE_ENABLED: "1",
    ROOM_MACHINE_HOME: home,
    ...extra,
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the machine");
}

function lease(claimId, slot, identityId = "ai_caller") {
  return { identityId, claimId, slot, verified: true };
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-machine-server-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin, ownerKey };
}

async function post(origin, path, body, token) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function get(origin, path, token) {
  const response = await fetch(`${origin}${path}`, {
    headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

test.describe("room-machine", { concurrency: false }, () => {
  test("a call without a verified lease is refused before a guest starts", async () => {
    const home = homeDir();
    const relay = await startFakeRelay();
    const token = "tok-lease-check";
    saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, reconnectBackoffMs: 50 }, home);
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "machine"), token, { mode: 0o600 });
    relay.mint("unused", { machineToken: token, machineId: "mac-1", relayUrl: relay.ws, roomId: "commons", inviteCode: "RM-TEST", ownerMemberId: "owner" });
    const env = machineEnv(home);
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length === 1);
      assert.equal(JSON.stringify(relay.hellos[0]).includes(token), false);
      relay.send({ type: "call", id: "no", tool: "machine.status", args: {}, caller: { identityId: "ai_x", claimId: "c1", slot: "desk", verified: false } });
      await waitFor(() => relay.results.length === 1);
      assert.equal(relay.results[0].ok, false);
      assert.equal(relay.results[0].error.code, "lease_required");
      assert.equal(readFileSync(join(home, "argv-log"), "utf8").includes("lume"), false);
    } finally {
      await daemon.stop();
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the relay link reconnects, and a quiet link suspends guests then refuses work until a heartbeat", async () => {
    const home = homeDir();
    const relay = await startFakeRelay();
    const token = "tok-link";
    saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, reconnectBackoffMs: 40 }, home);
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "machine"), token, { mode: 0o600 });
    relay.mint("unused", { machineToken: token });
    const env = machineEnv(home, { ROOM_MACHINE_DEADMAN_SECONDS: "1" });
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length >= 1);
      relay.sockets().at(-1).close();
      await waitFor(() => relay.hellos.length >= 2);
      const caller = lease("claim-desk", "desk");
      relay.send({ type: "call", id: "boot", tool: "desktop.screenshot", args: {}, caller });
      await waitFor(() => relay.results.some(result => result.id === "boot" && result.ok));
      await new Promise(resolve => setTimeout(resolve, 1300));
      assert.match(readFileSync(join(home, "argv-log"), "utf8"), /lume "suspend" "desk"/);
      relay.send({ type: "call", id: "late", tool: "machine.status", args: {}, caller });
      await waitFor(() => relay.results.some(result => result.id === "late"));
      const late = relay.results.find(result => result.id === "late");
      assert.equal(late.ok, false);
      assert.equal(late.error.code, "deadman");
      relay.send({ type: "heartbeat" });
      await new Promise(resolve => setTimeout(resolve, 80));
      relay.send({ type: "call", id: "back", tool: "machine.status", args: {}, caller });
      await waitFor(() => relay.results.some(result => result.id === "back"));
      assert.equal(relay.results.find(result => result.id === "back").ok, true);
    } finally {
      await daemon.stop();
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("halt stops the guest before the next call, which is refused", async () => {
    const home = homeDir();
    const relay = await startFakeRelay();
    const token = "tok-halt";
    saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, reconnectBackoffMs: 50 }, home);
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "machine"), token, { mode: 0o600 });
    relay.mint("unused", { machineToken: token });
    const env = machineEnv(home, { ROOM_MACHINE_DEADMAN_SECONDS: "30" });
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length === 1);
      const caller = lease("claim-halt", "desk");
      relay.send({ type: "call", id: "boot", tool: "desktop.screenshot", args: {}, caller });
      await waitFor(() => relay.results.some(result => result.id === "boot" && result.ok));
      relay.send({ type: "halt", epoch: 4 });
      relay.send({ type: "call", id: "next", tool: "machine.status", args: {}, caller });
      await waitFor(() => relay.results.some(result => result.id === "next"));
      const next = relay.results.find(result => result.id === "next");
      assert.equal(next.ok, false);
      assert.equal(next.error.code, "halted");
      assert.match(readFileSync(join(home, "argv-log"), "utf8"), /lume "stop" "desk"/);
    } finally {
      await daemon.stop();
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a tool outside the allowlist is refused before the guest driver is called", async () => {
    const home = homeDir();
    const relay = await startFakeRelay();
    const token = "tok-allow";
    const allow = defaultConfig().allow.filter(tool => tool !== "desktop.click");
    saveConfig({ ...defaultConfig(), allow, enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, reconnectBackoffMs: 50 }, home);
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "machine"), token, { mode: 0o600 });
    relay.mint("unused", { machineToken: token });
    const env = machineEnv(home, { ROOM_MACHINE_DEADMAN_SECONDS: "30" });
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length === 1);
      relay.send({ type: "call", id: "click", tool: "desktop.click", args: { x: 1, y: 1 }, caller: lease("claim-allow", "desk") });
      await waitFor(() => relay.results.length === 1);
      assert.equal(relay.results[0].error.code, "tool_denied");
      const log = readFileSync(join(home, "argv-log"), "utf8");
      assert.equal(log.includes("tools/call"), false);
      assert.equal(log.includes("screencapture"), false);
    } finally {
      await daemon.stop();
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("shell.vm caps a slow command and a huge command inside the guest", async () => {
    const home = homeDir();
    const env = machineEnv(home);
    const state = { running: {}, snapshots: {} };
    await spawnContext.run({ env }, async () => {
      const slow = await (await import("../lib/tools.mjs")).dispatchTool({
        tool: "shell.vm", args: { command: "sleep-me", timeoutMs: 200 }, slot: "scratch", claimId: "scratch-1", state, home,
      });
      assert.equal(slow.ok, false);
      assert.equal(slow.error.code, "timeout");
      const huge = await (await import("../lib/tools.mjs")).dispatchTool({
        tool: "shell.vm", args: { command: "big-output", timeoutMs: 2000 }, slot: "scratch", claimId: "scratch-1", state, home,
      });
      assert.equal(huge.ok, false);
      assert.equal(huge.error.code, "output_capped");
    });
    rmSync(home, { recursive: true, force: true });
  });

  test("a mutating desktop call records a frame hash and does not capture the host screen", async () => {
    const home = homeDir();
    const relay = await startFakeRelay();
    const token = "tok-frame";
    saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, roomOrigin: "http://127.0.0.1", roomId: "commons", reconnectBackoffMs: 50 }, home);
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "machine"), token, { mode: 0o600 });
    relay.mint("unused", { machineToken: token });
    const env = machineEnv(home, { ROOM_MACHINE_DEADMAN_SECONDS: "30" });
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length === 1);
      relay.send({ type: "call", id: "click", tool: "desktop.click", args: { x: 2, y: 3 }, caller: lease("rec-1", "desk") });
      await waitFor(() => relay.results.some(result => result.id === "click"));
      assert.equal(relay.results.find(result => result.id === "click").ok, true);
      const manifest = readManifest(home, "rec-1");
      const { readdirSync } = await import("node:fs");
      const frames = join(home, "recordings", "rec-1", "frames");
      const file = readFileSync(join(frames, readdirSync(frames)[0]));
      const hash = createHash("sha256").update(file).digest("hex");
      assert.equal(manifest.at(-1).frameHash, hash);
      assert.equal(file.toString("utf8"), "frame-bytes");
      assert.equal(readFileSync(join(home, "argv-log"), "utf8").includes("screencapture"), false);
    } finally {
      await daemon.stop();
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a third macOS guest is refused, and a failed permission check is not reported as granted", async () => {
    const home = homeDir();
    const env = machineEnv(home);
    const state = { running: {} };
    await spawnContext.run({ env }, async () => {
      assert.equal((await startGuest(state, "desk")).ok, true);
      assert.equal((await startGuest(state, "scratch-a")).ok, true);
      const third = await startGuest(state, "scratch-b");
      assert.equal(third.ok, false);
      assert.equal(third.code, "guest_limit");
      writeFileSync(join(home, "grants.json"), JSON.stringify({ accessibility: false, screen_recording: true }));
      const notices = [];
      const golden = await prepareGolden({ home, state: { running: {} }, postNotice: async notice => notices.push(notice) });
      assert.equal(golden.ok, false);
      assert.notEqual(golden.grants?.accessibility, true);
      assert.match(notices[0], /Owner action needed: four toggles/);
    });
    const log = readFileSync(join(home, "argv-log"), "utf8");
    const runs = log.split("\n").filter(line => line.startsWith("lume \"run\""));
    assert.equal(runs.length, 4);
    rmSync(home, { recursive: true, force: true });
  });

  test("uninstall reverts pmset, the pf anchor, and the local-network defaults", async () => {
    const home = homeDir();
    // Disposable pf.conf: never touch the host's real /etc/pf.conf.
    const pfConf = join(home, "pf.conf");
    writeFileSync(pfConf, "scrub-anchor \"com.apple/*\"\n");
    const env = machineEnv(home, { ROOM_MACHINE_PF_CONF: pfConf });
    await spawnContext.run({ env }, async () => {
      const applied = await applySystemChanges(home);
      assert.equal(applied.ok, true);
      // The anchor reference was appended and the main ruleset reloaded.
      assert.match(readFileSync(pfConf, "utf8"), /^anchor "room\.machine"$/m);
      const reverted = await revertSystemChanges(home);
      assert.equal(reverted.ok, true);
      // The revert removed the reference again.
      assert.doesNotMatch(readFileSync(pfConf, "utf8"), /^anchor "room\.machine"$/m);
    });
    const log = readFileSync(join(home, "argv-log"), "utf8");
    assert.match(log, /pmset "-a" "disablesleep" "0"/);
    assert.match(log, /pmset "-a" "autorestart" "0"/);
    // W5-H2: the main ruleset is reloaded after the pf.conf edit, and the
    // revert reloads it again after removing the reference.
    assert.match(log, new RegExp(`pfctl "-f" ${JSON.stringify(pfConf).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(log, /pfctl "-a" "room\.machine" "-F" "all"/);
    assert.match(log, /defaults "delete" "com.apple.network.local-network" "AllowedEthernetLocalNetworkAddresses"/);
    assert.match(log, /defaults "delete" "com.apple.network.local-network" "AllowedWiFiLocalNetworkAddresses"/);
    rmSync(home, { recursive: true, force: true });
  });

  test("a failed pfctl -f reload rolls the pf.conf edit back", async () => {
    const home = homeDir();
    const pfConf = join(home, "pf.conf");
    const before = "scrub-anchor \"com.apple/*\"\n";
    writeFileSync(pfConf, before);
    writeFileSync(join(home, "pfctl-fail-f"), "");
    const env = machineEnv(home, { ROOM_MACHINE_PF_CONF: pfConf });
    await spawnContext.run({ env }, async () => {
      const applied = await applySystemChanges(home);
      assert.equal(applied.ok, false);
      assert.match(applied.error, /anchor reference not activated/);
      // No partial change left behind.
      assert.equal(readFileSync(pfConf, "utf8"), before);
    });
    rmSync(home, { recursive: true, force: true });
  });

  test("the machine token stays off argv, the child environment, and the hello body", async () => {
    const home = homeDir();
    const env = machineEnv(home);
    const canary = "tok-canary-9f3a";
    await spawnContext.run({ env }, () => saveSecret("machine", canary, home));
    const argv = readFileSync(join(home, "argv-log"), "utf8");
    const childEnv = readFileSync(join(home, "env-log"), "utf8");
    assert.equal(argv.includes(canary), false);
    assert.equal(childEnv.includes(canary), false);
    assert.equal(readFileSync(join(home, "security-stdin"), "utf8").includes(canary), true);
    const file = join(home, "secrets", "machine");
    assert.equal(readFileSync(file, "utf8"), canary);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const relay = await startFakeRelay();
    saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, reconnectBackoffMs: 50 }, home);
    relay.mint("unused", { machineToken: canary });
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length === 1);
      assert.equal(JSON.stringify(relay.hellos[0]).includes(canary), false);
      assert.equal(readFileSync(join(home, "argv-log"), "utf8").includes(canary), false);
      assert.equal(readFileSync(join(home, "env-log"), "utf8").includes(canary), false);
    } finally {
      await daemon.stop();
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("only the owner can spend an approval code, and only once before it expires", async (t) => {
    const { origin, ownerKey } = await serve(t);
    const home = homeDir();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const env = machineEnv(home, { ROOM_ORIGIN: origin });
    const relay = await startFakeRelay();
    t.after(() => relay.close());
    const invite = await post(origin, "/api/rooms/commons/agent-invites", { profile: "contribute", displayName: "Room machine" }, ownerKey);
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    relay.mint("once", {
      machineToken: "tok-approval",
      machineId: "mac-1",
      label: "spare",
      roomId: "commons",
      ownerMemberId: "owner",
      inviteCode: invite.json.code,
      displayName: "Room machine",
      relayUrl: relay.ws,
      roomOrigin: origin,
    });
    const enrolled = await spawnContext.run({ env }, async () => enroll({
      code: "once",
      home,
      env: { ...env, ROOM_MACHINE_RELAY_URL: relay.http },
      relayHttp: relay.http,
      insecure: true, // local fake relay over plain http
    }));
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    const secret = await spawnContext.run({ env }, () => readSecret("identity", home));
    const requested = await requestApproval({
      home, origin, roomId: "commons", secret, ownerMemberId: "owner", className: "shell.desk", detail: "desk shell",
    });
    assert.equal(requested.ok, true);
    const stranger = await post(origin, "/api/rooms/commons/commands", {
      id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: `approve ${requested.code}` },
    }, secret);
    assert.equal(stranger.status, 201, JSON.stringify(stranger.json));
    const ignored = await takeApproval({ home, origin, roomId: "commons", secret, code: requested.code });
    assert.equal(ignored.ok, false);
    assert.equal(ignored.reason, "approval_required");
    const owner = await post(origin, "/api/rooms/commons/commands", {
      id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: `approve ${requested.code}` },
    }, ownerKey);
    assert.equal(owner.status, 201, JSON.stringify(owner.json));
    const taken = await takeApproval({ home, origin, roomId: "commons", secret, code: requested.code });
    assert.equal(taken.ok, true);
    const again = await takeApproval({ home, origin, roomId: "commons", secret, code: requested.code });
    assert.equal(again.ok, false);
    assert.equal(again.reason, "approval_denied");
    writeFileSync(join(home, "approvals.json"), JSON.stringify({ old: { className: "shell.desk", ownerMemberId: "owner", expiresAt: Date.now() - 1000, used: false } }));
    const expired = await takeApproval({ home, origin, roomId: "commons", secret, code: "old" });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, "approval_denied");
  });

  test("doctor posts measured facts, and release closes the claim with at most ten blobs", async (t) => {
    const { origin, ownerKey } = await serve(t);
    const home = homeDir();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const relay = await startFakeRelay();
    t.after(() => relay.close());
    const invite = await post(origin, "/api/rooms/commons/agent-invites", { profile: "contribute", displayName: "Room machine" }, ownerKey);
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    relay.mint("desk-code", {
      machineToken: "tok-doctor-receipt",
      machineId: "mac-1",
      label: "spare",
      roomId: "commons",
      ownerMemberId: "owner",
      inviteCode: invite.json.code,
      displayName: "Room machine",
      relayUrl: relay.ws,
      roomOrigin: origin,
    });
    const env = machineEnv(home, {
      ROOM_MACHINE_RELAY_URL: relay.http,
      ROOM_MACHINE_DEADMAN_SECONDS: "30",
      ROOM_ORIGIN: origin,
    });
    const enrolled = await spawnContext.run({ env }, () => enroll({ code: "desk-code", home, env, relayHttp: relay.http, insecure: true }));
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    const secret = await spawnContext.run({ env }, () => readSecret("identity", home));
    const presence = await get(origin, "/api/agent-heartbeats", secret);
    assert.equal(presence.status, 200, JSON.stringify(presence.json));
    assert.equal(presence.json.hosts[0].hostId, "room-machine");
    assert.equal(presence.json.hosts[0].mode, "wakeable");
    const report = await spawnContext.run({ env }, () => doctorReport({ home }));
    assert.equal(report.ok, true, report.body);
    const arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
    assert.match(report.body, new RegExp(`arch: ${arch}`));
    assert.match(report.body, /macos: not measured/);
    assert.match(report.body, /chip: not measured/);
    assert.match(report.body, /lume: lume 0\.6\.0-fake/);
    assert.equal(report.body.includes("Apple M"), false);
    const events = await get(origin, "/api/rooms/commons/events?after=0&limit=100", secret);
    assert.equal(events.status, 200);
    assert.equal(events.json.events.some(entry => String(entry.event?.data?.body ?? "").includes(`arch: ${arch}`)), true);
    const created = await post(origin, "/api/rooms/commons/work-claims", {
      id: "lease1", title: "Desk", files: ["resource/mac-1/desk"], reviewPolicy: "self_attested",
    }, secret);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const claimed = await post(origin, "/api/rooms/commons/work-claims/lease1/claim", {}, secret);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
    const daemon = new MachineDaemon({ home, env });
    try {
      await spawnContext.run({ env }, () => daemon.start());
      await waitFor(() => relay.hellos.length >= 1);
      const caller = lease("lease1", "desk", enrolled.identityId);
      relay.send({ type: "call", id: "click", tool: "desktop.click", args: { x: 1, y: 1 }, caller });
      await waitFor(() => relay.results.some(result => result.id === "click"));
      assert.equal(relay.results.find(result => result.id === "click").ok, true);
      relay.send({ type: "call", id: "rel", tool: "machine.release", args: {}, caller });
      await waitFor(() => relay.results.some(result => result.id === "rel"));
      const released = relay.results.find(result => result.id === "rel");
      assert.equal(released.ok, true, JSON.stringify(released));
      assert.ok(released.result.blobs.length >= 1);
      assert.ok(released.result.blobs.length <= 10);
      assert.equal(released.result.closed, true, JSON.stringify(released));
      const done = await get(origin, "/api/rooms/commons/work-claims/lease1", secret);
      assert.equal(done.json.state, "done");
      assert.ok(done.json.blobs.length <= 10);
    } finally {
      await daemon.stop();
    }
  });

  test("the installer does nothing when the flag is off, and refuses an empty payload without sudo", () => {
    const home = homeDir();
    const offEnv = { ...process.env, HOME: home, PATH: `${fakes}:${process.env.PATH}`, ROOM_MACHINE_HOME: home };
    delete offEnv.ROOM_MACHINE_ENABLED;
    const off = spawnSync("bash", [join(repo, "machine/install.sh")], {
      env: offEnv,
      encoding: "utf8",
    });
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /room-machine is off/);
    assert.equal(existsSync(join(home, "sudo-called")), false);
    const stripped = readFileSync(join(repo, "machine/install.sh"), "utf8")
      .replace(/^PAYLOAD_SHA256=".*"$/m, 'PAYLOAD_SHA256=""')
      .replace(/^PAYLOAD_B64=".*"$/m, 'PAYLOAD_B64=""');
    const dir = mkdtempSync(join(tmpdir(), "room-machine-install-"));
    writeFileSync(join(dir, "install.sh"), stripped);
    const on = spawnSync("bash", [join(dir, "install.sh")], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakes}:${dirname(process.execPath)}:${process.env.PATH}`,
        ROOM_MACHINE_ENABLED: "1",
        ROOM_MACHINE_HOME: home,
      },
      encoding: "utf8",
    });
    assert.notEqual(on.status, 0);
    assert.match(`${on.stdout}\n${on.stderr}`, /payload sha256 is empty/);
    assert.equal(existsSync(join(home, "sudo-called")), false);
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

// L-3: files.put/files.get names must reject "." / ".." and leading-dot
// segments explicitly, not rely on the guest shell failing closed.
test("L-3: isSafeFileName rejects dot segments", () => {
  assert.equal(isSafeFileName("notes.txt"), true);
  assert.equal(isSafeFileName("a-b_c.d"), true);
  assert.equal(isSafeFileName("x".repeat(128)), true);
  assert.equal(isSafeFileName("."), false);
  assert.equal(isSafeFileName(".."), false);
  assert.equal(isSafeFileName(".hidden"), false);
  assert.equal(isSafeFileName(""), false);
  assert.equal(isSafeFileName("x".repeat(129)), false);
  assert.equal(isSafeFileName("../x"), false);
  assert.equal(isSafeFileName(null), false);
  assert.equal(isSafeFileName(42), false);
});

// L-5: runCommand must cap stderr the same way it caps stdout — a noisy
// child must not grow memory without bound over the timeout window.
test("L-5: runCommand caps stderr and marks the run capped", async () => {
  const maxBytes = 64 * 1024;
  const ran = await runCommand(process.execPath,
    ["-e", `process.stderr.write("e".repeat(${4 * maxBytes}))`],
    { maxBytes, timeoutMs: 10_000 });
  assert.equal(ran.capped, true);
  assert.ok(ran.stderr.length <= maxBytes,
    `stderr ${ran.stderr.length} bytes exceeds the ${maxBytes} cap`);
});

test("L-5: runCommand still resolves quiet commands uncapped", async () => {
  const ran = await runCommand(process.execPath, ["-e", "console.log('hi')"], { maxBytes: 1024 });
  assert.equal(ran.capped, false);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout.toString("utf8"), /hi/);
});
