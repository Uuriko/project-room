import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrokHostError, parseNeedsMeBody, parseWakePing, wakeToAttentionItem,
  pendingWakeToItem, attentionKey, selectUnhandled, markHandled, emptyJournal,
  loadJournal, buildRunPlan, assertPlanSafe, parseAttentionItem, childEnvFor
} from "../client/grok-host.mjs";
import { pull, doctor, ingestWake, writeJournalFile, readJournalFile } from "../scripts/grok-room-host.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

const secret = "pri_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function needsMe(items, extra = {}) {
  return { identityId: "ai_x", items, cursor: { rooms: { den: 4 } }, hasMore: false, untrusted: true, ...extra };
}

function mention(over = {}) {
  return {
    kind: "mention", roomId: "den", seq: 4, id: "msg-1",
    summary: "please look", next: { tool: "room_reply", arguments: { roomId: "den", replyToId: "msg-1" } },
    ...over
  };
}

test("needs-me items keep id as the reply target (messageId ?? eventId)", () => {
  const parsed = parseNeedsMeBody(needsMe([mention()]));
  assert.equal(parsed.untrusted, true);
  assert.equal(parsed.items[0].id, "msg-1");
  assert.equal(attentionKey(parsed.items[0]), "mention:den:msg-1");
});

test("wake ping prefers signal.messageId over signalId", () => {
  const ping = parseWakePing({
    event: "agent.wake", agentId: "ai_x",
    signal: { signalId: "sig-9", messageId: "msg-1", roomId: "den", kind: "mention", seq: 4 },
    ackHint: "react 👍 to acknowledge"
  });
  const item = wakeToAttentionItem(ping);
  assert.equal(item.id, "msg-1");
  assert.equal(item.kind, "mention");
  assert.equal(attentionKey(item), "mention:den:msg-1");
});

test("wake ping without messageId falls back to signalId", () => {
  const item = wakeToAttentionItem({
    event: "agent.wake", agentId: "ai_x",
    signal: { signalId: "a877122a", roomId: "den" }
  });
  assert.equal(item.id, "a877122a");
  assert.equal(item.kind, "wake");
});

test("journal skips a handled key and records a new one", () => {
  const a = parseAttentionItem(mention());
  const b = parseAttentionItem(mention({ id: "msg-2", seq: 5 }));
  let journal = emptyJournal();
  journal = markHandled(journal, a, 1000);
  const fresh = selectUnhandled([a, b], journal);
  assert.deepEqual(fresh.map(item => item.id), ["msg-2"]);
  assert.equal(loadJournal(journal).handled[attentionKey(a)], 1000);
});

test("run plan never includes the identity secret", () => {
  const plan = assertPlanSafe(buildRunPlan(mention(), { origin: "https://room.example" }), [secret]);
  assert.equal(plan.key, "mention:den:msg-1");
  assert.match(plan.prompt, /untrusted data/);
  assert.match(plan.prompt, /id=msg-1/);
  assert.equal(plan.prompt.includes(secret), false);
  assert.throws(() => assertPlanSafe({ prompt: `hi ${secret}` }, [secret]), /secret_in_plan/);
});

test("childEnvFor puts the bearer in PROJECT_ROOM_SECRET for hosted MCP", () => {
  const env = childEnvFor({ PATH: "/bin" }, { token: secret, origin: "https://room.example" });
  assert.equal(env.PROJECT_ROOM_SECRET, secret);
  assert.equal(env.ROOM_AGENT_ORIGIN, "https://room.example");
  assert.equal(env.PATH, "/bin");
  assert.equal(buildRunPlan(mention()).prompt.includes(secret), false);
});

test("malformed needs-me and wake payloads fail closed", () => {
  assert.throws(() => parseNeedsMeBody(null), GrokHostError);
  assert.throws(() => parseNeedsMeBody({ items: [{ kind: "mention" }] }), GrokHostError);
  assert.throws(() => parseWakePing({ event: "message.posted" }), GrokHostError);
  assert.throws(() => parseAttentionItem({ kind: "mention", roomId: "den", id: "x", seq: -1 }), GrokHostError);
});

