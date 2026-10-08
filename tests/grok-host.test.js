import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrokHostError, parseNeedsMeBody, parseWakePing, wakeToAttentionItem,
  pendingWakeToItem, attentionKey, selectUnhandled, markHandled, emptyJournal,
  loadJournal, buildRunPlan, assertPlanSafe, parseAttentionItem, childEnvFor, emptyAttentionNext, countKinds,
  setCursor
} from "../client/grok-host.mjs";
import { pull, doctor, ingestWake, writeJournalFile, readJournalFile, loadPendingAccess, rememberPendingAccess, writePendingAccessFile, fileAccessRequest, claimWork as hostClaim, handleTextCommand, replyMessageId } from "../scripts/grok-room-host.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
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
    ackHint: "react 👍 marks the mention responded; a reaction alone does not clear the wake signal — POST /api/agent-heartbeats/ack {signalIds} (or MCP heartbeat_ack) to clear it"
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

test("countKinds tallies planned attention by kind", () => {
  assert.deepEqual(countKinds([mention(), mention({ id: "msg-2", kind: "direct_ask", seq: 5 })]), {
    mention: 1,
    direct_ask: 1
  });
  assert.deepEqual(countKinds([]), {});
});

test("emptyAttentionNext is honest and secret-free", () => {
  const next = emptyAttentionNext({ execute: false });
  assert.match(next, /No new attention/);
  assert.match(next, /pull-only/);
  assert.equal(next.includes(secret), false);
  assert.match(emptyAttentionNext({ execute: true }), /did not start a model/);
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

test("successful pull journals completion and is a no-op on the second sight", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory };
  const body = needsMe([mention(), mention({ id: "msg-2", seq: 5 })]);
  const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
  const first = await pull({ env, fetchImpl, execute: true, runner: async () => ({ code: 0 }), now: () => 50 });
  assert.equal(first.planned.length, 2);
  assert.equal(first.executed.length, 2);
  const second = await pull({ env, fetchImpl, execute: true, runner: async () => ({ code: 0 }), now: () => 60 });
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

test("rememberPendingAccess is idempotent on requestId", () => {
  const first = rememberPendingAccess({ requests: [] }, { requestId: "ar_1", roomId: "build-together-32f67587", identityId: "ai_x" });
  const second = rememberPendingAccess(first, { requestId: "ar_1", roomId: "build-together-32f67587", identityId: "ai_x" });
  assert.equal(second.requests.length, 1);
  assert.deepEqual(loadPendingAccess(null), { requests: [] });
});

test("doctor reports pending admissions from the saved request list", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writePendingAccessFile(join(directory, "pending-access.json"), {
    requests: [{ requestId: "ar_1", roomId: "build-together-32f67587", identityId: "ai_x" }]
  });
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url);
    if (path.includes("/api/health")) return new Response("{\"ok\":true}", { status: 200 });
    if (path.includes("/api/access-requests/ar_1")) {
      return new Response(JSON.stringify({ requestId: "ar_1", roomId: "build-together-32f67587", status: "pending" }), { status: 200 });
    }
    if (path.includes("/api/agent-heartbeats")) {
      return new Response(JSON.stringify({ host: { hostId: "grok-build" }, pendingWakes: [] }), { status: 200 });
    }
    return new Response(JSON.stringify(needsMe([])), { status: 200 });
  };
  const result = await doctor({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pendingAdmissions, [{ requestId: "ar_1", roomId: "build-together-32f67587", status: "pending" }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("fileAccessRequest remembers the pending row without putting the secret in JSON", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith("/api/needs-me")) return Response.json(needsMe([]));
    const body = JSON.parse(opts.body || "{}");
    return new Response(JSON.stringify({ requestId: body.requestId, roomId: body.roomId, status: "pending" }), { status: 200 });
  };
  const result = await fileAccessRequest({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, roomId: "build-together-32f67587", note: "join"
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "pending");
  assert.equal(result.roomId, "build-together-32f67587");
  assert.match(result.requestId, /^ar_/);
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
    if (path.includes("/work-claims") || path.includes("/agent-inbox")) {
      return new Response(JSON.stringify({ claims: [], directMentions: [] }), { status: 200 });
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
  await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, execute: true, runner: async () => ({ code: 0 }), now: () => 1 });
  handlers.needsMe = needsMe([]);
  await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, execute: true, runner: async () => ({ code: 0 }), now: () => 2 });
  assert.equal(handlers.beats, 2);
  assert.equal(handlers.beatBodies[0].mode, "pull-only");
  assert.equal(handlers.beatBodies[0].workWakes, undefined);
  assert.match(handlers.needs[1], /since=/);
  const journal = readJournalFile(join(directory, "grok-host-journal.json"));
  assert.deepEqual(journal.cursor, { rooms: { den: 4 } });
});

