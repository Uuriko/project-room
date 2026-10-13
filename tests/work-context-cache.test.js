import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { readResumablePreparation } from "../client/work-context-cache.mjs";
import { auditRecovery } from "../server/recovery.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(); let store = f.store, server, port;
  const start = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(port ?? 0, "127.0.0.1", resolve)); port = server.address().port;
  };
  const stop = async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  };
  await start();
  t.after(async () => { await stop(); rmSync(f.directory, { recursive: true, force: true }); });
  const connection = { version: 1, origin: `http://127.0.0.1:${port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const directory = join(f.directory, "connection"); saveAgentConnection(directory, connection);
  const options = { directory, connection }, client = new RoomAgentClient({ ...connection,
    fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Connection: "close" } }) });
  let at = Date.now(); store.now = () => at;
  const send = (type, data) => { at += 2000; return store.command(f.keys.owner, "commons", { id: randomUUID(), type, data }); };
  const post = (id, body = id) => send("message.posted", { messageId: id, body, workItemId: "test-handoff" });
  const files = () => readdirSync(join(directory, "task-context")).filter(name => name.endsWith(".json")).map(name => join(directory, "task-context", name));
  return { ...f, connection, directory, options, client, send, post, files, store: () => store,
    read: extra => readResumablePreparation(client, "test-handoff", { ...options, ...extra }),
    restart: async () => { await stop(); store = new RoomStore(join(f.directory, "room.sqlite")); store.now = () => at; await start(); } };
}
const bodies = result => result.discussion.items.map(row => row.message.body);

test("retained discussion survives service/client restart and appends without rereading old text", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 30; n++) f.post(`history-${n}`, `History ${n} ` + "x".repeat(1000));
  const before = auditRecovery(f.store()).dataSha256;
  const first = await f.read();
  assert.equal(first.continuation.reused, false);
  assert.equal(auditRecovery(f.store()).dataSha256, before, "only private local cache writes");
  assert.equal(lstatSync(join(f.directory, "task-context")).mode & 0o077, 0);
  assert.equal(lstatSync(f.files()[0]).mode & 0o077, 0);
  assert.equal(readFileSync(f.files()[0], "utf8").includes(f.connection.token), false);
  await f.restart(); f.post("later", "A new contribution");
  const second = await readResumablePreparation(new RoomAgentClient(f.connection), "test-handoff", f.options);
  assert.equal(second.continuation.reused, true); assert.equal(second.continuation.deltaItems, 1);
  assert.deepEqual(bodies(second), [...bodies(first), "A new contribution"]);
  assert.ok(second.continuation.receivedBytes < first.continuation.receivedBytes / 2);
  t.diagnostic(`Controlled discussion bytes: full ${first.continuation.receivedBytes}, resumed ${second.continuation.receivedBytes}; retained ${second.continuation.retainedItems}, delta ${second.continuation.deltaItems}`);
  f.send("room.charter_updated", { expectedRevision: f.store().room("commons").state.room.charter?.revision ?? 0,
    purpose: "Use the revised instructions", outputs: null, boundaries: null, escalation: null });
  const third = await f.read(); assert.equal(third.continuation.deltaItems, 0); assert.deepEqual(bodies(third), bodies(second));
  assert.equal(third.instructions.charter.purpose, "Use the revised instructions");
  assert.equal(third.changedDuringRead, false); assert.equal(third.eventsAfterDiscussion, false);
});

test("resumed output uses fresh viewer permissions and outstanding request metadata", async t => {
  const f = await fixture(t); const first = await f.read();
  f.send("member.access_changed", { memberId: "producer", expectedMemberRevision: first.viewer.revision, permissions: [], active: true });
  f.send("message.posted", { messageId: "current-ask", body: "Please clarify", toMemberId: "producer", requestKind: "reply", workItemId: "test-handoff" });
  const current = await f.read();
  assert.deepEqual(current.viewer.permissions, []); assert.equal(current.viewer.revision, first.viewer.revision + 1);
  assert.equal(current.replyRequestContext.requests[0].id, "current-ask");
  const persisted = JSON.parse(readFileSync(f.files()[0], "utf8"));
  assert.equal(Object.hasOwn(persisted, "viewer"), false); assert.equal(Object.hasOwn(persisted, "replyRequestContext"), false);
});

test("edits and deletion invalidate retained text before a bounded full reread", async t => {
  const f = await fixture(t); f.post("mutable", "Earlier words"); await f.read();
  f.send("message.edited", { messageId: "mutable", body: "Revised words", expectedMessageRevision: 0 });
  const revised = await f.read(); assert.equal(revised.continuation.reset, true); assert.equal(revised.continuation.reused, false);
  assert.ok(bodies(revised).includes("Revised words")); assert.ok(!bodies(revised).includes("Earlier words"));
  f.send("message.deleted", { messageId: "mutable", expectedMessageRevision: 1 });
  const deleted = await f.read(); assert.equal(deleted.continuation.reset, true);
  assert.ok(!bodies(deleted).includes("Revised words")); assert.ok(!readFileSync(f.files()[0], "utf8").includes("Revised words"));
});

test("partial page and byte/deadline failures never advance the completed cache", async t => {
  const f = await fixture(t); await f.read(); const file = f.files()[0], original = readFileSync(file, "utf8");
  for (let n = 0; n < 60; n++) f.post(`more-${n}`);
  await assert.rejects(f.read({ maxPages: 1 }), { code: "context_cache_limit" });
  assert.equal(readFileSync(file, "utf8"), original);
  await assert.rejects(f.read({ maxBytes: 1024 }), { code: "context_cache_limit" });
  // Oversized existing records are discarded, so establish a fresh completed record.
  await f.read(); const completed = readFileSync(f.files()[0], "utf8");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.read({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(readFileSync(f.files()[0], "utf8"), completed);
  const slow = new RoomAgentClient({ ...f.connection, fetchImpl: async (url, options) => {
    await new Promise(resolve => setTimeout(resolve, 25)); return fetch(url, options);
  } });
  await assert.rejects(readResumablePreparation(slow, "test-handoff", { ...f.options, deadlineMs: 5 }));
  assert.equal(readFileSync(f.files()[0], "utf8"), completed);
});

test("final authorization scope change invalidates the cache and failed access returns no saved text", async t => {
  const f = await fixture(t); f.post("private-context", "Old private context"); await f.read();
  let contexts = 0;
  const changing = {
    workDiscussion: (...args) => f.client.workDiscussion(...args),
    workContext: async (...args) => {
      const result = await f.client.workContext(...args);
      if (++contexts === 2) result.viewer.revision++;
      return result;
    }
  };
  await assert.rejects(readResumablePreparation(changing, "test-handoff", f.options), { code: "context_scope_changed" });
  assert.deepEqual(f.files(), []);
  await f.read(); f.store().issueAccessKey("commons", "producer");
  await assert.rejects(f.read(), error => [401, 403].includes(error.status));
});

test("cache corruption is discarded; credential/member scope cannot reuse another saved discussion", async t => {
  const f = await fixture(t); f.post("integrity", "Original text"); await f.read();
  const file = f.files()[0], value = JSON.parse(readFileSync(file, "utf8"));
  value.discussion.items[0].message.body = "Corrupted local text"; writeFileSync(file, JSON.stringify(value));
  const repaired = await f.read(); assert.equal(repaired.continuation.reset, true); assert.ok(!bodies(repaired).includes("Corrupted local text"));
  for (const malformed of ["invalid JSON", "null", "42", "[]"]) {
    writeFileSync(file, malformed);
    const recovered = await f.read();
    assert.equal(recovered.continuation.reset, true, `discard malformed root: ${malformed}`);
    assert.ok(bodies(recovered).includes("Original text"));
  }
  const other = { ...f.connection, memberId: "reviewer", token: f.keys.reviewer };
  const next = await readResumablePreparation(new RoomAgentClient(other), "test-handoff", { ...f.options, connection: other });
  assert.equal(next.continuation.reused, false); assert.equal(f.files().length, 2);
});

test("a page crossing viewer scope refuses retained content and invalidates the local record", async t => {
  const f = await fixture(t); await f.read();
  const crossing = { workContext: (...args) => f.client.workContext(...args), workDiscussion: async (...args) => {
    const result = await f.client.workDiscussion(...args); result.viewerId = "reviewer"; return result;
  } };
  await assert.rejects(readResumablePreparation(crossing, "test-handoff", f.options), { code: "context_scope_changed" });
  assert.deepEqual(f.files(), []);
});

test("symlinks are refused and failed persistence cannot report a completed preparation", async t => {
  const f = await fixture(t); await f.read(); const file = f.files()[0];
  const target = join(f.directory, "outside"); writeFileSync(target, "untouched", { mode: 0o600 });
  unlinkSync(file); symlinkSync(target, file);
  await assert.rejects(f.read(), { code: "context_cache_not_private" });
  assert.equal(readFileSync(target, "utf8"), "untouched"); unlinkSync(file);
  let contexts = 0;
  const broken = { workDiscussion: (...args) => f.client.workDiscussion(...args), workContext: async (...args) => {
    const result = await f.client.workContext(...args);
    if (++contexts === 2) mkdirSync(file, { mode: 0o700 });
    return result;
  } };
  await assert.rejects(readResumablePreparation(broken, "test-handoff", f.options), { code: "context_cache_not_private" });
  assert.equal(lstatSync(file).isDirectory(), true);
  assert.equal(readdirSync(join(f.directory, "task-context")).some(name => name.endsWith(".tmp")), false);
});

test("disk persistence failure leaves the old completed cache byte-identical", async t => {
  const f = await fixture(t); await f.read(); const file = f.files()[0], before = readFileSync(file, "utf8");
  f.post("new-not-persisted");
  const stub = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("Synthetic disk full"), { code: "ENOSPC" }); });
  syncBuiltinESMExports();
  try { await assert.rejects(f.read(), { code: "ENOSPC" }); }
  finally { stub.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readdirSync(join(f.directory, "task-context")).some(name => name.endsWith(".tmp")), false);
  const retry = await f.read(); assert.equal(retry.continuation.deltaItems, 1); assert.ok(bodies(retry).includes("new-not-persisted"));
});

test("existing preflight CLI opts into durable resume while numeric checkpoints keep their old behavior", async t => {
  const f = await fixture(t), cwd = join(f.directory, "checkout"); mkdirSync(cwd);
  const git = args => { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
  git(["init", "--quiet"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const script = new URL("../scripts/agent-work-preflight.mjs", import.meta.url).pathname;
  const run = mode => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, f.directory, "test-handoff", mode], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("close", code => { try { assert.equal(code, 2, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
  });
  const first = await run("--resume"); assert.equal(first.preparation.continuation.reused, false);
  f.post("cli-later");
  const next = await run("--resume"); assert.equal(next.preparation.continuation.reused, true);
  assert.equal(next.preparation.continuation.deltaItems, 1); assert.ok(bodies(next.preparation).includes("cli-later"));
  assert.equal(JSON.stringify(next).includes(f.connection.token), false);
  const legacy = await run(String(next.preparation.discussion.checkpoint));
  assert.deepEqual(legacy.preparation.discussion.items, []); assert.equal(legacy.preparation.continuation, undefined);
});
