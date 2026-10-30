import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMcpEventSubscriptions } from "../server/mcp-event-subscriptions.mjs";
const principal = { principalType: "invited-agent", familyId: "family1", scopes: ["chat:read", "chat:write"], resource: "https://room.example/mcp", roomId: "room1", identityId: "identity1", memberId: "agent1" };
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const input = { principal, name: "room.requested", arguments: { roomId: "room1", memberId: "agent1" }, delivery: { mode: "webhook", url: "https://callback.example/events", secret } };
function setup(t, path = ":memory:") {
  const db = new DatabaseSync(path); t.after(() => { if (db.isOpen) db.close(); });
  let at = 1793390400000, allowed = true, status = 200, blocker, verified = 0;
  const seen = [];
  const store = { db, now: () => at, transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } } };
  const options = { store, authorize: async () => allowed, dnsResolvers: { lookup: async () => [{ address: "8.8.8.8", family: 4 }] }, transport: async (_url, _addresses, request) => {
    const body = JSON.parse(request.body);
    if (body.type === "verification") { verified++; return { status: 200, text: async () => JSON.stringify({ challenge: body.challenge }) }; }
    seen.push(request); if (blocker) await blocker;
    return { status, text: async () => "{}" };
  } };
  const manager = createMcpEventSubscriptions(options);
  return { db, manager, options, seen, verified: () => verified, advance: ms => { at += ms; }, deny: () => { allowed = false; }, status: value => { status = value; }, block: value => { blocker = value; } };
}
const event = { roomId: "room1", memberId: "agent1", requestId: "request1", messageId: "message1", eventId: "wake1" };
test("canonical subscriptions isolate agents and persist stable retries across manager restart", async t => {
  const x = setup(t);
  const first = await x.manager.subscribe(input);
  assert.equal((await x.manager.subscribe({ ...input, arguments: { memberId: "agent1", roomId: "room1" } })).id, first.id);
  await assert.rejects(x.manager.subscribe({ ...input, arguments: { roomId: "other", memberId: "agent1" } }), /scope/);
  assert.equal(x.manager.enqueueRequested({ ...event, memberId: "other" }), 0);
  assert.equal(x.manager.enqueueRequested(event), 1);
  assert.equal(x.manager.enqueueRequested(event), 0);
  x.status(503); await x.manager.drain(); assert.equal(x.seen.length, 1);
  x.advance(3000); x.status(200);
  await createMcpEventSubscriptions(x.options).drain();
  assert.equal(x.seen.length, 2);
  assert.equal(x.seen[0].headers["webhook-id"], x.seen[1].headers["webhook-id"]);
  assert.notEqual(x.seen[0].headers["webhook-timestamp"], x.seen[1].headers["webhook-timestamp"]);
  assert.deepEqual(JSON.parse(x.seen[0].body).data, { roomId: "room1", memberId: "agent1", requestId: "request1", messageId: "message1" });
  await x.manager.drain(); assert.equal(x.seen.length, 2);
});
test("current revocation, expiry and cross-principal unsubscribe fence delivery", async t => {
  const x = setup(t); const sub = await x.manager.subscribe(input);
  x.manager.unsubscribe({ principal: { ...principal, familyId: "wrong" }, id: sub.id });
  x.manager.enqueueRequested(event); await x.manager.drain(); assert.equal(x.seen.length, 1);
  x.manager.enqueueRequested({ ...event, eventId: "wake2" }); x.deny();
  await x.manager.drain(); assert.equal(x.seen.length, 1);
  await assert.rejects(x.manager.subscribe(input), /denied/);
});
test("expired subscription and permanent callback failures stop retries", async t => {
  const x = setup(t); await x.manager.subscribe(input);
  x.manager.enqueueRequested(event); x.advance(3600001); await x.manager.drain(); assert.equal(x.seen.length, 0);
  const y = setup(t); await y.manager.subscribe(input); y.manager.enqueueRequested(event); y.status(410);
  await y.manager.drain(); y.advance(60000); await y.manager.drain(); assert.equal(y.seen.length, 1);
});
test("concurrent workers lease once; unsubscribe cannot be undone by delayed receipt", async t => {
  const x = setup(t); const sub = await x.manager.subscribe(input); x.manager.enqueueRequested(event);
  let release; x.block(new Promise(resolve => { release = resolve; }));
  const draining = x.manager.drain();
  await new Promise(resolve => setImmediate(resolve));
  await createMcpEventSubscriptions(x.options).drain(); assert.equal(x.seen.length, 1);
  x.manager.unsubscribe({ principal, id: sub.id }); release(); await draining;
  assert.equal(x.db.prepare("SELECT state FROM mcp_event_outbox").get().state, "dead");
});
test("crashed leases are reclaimable with same event identity and attempts are bounded", async t => {
  const x = setup(t); await x.manager.subscribe(input); x.manager.enqueueRequested(event);
  x.db.prepare("UPDATE mcp_event_outbox SET state='leased',lease='crashed',lease_until=?,attempts=1").run(x.options.store.now() + 1000);
  await x.manager.drain(); assert.equal(x.seen.length, 0);
  x.advance(1001); x.status(503);
  for (let i = 0; i < 10; i++) { await x.manager.drain(); x.advance(60001); }
  assert.equal(x.seen.length, 7);
  assert.equal(x.db.prepare("SELECT state FROM mcp_event_outbox").get().state, "dead");
});
test("rotation has only a bounded previous signing key window", async t => {
  const x = setup(t); await x.manager.subscribe(input);
  await x.manager.subscribe({ ...input, delivery: { ...input.delivery, secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` } });
  x.manager.enqueueRequested(event); await x.manager.drain(); assert.equal(x.seen[0].headers["webhook-signature"].split(" ").length, 2);
  x.advance(60001); x.manager.enqueueRequested({ ...event, eventId: "wake2" }); await x.manager.drain();
  assert.equal(x.seen[1].headers["webhook-signature"].split(" ").length, 1);
});

test("SQLite outbox survives closing the database and starting a new process-equivalent manager", async t => {
  const dir = mkdtempSync(join(tmpdir(), "room-mcp-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const first = setup(t, path);
  const sub = await first.manager.subscribe(input);
  first.manager.enqueueRequested(event); first.db.close();
  const restarted = setup(t, path);
  await restarted.manager.drain();
  assert.equal(restarted.seen.length, 1);
  assert.equal(restarted.seen[0].headers["X-MCP-Subscription-Id"], sub.id);
  assert.equal(JSON.parse(restarted.seen[0].body).eventId, event.eventId);
});
test("unsubscribe during challenge cannot reactivate an abandoned subscription", async t => {
  const x = setup(t); let release, arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const original = x.options.transport;
  const manager = createMcpEventSubscriptions({ ...x.options, transport: async (...args) => { arrived(); await blocked; return original(...args); } });
  const creating = manager.subscribe(input); await waiting;
  const row = x.db.prepare("SELECT id FROM mcp_event_subscriptions").get();
  manager.unsubscribe({ principal, id: row.id }); release();
  await assert.rejects(creating, /superseded/);
  assert.equal(manager.enqueueRequested(event), 0);
  assert.equal(x.db.prepare("SELECT document FROM mcp_event_subscriptions").get().document, "{}");
});

test("callback ownership cache is bounded, persistent, and invalidated by key rotation", async t => {
  const x = setup(t); await x.manager.subscribe(input); assert.equal(x.verified(), 1);
  x.advance(30000); await createMcpEventSubscriptions(x.options).subscribe(input); assert.equal(x.verified(), 1);
  x.advance(30001); await x.manager.subscribe(input); assert.equal(x.verified(), 2);
  await x.manager.subscribe({ ...input, delivery: { ...input.delivery, secret: `whsec_${Buffer.alloc(32, 8).toString("base64")}` } });
  assert.equal(x.verified(), 3);
});

test("event policy is rechecked after DNS resolution immediately before sending", async t => {
  const x = setup(t); let allowed = true;
  const manager = createMcpEventSubscriptions({ ...x.options, authorizeEvent: () => allowed });
  await manager.subscribe(input); manager.enqueueRequested({ ...event, context: { actorId: "owner", kind: "mention" } });
  x.options.dnsResolvers.lookup = async () => { allowed = false; return [{ address: "8.8.8.8", family: 4 }]; };
  await manager.drain(); assert.equal(x.seen.length, 0);
  assert.equal(x.db.prepare("SELECT state FROM mcp_event_outbox").get().state, "dead");
});