test("empty pull is silent and points at emptyAttentionNext", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = { needsMe: needsMe([]), acks: [] };
  const result = await pull({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl: roomFetch(handlers), now: () => 7
  });
  assert.equal(result.ok, true);
  assert.equal(result.silent, true);
  assert.equal(result.planned.length, 0);
  assert.equal(result.next, emptyAttentionNext({ execute: false }));
  assert.deepEqual(result.kinds, {});
  assert.equal(JSON.stringify(result).includes(secret), false);
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
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl: roomFetch(handlers), execute: true, runner: async () => ({ code: 0 }), now: () => 3
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
    if (path.includes("/work-claims") || path.includes("/agent-inbox")) {
      return new Response(JSON.stringify({ claims: [], directMentions: [] }), { status: 200 });
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
  const first = await ingestWake({ env, body, execute: true, runner: async () => ({ code: 0 }), now: () => 4 });
  assert.equal(first.key, "mention:den:msg-1");
  assert.equal(first.planned.length, 1);
  const second = await ingestWake({ env, body, execute: true, runner: async () => ({ code: 0 }), now: () => 5 });
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


test("preview leaves journal and wake acknowledgement untouched so execute can still run", async t => {
  const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory };
  const handlers = { needsMe: needsMe([]), acks: [],
    pendingWakes: [{ signalId: "sig-1", kind: "mention", roomId: "den", messageId: "msg-1" }] };
  const fetchImpl = roomFetch(handlers);
  let runs = 0; const runner = async () => { runs++; return { code: 0 }; };
  const preview = await pull({ env, fetchImpl, runner });
  assert.equal(preview.planned.length, 1);
  assert.equal(runs, 0);
  assert.deepEqual(readJournalFile(join(directory, "grok-host-journal.json")), emptyJournal());
  assert.deepEqual(handlers.acks, []);
  const executed = await pull({ env, fetchImpl, execute: true, runner });
  assert.equal(runs, 1); assert.equal(executed.executed.length, 1);
  assert.deepEqual(handlers.acks, [{ signalIds: ["sig-1"] }]);
});

for (const outcome of ["nonzero", "throw"]) {
  test(`failed ${outcome} runner remains retryable without acknowledgement or cursor advance`, async t => {
    const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = { ROOM_AGENT_CONFIG: directory };
    const handlers = { needsMe: needsMe([mention()]), acks: [],
      pendingWakes: [{ signalId: "sig-fail", kind: "mention", roomId: "den", messageId: "msg-1" }] };
    const fetchImpl = roomFetch(handlers); let runs = 0;
    const runner = async () => {
      runs++;
      if (runs === 1) { if (outcome === "throw") throw new Error("synthetic spawn failure"); return { code: 1 }; }
      return { code: 0 };
    };
    const first = pull({ env, fetchImpl, execute: true, runner });
    if (outcome === "throw") await assert.rejects(first, /synthetic spawn failure/); else await first;
    assert.deepEqual(readJournalFile(join(directory, "grok-host-journal.json")), emptyJournal());
    assert.deepEqual(handlers.acks, []);
    await pull({ env, fetchImpl, execute: true, runner });
    assert.equal(runs, 2);
    assert.deepEqual(handlers.acks, [{ signalIds: ["sig-fail"] }]);
  });
}

test("runner output removes the known bearer before returning printable results", async t => {
  const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = { needsMe: needsMe([mention()]), acks: [] };
  const result = await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl: roomFetch(handlers), execute: true,
    runner: async () => ({ code: 0, stdout: `before ${secret} after`, stderr: `error ${secret}` }) });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.executed[0].result.stdout, "before [REDACTED] after");
  assert.equal(result.executed[0].result.stderr, "error [REDACTED]");
});


