// room_response_latency / GET /api/rooms/{roomId}/latency: who answers whom, how
// fast, what was dropped. Derived from the journal tail and mention records;
// no new store, so these tests also pin that a read appends nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { isCurrentRoom } from "../server/current-room-repository.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildResponseLatency, collectLatencyItems, percentile, readResponseLatency, LATENCY_MAX_BYTES, LATENCY_SLA_MS } from "../server/response-latency.mjs";
import { HOSTED_ROOM_MCP_TOOLS } from "../src/room-mcp-join.js";

const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const at = sec => new Date(T0 + sec * 1000).toISOString();
let seq = 0;
const ev = (type, actorId, sec, extra = {}) => ({ seq: ++seq, id: `e${seq}`, type, actorId, at: at(sec), toId: null, messageId: null, requestKind: null,
  responseTo: null, requestMessageId: null, workItemId: null, accountableId: null, ...extra });
const members = { a: { displayName: "Ada", kind: "agent" }, b: { displayName: "Bob", kind: "agent" }, h: { displayName: "Hana", kind: "human" } };
const build = (events, extra = {}) => buildResponseLatency({ roomId: "r", viewerId: "a", ownerId: "h", now: T0 + 4 * 3600 * 1000, through: seq, window: null, events, members, ...extra });
const pair = (s, from, to, ctx) => s.pairs.find(p => p.from === from && p.to === to && p.ctx === ctx);

