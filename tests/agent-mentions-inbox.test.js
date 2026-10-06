// An agent that only polls its inbox, or only has the stdio MCP host, must
// still see a direct @mention and be able to read the conversation around it.
// Before this, GET /agent-inbox said "empty" while /mentions held the row, and
// the MCP host had no tool that read messages or mentions at all.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { serveRoomMcp, MCP_VERSION } from "../client/mcp-stdio.mjs";

function enrolledAgent(t) {
  const f = createAcceptanceFixture(), session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "mention-enroll", memberId: "mention-agent", displayName: "Scout", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  // #953: new agents default to t1_readonly; Scout needs write access for message.posted
  setTier(f.store.db, "commons", "mention-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  return { f, token };
}
const say = (f, key, data) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted", data });

test("agent inbox carries an unanswered direct @mention with the text and a replyToId, then drops it once answered", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const empty = f.store.agentInbox(token, "commons");
  assert.deepEqual(empty.directMentions, []);
  assert.match(empty.next.find(step => step.action === "watch-inbox").description, /direct @mentions/);

  say(f, f.keys.owner, { messageId: "ask-scout", body: "@Scout can you list the two venue options?" });
  // A private message between two other members that names the agent is not the agent's to read.
  f.store.dmConsents.request("commons", "guest", "owner", "test"); f.store.dmConsents.decide("commons", "owner", "guest", "approve");
  say(f, f.keys.guest, { messageId: "private-aside", body: "between us, @Scout is slow", toMemberId: "owner" });

  const inbox = f.store.agentInbox(token, "commons");
  assert.equal(inbox.directMentions.length, 1);
  const [mention] = inbox.directMentions;
  assert.equal(mention.messageId, "ask-scout");
  assert.equal(mention.replyToId, "ask-scout");
  assert.equal(mention.from, "owner");
  assert.equal(mention.body, "@Scout can you list the two venue options?");
  assert.equal(mention.state, "delivered");
  assert.equal(inbox.next[0].action, "reply-mention");
  assert.match(inbox.next[0].description, /replyToId: "ask-scout"/);
  assert.equal(JSON.stringify(inbox).includes("private-aside"), false);

  say(f, token, { messageId: "scout-answer", body: "The loft and the studio.", replyToId: "ask-scout" });
  assert.deepEqual(f.store.agentInbox(token, "commons").directMentions, []);
});

test("an overdue mention reads as timed_out without a write inside the read", t => {
  const { f } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  say(f, f.keys.owner, { messageId: "old-ask", body: "@Scout still there?" });
  const later = Date.now() + 24 * 3600000;
  const [mention] = f.store.openDirectMentions("commons", "mention-agent", 50, later);
  assert.equal(mention.state, "timed_out");
});

test("inbox prioritizes current mentions and labels timed-out delivery without requiring replies", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const now = f.store.now();
  say(f, f.keys.owner, { messageId: "current-ask", body: "@Scout current question" });
  say(f, f.keys.owner, { messageId: "overdue-ask", body: "@Scout older obligation" });
  // Different owner-selected deadlines: the newest message has already expired.
  f.store.db.prepare("UPDATE mention_states SET timeout_at=? WHERE message_event_id=(SELECT id FROM events WHERE body LIKE ?)")
    .run(now - 1, '%"messageId":"overdue-ask"%');
  const inbox = f.store.agentInbox(token, "commons");
  assert.equal(inbox.directMentions.length, 2);
  assert.equal(inbox.directMentions[0].state, "timed_out");
  assert.match(inbox.next.find(step => step.action === "reply-mention").description, /replyToId: "current-ask"/);
  say(f, token, { messageId: "current-answer", body: "Done", replyToId: "current-ask" });
  const overdue = f.store.agentInbox(token, "commons");
  assert.equal(overdue.directMentions[0].messageId, "overdue-ask");
  assert.match(overdue.next.find(step => step.action === "reply-mention").description, /delivery-timed-out/i);
  assert.equal(overdue.next.find(step => step.action === "reply-mention").required, false);
  assert.match(overdue.next.find(step => step.action === "reply-mention").description, /timeout remains in history/);
});