test("duplicate heartbeat and paged attention runs one handler", async t => {
  const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handlers = { needsMe: needsMe([mention(), mention()]), acks: [],
    pendingWakes: [{ signalId: "sig-duplicate", kind: "mention", roomId: "den", messageId: "msg-1" }] };
  let runs = 0;
  const result = await pull({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl: roomFetch(handlers), execute: true,
    runner: async () => { runs++; return { code: 0 }; } });
  assert.equal(runs, 1); assert.equal(result.executed.length, 1);
  assert.deepEqual(handlers.acks, [{ signalIds: ["sig-duplicate"] }]);
});


test("a later handoff for the same Work Item executes while each event retry stays deduplicated", async t => {
  const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory }, calls = [];
  const handoff = seq => ({ kind: "handoff", roomId: "den", id: "work-1", seq,
    summary: `Review event ${seq}`, next: { tool: "room_read_work", arguments: { roomId: "den", workItemId: "work-1" } } });
  const handlers = { needsMe: needsMe([handoff(4), handoff(4)]), acks: [] };
  const fetchImpl = roomFetch(handlers);
  const runner = async plan => { calls.push(plan.item.seq); return { code: 0 }; };
  const run = () => pull({ env, fetchImpl, execute: true, runner });
  await run(); await run(); assert.deepEqual(calls, [4]);
  handlers.needsMe = needsMe([handoff(9), handoff(9)], { cursor: { rooms: { den: 9 } } });
  const later = await run();
  assert.equal(later.executed.length, 1);
  await run(); assert.deepEqual(calls, [4, 9], "new event on same work runs once, same event retry does not rerun");
});

test("failed later handoff preserves retry and cursor despite an earlier completed event", async t => {
  const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ROOM_AGENT_CONFIG: directory };
  const item = seq => ({ kind: "handoff", roomId: "den", id: "work-1", seq, summary: "Review" });
  const handlers = { needsMe: needsMe([item(4)]), acks: [] }, calls = [];
  const fetchImpl = roomFetch(handlers); let fail = false;
  const runner = async plan => { calls.push(plan.item.seq); return { code: fail ? 1 : 0 }; };
  await pull({ env, fetchImpl, execute: true, runner });
  handlers.needsMe = needsMe([item(9)], { cursor: { rooms: { den: 9 } } }); fail = true;
  await pull({ env, fetchImpl, execute: true, runner });
  assert.deepEqual(readJournalFile(join(directory, "grok-host-journal.json")).cursor, { rooms: { den: 4 } });
  fail = false;
  await pull({ env, fetchImpl, execute: true, runner });
  assert.deepEqual(calls, [4, 9, 9]);
  assert.deepEqual(readJournalFile(join(directory, "grok-host-journal.json")).cursor, { rooms: { den: 9 } });
});


test("legacy handoff journal remains intact without suppressing a newer event", async t => {
  const directory = fixtureDir(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "grok-host-journal.json");
  writeJournalFile(filename, { handled: { "handoff:den:work-1": 123 }, cursor: { rooms: { den: 4 } } });
  const handlers = { needsMe: needsMe([{ kind: "handoff", roomId: "den", id: "work-1", seq: 9,
    summary: "Read current handoff", next: { tool: "room_read_work", arguments: { roomId: "den", workItemId: "work-1" } } }],
  { cursor: { rooms: { den: 9 } } }), acks: [] };
  let runs = 0;
  const options = { env: { ROOM_AGENT_CONFIG: directory }, fetchImpl: roomFetch(handlers), execute: true,
    runner: async () => { runs++; return { code: 0 }; } };
  assert.equal((await pull(options)).executed.length, 1);
  assert.equal((await pull(options)).executed.length, 0);
  assert.equal(runs, 1);
  assert.equal(readJournalFile(filename).handled["handoff:den:work-1"], 123, "upgrade retains legacy evidence");
});

