// RC-2026-09-19-079 (QAU-003): connectors/muse.md is an executable
// contract — its request examples must return 2xx as written. This test
// parses the brief's own markdown in document order, substitutes the
// documented placeholders with live values, runs every example against a
// real server, and fails on anything but 2xx so brief drift is caught here
// instead of by a user. Illustrative response-shape blocks (no type/data
// keys) are skipped; everything else is executed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const brief = readFileSync(new URL("../connectors/muse.md", import.meta.url), "utf8");

// Collect, in document order: every backticked `GET /api/rooms/{roomId}/…`
// path and every ```json block shaped like a command body ({ id, type, data }).
function collectExamples() {
  const gets = [], commands = [];
  const lines = brief.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const get = /`GET (\/api\/rooms\/\{roomId\}\/[^`]+)`/.exec(lines[i]);
    if (get) { gets.push({ line: i + 1, path: get[1] }); continue; }
    if (lines[i].trim() === "```json") {
      const block = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "```") block.push(lines[j++]);
      assert.ok(j < lines.length, `unclosed json block at line ${i + 1}`);
      i = j;
      let parsed;
      try { parsed = JSON.parse(block.join("\n")); }
      catch { continue; } // Illustrative response shape with {...} elisions — not executable.
      if (typeof parsed?.type === "string" && parsed.data && typeof parsed.data === "object") {
        commands.push({ line: i + 1, raw: block.join("\n") });
      }
      // Anything else is an illustrative response shape — not executable.
    }
  }
  return { gets, commands };
}

test("connector brief: every example returns 2xx against the real API", async t => {
  const { gets, commands } = collectExamples();
  // The brief documents 5 request bodies and 5 request lines; if an editor
  // adds or removes one, this number must be updated deliberately.
  assert.equal(commands.length, 5, `expected 5 command examples, found ${commands.length}`);
  assert.equal(gets.length, 5, `expected 5 GET examples, found ${gets.length}`);

  const f = createAcceptanceFixture();
  const signEvidence = makeTestSigner(f.store);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const key = f.keys.owner; // fixture owner: full permissions
  const roomId = "commons", memberId = "owner";

  const post = body => fetch(`${origin}/api/rooms/${roomId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const get = path => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${key}` } });

  // Execution context: placeholders resolve to values produced by earlier
  // examples, in document order — exactly how a connector client would work.
  // GETs and POSTs interleave in the brief, so merge both kinds by line.
  const ctx = { lastMessageId: null, workItemId: null };
  const substitute = raw => raw
    .replaceAll("<uuid>", () => randomUUID())
    .replaceAll("<workItemId>", () => (ctx.workItemId ??= randomUUID()))
    .replaceAll("<memberId>", memberId)
    .replaceAll("{roomId}", roomId)
    .replaceAll("{messageId}", () => {
      assert.ok(ctx.lastMessageId, "GET thread example needs a message posted earlier in the brief");
      return ctx.lastMessageId;
    })
    .replaceAll("<messageId>", () => {
      assert.ok(ctx.lastMessageId, "reply example needs a message posted earlier in the brief");
      return ctx.lastMessageId;
    });

  const ordered = [
    ...commands.map(c => ({ kind: "command", line: c.line, raw: c.raw })),
    ...gets.map(g => ({ kind: "get", line: g.line, path: g.path })),
  ].sort((a, b) => a.line - b.line);

  for (const step of ordered) {
    if (step.kind === "command") {
      const body = JSON.parse(substitute(step.raw));
      // The brief's work.completed example carries a placeholder for
      // signedEvidence; the test injects a real signature so the example
      // exercises the live 2xx path against the current server.
      if (body.type === "work.completed") body.data.signedEvidence = signEvidence();
      const res = await post(body);
      const text = await res.text();
      assert.ok(res.status === 201 || res.status === 200,
        `brief command (line ${step.line}, ${body.type}) returned ${res.status}: ${text}`);
      const result = JSON.parse(text);
      // A real connector client learns ids from the POST response: the
      // event id is the message id when the example sends no explicit
      // messageId (postMessage falls back to the event id).
      if (body.type === "message.posted") ctx.lastMessageId = body.data.messageId ?? result.event?.id;
      assert.ok(ctx.lastMessageId, "message.posted must yield a message id");
      if (body.type === "work.proposed") assert.equal(ctx.workItemId, body.data.workItemId, "propose example sets the shared workItemId");
    } else {
      const path = substitute(step.path);
      const res = await get(path);
      assert.equal(res.status, 200, `brief GET (line ${step.line}, ${path}) returned ${res.status}: ${await res.text()}`);
    }
  }
});

