// Matchmaking P1 — route tests (RC-2026-09-30-3616).
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Each test guards an independent, behavior-level contract of the new
//    routes: the one-call enter golden path (upsert + P1 abstention
//    envelope — the contract P3 fills without changing), the 404-before-
//    enter guard on matches/PATCH, PATCH pausing removing the seeker from
//    poster discovery, and the bounty-convention idempotency (replay
//    returns the original response without re-executing; key reuse with
//    different input is a 409; replay scope is per-caller so one member
//    can never replay another's response). Credible regressions: a
//    weakened idempotency journal double-appending profile.entered events,
//    a leaky cross-member replay, a guessed member kind.
// 2. No existing coverage: server/matchmaking-routes.mjs is new. The HTTP
//    mount is deferred (server/http.mjs held live), so these tests call the
//    handler module directly at its real boundary — the same boundary the
//    deferred mount will call.
// 3. No test-only production seams: the store/db/auth/helpers shapes are
//    the wiring layer's real call shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { handleMatchmakingRoutes, P1_ABSTAIN_REASON } from "../server/matchmaking-routes.mjs";
import { matchProfilesSchema, createMatchProfiles } from "../server/match-profiles.mjs";
import { matchEventsSchema, matchIdempotencySchema, createMatchEvents } from "../server/match-events.mjs";

const ROOM = "room-1";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  // Test-only DDL: the wiring layer provisions these tables in the app DB.
  db.exec(matchProfilesSchema);
  db.exec(matchEventsSchema);
  db.exec(matchIdempotencySchema);
  t.after(() => db.close());
  const store = { db, transaction: fn => fn() };
  const seen = [];
  const helpers = {
    json: (res, status, body, isHead) => { seen.push({ status, body, isHead }); return { status, body }; },
    reject: (status, code, message) => {
      const error = new Error(message);
      error.status = status; error.code = code;
      throw error;
    },
    body: async req => req._payload,
  };
  const authFor = (identityId, kind) => ({
    member: { id: identityId, kind, displayName: String(identityId).replace("id:agent/", "") },
    identityId,
  });
  const call = ({ route, method, payload = {}, headers = {}, query = "",
    identityId = "id:agent/jill", kind = "agent" } = {}) =>
    handleMatchmakingRoutes({
      req: { method, headers, _payload: payload },
      res: {},
      url: new URL(`https://example.test/api/rooms/${ROOM}/matchmaking/${route}${query}`),
      store, roomId: ROOM,
      // kind === "MISSING" forces member.kind to undefined (default params
      // would otherwise swallow an explicit undefined and hide the fail-closed path).
      auth: identityId === null ? {} : authFor(identityId, kind === "MISSING" ? undefined : kind),
      matchmakingRoute: route,
      helpers,
    });
  const events = identityId => createMatchEvents({ db }).list({ roomId: ROOM, identityId });
  // The journal lists newest-first; reverse to causal order for assertions.
  const causalTypes = identityId => events(identityId).map(e => e.type).reverse();
  return { store, seen, call, events, causalTypes, db };
}

