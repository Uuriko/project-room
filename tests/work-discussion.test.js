import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";
import { selectedWorkDiscussion, discussionWindow } from "../server/work-discussion.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }), handles = new Set();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const handle of handles) await handle.close();
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const post = (id, data = {}, actor = "owner") => send(actor, T.MESSAGE_POSTED, { messageId: id, body: id, ...data });
  const propose = (id, sourceMessageId) => send("owner", T.WORK_PROPOSED, { workItemId: id, title: id, definitionOfDone: "A useful answer",
    accountableMemberId: "producer", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: "owner", ...(sourceMessageId ? { sourceMessageId } : {}) });
  const config = { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const configDirectory = join(f.directory, "producer-config"); saveAgentConnection(configDirectory, config);
  const open = async () => { const handle = await openMcpTestClient(configDirectory); handles.add(handle); return handle; };
  return { ...f, origin, send, post, propose, config, configDirectory, open, client: new RoomAgentClient(config),
    view: (id = "test-handoff", options = {}, actor = "producer") => f.store.workDiscussion(f.keys[actor], "commons", id, options) };
}
const ids = value => value.discussion.items.map(row => row.message.id);
const cursorChange = (cursor, change) => { const value = JSON.parse(Buffer.from(cursor, "base64url")); change(value); return Buffer.from(JSON.stringify(value)).toString("base64url"); };

test("focused discussion selects exact anchors and descendants without importing sibling or other-work branches", async t => {
  const f = await fixture(t);
  f.post("parent"); f.post("nested", { replyToId: "parent" }); f.post("sibling", { replyToId: "parent", body: "UNRELATED SIBLING" });
  f.propose("nested-work", "nested"); f.propose("other", "nested");
  f.post("child", { replyToId: "nested", toMemberId: "reviewer", body: "Room-visible attention, not a private message" }, "guest");
  f.post("other-branch", { replyToId: "nested", workItemId: "other", body: "UNRELATED BRANCH" });
  f.post("other-reply", { replyToId: "other-branch", body: "UNRELATED DESCENDANT" });
  f.post("draft", { workItemId: "nested-work", packetId: "shared-packet", basisRevision: 0, body: "One\nexact draft ☀" }, "producer");
  f.post("draft-reply", { replyToId: "draft" }, "reviewer");
  f.post("reseed", { workItemId: "nested-work", replyToId: "other-branch", packetId: "shared-packet", basisRevision: 0 }, "producer");
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false });
  const before = auditRecovery(f.store), snapshot = f.store.snapshot(f.keys.owner, "commons"), result = await f.client.workDiscussion("nested-work");
  assert.deepEqual(ids(result), ["nested", "child", "draft", "draft-reply", "reseed"]);
  assert.deepEqual(result.discussion.items.map(row => row.relation), ["source", "reply", "linked", "reply", "linked"]);
  assert.equal(result.discussion.items[1].message.toMemberId, "reviewer");
  assert.equal(result.current.participants.find(p => p.id === "guest").active, false);
  assert.equal(result.discussion.items[2].message.proposal.attribution, "manual-unverified");
  assert.equal(result.discussion.items[2].message.body, "One\nexact draft ☀");
  assert.equal(JSON.stringify(result).includes("UNRELATED"), false);
  assert.equal(result.discussion.checkpoint, snapshot.sequence);
  assert.equal(Object.hasOwn(result, "state"), false); assert.equal(Object.hasOwn(result, "cursor"), false);
  assert.deepEqual(auditRecovery(f.store), before);
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), snapshot);
  const shared = f.view("other"); assert.deepEqual(ids(shared), ["nested", "child", "other-branch", "other-reply"]);
  result.discussion.items[0].message.body = "Not a stored edit";
  assert.equal(f.view("nested-work").discussion.items[0].message.body, "nested");
});

