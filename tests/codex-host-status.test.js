import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexStatusWriter, readCodexHostStatus, stopCodexHost } from "../client/codex-host-status.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const cli = realpathSync("scripts/run-codex-room.mjs");
const waitFor = async check => { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw Error("Status wait timed out"); await delay(30); } };
function setup(t, account = { type: "chatgpt", email: "PRIVATE-ACCOUNT-DETAIL", planType: "plus" }, requiresOpenaiAuth = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-status-"))), home = join(root, "profile"), cwd = join(root, "workspace");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd);
  const command = join(root, "codex"), config = join(root, "runtime.json"), journal = join(root, "journal.sqlite");
  writeFileSync(command, `#!${process.execPath}
import readline from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
switch(m.method){case 'initialize':result={};break;case 'thread/start':result={thread:{id:'probe'}};break;case 'thread/name/set':result={};break;case 'thread/read':case 'thread/resume':result={thread:{id:m.params.threadId,turns:[]}};break;
case 'account/read':if(m.params.refreshToken!==false)throw Error('Unexpected token refresh');result=${JSON.stringify({ account, requiresOpenaiAuth })};break;
default:throw Error('Forbidden execution or unexpected method '+m.method);}
send({id:m.id,result});});`);
  chmodSync(command, 0o700);
  writeFileSync(config, JSON.stringify({ command, cwd, codexHome: home, policy: { approvalPolicy: "never", sandbox: "read-only" }, requestTimeoutMs: 1000 }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, journal, config };
}

test("preflight uses account metadata without model calls, refresh, or identity disclosure", t => {
  for (const [account, required, credentials] of [[{ type: "chatgpt", email: "PRIVATE-ACCOUNT-DETAIL", planType: "plus" }, true, "present"], [null, true, "login_required"], [null, false, "not_required"]]) {
    const f = setup(t, account, required);
    const result = spawnSync(process.execPath, [cli, "--preflight", f.config], { encoding: "utf8", timeout: 5000, env: { PATH: "/unavailable" } });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout); assert.equal(value.credentials, credentials); assert.equal(value.modelExecution, "not_tested");
    assert.equal(value.modelTurnExecuted, false); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-ACCOUNT-DETAIL|planType|apiKey/);
  }
});

test("status never turns stale or released ownership into a ready host; stop uses the owned control", t => {
  const f = setup(t), directory = `${f.journal}.watch`, owner = new WatchJournal(directory);
  const writer = createCodexStatusWriter(directory, { origin: "https://room.example", roomId: "room", memberId: "agent" });
  t.after(() => { writer.close(); owner.close(); });
  writer.event({ type: "host_readiness", credentials: "present", token: "PRIVATE-TOKEN" });
  let status = readCodexHostStatus(f.journal); assert.equal(status.fresh, true); assert.equal(status.credentials, "present");
  assert.doesNotMatch(readFileSync(join(directory, "status.json"), "utf8"), /PRIVATE-TOKEN/);
  assert.equal(statSync(join(directory, "status.json")).mode & 0o777, 0o600);
  status = readCodexHostStatus(f.journal, { now: Date.now() + 20000 });
  assert.equal(status.fresh, false); assert.equal(status.phase, "unknown"); assert.equal(status.credentials, "unknown");
  assert.equal(stopCodexHost(f.journal).stopRequested, true); assert.equal(owner.shouldStop(), true);
  owner.close(); writer.close();
  status = readCodexHostStatus(f.journal); assert.equal(status.phase, "stopped"); assert.equal(status.protocol, "unverified");
});

test("a new watcher cannot inherit the previous owner's qualified status", t => {
  const f = setup(t), directory = `${f.journal}.watch`, owner = new WatchJournal(directory);
  const writer = createCodexStatusWriter(directory, { origin: "https://room.example", roomId: "room", memberId: "agent" });
  writer.event({ type: "host_readiness", credentials: "present" });
  assert.equal(readCodexHostStatus(f.journal).fresh, true);
  writer.close(); owner.close();
  const replacement = new WatchJournal(directory);
  t.after(() => replacement.close());
  const status = readCodexHostStatus(f.journal);
  assert.equal(status.fresh, false); assert.equal(status.phase, "unknown");
  assert.equal(status.protocol, "unverified"); assert.equal(status.credentials, "unknown");
});

test("status rejects symlink substitution instead of reading outside its private directory", t => {
  const f = setup(t), directory = `${f.journal}.watch`, owner = new WatchJournal(directory);
  t.after(() => owner.close());
  const outside = join(f.root, "private.json"); writeFileSync(outside, '{"secret":"PRIVATE-SECRET"}', { mode: 0o600 });
  symlinkSync(outside, join(directory, "status.json"));
  assert.throws(() => readCodexHostStatus(f.journal), /private owned path/);
});

test("desktop CLI starts idle, publishes a fresh bounded heartbeat, and stops without a model turn", async t => {
  const f = setup(t), room = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: room.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); room.store.close(); });
  const connectionDir = join(f.root, "room"), origin = `http://127.0.0.1:${server.address().port}`;
  saveAgentConnection(connectionDir, { version: 1, origin, roomId: "commons", memberId: "producer", token: room.keys.producer });
  const child = spawn(process.execPath, [cli, "--watch", f.journal, f.config], { env: { ROOM_AGENT_CONFIG: connectionDir, PATH: "/unavailable", ROOM_HOST_SCOPE: JSON.stringify({ origin, roomId: "commons", memberId: "producer" }) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
  const finished = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => { child.kill("SIGTERM"); await finished; });
  await waitFor(() => { try { return readCodexHostStatus(f.journal).credentials === "present"; } catch { return false; } });
  const initial = readCodexHostStatus(f.journal); assert.equal(initial.pid, child.pid); assert.equal(initial.protocol, "qualified");
  await waitFor(() => readCodexHostStatus(f.journal).updatedAt !== initial.updatedAt);
  const listed = spawnSync(process.execPath, [cli, "--status-watch", f.journal], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout).fresh, true);
  const stopped = spawnSync(process.execPath, [cli, "--stop-watch", f.journal], { encoding: "utf8" });
  assert.equal(stopped.status, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).stopRequested, true);
  const result = await finished; assert.equal(result.code, 0, err);
  assert.equal(readCodexHostStatus(f.journal).phase, "stopped");
  assert.doesNotMatch(out + err, /PRIVATE-ACCOUNT-DETAIL|planType/);
});


for (const mismatch of ["origin", "roomId", "memberId", "malformed", "incomplete"]) {
  test(`desktop scope refuses ${mismatch} before opening a journal or provider`, t => {
    const f = setup(t), connectionDir = join(f.root, "room");
    const connection = { version: 1, origin: "https://fixture.invalid", roomId: "selected", memberId: "agent", token: "t".repeat(43) };
    saveAgentConnection(connectionDir, connection);
    const pinned = { origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId };
    if (mismatch === "incomplete") delete pinned.memberId;
    else if (mismatch !== "malformed") pinned[mismatch] += "-changed";
    const result = spawnSync(process.execPath, [cli, "--watch", f.journal, f.config], {
      encoding: "utf8", timeout: 2500,
      env: { PATH: "/unavailable", ROOM_AGENT_CONFIG: connectionDir,
        ROOM_HOST_SCOPE: mismatch === "malformed" ? "{" : JSON.stringify(pinned) }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Room connection changed; reconnect the agent in My Mac/);
    assert.equal(existsSync(f.journal), false, "refusal precedes journal and provider startup");
    assert.equal((result.stdout + result.stderr).includes(connection.token), false);
  });
}