const expectReject = async (promise, status, code) => {
  try { await promise; } catch (error) {
    assert.equal(error.status, status, `expected status ${status}, got ${error.status}: ${error.message}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return error;
  }
  assert.fail(`expected rejection ${status}/${code}`);
};

test("enter creates the profile (201) and returns the P1 abstention envelope", async t => {
  const { call, events } = setup(t);
  const { status, body } = await call({ route: "enter", method: "POST",
    payload: { intents: ["paid", "fun"], capabilities: ["rust"] } });
  assert.equal(status, 201);
  assert.equal(body.profile.identityId, "id:agent/jill");
  assert.equal(body.profile.kind, "agent");
  assert.deepEqual([...body.profile.intents], ["paid", "fun"]);
  assert.deepEqual(body.matches, []);
  assert.equal(body.abstained, true);
  assert.equal(typeof body.abstainReason, "string");
  assert.ok(body.abstainReason.length > 0);
  assert.equal(body.abstainReason, P1_ABSTAIN_REASON);
  assert.deepEqual(events("id:agent/jill").map(e => e.type), ["profile.entered"]);
});

test("enter twice updates the same profile (200) and journals profile.updated", async t => {
  const { call, causalTypes } = setup(t);
  await call({ route: "enter", method: "POST", payload: { intents: ["fun"] } });
  const { status, body } = await call({ route: "enter", method: "POST",
    payload: { intents: ["credits"], availability: "busy" } });
  assert.equal(status, 200);
  assert.deepEqual([...body.profile.intents], ["credits"]);
  assert.equal(body.profile.availability, "busy");
  assert.deepEqual(causalTypes("id:agent/jill"), ["profile.entered", "profile.updated"]);
});

test("enter rejects unknown body keys and wrong methods", async t => {
  const { call } = setup(t);
  await expectReject(
    call({ route: "enter", method: "POST", payload: { intents: ["fun"], hacker: true } }),
    422, "invalid_matchmaking_input");
  await expectReject(
    call({ route: "enter", method: "POST", payload: { intents: ["lottery"] } }),
    422, "invalid_intents");
  await expectReject(call({ route: "enter", method: "GET" }), 405, "method_not_allowed");
});

test("enter fails closed when the member kind is missing — never guessed", async t => {
  const { call } = setup(t);
  await expectReject(
    call({ route: "enter", method: "POST", payload: { intents: ["fun"] }, kind: "MISSING", identityId: "id:agent/x" }),
    422, "invalid_member_kind");
});

test("matches returns the P1 envelope and journals matches.viewed", async t => {
  const { call, causalTypes } = setup(t);
  await call({ route: "enter", method: "POST", payload: { intents: ["fun"] } });
  const { status, body } = await call({ route: "matches", method: "GET", query: "?for=self" });
  assert.equal(status, 200);
  assert.deepEqual(body.matches, []);
  assert.equal(body.abstained, true);
  assert.equal(body.abstainReason, P1_ABSTAIN_REASON);
  assert.equal(body.profile.identityId, "id:agent/jill");
  assert.deepEqual(causalTypes("id:agent/jill"), ["profile.entered", "matches.viewed"]);
});

test("matches and PATCH require a profile first (404 with the enter pointer)", async t => {
  const { call } = setup(t);
  const err = await expectReject(call({ route: "matches", method: "GET" }), 404, "profile_not_found");
  assert.match(err.message, /matchmaking\/enter/);
  await expectReject(
    call({ route: "profile", method: "PATCH", payload: { availability: "paused" } }),
    404, "profile_not_found");
});

test("PATCH pauses the profile and it leaves poster discovery", async t => {
  const { store, call } = setup(t);
  await call({ route: "enter", method: "POST", payload: { intents: ["paid"] } });
  const { status, body } = await call({ route: "profile", method: "PATCH",
    payload: { availability: "paused" } });
  assert.equal(status, 200);
  assert.equal(body.profile.availability, "paused");
  const profiles = createMatchProfiles({ db: store.db });
  assert.deepEqual(profiles.listPublic({ roomId: ROOM }), [],
    "a paused seeker is invisible to poster candidate search");
  await expectReject(
    call({ route: "profile", method: "PATCH", payload: {} }),
    422, "invalid_matchmaking_input");
  await expectReject(
    call({ route: "profile", method: "PATCH", payload: { discoverable: "everyone" } }),
    422, "invalid_discoverable");
});

test("idempotency: replay returns the original response without re-executing", async t => {
  const { call, events } = setup(t);
  const payload = { intents: ["fun"], idempotencyKey: "key-1" };
  const first = await call({ route: "enter", method: "POST", payload });
  const second = await call({ route: "enter", method: "POST", payload });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(events("id:agent/jill").map(e => e.type), ["profile.entered"],
    "the replay must not append a second journal event");
});

test("idempotency: same key with different input is a 409; scope is per-caller", async t => {
  const { call } = setup(t);
  await call({ route: "enter", method: "POST",
    payload: { intents: ["fun"], idempotencyKey: "key-2" } });
  await expectReject(
    call({ route: "enter", method: "POST",
      payload: { intents: ["paid"], idempotencyKey: "key-2" } }),
    409, "idempotency_key_reused");
  // A different caller reusing the same key gets their own record, not a
  // replay of the first caller's response (no cross-member leak).
  const other = await call({ route: "enter", method: "POST",
    payload: { intents: ["fun"], idempotencyKey: "key-2" }, identityId: "id:agent/grok" });
  assert.equal(other.status, 201);
  assert.equal(other.body.profile.identityId, "id:agent/grok");
});

test("idempotency via the Idempotency-Key header works on PATCH", async t => {
  const { call, events } = setup(t);
  await call({ route: "enter", method: "POST", payload: { intents: ["fun"] } });
  const headers = { "idempotency-key": "patch-1" };
  const first = await call({ route: "profile", method: "PATCH",
    payload: { availability: "busy" }, headers });
  const second = await call({ route: "profile", method: "PATCH",
    payload: { availability: "busy" }, headers });
  assert.equal(first.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(events("id:agent/jill").filter(e => e.type === "profile.updated").length, 1);
});