function fixtureDir() {
  const parent = mkdtempSync(join(tmpdir(), "grok-host-"));
  chmodSync(parent, 0o700);
  const directory = join(parent, "conn");
  saveAgentConnection(directory, {
    version: 1, origin: "https://room.example", roomId: "den", memberId: "ai_x", token: secret
  });
  return directory;
}

test("pull journals first sight and is a no-op on the second sight", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory };
  const body = needsMe([mention(), mention({ id: "msg-2", seq: 5 })]);
  const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
  const first = await pull({ env, fetchImpl, now: () => 50 });
  assert.equal(first.planned.length, 2);
  assert.equal(first.executed.length, 0);
  const second = await pull({ env, fetchImpl, now: () => 60 });
  assert.equal(second.planned.length, 0);
  const journal = readJournalFile(join(directory, "grok-host-journal.json"));
  assert.ok(journal.handled["mention:den:msg-1"]);
  assert.ok(journal.handled["mention:den:msg-2"]);
});

test("pull --execute calls the runner once per new item and still redacts the secret", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory, GROK_BIN: "/bin/false" };
  const fetchImpl = async () => new Response(JSON.stringify(needsMe([mention()])), { status: 200 });
  const calls = [];
  const runner = async plan => {
    calls.push(plan);
    assert.equal(JSON.stringify(plan).includes(secret), false);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const result = await pull({ env, fetchImpl, execute: true, runner, now: () => 1 });
  assert.equal(calls.length, 1);
  assert.equal(result.executed[0].key, "mention:den:msg-1");
  const again = await pull({ env, fetchImpl, execute: true, runner, now: () => 2 });
  assert.equal(calls.length, 1);
  assert.equal(again.executed.length, 0);
});

test("doctor without a connection reports config_not_found and no secret", async () => {
  const result = await doctor({ env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, "config_not_found");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("doctor with a live fetch reports credential_accepted", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async (url) => {
    const path = String(url);
    if (path.endsWith("/api/health")) return new Response("{\"ok\":true}", { status: 200 });
    return new Response(JSON.stringify(needsMe([])), { status: 200 });
  };
  const result = await doctor({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.code, "credential_accepted");
  assert.equal(result.items, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("doctor heartbeats pull-only on the real beat path without failing membership", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = { needsMe: needsMe([]), acks: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes("/api/health")) return new Response("{\"ok\":true}", { status: 200 });
    return roomFetch(handlers)(url, opts);
  };
  const result = await doctor({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.code, "credential_accepted");
  assert.equal(result.presence, "pull-only");
  assert.equal(result.hostId, "grok-build");
  assert.equal(result.pendingWakes, 0);
  assert.equal(result.listening, "pull-only");
  assert.equal(result.executeDefault, false);
  assert.deepEqual(result.rooms, ["den"]);
  assert.equal(handlers.beats, 1);
  assert.equal(handlers.beatBodies[0].mode, "pull-only");
  assert.equal(handlers.beatBodies[0].workWakes, undefined);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("doctor stays credential_accepted when heartbeat is refused", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url);
    if (path.includes("/api/health")) return new Response("{\"ok\":true}", { status: 200 });
    if (path.includes("/api/agent-heartbeats") && (opts.method || "GET") === "POST") {
      return new Response(JSON.stringify({ error: { code: "invalid_heartbeat", message: "nope" } }), { status: 422 });
    }
    return new Response(JSON.stringify(needsMe([])), { status: 200 });
  };
  const result = await doctor({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.code, "credential_accepted");
  assert.equal(result.presence, "heartbeat_failed");
  assert.equal(result.hostId, null);
});

test("journal file round-trip stays 0600-shaped JSON without the secret", t => {
  const directory = mkdtempSync(join(tmpdir(), "grok-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "grok-host-journal.json");
  writeJournalFile(filename, markHandled(emptyJournal(), mention(), 9));
  const loaded = readJournalFile(filename);
  assert.equal(loaded.handled["mention:den:msg-1"], 9);
  assert.equal(JSON.stringify(loaded).includes(secret), false);
});

function roomFetch(handlers) {
  return async (url, opts = {}) => {
    const path = String(url);
    const method = opts.method || "GET";
    if (path.includes("/api/agent-heartbeats/ack") && method === "POST") {
      const body = JSON.parse(opts.body || "{}");
      handlers.acks?.push(body);
      return new Response(JSON.stringify({ acknowledged: body.signalIds || [] }), { status: 200 });
    }
    if (path.includes("/api/agent-heartbeats") && method === "POST") {
      handlers.beats = (handlers.beats || 0) + 1;
      handlers.beatBodies = handlers.beatBodies || [];
      if (opts.body) handlers.beatBodies.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({
        host: { hostId: "grok-build", mode: "pull-only" },
        pendingWakes: handlers.pendingWakes || []
      }), { status: 200 });
    }
    handlers.needs = handlers.needs || [];
    handlers.needs.push(path);
    return new Response(JSON.stringify(handlers.needsMe || needsMe([])), { status: 200 });
  };
}

test("pending wake prefers messageId and workItemId", () => {
  const mention = pendingWakeToItem({ signalId: "sig-1", kind: "mention", roomId: "den", messageId: "msg-9" });
  assert.equal(mention.id, "msg-9");
  assert.equal(mention.next.arguments.replyToId, "msg-9");
  const work = pendingWakeToItem({ signalId: "sig-2", kind: "work", roomId: "den", workItemId: "wi-1", workRevision: 3 });
  assert.equal(work.id, "wi-1");
  assert.equal(work.seq, 3);
  assert.equal(work.next.tool, "room_read_work");
});

test("pull sends the saved needs-me cursor on the next pass", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = { needsMe: needsMe([mention()]), acks: [] };
  const fetchImpl = roomFetch(handlers);
  await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, now: () => 1 });
  handlers.needsMe = needsMe([]);
  await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, now: () => 2 });
  assert.equal(handlers.beats, 2);
  assert.equal(handlers.beatBodies[0].mode, "pull-only");
  assert.equal(handlers.beatBodies[0].workWakes, undefined);
  assert.match(handlers.needs[1], /since=/);
  const journal = readJournalFile(join(directory, "grok-host-journal.json"));
  assert.deepEqual(journal.cursor, { rooms: { den: 4 } });
});

test("pull merges heartbeat pendingWakes and acks their signal ids", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = {
    needsMe: needsMe([]),
    acks: [],
    pendingWakes: [{ signalId: "sig-1", kind: "mention", roomId: "den", messageId: "msg-9" }]
  };
  const result = await pull({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl: roomFetch(handlers), now: () => 3
  });
  assert.equal(result.planned[0].item.id, "msg-9");
  assert.deepEqual(handlers.acks[0].signalIds, ["sig-1"]);
});

