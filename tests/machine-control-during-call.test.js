import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnContext } from "../machine/lib/spawn.mjs";
import { defaultConfig, saveConfig } from "../machine/lib/config.mjs";
import { MachineDaemon } from "../machine/lib/daemon.mjs";
import { startFakeRelay } from "../machine/test/fake-relay.mjs";

// A Halt or Pause must reach the daemon while a call is still running. Calls
// can take minutes (an owner approval wait, a slow guest command); a control
// frame queued behind one lands only after that call has acted, while the
// relay has already told the caller the machine was halted.
const fakes = fileURLToPath(new URL("../machine/fakes/", import.meta.url));

function machineEnv(home, extra = {}) {
  return {
    PATH: `${fakes}:${process.env.PATH}`, HOME: home, TMPDIR: home, LANG: "C", LC_ALL: "C",
    USER: "room", LOGNAME: "room", TERM: "dumb", ROOM_MACHINE_ENABLED: "1", ROOM_MACHINE_HOME: home,
    ROOM_MACHINE_DEADMAN_SECONDS: "30", ...extra,
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

const caller = (claimId, slot) => ({ identityId: "ai_caller", claimId, slot, verified: true });

async function startDaemon(t, { token, config = {}, env: extra = {} }) {
  const home = mkdtempSync(join(tmpdir(), "room-machine-control-"));
  writeFileSync(join(home, "argv-log"), "");
  writeFileSync(join(home, "env-log"), "");
  const relay = await startFakeRelay();
  saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare", relayUrl: relay.ws, reconnectBackoffMs: 50, ...config }, home);
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets", "machine"), token, { mode: 0o600 });
  writeFileSync(join(home, "secrets", "identity"), "rak_test_identity", { mode: 0o600 });
  relay.mint("unused", { machineToken: token });
  const env = machineEnv(home, extra);
  const daemon = new MachineDaemon({ home, env });
  t.after(async () => {
    await daemon.stop();
    await relay.close();
    rmSync(home, { recursive: true, force: true });
  });
  await spawnContext.run({ env }, () => daemon.start());
  assert.ok(await waitFor(() => relay.hellos.length === 1), "daemon linked");
  return { home, relay, daemon };
}

test("a halt is applied while a slow call is still running", async t => {
  const { relay, daemon } = await startDaemon(t, { token: "tok-control-slow" });
  relay.send({ type: "call", id: "slow", tool: "shell.vm", args: { command: "sleep-me", timeoutMs: 2500 }, caller: caller("slow-1", "scratch") });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(relay.results.length, 0, "the slow call is still running");
  relay.send({ type: "halt", epoch: 1 });
  assert.ok(await waitFor(() => daemon.state.halted === true, 1000), "the halt landed before the slow call finished");
  assert.equal(relay.results.length, 0, "and the slow call had not finished yet");
  assert.ok(await waitFor(() => relay.results.some(result => result.id === "slow"), 5000), "the slow call still answers");
  relay.send({ type: "call", id: "after", tool: "machine.status", args: {}, caller: caller("slow-1", "scratch") });
  assert.ok(await waitFor(() => relay.results.some(result => result.id === "after")));
  assert.equal(relay.results.find(result => result.id === "after").error.code, "halted");
});

test("a call approved after the owner halted is refused, not run", async t => {
  const posts = [];
  let approve = null;
  const room = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url.pathname === "/api/rooms/commons/commands") {
        posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).data.body);
        res.writeHead(201).end("{}");
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/rooms/commons/events") {
        const events = approve ? [{ type: "message.posted", actorId: "owner", data: { body: `approve ${approve}` } }] : [];
        res.writeHead(200).end(JSON.stringify({ events, next: events.length }));
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise(resolve => room.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => room.close(resolve)));
  const origin = `http://127.0.0.1:${room.address().port}`;
  const { home, relay, daemon } = await startDaemon(t, {
    token: "tok-control-approval",
    config: { roomOrigin: origin, roomId: "commons", ownerMemberId: "owner" },
    env: { ROOM_MACHINE_APPROVAL_WAIT_MS: "5000" },
  });
  relay.send({ type: "call", id: "desk", tool: "shell.vm", args: { command: "approved-after-halt", timeoutMs: 2000 }, caller: caller("desk-1", "desk") });
  assert.ok(await waitFor(() => posts.length === 1), "the daemon asked the owner");
  const code = /^approve ([0-9a-f]{32}) /.exec(posts[0])?.[1];
  assert.ok(code, posts[0]);
  relay.send({ type: "halt", epoch: 1 });
  await waitFor(() => daemon.state.halted === true, 1000);
  approve = code;
  assert.ok(await waitFor(() => relay.results.some(result => result.id === "desk"), 6000), "the call answers");
  const result = relay.results.find(item => item.id === "desk");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "halted");
  assert.equal(readFileSync(join(home, "argv-log"), "utf8").includes("approved-after-halt"), false, "the guest command never ran");
});