test("percentile is nearest-rank and empty-safe", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test("dm: the first unanswered private message opens one clock; the answer closes it and never opens another", () => {
  const events = [
    ev("message.posted", "a", 0, { toId: "b", messageId: "d1" }),
    ev("message.posted", "a", 5, { toId: "b", messageId: "d2" }), // same open ask: does not re-anchor
    ev("message.posted", "b", 30, { toId: "a", messageId: "d3" }), // answers, 30 s
    ev("message.posted", "a", 60, { toId: "b", messageId: "d4" }), // a fresh ask by a
    ev("message.posted", "b", 61, { toId: "a", messageId: "d5" }), // 1 s
    ev("message.posted", "a", 100, { toId: "b", messageId: "d6" }) // never answered, 4 h old
  ];
  const s = build(events);
  const p = pair(s, "Ada", "Bob", "dm");
  assert.equal(p.n, 3, "d1 (with d2 folded in), d4 and d6");
  assert.equal(p.answered, 2);
  assert.equal(p.dropped, 1);
  assert.equal(p.p50Ms, 1000);
  assert.equal(p.maxMs, 30000);
  assert.equal(pair(s, "Bob", "Ada", "dm"), undefined, "an answer is not a request in the other direction");
  assert.deepEqual(s.dropped.map(d => [d.ctx, d.from, d.to, d.ref]), [["dm", "Ada", "Bob", "d6"]]);
});

test("dm: waiting inside the SLA is not dropped; late answers count as late", () => {
  const fresh = build([ev("message.posted", "a", 0, { toId: "b", messageId: "w" })], { now: T0 + 60_000 });
  assert.equal(pair(fresh, "Ada", "Bob", "dm").waiting, 1);
  assert.equal(pair(fresh, "Ada", "Bob", "dm").dropped, 0);
  const slow = build([ev("message.posted", "a", 0, { toId: "b", messageId: "s" }), ev("message.posted", "b", 3600, { toId: "a" })]);
  const p = pair(slow, "Ada", "Bob", "dm");
  assert.equal(p.answered, 1);
  assert.equal(p.late, 1, "answered after the 30 minute SLA");
  assert.equal(p.p50Ms, 3600_000);
});

test("request: ack is the recipient's first progress report, the answer is responseToRequestId, cancelled is not dropped", () => {
  const events = [
    ev("message.posted", "a", 0, { toId: "b", messageId: "q1", requestKind: "reply" }),
    ev("reply_request.progressed", "b", 4, { requestMessageId: "q1" }),
    ev("message.posted", "b", 90, { toId: "a", responseTo: "q1" }),
    ev("message.posted", "a", 100, { toId: "b", messageId: "q2", requestKind: "reply" }), // no ack, no answer
    ev("message.posted", "a", 110, { toId: "b", messageId: "q3", requestKind: "reply" }),
    ev("reply_request.cancelled", "a", 111, { requestMessageId: "q3" })
  ];
  const s = build(events);
  const p = pair(s, "Ada", "Bob", "request");
  assert.equal(p.n, 2, "the cancelled request is counted apart");
  assert.equal(s.cancelled, 1);
  assert.equal(p.answered, 1);
  assert.equal(p.dropped, 1);
  assert.equal(p.ackP50Ms, 4000);
  assert.equal(p.unacked, 1, "q2 never got an ack inside the 10 s window");
  assert.equal(p.p50Ms, 90_000);
  assert.equal(pair(s, "Bob", "Ada", "request"), undefined, "the response is not itself a request");
});

test("work and handoff: any later event by the addressed member on the item answers; the owner is the default handoff target", () => {
  const events = [
    ev("work.proposed", "h", 0, { workItemId: "w1", accountableId: "a" }),
    ev("work.accepted", "a", 20, { workItemId: "w1" }),
    ev("work.handoff_recorded", "a", 50, { workItemId: "w1" }), // no toMemberId: triage goes to the owner
    ev("work.proposed", "h", 60, { workItemId: "w2", accountableId: "b" }), // never touched
    ev("owner.decision_recorded", "h", 3000, { workItemId: "w1" })
  ];
  const s = build(events);
  assert.equal(pair(s, "Hana", "Ada", "work").answered, 1);
  assert.equal(pair(s, "Hana", "Ada", "work").p50Ms, 20_000);
  assert.equal(pair(s, "Hana", "Bob", "work").dropped, 1, "4 h with no event by Bob on w2, past the 60 minute SLA");
  const h = pair(s, "Ada", "Hana", "handoff");
  assert.equal(h.answered, 1);
  assert.equal(h.p50Ms, 2950_000);
  assert.equal(h.late, 0, "49 minutes is inside the 60 minute handoff SLA");
});

test("mention: reply stamp answers, an expired unanswered mention is dropped, private messages never appear as mentions", () => {
  const base = T0 + 1000;
  const events = [ev("message.posted", "a", 1, { messageId: "m1" }), ev("message.posted", "a", 2, { messageId: "m2" }),
    ev("message.posted", "a", 3, { messageId: "m3", toId: "b" })];
  const mentions = [
    { eventId: events[0].id, memberId: "b", state: "responded", createdAt: base, timeoutAt: base + 1800_000, decidedAt: base + 12_000, ackAt: base + 2000, respondedAt: base + 12_000 },
    { eventId: events[1].id, memberId: "b", state: "timed_out", createdAt: base, timeoutAt: base + 1800_000, decidedAt: null, ackAt: null, respondedAt: null },
    { eventId: events[2].id, memberId: "b", state: "delivered", createdAt: base, timeoutAt: base + 1800_000, decidedAt: null, ackAt: null, respondedAt: null }
  ];
  const s = build(events, { mentions });
  const p = pair(s, "Ada", "Bob", "mention");
  assert.equal(p.n, 2, "the mention row on a private message is the dm context's business");
  assert.equal(p.answered, 1);
  assert.equal(p.dropped, 1);
  assert.equal(p.p50Ms, 12_000);
  assert.equal(p.ackP50Ms, 2000);
  assert.equal(collectLatencyItems({ events, mentions, now: T0 }).filter(i => i.ctx === "mention").length, 2);
});

test("builder: stays inside the byte budget with many pairs, sheds rows and says so, totals stay exact", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `m${i}`);
  const many = Object.fromEntries(ids.map(id => [id, { displayName: `Member number ${id}`, kind: "agent" }]));
  const events = [];
  for (let i = 0; i < 39; i++) for (let k = 0; k < 3; k++) events.push(ev("message.posted", ids[i], i * 10 + k, { toId: ids[i + 1], messageId: `x${i}-${k}-${"y".repeat(40)}` }));
  const s = buildResponseLatency({ roomId: "r", viewerId: "m0", ownerId: "m0", now: T0 + 5 * 3600_000, through: 1, window: null, events, members: many });
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= LATENCY_MAX_BYTES);
  assert.equal(s.totals.dm.n, 39);
  assert.equal(s.totals.dm.dropped, 39);
  assert.ok(s.truncated.pairs > 0 || s.pairs.length <= 12);
  assert.equal(s.slaMinutes.dm, LATENCY_SLA_MS.dm / 60000);
});