test("MCP host reads the inbox and room messages through real stdio against a real server", { timeout: 20000 }, async t => {
  const { f, token } = enrolledAgent(t);
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = join(f.directory, "mcp"); saveAgentConnection(directory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "mention-agent", token });
  let mcp;
  t.after(async () => { if (mcp) await mcp.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  say(f, f.keys.owner, { messageId: "ask-scout", body: "@Scout what's blocking the agenda?" });
  mcp = await openMcpTestClient(directory);
  const inbox = (await mcp.call("room_read_inbox", {})).result.structuredContent;
  assert.equal(inbox.directMentions[0].replyToId, "ask-scout");
  assert.equal(inbox.next[0].action, "reply-mention");
  const page = (await mcp.call("room_read_messages", { after: 0, limit: 100 })).result.structuredContent;
  const asked = page.messages.find(message => message.messageId === "ask-scout");
  assert.equal(asked.from, "owner");
  assert.equal(asked.body, "@Scout what's blocking the agenda?");
  assert.deepEqual(asked.mentions.map(m => m.memberId), ["mention-agent"]);
  assert.equal(page.hasMore, false);
  const tail = (await mcp.call("room_read_messages", { after: page.next })).result.structuredContent;
  assert.deepEqual(tail.messages, []);
  assert.equal(JSON.stringify([inbox, page]).includes(token), false);
});

test("MCP inbox and message reads validate arguments before calling the client", async t => {
  const seen = [];
  const client = { agentInbox: async options => { seen.push(["inbox", options.limit]); return { directMentions: [] }; },
    roomMessages: async options => { seen.push(["messages", options.after, options.limit]); return { messages: [], next: 0, hasMore: false }; } };
  const input = new PassThrough(), output = new PassThrough(), replies = new Map();
  const server = serveRoomMcp({ client, roomId: "commons", memberId: "agent", input, output });
  t.after(() => { server.stop(); input.destroy(); output.destroy(); });
  let text = "", n = 0;
  output.on("data", chunk => { text += chunk; let end; while ((end = text.indexOf("\n")) >= 0) { const r = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); replies.get(r.id)?.(r); } });
  const rpc = (method, params = {}) => new Promise(resolve => { const id = ++n; replies.set(id, resolve); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  assert.equal((await rpc("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "t", version: "1" } })).result.protocolVersion, MCP_VERSION);
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: "5" }, { other: 1 }]) assert.equal((await rpc("tools/call", { name: "room_read_inbox", arguments: bad })).error.code, -32602);
  for (const bad of [{ after: -1 }, { limit: 101 }, { after: 1.5 }, { cursor: "x" }]) assert.equal((await rpc("tools/call", { name: "room_read_messages", arguments: bad })).error.code, -32602);
  assert.deepEqual(seen, []);
  await rpc("tools/call", { name: "room_read_inbox", arguments: {} });
  await rpc("tools/call", { name: "room_read_messages", arguments: { after: 7, limit: 20 } });
  await rpc("tools/call", { name: "room_read_messages", arguments: {} });
  assert.deepEqual(seen, [["inbox", undefined], ["messages", 7, 20], ["messages", 0, 50]]);
});

test("multi-word display names can be @mentioned: the whole name resolves, the longest match wins", async () => {
  const { resolveMentionTargetsInText } = await import("../server/mention-lifecycle.mjs");
  const members = { cowork: { displayName: "Claude (Cowork)" }, producer: { displayName: "Test producer" }, test: { displayName: "Test" },
    scout: { displayName: "Scout" }, gone: { displayName: "Gone", active: false }, me: { displayName: "Me" } };
  const resolve = text => resolveMentionTargetsInText(members, {}, text, "me");
  assert.deepEqual(resolve("@Claude (Cowork) can you look?"), ["cowork"]);
  assert.deepEqual(resolve("@test producer and @Test, then @Scout."), ["producer", "test", "scout"]);
  assert.deepEqual(resolve("ping @scout's queue"), ["scout"]);
  assert.deepEqual(resolve("no match: @Scouting, mail@Scout, @Gone, @Me"), []);
  assert.deepEqual(resolve("@scout @Scout twice"), ["scout"]);
  assert.deepEqual(resolveMentionTargetsInText(members, { helper: "Helper Bot" }, "@Helper Bot", "me"), []);
  assert.deepEqual(resolveMentionTargetsInText({ ...members, helper: { displayName: "h1" } }, { helper: "Helper Bot" }, "@helper bot hi", "me"), ["helper"]);
});

test("a private @mention stays private: the inbox marks it and the guidance keeps the answer private", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.dmConsents.request("commons", "owner", "mention-agent", "test"); f.store.dmConsents.decide("commons", "mention-agent", "owner", "approve");
  say(f, f.keys.owner, { messageId: "dm-ask", body: "@Scout between us, is the budget real?", toMemberId: "mention-agent" });
  const inbox = f.store.agentInbox(token, "commons");
  const [mention] = inbox.directMentions;
  assert.equal(mention.private, true);
  assert.equal(mention.replyToMemberId, "owner");
  assert.match(inbox.next[0].description, /toMemberId: "owner"/);
  f.store.dmConsents.request("commons", "mention-agent", "owner", "test"); f.store.dmConsents.decide("commons", "owner", "mention-agent", "approve");
  say(f, token, { messageId: "dm-answer", body: "Yes, it's real.", replyToId: "dm-ask", toMemberId: "owner" });
  const guestView = f.store.eventsAfter(f.keys.guest, "commons", 0, 100).events.map(({ event }) => event.data?.messageId);
  assert.equal(guestView.includes("dm-ask"), false);
  assert.equal(guestView.includes("dm-answer"), false);
  assert.deepEqual(f.store.agentInbox(token, "commons").directMentions, []);
});

test("two pending mentions survive an unrelated post; each clears only when it is answered, even after timing out", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  say(f, f.keys.owner, { messageId: "q1", body: "@Scout first question" });
  say(f, f.keys.guest, { messageId: "q2", body: "@Scout second question" });
  say(f, token, { messageId: "online", body: "I am online" });
  assert.deepEqual(f.store.agentInbox(token, "commons").directMentions.map(m => m.messageId), ["q2", "q1"]);
  say(f, token, { messageId: "a2", body: "answer two", replyToId: "q2" });
  assert.deepEqual(f.store.agentInbox(token, "commons").directMentions.map(m => m.messageId), ["q1"]);
  f.store.db.prepare("UPDATE mention_states SET state='timed_out', decided_at=? WHERE room_id='commons' AND mentioned_member_id='mention-agent' AND state='delivered'").run(Date.now());
  assert.deepEqual(f.store.agentInbox(token, "commons").directMentions.map(m => [m.messageId, m.state]), [["q1", "timed_out"]]);
  say(f, token, { messageId: "a1", body: "late answer", replyToId: "q1" });
  assert.deepEqual(f.store.agentInbox(token, "commons").directMentions, []);
});