// H-20 regression: the grok child ran with no timeout and unbounded output
// buffering — a hung child stalled the host loop forever, a noisy one grew
// memory without bound. Contract: the runner kills a hung child after
// GROK_HOST_TIMEOUT_MS and caps buffered output head+tail at
// GROK_HOST_MAX_OUTPUT_BYTES.
// Credible regression: pre-fix there is no timeout logic and no cap, so the
// hang test's race timer wins (pull never resolves in time) and the spew test
// sees no truncation marker.
// Existing coverage gap: tests/grok-host.test.js had no timeout/kill/cap tests.
// Real boundary: pull(..., { execute: true }) with the real default runner and
// a fake GROK_BIN. No new production seams (both knobs are env vars).
test("a hung grok child is killed after GROK_HOST_TIMEOUT_MS and the loop continues", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hangBin = join(directory, "hang.sh");
  writeFileSync(hangBin, "#!/bin/sh\nsleep 8\n");
  chmodSync(hangBin, 0o755);
  const env = { ROOM_AGENT_CONFIG: directory, GROK_BIN: hangBin, GROK_HOST_TIMEOUT_MS: "300" };
  const fetchImpl = async () => new Response(JSON.stringify(needsMe([mention()])), { status: 200 });
  const raced = await Promise.race([
    pull({ env, fetchImpl, execute: true, now: () => 1 }).then(r => ({ done: true, r })),
    new Promise(resolve => setTimeout(() => resolve({ done: false }), 5000)),
  ]);
  assert.equal(raced.done, true, "pull resolves instead of hanging on a stuck grok child");
  const exec = raced.r.executed[0];
  assert.notEqual(exec.result.code, 0, "a timed-out child is not marked handled");
  assert.match(exec.result.stderr, /timed out after 300ms/, "the timeout is reported on stderr");
});

test("noisy grok output is capped head+tail instead of buffered whole", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const spewBin = join(directory, "spew.sh");
  writeFileSync(spewBin, "#!/bin/sh\nyes ABCDEFGH | head -c 200000\n");
  chmodSync(spewBin, 0o755);
  const env = { ROOM_AGENT_CONFIG: directory, GROK_BIN: spewBin, GROK_HOST_MAX_OUTPUT_BYTES: "2000" };
  const fetchImpl = async () => new Response(JSON.stringify(needsMe([mention()])), { status: 200 });
  const result = await pull({ env, fetchImpl, execute: true, now: () => 1 });
  const out = result.executed[0].result.stdout;
  assert.match(out, /truncated/, "capped output carries the truncation marker");
  assert.ok(out.length < 8000, "runner cap applies before the 8000-char journal slice");
});

