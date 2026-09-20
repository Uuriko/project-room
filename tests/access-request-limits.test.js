import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// POST /api/access-requests is unauthenticated: an identity that is not a member
// yet asks to join. docs/ROUTE-AUTH-TABLE.md says it "is rate limited per
// identity (5/hour)".
//
// That bound was keyed on the caller-supplied identityId, and checked BEFORE
// the identity was proven to exist, so changing one character per request
// voided it entirely - and each made-up value allocated a token bucket that was
// never released, on a route with no per-address limit at all. Its three
// sibling open routes each carry one.
//
// Keyed after the existence check, the key space is the identities table.

function setup(t, { capacity = 5, refillPerSecond = 5 / 3600, maxKeys } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-access-request-limits-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const buckets = new Map();
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ store: buckets, capacity, refillPerSecond, ...(maxKeys ? { maxKeys } : {}) })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, buckets };
}

const ask = (requests, identityId, requestId, roomId = "commons") => {
  try {
    return { ok: true, result: requests.request(roomId, { identityId, displayName: "Asker", requestedPermissions: ["steer"], note: "please", requestId }) };
  } catch (error) { return { ok: false, status: error.status, code: error.code }; }
};

test("an identity that does not exist never allocates a rate-limit bucket", t => {
  const { requests, buckets } = setup(t);

  for (let index = 0; index < 50; index += 1) {
    const answer = ask(requests, `made-up-identity-${index}`, `req-${index}`);
    assert.equal(answer.ok, false);
    assert.equal(answer.status, 404, "an unknown identity is a 404, and says nothing more");
  }
  assert.equal(buckets.size, 0, "50 invented identities must leave nothing behind");
});

test("a real identity is still bounded at its documented budget", t => {
  const { store, requests, buckets } = setup(t);
  const identity = store.identities.create("Asking Agent");

  // Five rooms so each ask is a distinct, genuinely new request.
  for (let index = 0; index < 5; index += 1) {
    store.initialize(initialRoom(`room-${index}`));
  }
  const answers = [];
  for (let index = 0; index < 7; index += 1) {
    answers.push(ask(requests, identity.identityId, `req-${index}`, `room-${index % 5}`));
  }
  assert.ok(answers.some(answer => !answer.ok && answer.status === 429), "the budget still refuses");
  assert.equal(buckets.size, 1, "one real identity, one bucket");
});

test("the bucket map is bounded and evicts the least recently used", t => {
  const { store, requests, buckets } = setup(t, { maxKeys: 3 });
  const identities = [];
  for (let index = 0; index < 5; index += 1) {
    identities.push(store.identities.create(`Agent ${index}`).identityId);
    store.initialize(initialRoom(`room-${index}`));
  }
  for (const [index, identityId] of identities.entries()) ask(requests, identityId, `req-${index}`, `room-${index}`);

  assert.ok(buckets.size <= 3, `bounded at 3, saw ${buckets.size}`);
  // The two oldest keys are the ones that went.
  assert.ok(!buckets.has(`access-request:${identities[0]}`));
  assert.ok(buckets.has(`access-request:${identities[4]}`), "the most recent survives");
});

test("eviction is by recency of use, not of creation", t => {
  const limiter = createRateLimiter({ store: new Map(), capacity: 10, refillPerSecond: 1, maxKeys: 2 });
  const buckets = new Map();
  const bounded = createRateLimiter({ store: buckets, capacity: 10, refillPerSecond: 1, maxKeys: 2 });
  assert.ok(limiter.check("a").allowed);

  bounded.check("a");
  bounded.check("b");
  bounded.check("a"); // touching "a" makes "b" the least recently used
  bounded.check("c");
  assert.ok(buckets.has("a"), "the recently used key stays");
  assert.ok(buckets.has("c"));
  assert.ok(!buckets.has("b"), "the untouched one is the one evicted");
});

test("an evicted identity gets a fresh budget rather than a refusal", t => {
  // The trade this makes: a flood costs the flooded-out keys their history, but
  // never locks anyone out. Refusing new keys instead would let one attacker
  // deny the route to everybody.
  const buckets = new Map();
  const limiter = createRateLimiter({ store: buckets, capacity: 1, refillPerSecond: 1 / 3600, maxKeys: 1 });
  assert.equal(limiter.check("victim").allowed, true);
  assert.equal(limiter.check("victim").allowed, false, "budget spent");
  limiter.check("flood");                       // evicts "victim"
  assert.equal(limiter.check("victim").allowed, true, "comes back with a fresh bucket, not a refusal");
});
