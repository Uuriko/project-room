import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrokHostError, parseNeedsMeBody, parseWakePing, wakeToAttentionItem,
  attentionKey, selectUnhandled, markHandled, emptyJournal, loadJournal,
  buildRunPlan, assertPlanSafe, parseAttentionItem
} from "../client/grok-host.mjs";
import { pull, doctor, writeJournalFile, readJournalFile } from "../scripts/grok-room-host.mjs";
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

test("journal file round-trip stays 0600-shaped JSON without the secret", t => {
  const directory = mkdtempSync(join(tmpdir(), "grok-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "grok-host-journal.json");
  writeJournalFile(filename, markHandled(emptyJournal(), mention(), 9));
  const loaded = readJournalFile(filename);
  assert.equal(loaded.handled["mention:den:msg-1"], 9);
  assert.equal(JSON.stringify(loaded).includes(secret), false);
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
