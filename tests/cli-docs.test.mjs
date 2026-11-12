import test from "node:test";
import assert from "node:assert/strict";
import { docsCommand } from "../cli/commands/docs.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const connection = async () => ({ origin: "https://room.example", roomId: "room-one", secret: "synthetic" });
test("docs list preserves bounded continuation and emits JSON", async () => {
  let output;
  await docsCommand(["list", "--limit", "2", "--after", "brief"], { connection, out: value => output = JSON.parse(value), fetchImpl: async (url, options) => {
    assert.equal(url, "https://room.example/api/rooms/room-one/docs?limit=2&after=brief");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic");
    return Response.json({ docs: [], hasMore: true, nextAfter: "next" });
  } });
  assert.equal(output.nextAfter, "next");
});
test("docs stale writes preserve requested base and are not retried", async () => {
  let calls = 0;
  await assert.rejects(docsCommand(["write", "brief", "--title", "Brief", "--file", "draft.md", "--base-rev", "2"], { connection, readFile: () => "draft", fetchImpl: async (_url, options) => {
    calls++;
    assert.deepEqual(JSON.parse(options.body), { title: "Brief", body: "draft", baseRev: 2 });
    return Response.json({ error: { code: "doc_rev_conflict", message: "Read current revision" } }, { status: 409 });
  } }), /409 doc_rev_conflict/);
  assert.equal(calls, 1);
});
test("docs invalid input never loads credentials or sends a request", async () => {
  for (const args of [["read", "../secret"], ["list", "--limit", "501"], ["list", "--limit", "2", "--limit", "3"], ["write", "brief", "--title", "x", "--file", "x"]]) {
    await assert.rejects(docsCommand(args, { connection: () => { assert.fail("must validate first"); } }));
  }
});

test("CLI document is usable by a second authenticated agent and preserves stale edits", async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, roomDocsEnabled: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = fixture.store.identities.create("CLI author");
  const peer = fixture.store.identities.create("CLI peer");
  const call = async (path, secret, body) => fetch(origin + path, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await call("/api/agent-rooms", owner.secret, { roomId: "cli-docs", title: "CLI Docs", purpose: "synthetic", kind: "personal", displayName: "Author" })).status, 201);
  assert.equal((await call("/api/access-requests", peer.secret, { roomId: "cli-docs", identityId: peer.identityId, displayName: "Peer", requestedPermissions: ["accept_work"], note: null, requestId: "cli-docs-peer" })).status, 201);
  assert.equal((await call("/api/rooms/cli-docs/access-requests/cli-docs-peer/decide", owner.secret, { decision: "approve", permissions: ["accept_work"], note: null })).status, 200);
  const run = async (secret, args, body) => {
    let result;
    await docsCommand(args, { connection: async () => ({ origin, roomId: "cli-docs", secret }), readFile: () => body, out: text => { result = JSON.parse(text); } });
    return result;
  };
  const write = rev => ["write", "brief", "--title", "Brief", "--file", "synthetic.md", "--base-rev", String(rev)];
  const mcpRead = async (secret, rev) => {
    const response = await call("/mcp", secret, { jsonrpc: "2.0", id: "docs-parity", method: "tools/call", params: { name: "room_docs", arguments: { roomId: "cli-docs", docId: "brief", ...(rev ? { rev } : {}) } } });
    const result = await response.json();
    assert.equal(result.result?.isError, undefined, JSON.stringify(result));
    return result.result.structuredContent.doc;
  };
  assert.equal((await run(owner.secret, write(0), "original")).doc.rev, 1);
  assert.equal((await run(peer.secret, ["list"])).docs[0].docId, "brief");
  assert.equal((await run(peer.secret, ["read", "brief"])).doc.body, "original");
  assert.equal((await mcpRead(peer.secret)).body, "original");
  assert.equal((await run(peer.secret, write(1), "peer result")).doc.rev, 2);
  await assert.rejects(run(owner.secret, write(1), "stale draft"), /doc_rev_conflict/);
  assert.equal((await run(owner.secret, ["read", "brief"])).doc.body, "peer result");
  assert.equal((await run(owner.secret, ["read", "brief", "--rev", "1"])).doc.body, "original");
  assert.equal((await mcpRead(owner.secret)).body, "peer result");
  assert.equal((await mcpRead(owner.secret, 1)).body, "original");
});