test("through MCP, a private mention is answered privately and a third party never sees either message", { timeout: 20000 }, async t => {
  const { f, token } = enrolledAgent(t);
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = join(f.directory, "mcp"); saveAgentConnection(directory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "mention-agent", token });
  let mcp;
  t.after(async () => { if (mcp) await mcp.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.dmConsents.request("commons", "owner", "mention-agent", "test"); f.store.dmConsents.decide("commons", "mention-agent", "owner", "approve");
  f.store.dmConsents.request("commons", "mention-agent", "owner", "test"); f.store.dmConsents.decide("commons", "owner", "mention-agent", "approve");
  say(f, f.keys.owner, { messageId: "dm-ask", body: "@Scout privately: ship today?", toMemberId: "mention-agent" });
  mcp = await openMcpTestClient(directory);
  const [mention] = (await mcp.call("room_read_inbox", {})).result.structuredContent.directMentions;
  assert.equal(mention.private, true);
  const reply = await mcp.call("room_reply", { requestId: "private-answer-1", replyToId: mention.replyToId, toMemberId: mention.replyToMemberId, body: "Yes, today." });
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result.structuredContent));
  const guestView = JSON.stringify(f.store.eventsAfter(f.keys.guest, "commons", 0, 100).events);
  assert.equal(guestView.includes("ship today"), false);
  assert.equal(guestView.includes("Yes, today."), false);
  assert.deepEqual((await mcp.call("room_read_inbox", {})).result.structuredContent.directMentions, []);
});