test("frozen sequence pages survive sparse activity, reactions, new replies, read-marker changes and restart", async t => {
  const f = await fixture(t), fixedTime = Date.now(); f.store.now = () => fixedTime;
  for (let n = 0; n < 115; n++) {
    f.post("reply-" + n, { replyToId: "test-request" });
    if (n % 10 === 0) f.post("noise-" + n);
  }
  const initial = f.view("test-handoff", { limit: 17 }), frozen = initial.discussion.horizon, firstItems = structuredClone(initial.discussion.items);
  f.post("arrived-later", { replyToId: "reply-114" });
  f.send("owner", T.MESSAGE_REACTION_SET, { messageId: "test-request", reaction: "like", active: true });
  f.store.markCaughtUp(f.keys.producer, "commons", f.store.room("commons").sequence);
  let page = initial, all = [...ids(page)];
  const reopened = new RoomStore(join(f.directory, "room.sqlite"), { readOnly: true, now: () => fixedTime });
  try {
    while (page.discussion.hasMore) {
      page = reopened.workDiscussion(f.keys.producer, "commons", "test-handoff", { cursor: page.discussion.nextCursor, limit: 17 });
      assert.equal(page.discussion.horizon, frozen); all.push(...ids(page));
    }
  } finally { reopened.close(); }
  assert.equal(all.length, 116); assert.equal(new Set(all).size, 116); assert.equal(all.includes("arrived-later"), false);
  assert.equal(page.discussion.checkpoint, frozen);
  assert.deepEqual(f.view("test-handoff", { cursor: initial.discussion.nextCursor, limit: 17 }).discussion.items.map(r => r.message.id), all.slice(17, 34));
  assert.equal(firstItems.some(row => Object.hasOwn(row.message, "reactions")), false);
  const next = await f.client.workDiscussion("test-handoff", { since: frozen });
  assert.deepEqual(ids(next), ["arrived-later"]); assert.equal(next.current.workRevision, 0);
  assert.equal(next.discussion.hasMore, false); assert.equal(next.discussion.checkpoint, next.current.evaluatedThrough);
  assert.deepEqual(ids(await f.client.workDiscussion("test-handoff", { since: next.discussion.checkpoint })), []);
});

test("empty and superseded work, legacy message IDs and byte-bounded pages retain truthful progress", async t => {
  const f = await fixture(t); f.propose("empty"); f.propose("replacement");
  assert.deepEqual(ids(f.view("empty")), []); assert.equal(f.view("empty").discussion.hasMore, false);
  const legacy = f.send("owner", T.MESSAGE_POSTED, { body: "Legacy ID" }); f.propose("legacy", legacy.event.id);
  assert.equal(f.view("legacy").discussion.items[0].message.id, legacy.event.id);
  f.send("owner", T.WORK_SUPERSEDED, { workItemId: "legacy", expectedRevision: 0, supersededByWorkItemId: "replacement", reason: "Changed plan" });
  assert.equal(f.view("legacy").current.workState, "superseded"); assert.equal(ids(f.view("legacy")).length, 1);
  for (let n = 0; n < 10; n++) f.post("large-" + n, { workItemId: "empty", body: "☀".repeat(3900) });
  let page = await f.client.workDiscussion("empty", { limit: 50 }), count = page.discussion.items.length;
  assert.ok(count < 10); assert.equal(page.discussion.hasMore, true); assert.ok(page.discussion.rowBytes <= 65536);
  while (page.discussion.hasMore) { page = await f.client.workDiscussion("empty", { cursor: page.discussion.nextCursor, limit: 50 }); count += page.discussion.items.length; }
  assert.equal(count, 10);
  const room = f.store.room("commons"), message = structuredClone(room.state.messages.find(m => m.id === "large-0")); message.body = "x".repeat(70000);
  const state = { ...room.state, messages: [message] }, window = discussionWindow({ sequence: room.sequence, roomId: "commons", workItemId: "empty", viewerId: "producer" });
  assert.throws(() => selectedWorkDiscussion({ state, workItemId: "empty", viewerId: "producer", sequence: room.sequence, now: Date.now(),
    metadata: [{ id: "event", message_id: message.id, sequence: room.sequence }], window, anchorId: "event" }), { code: "discussion_entry_too_large" });
});

