// Requested-mode recovery reported by the Windows Codex contributor
// ai_v2FbsDdkifUlYyoH; follows their eight-case mock-RPC proposal.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentHost } from "../room-acp/src/agent-host.mjs";
import { renderTurn } from "../room-acp/src/render.mjs";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { createPeer } from "../room-acp/src/jsonrpc.mjs";

const prompt = [{ type: "text", text: "synthetic task" }];

test("a delayed ACP pipe error retires the peer and rejects all pending requests", async () => {
  const input = new PassThrough();
  const frames = [];
  let retired = 0;
  const output = new Writable({
    write(frame, _encoding, done) {
      frames.push(frame.toString());
      setImmediate(() => done(Object.assign(new Error("fixture pipe closed"), { code: "EPIPE" })));
    },
  });
  const peer = createPeer({ input, output, onTransportError: () => { retired++; } });
  try {
    await Promise.all([
      assert.rejects(peer.request("session/prompt"), { code: -32000, message: "connection failed" }),
      assert.rejects(peer.request("session/load"), { code: -32000, message: "connection failed" }),
    ]);
    assert.equal(peer.closed, true);
    assert.equal(retired, 1);
    assert.equal(peer.notify("session/cancel"), false);
    await assert.rejects(peer.request("session/new"), { code: -32000, message: "connection closed" });
    assert.deepEqual(frames.map(frame => JSON.parse(frame).method), ["session/prompt"]);
  } finally {
    peer.close();
    input.destroy();
  }
});

function mockHost({ saved = null, mode = "read-only", loadError = null, modeError = null } = {}) {
  const calls = [], writes = [], logs = [];
  const savedSessions = new Map(saved ? [["thread", saved]] : []);
  const originalSet = savedSessions.set.bind(savedSessions);
  savedSessions.set = (key, value) => { writes.push([key, value]); return originalSet(key, value); };
  const host = new AgentHost({ candidate: {}, mode, savedSessions, log: text => logs.push(text) });
  host.capabilities = { loadSession: true };
  host.process = { peer: { async request(method, params, options) {
    calls.push({ method, params, options });
    if (method === "session/load" && loadError) throw loadError;
    if (method === "session/new") return { sessionId: "new-session" };
    if (method === "session/set_mode" && modeError) throw modeError;
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  } } };
  return { host, calls, writes, logs, savedSessions };
}

for (const saved of [null, "saved-session"]) {
  const label = saved ? "loaded" : "new";
  test(`${label} session applies requested mode before prompt and caches only success`, async () => {
    const f = mockHost({ saved });
    const result = await f.host.session("thread");
    const sessionId = saved ?? "new-session";
    assert.deepEqual(result, saved
      ? { sessionId, created: false, loaded: true }
      : { sessionId, created: true });
    await f.host.prompt("thread", prompt);
    assert.deepEqual(f.calls.map(call => call.method), [saved ? "session/load" : "session/new", "session/set_mode", "session/prompt"]);
    assert.deepEqual(f.calls[1].params, { sessionId, modeId: "read-only" });
    assert.equal(f.calls[1].options.timeoutMs, 15000);
    assert.equal(f.host.sessions.get("thread"), sessionId);
    assert.equal(f.host.threadOf.get(sessionId), "thread");
    assert.deepEqual(f.writes, saved ? [] : [["thread", sessionId]]);
    assert.equal(f.host.recorders.size, 0);
  });

  test(`${label} session mode refusal never prompts, caches, or falls back`, async () => {
    const refused = Object.assign(new Error("requested mode refused"), { code: -32602 });
    const f = mockHost({ saved, modeError: refused });
    await assert.rejects(f.host.prompt("thread", prompt), error => error === refused);
    assert.deepEqual(f.calls.map(call => call.method), [saved ? "session/load" : "session/new", "session/set_mode"]);
    assert.equal(f.host.sessions.size, 0);
    assert.equal(f.host.threadOf.size, 0);
    assert.equal(f.host.recorders.size, 0);
    assert.deepEqual(f.writes, []);
    assert.equal(f.savedSessions.get("thread"), saved ?? undefined);
    assert.deepEqual(f.logs, [], "mode refusal must not be reported as a load failure");
  });

  test(`${label} session with null mode preserves the adapter default`, async () => {
    const f = mockHost({ saved, mode: null });
    await f.host.prompt("thread", prompt);
    assert.deepEqual(f.calls.map(call => call.method), [saved ? "session/load" : "session/new", "session/prompt"]);
  });
}