// M-53: corrupt pending-access state must fail loudly (never silently forget
// requests), and the corrupt file must be preserved for forensics.
test("M-53: corrupt pending-access file fails loudly and is backed up", async t => {
  const { mkdtempSync: mk, readdirSync: rd, readFileSync: rf, existsSync: ex } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { readPendingAccessFile } = await import("../scripts/grok-room-host.mjs");
  const root = join(fileURLToPath(import.meta.url), "..", "..", ".tmp");
  const directory = mk(join(root, "grok-host-m53-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "pending-access.json");
  writeFileSync(file, "{not valid json!!!");
  assert.throws(() => readPendingAccessFile(file), (err) => {
    assert.ok(err instanceof GrokHostError);
    assert.equal(err.code, "invalid_pending_access");
    return true;
  });
  const backups = rd(directory).filter((n) => n.startsWith("pending-access.json.corrupt-"));
  assert.equal(backups.length, 1, "exactly one corrupt backup preserved");
  assert.equal(rf(join(directory, backups[0]), "utf8"), "{not valid json!!!");
  assert.equal(ex(file), false, "corrupt original moved aside");
});

// M-53: journal writes must replace the file atomically. Observable contract:
// the destination is swapped in (new inode via rename), never truncated in
// place — a crash mid-write can never leave a half-written journal.
test("M-53: journal write replaces the file instead of truncating in place", async t => {
  const { mkdtempSync: mk, readdirSync: rd, statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = join(fileURLToPath(import.meta.url), "..", "..", ".tmp");
  const directory = mk(join(root, "grok-host-m53-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "journal.json");
  writeJournalFile(file, setCursor(emptyJournal(), { rooms: { den: 1 } }));
  const first = statSync(file);
  writeJournalFile(file, setCursor(emptyJournal(), { rooms: { den: 2 } }));
  const second = statSync(file);
  assert.notEqual(first.ino, second.ino, "second write swapped in a new file (rename), not a truncate");
  assert.deepEqual(readJournalFile(file).cursor, { rooms: { den: 2 } });
  assert.deepEqual(
    rd(directory).filter((n) => n.includes(".tmp-")),
    [],
    "no temp write files litter the directory",
  );
});


async function liveAccessFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "grok-access-http-"));
  const store = new RoomStore(join(root, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Access fixture owner");
  const worker = store.identities.create("Access fixture worker");
  rooms.create(owner.secret, { roomId: "source", title: "Source", purpose: "Alias fixture", kind: "personal" });
  rooms.create(owner.secret, { roomId: "target", title: "Target", purpose: "Access fixture", kind: "personal" });
  store.identities.link(owner.secret, "source", { identityId: worker.identityId, memberId: "worker-alias", permissions: [] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = join(root, "connection");
  saveAgentConnection(directory, { version: 1, origin, roomId: "source", memberId: "worker-alias", token: worker.secret });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  return { store, worker, directory, env: { ROOM_AGENT_CONFIG: directory } };
}

test("real HTTP access uses global identity for an alias seat, preserves scopes, and polls legacy journals", async t => {
  const { store, worker, directory, env } = await liveAccessFixture(t);
  const beforeLinks = store.db.prepare("SELECT * FROM identity_links ORDER BY room_id,identity_id").all();
  const result = await fileAccessRequest({ env, roomId: "target", note: "Existing saved host" });
  assert.equal(result.status, "pending");
  const row = store.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(result.requestId);
  assert.equal(row.identity_id, worker.identityId); assert.notEqual(row.identity_id, "worker-alias");
  assert.deepEqual(JSON.parse(row.requested_permissions), ["accept_work", "complete_work"]);
  assert.deepEqual(store.db.prepare("SELECT * FROM identity_links ORDER BY room_id,identity_id").all(), beforeLinks);
  const filename = join(directory, "pending-access.json");
  const text = readFileSync(filename, "utf8"); assert.ok(!text.includes(worker.secret));
  assert.equal(JSON.stringify(result).includes(worker.secret), false);
  // A pre-upgrade journal without identity/body must poll with authenticated global identity.
  writePendingAccessFile(filename, { requests: [{ requestId: result.requestId, roomId: "target" }] });
  const checked = await doctor({ env });
  assert.deepEqual(checked.pendingAdmissions, [{ requestId: result.requestId, roomId: "target", status: "pending" }]);
  let posts = 0;
  const replay = await fileAccessRequest({ env, roomId: "target", fetchImpl: (url, options) => {
    if (options.method === "POST") posts++;
    return fetch(url, options);
  } });
  assert.equal(replay.requestId, result.requestId); assert.equal(posts, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM access_requests").get().n, 1);
});

test("real committed response loss retains write-ahead intent and a restarted CLI replays without duplicate", async t => {
  const { store, worker, directory, env } = await liveAccessFixture(t);
  const filename = join(directory, "pending-access.json");
  let posted;
  await assert.rejects(fileAccessRequest({ env, roomId: "target", note: "Saved host requests review access", fetchImpl: async (url, options) => {
    if (options.method === "POST") {
      posted = JSON.parse(options.body);
      assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")).requests[0].input, posted, "intent is durable before POST");
      const response = await fetch(url, options); assert.equal(response.status, 201); await response.text();
      throw new Error("simulated response loss after commit");
    }
    return fetch(url, options);
  } }), /simulated response loss/);
  const saved = readFileSync(filename, "utf8");
  assert.ok(!saved.includes(worker.secret));
  const before = store.db.prepare("SELECT * FROM access_requests ORDER BY request_id").all();
  assert.equal(before.length, 1);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["scripts/grok-room-host.mjs", "request-access", "target"], {
    cwd: new URL("..", import.meta.url), env: { ...process.env, ...env }
  });
  const retry = JSON.parse(stdout);
  assert.equal(retry.ok, true); assert.equal(retry.requestId, posted.requestId); assert.equal(retry.status, "pending");
  assert.deepEqual(store.db.prepare("SELECT * FROM access_requests ORDER BY request_id").all(), before);
  assert.equal(readFileSync(filename, "utf8"), saved);
  assert.ok(!stdout.includes(worker.secret) && !stderr.includes(worker.secret));
  await assert.rejects(fileAccessRequest({ env, roomId: "target", note: "changed terms" }), error => error.code === "request_conflict");
  assert.deepEqual(store.db.prepare("SELECT * FROM access_requests ORDER BY request_id").all(), before);
});

test("real revoked saved identity cannot file or replay access intents", async t => {
  const { store, worker, directory, env } = await liveAccessFixture(t);
  const result = await fileAccessRequest({ env, roomId: "target" });
  const filename = join(directory, "pending-access.json");
  const saved = readFileSync(filename, "utf8");
  const before = store.db.prepare("SELECT * FROM access_requests ORDER BY request_id").all();
  store.identities.revoke(worker.identityId, worker.secret);
  let posts = 0;
  const fetchImpl = (url, options) => { if (options.method === "POST") posts++; return fetch(url, options); };
  await assert.rejects(fileAccessRequest({ env, roomId: "target", fetchImpl }), error => error.code === "unauthenticated");
  await assert.rejects(fileAccessRequest({ env, roomId: "source", fetchImpl }), error => error.code === "unauthenticated");
  assert.equal(posts, 0); assert.equal(readFileSync(filename, "utf8"), saved);
  assert.deepEqual(store.db.prepare("SELECT * FROM access_requests ORDER BY request_id").all(), before);
  assert.equal(before[0].request_id, result.requestId);
  assert.equal(existsSync(join(directory, "connection.json")), true);
});

test("text match ranks listings and never claims", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const listings = [
    { id: "h1", kind: "offer", motive: "hobby", title: "Docs", tags: ["docs"], open: true },
    { id: "c1", kind: "bounty", motive: "cash", title: "Paid", tags: ["docs"], open: true }
  ];
  const result = await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory },
    line: "match hobby docs",
    listings
  });
  assert.equal(result.verb, "match");
  assert.deepEqual(result.matches.map(row => row.id), ["h1"]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("claim posts the existing work-claims lease and redacts the bearer", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let posted = null;
  const fetchImpl = async (url, opts = {}) => {
    posted = { url: String(url), body: JSON.parse(opts.body || "{}") };
    return new Response(JSON.stringify({
      id: "w1", state: "claimed", owner: "ai_x", leaseExpiresAt: 1_800_000_000_000, fileWarnings: []
    }), { status: 200 });
  };
  const result = await hostClaim({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, workItemId: "w1", leaseHours: 6
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, "claimed");
  assert.equal(result.workItemId, "w1");
  assert.match(posted.url, /\/work-claims\/w1\/claim$/);
  assert.equal(posted.body.leaseHours, 6);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("claim surfaces work_claim_conflict when another agent holds the lease", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { code: "work_claim_conflict", message: "already claimed" }
  }), { status: 409 });
  await assert.rejects(
    hostClaim({ env: { ROOM_AGENT_CONFIG: directory }, fetchImpl, workItemId: "w1" }),
    error => error.code === "work_claim_conflict"
  );
});

test("text claim posts the stored work-item id, not a lowercased copy", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ id: "ROLE-DRIVER", state: "claimed" }), { status: 200 });
  };
  const env = { ROOM_AGENT_CONFIG: directory };
  const first = await handleTextCommand({ env, fetchImpl, line: "claim ROLE-DRIVER" });
  const second = await handleTextCommand({ env, fetchImpl, line: "PR claim ROLE-DRIVER" });
  assert.equal(first.workItemId, "ROLE-DRIVER");
  assert.equal(second.workItemId, "ROLE-DRIVER");
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url.endsWith("/work-claims/ROLE-DRIVER/claim")), urls.join("\n"));
  assert.equal(JSON.stringify(first).includes(secret), false);
});