test("continuations reject mixed/malformed/scope/anchor changes and every page rechecks access", async t => {
  const f = await fixture(t); f.post("reply", { replyToId: "test-request" }); f.propose("other");
  const first = f.view("test-handoff", { limit: 1 }), cursor = first.discussion.nextCursor, before = auditRecovery(f.store);
  for (const options of [{ limit: 0 }, { limit: 51 }, { since: -1 }, { since: "0" }, { cursor: "" }, { cursor: "bad" }, { cursor, since: 0 },
    { cursor: cursorChange(cursor, c => c.workItemId = "other") }, { cursor: cursorChange(cursor, c => c.roomId = "elsewhere") },
    { cursor: cursorChange(cursor, c => c.viewerId = "reviewer") }, { cursor: cursorChange(cursor, c => c.after = 1) },
    { cursor: cursorChange(cursor, c => c.extra = true) }]) assert.throws(() => f.view("test-handoff", options), { code: "invalid_discussion" });
  assert.throws(() => f.view("test-handoff", { since: first.discussion.horizon + 1 }), { code: "discussion_ahead" });
  assert.throws(() => f.view("test-handoff", { cursor: cursorChange(cursor, c => c.anchorId = "different-event") }), { code: "discussion_history_changed" });
  assert.deepEqual(auditRecovery(f.store), before);
  const base = f.origin + "/api/rooms/commons/work-discussion", headers = { Authorization: "Bearer " + f.keys.producer };
  for (const query of ["workItemId=test-handoff&since=", "workItemId=test-handoff&limit=1.0", "workItemId=test-handoff&limit=1&limit=2",
    "workItemId=test-handoff&viewerId=owner", "workItemId=test-handoff&since=01"]) assert.equal((await fetch(base + "?" + query, { headers })).status, 422);
  assert.equal((await fetch(base + "?workItemId=test-handoff")).status, 401);
  assert.equal((await fetch(base.replace("commons", "elsewhere") + "?workItemId=test-handoff", { headers })).status, 403);
  const browser = f.store.createSession(f.keys.owner);
  assert.throws(() => f.store.workDiscussion(browser.token, "commons", "test-handoff", { expectedSessionBinding: "f".repeat(64) }), { status: 409 });
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "producer", expectedMemberRevision: 0, permissions: ["accept_work", "complete_work"], active: false });
  await assert.rejects(f.client.workDiscussion("test-handoff", { cursor }), { status: 401 });
});

test("client verifies the selected response, boundaries, ordered identities and exact bytes before exposing it", async t => {
  const f = await fixture(t); f.post("reply", { replyToId: "test-request" });
  const original = f.view(), calls = []; let value = original;
  const client = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.keys.producer,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => structuredClone(value) }; } });
  const controller = new AbortController();
  await client.workDiscussion("test-handoff", { signal: controller.signal });
  assert.equal(calls.length, 1); assert.match(calls[0].url, /work-discussion\?/); assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error"); controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  for (const change of [v => v.workItemId = "other", v => v.roomId = "other", v => v.current.workRevision++,
    v => v.discussion.checkpoint--, v => v.discussion.rowBytes++, v => v.discussion.items.reverse(),
    v => v.discussion.items[0].message.id = "constructor", v => v.discussion.items[0].message.body += "changed",
    v => v.discussion.cursor = "foreign", v => v.discussion.limit++, v => v.scope.targetedMessages = "private"]) {
    value = structuredClone(original); change(value); await assert.rejects(client.workDiscussion("test-handoff"), { code: "invalid_response" });
  }
  const count = calls.length;
  for (const options of [{ limit: 51 }, { since: -1 }, { cursor: "x", since: 0 }, { unknown: true }, null, []]) await assert.rejects(client.workDiscussion("test-handoff", options));
  assert.equal(calls.length, count);
  value = { ...original, viewerId: "reviewer" };
  const check = await fetch(f.origin + "/api/session", { headers: { Authorization: "Bearer " + f.keys.producer } }).then(r => r.json());
  const pinned = new RoomAgentClient({ ...f.config, fetchImpl: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/api/session") ? check : value }) });
  await assert.rejects(pinned.workDiscussion("test-handoff"), { code: "identity_mismatch" });
});

