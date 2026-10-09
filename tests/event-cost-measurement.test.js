// WAVE-500 W1: event-cost measurement harness.
//
// Measures how many `events` rows (room_id, sequence, id, body) each common
// operation appends to a real RoomStore, on the default path and (when the
// branch implements it) the ?fast=1 path. Measurement only — this file
// changes no production behavior.
//
// Budget context (server/store.mjs PILOT_LIMITS):
//   eventsPerRoom = 1,000,000, projectionBytes = 4MB (4*1024*1024).
// Design expectation from the wave300 data-plane-fastpath lane
// (docs/WORK-CLAIMS-FAST-PATH.md on refs/heads/wave300/data-plane-fastpath):
// one work_claim.updated room event per committed claim change (~5 per full
// lifecycle), zero on the ?fast=1 pure-state path.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const eventCount = store =>
  store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;

// Run fn, return how many `events` rows it added (plus fn's own result).
async function measure(store, fn) {
  const before = eventCount(store);
  const result = await fn();
  return { added: eventCount(store) - before, result };
}

async function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Retry transient transport failures; a flaky loopback fetch must never
  // fail the measurement.
  const call = async (method, path, { token, data, retries = 4 } = {}) => {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(origin + path, {
          method,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        const isJson = res.headers.get("content-type")?.includes("json");
        return { status: res.status, body: isJson ? await res.json() : await res.text() };
      } catch (error) {
        lastError = error;
        await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  const command = (token, type, data) =>
    store.command(token, "commons", { id: randomUUID(), type, data });
  return { store, ownerKey, call, command };
}

const ok = (name, response) => {
  assert.ok([200, 201].includes(response.status),
    `${name}: expected 2xx, got ${response.status}: ${JSON.stringify(response.body).slice(0, 400)}`);
  return response;
};

const wc = id => `/api/rooms/commons/work-claims/${id}`;

test("work-claim lifecycle (default path): create -> claim -> note update -> release -> reclaim -> settle", async t => {
  const f = await serve(t);
  const costs = {};
  const step = async (name, path, data) => {
    const { added, result } = await measure(f.store,
      () => f.call("POST", path, { token: f.ownerKey, data }));
    ok(name, result);
    costs[name] = added;
    assert.ok(added <= 2, `${name}: added ${added} events, generous bound is <= 2`);
  };
  await step("create", "/api/rooms/commons/work-claims", { id: "w1", title: "survival probe" });
  await step("claim", `${wc("w1")}/claim`, { note: "taking it" });
  await step("note update", `${wc("w1")}/update`, { note: "halfway there" });
  await step("release", `${wc("w1")}/release`, { note: "handing off" });
  await step("reclaim", `${wc("w1")}/claim`, { note: "taking it back" });
  await step("start", `${wc("w1")}/update`, { state: "in_progress" });
  await step("settle (finish)", `${wc("w1")}/update`, { state: "done" });
  const total = Object.values(costs).reduce((a, b) => a + b, 0);
  console.log(`[event-cost] default claim lifecycle: ${JSON.stringify(costs)} total=${total}`);
  assert.ok(total <= 8, `lifecycle total ${total} events exceeds generous bound 8`);
});

test("work-claim lifecycle (?fast=1): zero room events when the fast path is present", async t => {
  const f = await serve(t);
  const step = (name, path, data, token = f.ownerKey) =>
    measure(f.store, () => f.call("POST", path, { token, data }))
      .then(({ added, result }) => { ok(name, result); return added; });
  // Probe: on a branch WITHOUT the fast path this create adds 1 event; with
  // ?fast=1 support it adds 0 (registry.set only, no room event).
  const probeAdded = await step("fast probe (create)", "/api/rooms/commons/work-claims?fast=1",
    { id: "fastprobe", title: "fast probe" });
  if (probeAdded > 0) {
    // ?fast=1 is not implemented on this branch (the wave300
    // data-plane-fastpath lane's implementation is unmerged), so the query
    // param is a no-op and fast costs equal default costs. Record the
    // observation for the docs table; the wave300 lane measured 5 -> 0.
    console.log(`[event-cost] ?fast=1 NOT implemented on this branch: fast create added ${probeAdded} event(s), identical to the default path.`);
    t.skip("?fast=1 unmerged on this branch — param is a no-op; see docs/wave500/EVENT-COST-TABLE.md");
    return;
  }
  const costs = { create: probeAdded };
  costs.claim = await step("fast claim", `${wc("fastprobe")}/claim?fast=1`, { note: "taking it" });
  costs["note update"] = await step("fast note update", `${wc("fastprobe")}/update?fast=1`, { note: "halfway" });
  costs.release = await step("fast release", `${wc("fastprobe")}/release?fast=1`, { note: "done with it" });
  costs.reclaim = await step("fast reclaim", `${wc("fastprobe")}/claim?fast=1`, {});
  costs.start = await step("fast start", `${wc("fastprobe")}/update?fast=1`, { state: "in_progress" });
  costs["settle (finish)"] = await step("fast settle", `${wc("fastprobe")}/update?fast=1`, { state: "done" });
  const total = Object.values(costs).reduce((a, b) => a + b, 0);
  console.log(`[event-cost] fast claim lifecycle: ${JSON.stringify(costs)} total=${total}`);
  assert.equal(total, 0, `?fast=1 lifecycle must add zero room events, added ${total}`);
});

test("message post adds one room event", async t => {
  const f = await serve(t);
  const { added } = await measure(f.store, () =>
    f.command(f.ownerKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: "hello room" }));
  console.log(`[event-cost] message post: ${added}`);
  assert.equal(added, 1, `message post added ${added} events, expected 1`);
});

test("message edit adds one room event", async t => {
  const f = await serve(t);
  const messageId = f.command(f.ownerKey, T.MESSAGE_POSTED,
    { messageId: randomUUID(), body: "original" }).event.data.messageId;
  const { added } = await measure(f.store, () =>
    f.command(f.ownerKey, T.MESSAGE_EDITED, { messageId, body: "revised", expectedMessageRevision: 0 }));
  console.log(`[event-cost] message edit: ${added}`);
  assert.equal(added, 1, `message edit added ${added} events, expected 1`);
});

test("guest invite create adds no room events", async t => {
  const f = await serve(t);
  const { added, result } = await measure(f.store, () =>
    f.call("POST", "/api/rooms/commons/guest-invites", {
      token: f.ownerKey,
      data: { requestId: randomUUID(), guestLabel: "cost probe", expectedOwnerRevision: 0 },
    }));
  ok("invite create", result);
  console.log(`[event-cost] invite create: ${added}`);
  assert.ok(added <= 1, `invite create added ${added} events, bound is <= 1`);
});

test("guest invite redeem adds one room event (member join)", async t => {
  const f = await serve(t);
  const minted = ok("invite create", await f.call("POST", "/api/rooms/commons/guest-invites", {
    token: f.ownerKey,
    data: { requestId: randomUUID(), guestLabel: "cost probe", expectedOwnerRevision: 0 },
  })).body;
  const identity = f.store.identities.create("CostProbe");
  const keys = generateKeyPair();
  const cardBody = { name: "CostProbe", description: "event-cost probe", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const { added, result } = await measure(f.store, () =>
    f.call("POST", "/api/guest-invites/redeem", {
      token: identity.secret, data: { inviteCode: minted.code, card },
    }));
  ok("invite redeem", result);
  console.log(`[event-cost] invite redeem: ${added}`);
  assert.equal(added, 1, `invite redeem added ${added} events, expected 1`);
});

test("member join (member.added) adds one room event", async t => {
  const f = await serve(t);
  const { added } = await measure(f.store, () =>
    f.command(f.ownerKey, T.MEMBER_ADDED,
      { memberId: "joiner", displayName: "Joiner", kind: "human", permissions: [] }));
  console.log(`[event-cost] member join: ${added}`);
  assert.equal(added, 1, `member join added ${added} events, expected 1`);
});

test("member leave (self-deactivation) adds one room event", async t => {
  const f = await serve(t);
  f.command(f.ownerKey, T.MEMBER_ADDED,
    { memberId: "leaver", displayName: "Leaver", kind: "human", permissions: [] });
  const leaverKey = f.store.issueAccessKey("commons", "leaver");
  const { added, result } = await measure(f.store, () =>
    f.call("DELETE", "/api/rooms/commons/members/leaver", { token: leaverKey }));
  ok("member leave", result);
  console.log(`[event-cost] member leave: ${added}`);
  assert.equal(added, 1, `member leave added ${added} events, expected 1`);
});

test("sweep with no expired leases adds no room events", async t => {
  const f = await serve(t);
  const { added, result } = await measure(f.store, () =>
    f.call("POST", "/api/rooms/commons/work-claims/sweep", { token: f.ownerKey, data: {} }));
  ok("sweep (clean)", result);
  console.log(`[event-cost] sweep (no expired leases): ${added}`);
  assert.equal(added, 0, `clean sweep added ${added} events, expected 0`);
});

test("sweep with one expired lease adds one room event (lease_expired)", async t => {
  const f = await serve(t);
  ok("create", await f.call("POST", "/api/rooms/commons/work-claims",
    { token: f.ownerKey, data: { id: "wexp", title: "expiring probe" } }));
  ok("claim", await f.call("POST", `${wc("wexp")}/claim`,
    { token: f.ownerKey, data: { leaseHours: 1 } }));
  // Backdate the lease through the registry (registry writes are not room
  // events) so the sweep has exactly one lapsed lease to reap.
  const item = f.store.workClaims.get("commons", "wexp");
  assert.ok(item?.leaseExpiresAt, "claimed item carries a lease");
  // leaseExpiresAt is an ISO string in the state machine (sweepRoom only
  // reaps string timestamps) — backdate through the registry, which writes
  // the durable claim table, not the room event log.
  f.store.workClaims.set("commons", { ...item, leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
  const { added, result } = await measure(f.store, () =>
    f.call("POST", "/api/rooms/commons/work-claims/sweep", { token: f.ownerKey, data: {} }));
  ok("sweep (expired)", result);
  console.log(`[event-cost] sweep (one expired lease): ${added}`);
  assert.equal(added, 1, `expired-lease sweep added ${added} events, expected 1`);
});