test("a playbook CLAIM line posts files and a lease, not a chat-only claim", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let posted;
  const fetchImpl = async (url, init) => {
    posted = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "fo-matchmaking-land-20261005", state: "claimed", fileWarnings: [] }), { status: 200 });
  };
  const until = new Date(Date.now() + 3 * 3600000).toISOString();
  const result = await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory },
    fetchImpl,
    line: `CLAIM fo-matchmaking-land-20261005 | files: server/a.mjs, server/b.mjs | lease until: ${until} | not touching: docs/x.md`,
  });
  assert.equal(result.verb, "claim");
  assert.equal(result.workItemId, "fo-matchmaking-land-20261005");
  assert.ok(posted.url.endsWith("/work-claims/fo-matchmaking-land-20261005/claim"));
  assert.deepEqual(posted.body.files, ["server/a.mjs", "server/b.mjs"]);
  assert.ok(posted.body.leaseHours >= 3 && posted.body.leaseHours <= 4);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a playbook HANDOFF line reassigns on the claim route, resolving a display name", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const posts = [];
  const fetchImpl = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/presence")) {
      return new Response(JSON.stringify({ members: [{ id: "ai_holder", displayName: "Jill - Dot", active: true }] }), { status: 200 });
    }
    posts.push({ url: path, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "plan-pr-autolink", state: "claimed", owner: "ai_holder" }), { status: 200 });
  };
  const result = await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory },
    fetchImpl,
    line: "HANDOFF plan-pr-autolink | to: Jill - Dot | note: take the two-line splice | room: muse-room",
  });
  assert.equal(result.verb, "handoff");
  assert.equal(result.owner, "ai_holder");
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith("/api/rooms/muse-room/work-claims/plan-pr-autolink/reassign"));
  assert.equal(posts[0].body.newOwner, "ai_holder");
  assert.equal(posts[0].body.note, "take the two-line splice");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("holders reads the claim list and does not post", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const methods = [];
  const fetchImpl = async (url, init = {}) => {
    methods.push(init.method || "GET");
    assert.equal(String(url).includes("/api/rooms/muse-room/work-claims"), true);
    return new Response(JSON.stringify({
      claims: [
        { id: "plan-pr-autolink", state: "claimed", owner: "ai_holder", files: ["scripts/runtime-package.mjs"], leaseExpiresAt: "2026-10-07T04:31:00.000Z" },
        { id: "other", state: "done", owner: "ai_old", files: ["scripts/runtime-package.mjs"] },
      ],
    }), { status: 200 });
  };
  const result = await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory },
    fetchImpl,
    line: "holders scripts/runtime-package.mjs | room: muse-room",
  });
  assert.deepEqual(methods, ["GET"]);
  assert.deepEqual(result.holders, [{
    id: "plan-pr-autolink", owner: "ai_holder", state: "claimed", leaseExpiresAt: "2026-10-07T04:31:00.000Z",
  }]);
});

