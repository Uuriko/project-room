import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }), requests = [], clients = [];
  t.after(async () => { for (const client of clients) await client.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  server.prependListener("request", req => requests.push({ method: req.method, path: req.url }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`, configDirectory = join(f.directory, "config"), attentionDirectory = join(f.directory, "attention");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });
  let revision = 0;
  return { ...f, requests, configDirectory, attentionDirectory,
    charter: purpose => f.store.command(f.keys.owner, "commons", { id: "instructions-" + revision, type: "room.charter_updated",
      data: { expectedRevision: revision++, purpose, outputs: null, boundaries: null, escalation: null } }),
    async mcp(enabled = true, attentionVersion) {
      const c = await openMcpTestClient(configDirectory, enabled ? { attentionDirectory, attentionVersion } : {});
      let closed = false; const original = c.close;
      c.close = async () => { if (!closed) { closed = true; return original(); } };
      clients.push(c); return c;
    },
    cli(args) { return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL("../scripts/agent-inbox.mjs", import.meta.url).pathname, "watch", ...args], { env: { ROOM_AGENT_CONFIG: configDirectory }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", x => stdout += x); child.stderr.on("data", x => stderr += x);
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    }); }
  };
}

test("real CLI pull survives restart; explicit ack differs from stdout and rejects stale IDs", { timeout: 20000 }, async t => {
  const f = await fixture(t); f.charter("Keep it brief");
  const before = f.store.snapshot(f.keys.producer, "commons");
  const run = await f.cli(["pull", f.attentionDirectory]); assert.equal(run.code, 0, run.stderr);
  assert.equal(f.requests.length, 13, "two observations plus the separate CLI startup check");
  const first = JSON.parse(run.stdout); assert.equal(first.items.length, 2);
  assert.deepEqual(JSON.parse((await f.cli(["pull", f.attentionDirectory])).stdout).items, first.items);
  const instruction = first.items.find(n => n.subject === "instructions");
  f.charter("An intentionally changed brief");
  assert.equal(JSON.parse((await f.cli(["ack", f.attentionDirectory, instruction.id])).stdout).status, "no_longer_current");
  const current = JSON.parse((await f.cli(["pull", f.attentionDirectory])).stdout);
  for (const item of current.items) assert.equal(JSON.parse((await f.cli(["ack", f.attentionDirectory, item.id])).stdout).status, "acknowledged");
  assert.equal(JSON.parse((await f.cli(["pull", f.attentionDirectory])).stdout).pending, 0);
  const status = JSON.parse((await f.cli(["status", f.attentionDirectory])).stdout);
  assert.equal(status.schemaVersion, 2); assert.equal(status.state, "stopped");
  const legacyStart = await f.cli(["start", f.attentionDirectory, "--once"]);
  assert.equal(legacyStart.code, 1); assert.match(legacyStart.stderr, /state_schema_mismatch/);
  const after = f.store.snapshot(f.keys.producer, "commons");
  assert.equal(after.sequence, before.sequence + 1); assert.equal(after.cursor, before.cursor); assert.deepEqual(after.state.workItems, before.state.workItems);
  assert.ok(f.requests.every(r => r.method === "GET"));
  for (const key of Object.values(f.keys)) assert.equal(JSON.stringify([first, current, legacyStart]).includes(key), false);
});

test("opt-in v3 CLI and MCP share request notices and exact acknowledgement across process restarts", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.store.command(f.keys.owner, "commons", { id: "request-notice", type: "message.posted",
    data: { messageId: "question", body: "PRIVATE question only in the scoped read", toMemberId: "producer", requestKind: "reply" } });
  const before = f.store.snapshot(f.keys.producer, "commons"), run = await f.cli(["pull", f.attentionDirectory, "--requests"]);
  assert.equal(run.code, 0, run.stderr);
  const initial = JSON.parse(run.stdout), request = initial.items.find(n => n.subject === "request");
  assert.equal(initial.schemaVersion, 3); assert.equal(initial.pending, 2); assert.equal(request.condition, "reply_requested");
  assert.equal(run.stdout.includes("PRIVATE question"), false);
  const wrongVersion = await f.cli(["pull", f.attentionDirectory]);
  assert.equal(wrongVersion.code, 1); assert.match(wrongVersion.stderr, /state_schema_mismatch/);
  const mcp = await f.mcp(true, 3);
  assert.equal((await mcp.request("tools/list")).result.tools.length, 26);
  assert.equal((await mcp.call("room_read_attention", { version: 3 })).error.code, -32602, "agent cannot select an operator inbox/version");
  assert.deepEqual((await mcp.call("room_read_attention")).result.structuredContent.items, initial.items);
  const context = (await mcp.call(request.nextRead.tool, request.nextRead.arguments)).result.structuredContent;
  assert.equal(context.request.id, "question"); assert.ok(context.current.answerBasis);
  assert.equal(context.page.items[0].message.body, "PRIVATE question only in the scoped read");
  assert.equal((await mcp.call("room_acknowledge_attention", { noticeId: request.id })).result.structuredContent.status, "acknowledged");
  await mcp.close();
  const ack = await f.cli(["ack", f.attentionDirectory, request.id, "--requests"]);
  assert.equal(ack.code, 0, ack.stderr); assert.equal(JSON.parse(ack.stdout).status, "already_acknowledged");
  const status = await f.cli(["status", f.attentionDirectory]);
  assert.equal(JSON.parse(status.stdout).schemaVersion, 3); assert.equal(JSON.parse(status.stdout).pending, 1);
  assert.deepEqual(f.store.snapshot(f.keys.producer, "commons"), before);
  assert.ok(f.requests.every(r => r.method === "GET"));
  const replacement = f.store.command(f.keys.owner, "commons", { id: "request-clarification", type: "message.posted",
    data: { messageId: "clarification", body: "An additional constraint", replyToId: "question" } });
  const stale = await f.cli(["ack", f.attentionDirectory, request.id, "--requests"]);
  assert.equal(JSON.parse(stale.stdout).status, "no_longer_current");
  const reopened = await f.mcp(true, 3), fresh = (await reopened.call("room_read_attention")).result.structuredContent.items.find(n => n.subject === "request");
  assert.notEqual(fresh.id, request.id); assert.equal(fresh.request.contextEventId, replacement.event.id);
});

test("optional real MCP pull/read-pointer/ack shares persisted identity with CLI and remains Room read-only", { timeout: 20000 }, async t => {
  const f = await fixture(t); f.charter("An exact synthetic instruction");
  const disabled = await f.mcp(false);
  assert.equal((await disabled.request("tools/list")).result.tools.length, 24);
  assert.equal((await disabled.call("room_read_attention")).error.code, -32602); await disabled.close();
  let mcp = await f.mcp(); const tools = (await mcp.request("tools/list")).result.tools;
  assert.equal(tools.length, 26); assert.ok(tools.slice(-2).every(t => t.annotations.readOnlyHint === false));
  assert.equal((await mcp.call("room_read_attention", { directory: "/not-operator-authorized" })).error.code, -32602);
  assert.equal((await mcp.call("room_acknowledge_attention", { noticeId: 1 })).error.code, -32602);
  const before = f.store.snapshot(f.keys.producer, "commons");
  f.requests.length = 0;
  const first = (await mcp.call("room_read_attention")).result.structuredContent; assert.equal(first.pending, 2);
  assert.equal(f.requests.length, 12, "pinned MCP pull keeps both observations with deduplicated anchors");
  for (const n of first.items) {
    const read = (await mcp.call(n.nextRead.tool, n.nextRead.arguments)).result.structuredContent;
    assert.equal(read.context?.charter?.revision ?? read.charter.revision, 1);
  }
  await mcp.close(); mcp = await f.mcp();
  assert.deepEqual((await mcp.call("room_read_attention")).result.structuredContent.items, first.items);
  const instruction = first.items[0];
  assert.equal((await mcp.call("room_acknowledge_attention", { noticeId: instruction.id })).result.structuredContent.status, "acknowledged");
  assert.equal(JSON.parse((await f.cli(["ack", f.attentionDirectory, instruction.id])).stdout).status, "already_acknowledged");
  const holding = new WatchJournal(f.attentionDirectory, { version: 2 });
  const busy = (await mcp.call("room_read_attention")).result; assert.equal(busy.isError, true); assert.equal(busy.structuredContent.code, "already_watching"); holding.close();
  assert.deepEqual(f.store.snapshot(f.keys.producer, "commons"), before);
  f.store.revoke(f.keys.producer);
  const revoked = (await mcp.call("room_acknowledge_attention", { noticeId: first.items[1].id })).result;
  assert.equal(revoked.isError, true); assert.equal(revoked.structuredContent.code, "access_ended");
  const observer = new WatchJournal(f.attentionDirectory, { acquire: false }); assert.equal(observer.status().pending, 1); observer.close();
  assert.ok(f.requests.every(r => r.method === "GET"));
});