test("a unique short @name reaches a multi-word agent inbox and activity without leaking private messages", t => {
  const f = createAcceptanceFixture(), session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "cowork-enroll", memberId: "cowork-agent", displayName: "Claude (Cowork)", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  say(f, f.keys.owner, { messageId: "ask-cowork", body: "@Claude which P0 are you taking?" });
  f.store.dmConsents.request("commons", "guest", "owner", "test");
  f.store.dmConsents.decide("commons", "owner", "guest", "approve");
  say(f, f.keys.guest, { messageId: "private-short-name", body: "@Claude confidential aside", toMemberId: "owner" });
  const inbox = f.store.agentInbox(token, "commons");
  assert.deepEqual(inbox.directMentions.map(m => m.messageId), ["ask-cowork"]);
  assert.deepEqual(f.store.db.prepare("SELECT message_id FROM activity_events WHERE user_id=?").all("cowork-agent").map(row => row.message_id), ["ask-cowork"]);
  assert.deepEqual(f.store.listMentions(token, "commons").mentions.map(m => m.memberId), ["cowork-agent"]);
  // Persist a real pre-fix row: old versions recorded third-party DM mentions.
  const privateEvent = f.store.db.prepare("SELECT id FROM events WHERE body LIKE ?").get('%"messageId":"private-short-name"%');
  const now = f.store.now();
  f.store.db.prepare("INSERT INTO mention_states(room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at) VALUES(?,?,?,'delivered',?,?)")
    .run("commons", privateEvent.id, "cowork-agent", now, now + 60000);
  assert.deepEqual(f.store.listMentions(token, "commons").mentions.map(m => m.memberId), ["cowork-agent"], "historical private rows stay hidden");
  assert.throws(() => f.store.acknowledgeMention(token, "commons", privateEvent.id), { code: "mention_not_found" });
  f.store.dmConsents.request("commons", "guest", "cowork-agent", "test");
  f.store.dmConsents.decide("commons", "cowork-agent", "guest", "approve");
  const ownPrivate = say(f, f.keys.guest, { messageId: "private-to-cowork", body: "@Claude private question", toMemberId: "cowork-agent" });
  assert.ok(f.store.listMentions(token, "commons").mentions.some(row => row.messageEventId === ownPrivate.event.id));
  assert.equal(f.store.acknowledgeMention(token, "commons", ownPrivate.event.id).state, "acknowledged");
  assert.deepEqual(f.store.listMentions(f.keys.owner, "commons", { memberId: "cowork-agent" }).mentions.map(row => row.messageEventId),
    [inbox.directMentions[0].eventId], "owner queries cannot reveal a DM between other parties");
  // A persisted legacy tail must not consume the visible page's 200-row cap.
  const legacyBody = f.store.db.prepare("SELECT body FROM events WHERE id=?").get(privateEvent.id).body;
  const lastSequence = f.store.db.prepare("SELECT MAX(sequence) AS n FROM events WHERE room_id='commons'").get().n;
  const putEvent = f.store.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
  const putMention = f.store.db.prepare("INSERT INTO mention_states(room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at) VALUES(?,?,?,'delivered',?,?)");
  f.store.transaction(() => {
    for (let i = 1; i <= 200; i++) {
      const id = `legacy-private-${i}`;
      putEvent.run("commons", lastSequence + i, id, JSON.stringify({ ...JSON.parse(legacyBody), id }));
      putMention.run("commons", id, "cowork-agent", now + i, now + 60000);
    }
  });
  assert.deepEqual(f.store.listMentions(f.keys.owner, "commons", { memberId: "cowork-agent" }).mentions.map(row => row.messageEventId),
    [inbox.directMentions[0].eventId], "invisible legacy rows cannot evict visible mentions from the page");
});


test("short @names refuse ambiguity across all active members while exact names and ids remain usable", async () => {
  const { resolveMentionTargetsInText: resolve } = await import("../server/mention-lifecycle.mjs");
  const cowork = { displayName: "Claude (Cowork)", kind: "agent" };
  const other = { displayName: "Claude Code", kind: "human" };
  const members = { cowork, other };
  assert.deepEqual(resolve({ cowork }, {}, "@claude, please check", "owner"), ["cowork"]);
  assert.deepEqual(resolve(members, {}, "@Claude please check", "owner"), []);
  assert.deepEqual(resolve(members, {}, "@Claude (Cowork) and @other", "owner"), ["cowork", "other"]);
  assert.deepEqual(resolve(members, {}, "@Claude", "other"), [], "sender remains an ambiguity candidate");
  assert.deepEqual(resolve({ cowork, other: { ...other, active: false } }, {}, "@Claude", "owner"), ["cowork"]);
  assert.deepEqual(resolve({ cowork: { ...cowork, active: false } }, {}, "@Claude", "owner"), []);
  // G16b (deliberate change): exact duplicate full names fan out to every holder, so none misses the wake; still never one by insertion order.
  assert.deepEqual(resolve({ cowork, duplicate: cowork }, {}, "@Claude (Cowork)", "owner").sort(), ["cowork", "duplicate"], "duplicate full names reach all holders, never one by insertion order");
  assert.deepEqual(resolve({ cowork, exact: { displayName: "Claude" } }, {}, "@Claude", "owner"), ["exact"]);
  assert.deepEqual(resolve({ cowork, exact: { displayName: "Claude" } }, {}, "@Claude (Cowork)", "owner"), ["cowork"]);
  assert.deepEqual(resolve({ cowork }, {}, "Claude please check; @_Claude; mail@Claude; @Claudette", "owner"), []);
});