test("DONE posts the done transition and PROGRESS posts in_progress", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "qa-receipt-prose-2", state: posts.at(-1).body.state }), { status: 200 });
  };
  await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl,
    line: "PROGRESS qa-receipt-prose-2 | note: tests kept | room: muse-room",
  });
  await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl,
    line: "DONE qa-receipt-prose-2 | room: muse-room",
  });
  assert.equal(posts[0].body.state, "in_progress");
  assert.equal(posts[0].body.note, "tests kept");
  assert.equal(posts[1].body.state, "done");
  assert.ok(posts.every(post => post.url.includes("/api/rooms/muse-room/work-claims/qa-receipt-prose-2/update")));
});

test("a tag reply posts once on that message, and the same note keeps the same id", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    if (path.includes("/agent-inbox") && (init.method || "GET") === "GET") {
      return new Response(JSON.stringify({
        directMentions: [{
          messageId: "claude-round-1791248841352", from: "ai_other", state: "delivered",
          sequence: 3489, at: "2026-10-06T01:07:21.416Z", body: "@Grok Build please check in",
        }],
      }), { status: 200 });
    }
    posts.push({ url: path, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ event: { sequence: 5700, type: "message.posted" } }), { status: 201 });
  };
  const env = { ROOM_AGENT_CONFIG: directory };
  const listed = await handleTextCommand({ env, fetchImpl, line: "tags | room: muse-room" });
  assert.equal(listed.tags[0].messageId, "claude-round-1791248841352");
  assert.equal(listed.tags[0].excerpt.includes(secret), false);
  const line = "reply claude-round-1791248841352 | note: Grok Build here. Tag me on the message you want answered. | room: muse-room";
  const first = await handleTextCommand({ env, fetchImpl, line });
  const second = await handleTextCommand({ env, fetchImpl, line });
  assert.equal(first.messageId, replyMessageId("muse-room", "claude-round-1791248841352", "Grok Build here. Tag me on the message you want answered."));
  assert.equal(second.messageId, first.messageId);
  assert.equal(posts.length, 2);
  assert.ok(posts.every(post => post.url.endsWith("/api/rooms/muse-room/commands")));
  assert.equal(posts[0].body.data.replyToId, "claude-round-1791248841352");
  assert.equal(posts[0].body.id, first.messageId);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(posts[0].body.data.toMemberId, undefined);
});