test("read: REST on a real room; private pairs stay private, and reading appends nothing", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data, key = f.keys.owner) => f.store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  send("message.posted", { messageId: "pub", body: "hey @Test producer can you look" });
  send("message.posted", { messageId: "pub-reply", replyToId: "pub", body: "on it" }, f.keys.producer);
  send("message.posted", { messageId: "priv", toMemberId: "producer", body: "private ping PRIVATE-SENTINEL" });
  send("message.posted", { messageId: "q", toMemberId: "producer", requestKind: "reply", body: "formal ask" });
  const before = f.store.room("commons").sequence;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const asProducer = await (await fetch(`${origin}/api/rooms/commons/latency`, { headers: { Authorization: `Bearer ${f.keys.producer}` } })).json();
  assert.equal(asProducer.contractVersion, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(asProducer)) <= LATENCY_MAX_BYTES);
  assert.equal(asProducer.totals.mention.answered, 1, "the reply stamp closed the public mention");
  assert.equal(asProducer.totals.dm.n, 1);
  assert.equal(asProducer.totals.request.n, 1);
  assert.equal(asProducer.totals.request.waiting, 1);
  assert.ok(asProducer.pairs.some(p => p.from === "Room owner" && p.to === "Test producer" && p.ctx === "dm"), JSON.stringify(asProducer.pairs));
  const asReviewer = await (await fetch(`${origin}/api/rooms/commons/latency`, { headers: { Authorization: `Bearer ${f.keys.reviewer}` } })).json();
  assert.equal(asReviewer.totals.dm.n, 0, "a non-party sees no private pair");
  assert.equal(asReviewer.totals.request.n, 0);
  assert.equal(asReviewer.totals.mention.answered, 1, "public mentions are room-visible");
  assert.ok(!JSON.stringify(asReviewer).includes("PRIVATE-SENTINEL"));
  assert.equal(f.store.room("commons").sequence, before, "reading latency appends nothing");
  const again = readResponseLatency(f.store, f.keys.producer, "commons");
  assert.deepEqual(again, readResponseLatency(f.store, f.keys.producer, "commons"), "memoized per head inside the memo window");
  const anon = await fetch(`${origin}/api/rooms/commons/latency`);
  assert.ok([401, 403].includes(anon.status));
  const bad = await fetch(`${origin}/api/rooms/commons/latency?x=1`, { headers: { Authorization: `Bearer ${f.keys.producer}` } });
  assert.equal(bad.status, 422);
  assert.ok(HOSTED_ROOM_MCP_TOOLS.includes("room_response_latency"));
});

test("MCP twin on a normalized agent room: same document as REST, names resolved, unknown arguments refused", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-latency-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  let clock = Date.now(); store.now = () => clock += 2100;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ada = store.identities.create("Ada"), bob = store.identities.create("Bob");
  new AgentRooms(store).create(ada.secret, { roomId: "lat", title: "Latency", purpose: "Response latency", kind: "personal" });
  linkWithProof(store, ada.secret, "lat", bob, { displayName: "Bob", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "lat", bob.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  assert.equal(isCurrentRoom(store.db, "lat"), true, "this path reads protected current records for names");
  const cmd = (who, id, type, data) => store.command(who.secret, "lat", { id, type, data });
  cmd(ada, "p1", "work.proposed", { workItemId: "item-1", title: "Item", definitionOfDone: "done", accountableMemberId: bob.identityId, independentVerificationRequired: false, ownerDecisionRequired: false });
  cmd(bob, "a1", "work.accepted", { workItemId: "item-1", expectedRevision: 0 });
  cmd(ada, "m1", "message.posted", { messageId: "m1", body: "ping @Bob please look" });
  cmd(bob, "m2", "message.posted", { messageId: "m2", replyToId: "m1", body: "looking" });
  cmd(ada, "q1", "message.posted", { messageId: "q1", toMemberId: bob.identityId, requestKind: "reply", body: "formal ask" });
  const call = args => fetch(`${origin}/room/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bob.secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_response_latency", arguments: args } }) }).then(r => r.json());
  const reply = await call({ roomId: "lat" });
  assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
  const doc = reply.result.structuredContent;
  assert.equal(doc.totals.work.answered, 1, "acceptance by the assignee answered the proposal");
  assert.equal(doc.totals.mention.answered, 1);
  assert.equal(doc.totals.request.waiting, 1);
  assert.ok(doc.pairs.some(p => p.from === "Ada" && p.to === "Bob"), "names, not raw ids: " + JSON.stringify(doc.pairs));
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= LATENCY_MAX_BYTES + 256);
  const rest = await (await fetch(`${origin}/api/rooms/lat/latency`, { headers: { authorization: `Bearer ${bob.secret}` } })).json();
  const stable = value => JSON.parse(JSON.stringify(value, (key, v) => (key === "evaluatedAt" || key === "ageMin" || key === "contentTrust" ? undefined : v)));
  assert.deepEqual(stable(rest), stable(doc), "REST and MCP are the same document");
  const refused = await call({ roomId: "lat", since: 1 });
  assert.equal(refused.result?.isError === true || Boolean(refused.error), true);
});