test("pull follows needs-me hasMore for a bounded number of pages", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let pages = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url);
    if (path.includes("/api/agent-heartbeats")) {
      return new Response(JSON.stringify({ host: { hostId: "grok-build" }, pendingWakes: [], acknowledged: [] }), { status: 200 });
    }
    pages += 1;
    if (pages === 1) {
      return new Response(JSON.stringify(needsMe([mention()], { hasMore: true, cursor: { rooms: { den: 4 } } })), { status: 200 });
    }
    return new Response(JSON.stringify(needsMe([mention({ id: "msg-2", seq: 5 })], { hasMore: false, cursor: { rooms: { den: 5 } } })), { status: 200 });
  };
  const result = await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, now: () => 8 });
  assert.equal(pages, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.planned.map(plan => plan.item.id), ["msg-1", "msg-2"]);
});

test("ingestWake journals an agent.wake once", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory };
  const body = {
    event: "agent.wake", agentId: "ai_x",
    signal: { signalId: "sig-9", messageId: "msg-1", roomId: "den", kind: "mention", seq: 4 }
  };
  const first = await ingestWake({ env, body, now: () => 4 });
  assert.equal(first.key, "mention:den:msg-1");
  assert.equal(first.planned.length, 1);
  const second = await ingestWake({ env, body, now: () => 5 });
  assert.equal(second.planned.length, 0);
  assert.equal(JSON.stringify(first).includes(secret), false);
});

test("unauthenticated needs-me becomes a machine-readable failure", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async () => new Response(JSON.stringify({ code: "unauthenticated", message: "nope" }), { status: 401 });
  await assert.rejects(
    pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl }),
    error => error instanceof GrokHostError && error.code === "unauthenticated"
  );
});