test("a private tag reply stays private and addresses the sender", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("/agent-inbox")) {
      return new Response(JSON.stringify({
        directMentions: [{
          messageId: "dm-private-1", from: "ai_sender", state: "delivered", private: true,
          replyToMemberId: "ai_sender", body: "@Grok Build private ask",
        }],
      }), { status: 200 });
    }
    posts.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ event: { sequence: 1, type: "message.posted" } }), { status: 201 });
  };
  const result = await handleTextCommand({
    env: { ROOM_AGENT_CONFIG: directory }, fetchImpl,
    line: "reply dm-private-1 | note: answering in the private thread | room: muse-room",
  });
  assert.equal(result.private, true);
  assert.equal(posts[0].data.toMemberId, "ai_sender");
  assert.equal(posts[0].data.replyToId, "dm-private-1");
});

test("a reply to a message that is not in the waiting inbox fails closed", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async () => new Response(JSON.stringify({ directMentions: [] }), { status: 200 });
  await assert.rejects(
    handleTextCommand({
      env: { ROOM_AGENT_CONFIG: directory }, fetchImpl,
      line: "reply missing-message | note: do not guess this is public | room: muse-room",
    }),
    error => error.code === "invalid_text_plug"
  );
});

test("holders fails closed when the claim scan is still truncated", async t => {
  const directory = fixtureDir();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let pages = 0;
  const fetchImpl = async () => {
    pages += 1;
    return new Response(JSON.stringify({
      claims: [{ id: `c${pages}`, state: "claimed", owner: "ai_x", files: ["scripts/runtime-package.mjs"] }],
      hasMore: true,
      nextCursor: `p${pages}`,
    }), { status: 200 });
  };
  await assert.rejects(
    handleTextCommand({
      env: { ROOM_AGENT_CONFIG: directory }, fetchImpl,
      line: "holders scripts/runtime-package.mjs | room: muse-room",
    }),
    error => error.code === "claim_scan_truncated"
  );
  assert.equal(pages, 4);
});