test("served Muse guide uses the room origin and recovers an exact formal answer", async t => {
  const fixture = createAcceptanceFixture();
  const { store } = fixture;
  const owner = store.identities.create("Guide owner");
  const producer = store.identities.create("Guide reader");
  const { roomId, ownerMemberId } = new AgentRooms(store).create(owner.secret, {
    roomId: "connector-guide", title: "Connector guide", purpose: "Test an exact reply", kind: "personal",
    displayName: "Guide owner"
  });
  linkWithProof(store, owner.secret, roomId, producer, { displayName: "Guide reader", permissions: [] });
  store.dmConsents.request(roomId, ownerMemberId, producer.identityId, "Fixture request");
  store.dmConsents.decide(roomId, producer.identityId, ownerMemberId, "approve");
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const served = await fetch(`${origin}/connectors/muse.md`);
  assert.equal(served.status, 200);
  const guide = await served.text();
  const originLine = guide.match(/^- \*\*Room origin:\*\* `([^`]+)`/m);
  assert.equal(originLine?.[1], "<ROOM_ORIGIN>");
  assert.doesNotMatch(guide, /room\.trydemigod\.com/);
  const endpoint = guide.match(/^- \*\*MCP:\*\* `POST ([^`]+)`/m)?.[1];
  assert.equal(endpoint, "<ROOM_ORIGIN>/mcp");
  const steps = Array.from(guide.matchAll(/^\d+\. `(room_[a-z_]+)`/gm), row => row[1]);
  const [checkAccess, findRequest, readRequest, answerRequest, checkReceipt] = steps;
  assert.equal(steps.length, 5);

  async function send(key, tool, args = {}) {
    const response = await fetch(endpoint.replace("<ROOM_ORIGIN>", origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: tool, arguments: { roomId, ...args } } })
    });
    assert.equal(response.status, 200, tool);
    return response;
  }
  async function call(key, tool, args) {
    const value = await (await send(key, tool, args)).json();
    assert.ok(!value.error && !value.result?.isError, `${tool}: ${JSON.stringify(value)}`);
    return value.result.structuredContent;
  }

  const access = await call(producer.secret, checkAccess);
  assert.equal(access.memberId, producer.identityId);
  const opened = await call(owner.secret, "room_request_reply", {
    requestId: randomUUID(), toMemberId: access.memberId, body: "What did the connector test verify?"
  });
  const next = await call(producer.secret, findRequest);
  const selected = next.requests.items.find(item => item.id === opened.requestMessageId);
  assert.equal(selected?.nextRead.tool, readRequest);
  const exact = await call(producer.secret, selected.nextRead.tool, selected.nextRead.arguments);
  assert.equal(exact.request.status, "open");
  const action = exact.responseActions.find(entry => entry.arguments.responseOutcome === "answered");
  assert.equal(action?.tool, answerRequest);

  const operationId = randomUUID();
  const write = await send(producer.secret, action.tool, {
    ...action.arguments, requestId: operationId, body: "Verified access and my exact tracked request."
  });
  await write.body.cancel(); // The client loses the answer response after sending it.
  const receipt = await call(producer.secret, checkReceipt, { operationId });
  assert.equal(receipt.status, "recorded");
  assert.equal(receipt.operationId, operationId);
  const settled = await call(producer.secret, readRequest, { requestMessageId: opened.requestMessageId });
  assert.equal(settled.request.status, "answered");
  const answers = settled.page.items.filter(item => item.kind === "answered");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].eventId, receipt.eventId);
});