for (const refused of [false, true]) {
  test(`failed load starts fresh but ${refused ? "does not bypass a refused" : "still applies the requested"} mode`, async () => {
    const modeError = refused ? new Error("requested mode refused") : null;
    const f = mockHost({ saved: "saved-session", loadError: new Error("session expired"), modeError });
    if (refused) await assert.rejects(f.host.prompt("thread", prompt), error => error === modeError);
    else await f.host.prompt("thread", prompt);
    assert.deepEqual(f.calls.map(call => call.method), ["session/load", "session/new", "session/set_mode", ...(refused ? [] : ["session/prompt"])]);
    assert.equal(f.host.recorders.size, 0);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /session expired/);
    assert.deepEqual(f.writes, refused ? [] : [["thread", "new-session"]]);
    assert.equal(f.savedSessions.get("thread"), refused ? "saved-session" : "new-session");
    assert.equal(f.host.sessions.size, refused ? 0 : 1);
  });
}

test("existing fake ACP subprocess accepts mode on a new and recovered session", async t => {
  const agent = fileURLToPath(new URL("../room-acp/fixtures/fake-agent.mjs", import.meta.url));
  const savedSessions = new Map();
  const options = { candidate: { command: process.execPath, args: [agent] }, env: {}, mode: "read-only", savedSessions };
  const first = new AgentHost(options);
  t.after(() => first.stop());
  await first.start();
  const session = await first.session("thread");
  assert.equal(renderTurn((await first.prompt("thread", prompt)).recorder), "echo: synthetic task");
  first.stop();
  const resumed = new AgentHost(options);
  t.after(() => resumed.stop());
  await resumed.start();
  assert.deepEqual(await resumed.session("thread"), { sessionId: session.sessionId, created: false, loaded: true });
  assert.equal(renderTurn((await resumed.prompt("thread", prompt)).recorder), "echo: synthetic task");
});

test("idle eviction waits for close before loading the same saved thread", async () => {
  const f = mockHost({ saved: "older-session", mode: null });
  f.savedSessions.set("warm", "warm-session");
  f.savedSessions.set("busy", "busy-session");
  await f.host.session("thread");
  await f.host.session("warm");
  await f.host.session("busy");
  const idle = key => key === "busy";
  await f.host.trimIdleSessions(1, idle);
  assert.equal(f.calls.some(call => call.method === "session/close"), false, "unsupported close is never called");
  f.host.capabilities.closeSession = true;
  const close = Promise.withResolvers();
  const request = f.host.process.peer.request;
  f.host.process.peer.request = (method, params, options) => {
    if (method !== "session/close") return request(method, params, options);
    f.calls.push({ method, params, options });
    return close.promise;
  };
  const trim = f.host.trimIdleSessions(1, idle);
  const reenter = f.host.session("thread");
  await Promise.resolve();
  assert.deepEqual(f.calls.map(call => call.method), ["session/load", "session/load", "session/load", "session/close"]);
  assert.deepEqual(f.calls.at(-1).params, { sessionId: "older-session" });
  assert.equal(f.host.sessions.get("busy"), "busy-session");
  assert.equal(f.host.sessions.get("warm"), "warm-session");
  assert.equal(f.savedSessions.get("thread"), "older-session");
  close.resolve({});
  await trim;
  assert.deepEqual(await reenter, { sessionId: "older-session", created: false, loaded: true });
  assert.equal(f.calls.at(-1).method, "session/load");
});

test("established session reuse does not reload or reset mode", async () => {
  const f = mockHost({ saved: "saved-session" });
  await f.host.prompt("thread", prompt);
  await f.host.prompt("thread", prompt);
  assert.deepEqual(f.calls.map(call => call.method), ["session/load", "session/set_mode", "session/prompt", "session/prompt"]);
});

for (const saved of [null, "saved-session"]) {
  test(`subprocess mode refusal stops ${saved ? "loaded" : "new"} session before prompt`, { timeout: 5000 }, async t => {
    const rpcModule = new URL("../room-acp/src/jsonrpc.mjs", import.meta.url).href;
    const script = `
      import { createPeer } from ${JSON.stringify(rpcModule)};
      const calls = [];
      createPeer({ input: process.stdin, output: process.stdout, onRequest(method) {
        if (method === "test/trace") return calls;
        calls.push(method);
        if (method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (method === "session/new") return { sessionId: "new-session" };
        if (method === "session/set_mode") throw Object.assign(new Error("unsupported synthetic mode"), { code: -32602 });
        return {};
      }});
    `;
    const savedSessions = new Map(saved ? [["thread", saved]] : []);
    const host = new AgentHost({ candidate: { command: process.execPath, args: ["--input-type=module", "-e", script] }, env: {}, mode: "synthetic-unsupported", savedSessions });
    t.after(() => host.stop());
    await host.start();
    await assert.rejects(host.prompt("thread", prompt), error => error.code === -32602 && error.message === "unsupported synthetic mode");
    assert.deepEqual(await host.process.peer.request("test/trace"), ["initialize", saved ? "session/load" : "session/new", "session/set_mode"]);
    assert.equal(host.sessions.size, 0);
    assert.equal(host.threadOf.size, 0);
    assert.equal(savedSessions.get("thread"), saved ?? undefined);
  });
}