test("client binds continued and next pages to the exact frozen window", async t => {
  const f = await fixture(t); for (let n = 0; n < 4; n++) f.post("window-" + n, { replyToId: "test-request" });
  const head = f.view("test-handoff", { limit: 1 }), cursor = head.discussion.nextCursor;
  const original = f.view("test-handoff", { cursor, limit: 1 }); let value = original;
  const client = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.keys.producer,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => value }) });
  assert.deepEqual(await client.workDiscussion("test-handoff", { cursor, limit: 1 }), original);
  for (const change of [v => v.discussion.horizon--, v => v.discussion.after--, v => v.discussion.since++,
    v => v.discussion.nextCursor = cursorChange(v.discussion.nextCursor, c => c.after++),
    v => v.discussion.nextCursor = cursorChange(v.discussion.nextCursor, c => c.anchorId = "changed-anchor"),
    v => v.discussion.nextCursor = cursorChange(v.discussion.nextCursor, c => c.viewerId = "wrong-viewer")]) {
    value = structuredClone(original); change(value);
    await assert.rejects(client.workDiscussion("test-handoff", { cursor, limit: 1 }), { code: "invalid_response" });
  }
});

test("invalid discussion CLI options are usage errors before private configuration is read", async () => {
  for (const extra of [["--limit", "0"], ["--limit", "51"], ["--since", "9007199254740992"], ["--since", "01"],
    ["--cursor", "x", "--since", "0"], ["--cursor", "!"], ["--limit", "1", "--limit", "2"]]) {
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", "discussion", "work", ...extra], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
      child.on("exit", code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.equal(JSON.parse(result.stderr).code, "usage_error");
  }
});

test("real MCP and CLI read a newer clarification, page and inspect their exact correlated draft without snapshots", async t => {
  const f = await fixture(t), first = await f.client.workContext("test-handoff", { includeSource: true });
  const clarification = f.post("clarification", { replyToId: "test-request", body: "New detail: use two agenda items and name the facilitator." });
  assert.equal((await f.client.workContext("test-handoff", { includeSource: true })).work.revision, first.work.revision);
  const mcp = await f.open(), read = async args => (await mcp.call("room_read_work_discussion", { workItemId: "test-handoff", ...args })).result.structuredContent;
  const head = await read({ limit: 1 }), tail = await read({ cursor: head.discussion.nextCursor, limit: 1 });
  assert.equal(tail.discussion.items[0].eventId, clarification.event.id);
  const args = { requestId: "clarification-draft", workItemId: "test-handoff", packetId: "packet", basisRevision: 0, body: "A synthetic two-item answer, ready for its facilitator." };
  const saved = (await mcp.call("room_post_draft", args)).result.structuredContent;
  const retry = (await mcp.call("room_post_draft", args)).result.structuredContent; assert.equal(retry.eventId, saved.eventId);
  const newer = await read({ since: tail.discussion.checkpoint });
  assert.equal(newer.discussion.items.length, 1); assert.equal(newer.discussion.items[0].eventId, saved.eventId);
  assert.equal(newer.discussion.items[0].message.body, args.body); assert.equal(newer.discussion.items[0].message.authorId, "producer");
  const invalid = await mcp.call("room_read_work_discussion", { workItemId: "test-handoff", cursor: head.discussion.nextCursor, since: 0 });
  assert.equal(invalid.error.code, -32602);
  const cli = await new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", "discussion", "test-handoff", "--since", String(tail.discussion.checkpoint), "--limit", "1"],
      { env: { ROOM_AGENT_CONFIG: f.configDirectory }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(cli.code, 0, cli.stderr); assert.equal(cli.stderr, ""); assert.deepEqual(ids(JSON.parse(cli.stdout)), ids(newer));
  assert.equal(f.store.snapshot(f.keys.producer, "commons").cursor, 0);
  assert.equal(f.view().current.workRevision, 0);
});
