// WAVE-400 fuzz worker: MCP tool-argument fuzz for the room_* work-claim tools.
//
// Target: server/mcp-full-profile.mjs — the hosted MCP dispatch layer
// (callHostedStdioTool) and its argument gate (validHostedStdioArgs) for:
//   room_link_work_claim_pr, room_close_work_claim, room_set_member_claim_cap,
//   room_acquire_claim, room_release_claim, room_renew_claim, room_read_board
//
// Invariants under test:
//   1. validHostedStdioArgs(name, args) returns a strict boolean and never
//      throws, for any hostile name/args (the transport calls it OUTSIDE its
//      try/catch, so a throw here is a 500/crash at the MCP boundary).
//   2. callHostedStdioTool either returns { value, isError } or throws a
//      ServiceError-shaped error (numeric status + string code, which the
//      transport's failureValue maps to a structured MCP error). Any other
//      throw (TypeError, DataCloneError, bare Error) becomes the transport's
//      { status: 500, code: "internal" } — a 500-equivalent — and is a bug.
//   3. A refused call (isError === true, or a proper ServiceError throw)
//      performs ZERO state mutation on the work-claims registry.
//   4. Error text (returned or thrown) never contains a stack trace or an
//      identity secret.
//
// TEST-ONLY: reads server modules, writes no production code, adds no deps.
// Seeded RNG (mulberry32); seed = Number(process.env.FUZZ_SEED ?? 20261008).

import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { callHostedStdioTool, validHostedStdioArgs } from "../server/mcp-full-profile.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";

/* ---------------- seeded RNG ---------------- */
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-10-mcp-args] FUZZ_SEED=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = arr => arr[(rand() * arr.length) | 0];
const randInt = (lo, hi) => lo + ((rand() * (hi - lo + 1)) | 0);

/* ---------------- accounting ---------------- */
const stats = { validatorCalls: 0, dispatchCalls: 0 };
const violations = [];
const observations = [];
function violation(tool, kind, detail, args) {
  let argText;
  try { argText = JSON.stringify(args); } catch { argText = String(args); }
  violations.push({ tool, kind, detail: String(detail).slice(0, 300), args: (argText ?? "").slice(0, 300) });
}

/* ---------------- fixture ---------------- */
const ROOM = "commons";
function fixture() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  const keys = { owner: store.issueAccessKey(ROOM, "owner") };
  for (const id of ["agent", "other"]) {
    store.command(keys.owner, ROOM, { id: `add-${id}`, type: "member.added",
      data: { memberId: id, displayName: id, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    keys[id] = store.issueAccessKey(ROOM, id);
    setTier(store.db, ROOM, id, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const now = Date.now();
  const seedClaim = (id, ownerId) => {
    let item = createWork({ id, title: `fuzz ${id}` }, { now, agentId: ownerId ?? "owner" });
    if (ownerId) item = claimWork(item, ownerId, { now, leaseHours: 24 });
    store.workClaims.set(ROOM, item);
    return item;
  };
  seedClaim("fuzz-claim-a", "agent"); // owned by the fuzz caller
  seedClaim("fuzz-claim-b", "other"); // owned by someone else (not-owner paths)
  seedClaim("fuzz-claim-open", null); // unclaimed, created by owner (cancel path)
  return { store, keys, close: () => store.close() };
}
const basisOf = (store, id) => {
  const item = store.workClaims.get(ROOM, id);
  return { claimedAt: item?.claimedAt, historyLength: (item?.history?.length ?? 0) + (item?.historyOmitted ?? 0) };
};
const PR_URL = n => `https://github.com/Uuriko/project-room/pull/${n}`;
const FUTURE_ISO = () => new Date(Date.now() + 3_600_000).toISOString();

/* ---------------- hostile pools ---------------- */
const UNIVERSAL = [
  null, undefined, true, false, 0, -1, 1.5, -1.5, NaN, Infinity, -Infinity,
  2147483647, 2147483648, 9007199254740991, 9007199254740992, 1e30, -1e30,
  "", " ", "   ", "\n", "\t", "\0", "a", "x".repeat(129), "x".repeat(10000),
  "constructor", "__proto__", "prototype", "hasOwnProperty", "toString",
  [], [1], ["a", "b"], [null], {}, { a: 1 }, { nested: { deep: [1, { z: null }] } },
  "😀", "claim-​zero", "ünïcödé", "�", "a\nb", " a ", "\t",
];
const CLAIM_ID_POOL = [
  "", " ", ".", "..", "../x", "..\\x", "/etc/passwd", "a/b", "a b",
  "a".repeat(129), "x".repeat(5000), "😀🎉", "CLAIM", "constructor", "__proto__",
  "prototype", "-lead", "_lead", "0lead", "a".repeat(128), "trailing ", " lead",
  "a.b", "a:b", "a_b-c9", "\0null", "null", "undefined", "NaN", "Infinity",
  "%2e%2e", "..%2f", "⋯", "ａｂｃ", "áe", "no-such-claim", "fuzz-claim-a",
];
const PR_POOL = [
  "https://github.com/Uuriko/project-room/pull/1", "http://github.com/o/r/pull/1",
  "https://github.com:444/o/r/pull/1", "https://user:pw@github.com/o/r/pull/1",
  "https://github.com/o/r/pull/1?x=1", "https://github.com/o/r/pull/1#f",
  "https://github.com/o/r/issues/1", "https://gitlab.com/o/r/pull/1",
  "javascript:alert(1)", "not a url", "", "https://github.com/" + "x".repeat(280),
  "https://github.com/o/r/pull/0", "https://github.com/o/r/pull/999999999999999999999",
  "HTTPS://GITHUB.COM/O/R/PULL/1", " https://github.com/o/r/pull/1 ",
  "https://github.com//pull/1", "https://github.com/o/r/pull/", "ftp://github.com/o/r/pull/1",
  123, null, true, {}, [], "x".repeat(301),
];
const CLAIM_AT_POOL = [
  "2026-10-08T14:53:18.000Z", "not-a-date", "", "2026-13-40T00:00:00Z",
  "0000-00-00T00:00:00Z", "9999-12-31T23:59:59.999Z", 1234567890, -1, 1.5, NaN,
  "2026-10-08", "10/08/2026", "yesterday", "x".repeat(101), "x".repeat(100),
  null, true, {}, [],
];
const INT_POOL = [-1, -2147483648, 1.5, NaN, Infinity, -Infinity, 9007199254740991, 9007199254740992, 1e30, "2", null, true, {}, [], 0];
const VERB_POOL = ["CLOSE", "Close", " close", "close ", "delete", "archive", "", "cancel\0", "cancell", 0, 1, true, null, {}, [], "closeclose"];
const REASON_POOL = ["", "x".repeat(4000), "x".repeat(4001), "x".repeat(100000), "😀".repeat(1000), 123, true, null, {}, [], "\0", "a\nb\tc"];
const CAP_POOL = [0, -1, 1.5, NaN, Infinity, -Infinity, 9007199254740992, 1e30, "20", "1", null, true, {}, [], 10001, -100, 2147483648];
const ID_POOL = ["", "x".repeat(129), "constructor", "__proto__", "prototype", 123, null, true, {}, [], "ok-id_1", "a.b:c_d-e"];
const STR_POOL = ["", "x".repeat(5000), "😀", 123, null, true, {}, [], "ok/repo", "a".repeat(600)];
const PATHS_POOL = [[], ["x".repeat(600)], [123], [null], [""], [" "], "not-an-array", {}, null,
  Array(65).fill("server/a.mjs"), [["nested"]], [{ p: 1 }], ["a", 1, null]];
const EXPIRES_POOL = ["not-a-date", "", 123, null, true, {}, [], "2020-01-01T00:00:00.000Z",
  "9999-12-31T23:59:59.999Z", "x".repeat(5000), "2026-10-08", 1.5, NaN];
const PR_ARRAY_POOL = [["https://github.com/o/r/pull/1"], "not-an-array", {}, null,
  Array(17).fill("https://github.com/o/r/pull/1"), [123], [""], ["not a url"]];
const BLOCKS_POOL = [[{ path: "a", block: "b" }], "x", {}, null, [{}], [{ path: 1 }],
  Array(65).fill({ path: "a" }), [{ path: "x".repeat(600) }]];
const QUEUE_POOL = ["ready", "all", "bogus", "", null, 123, true, {}, [], "READY"];
const STATE_POOL = ["unclaimed", "claimed", "in_progress", "blocked", "done", "closed", "bogus", "", "released", null, 123];
const LIMIT_POOL = [0, -1, 201, 1.5, NaN, Infinity, -Infinity, 9007199254740992, "50", null, true, {}, [], 2147483647];
const CURSOR_POOL = ["", "x".repeat(2049), "x".repeat(5000), "!!!", "a b", null, 123, true, {}, [], "😀", "."];
const VIEW_POOL = ["summary", "bogus", "", null, 123, true];
const AUTH_POOL = ["member", "owner", "bogus", null, 123, true, {}, []];
const ROOMID_POOL = [123, null, undefined, true, "", "x".repeat(5000), "../x", {}, [], "no-such-room", "COMMONS"];
const EXTRA_KEYS = ["zzz", "extra", "debug", "admin", "constructor", "__proto__", "", " ", "claimId2", "roomId2"];

/* ---------------- per-tool specs ---------------- */
const TOOL_SPECS = {
  room_link_work_claim_pr: {
    required: ["claimId", "pullRequest", "expectedClaimedAt", "expectedHistoryLength"],
    base: ctx => ({ claimId: "fuzz-claim-a", pullRequest: PR_URL(9000 + (ctx.prSeq++)),
      expectedClaimedAt: ctx.basis.claimedAt, expectedHistoryLength: ctx.basis.historyLength }),
    hostileFor: { claimId: () => pick(CLAIM_ID_POOL), pullRequest: () => pick(PR_POOL),
      expectedClaimedAt: () => pick(CLAIM_AT_POOL), expectedHistoryLength: () => pick(INT_POOL) },
  },
  room_close_work_claim: {
    required: ["claimId"],
    base: () => ({ claimId: pick(["fuzz-claim-a", "fuzz-claim-b", "fuzz-claim-open", "no-such-claim"]),
      verb: "close", reason: "fuzz retire" }),
    hostileFor: { claimId: () => pick(CLAIM_ID_POOL), verb: () => pick(VERB_POOL), reason: () => pick(REASON_POOL) },
  },
  room_set_member_claim_cap: {
    required: ["maxMemberOpenClaims"],
    base: () => ({ maxMemberOpenClaims: 20 }),
    hostileFor: { maxMemberOpenClaims: () => pick(CAP_POOL) },
  },
  room_acquire_claim: {
    required: ["repository", "ref", "paths", "expiresAt"],
    base: () => ({ requestId: `fuzz-req-${randInt(1, 999999)}`, repository: "Uuriko/project-room",
      ref: "main", paths: ["server/"], expiresAt: FUTURE_ISO() }),
    hostileFor: { requestId: () => pick(ID_POOL), repository: () => pick(STR_POOL), ref: () => pick(STR_POOL),
      paths: () => pick(PATHS_POOL), expiresAt: () => pick(EXPIRES_POOL),
      pullRequests: () => pick(PR_ARRAY_POOL), blocks: () => pick(BLOCKS_POOL) },
  },
  room_release_claim: {
    required: [],
    base: () => ({ requestId: `fuzz-rel-${randInt(1, 999999)}` }),
    hostileFor: { requestId: () => pick(ID_POOL) },
  },
  room_renew_claim: {
    required: ["expiresAt"],
    base: () => ({ requestId: `fuzz-ren-${randInt(1, 999999)}`, expiresAt: FUTURE_ISO() }),
    hostileFor: { requestId: () => pick(ID_POOL), expiresAt: () => pick(EXPIRES_POOL),
      progressMessageId: () => pick(ID_POOL) },
  },
  room_read_board: {
    required: [],
    base: () => ({}),
    hostileFor: { queue: () => pick(QUEUE_POOL), state: () => pick(STATE_POOL), limit: () => pick(LIMIT_POOL),
      cursor: () => pick(CURSOR_POOL), view: () => pick(VIEW_POOL), auth: () => pick(AUTH_POOL),
      swept: () => pick([true, false, "yes", 1, null]) },
  },
};
const TOOL_NAMES = Object.keys(TOOL_SPECS);

/* ---------------- hostile arg builders ---------------- */
function makeParams(tool, ctx) {
  const spec = TOOL_SPECS[tool];
  const roll = rand();
  if (roll < 0.55) { // one hostile param on an otherwise-valid base
    const args = spec.base(ctx);
    const param = pick(Object.keys(spec.hostileFor));
    args[param] = spec.hostileFor[param](ctx);
    return args;
  }
  if (roll < 0.65) { // missing required (or missing something when none required)
    const args = spec.base(ctx);
    const keys = Object.keys(args);
    if (spec.required.length) delete args[pick(spec.required)];
    else if (keys.length) delete args[pick(keys)];
    return args;
  }
  if (roll < 0.75) { // extra unknown params
    const args = spec.base(ctx);
    for (let i = 0, n = randInt(1, 3); i < n; i++) args[pick(EXTRA_KEYS)] = pick(UNIVERSAL);
    return args;
  }
  if (roll < 0.85) { // fully random hostile object
    const args = {};
    const keys = [...new Set([...Object.keys(spec.hostileFor), ...EXTRA_KEYS])];
    for (let i = 0, n = randInt(1, 4); i < n; i++) args[pick(keys)] = pick(UNIVERSAL);
    return args;
  }
  if (roll < 0.92) return {}; // empty
  return spec.base(ctx);
}
function makeCallArgs(tool, ctx) {
  const args = { roomId: ROOM, ...makeParams(tool, ctx) };
  if (rand() < 0.08) args.roomId = pick(ROOMID_POOL); // hostile roomId slice
  return args;
}

/* ---------------- invariant checkers ---------------- */
const snap = store =>
  JSON.stringify(store.workClaims.list(ROOM)) + "\n" + JSON.stringify(store.workClaims.rawConfig(ROOM));
const STACK_RE = /[\r\n][ \t]*at[ \t]+[^\s(]+[ \t]*\(/;
function leakKind(text, secrets) {
  if (typeof text !== "string" || !text) return null;
  for (const s of secrets) if (typeof s === "string" && s.length > 8 && text.includes(s)) return "secret";
  return STACK_RE.test(text) ? "stack" : null;
}
function safeStringify(value) {
  try { return { ok: true, text: JSON.stringify(value) }; }
  catch (error) { return { ok: false, text: `${error?.constructor?.name}: ${error?.message}` }; }
}

async function dispatchOnce(ctx, tool, callArgs, keyName, secrets) {
  const { store, keys } = ctx;
  const before = snap(store);
  let outcome, threw = null;
  try {
    outcome = await callHostedStdioTool(store, keys[keyName], tool, callArgs);
  } catch (error) { threw = error; }
  stats.dispatchCalls++;
  const label = `${tool} as ${keyName}`;
  if (threw) {
    // The transport's failureValue() maps a ServiceError-shaped throw
    // (numeric status + string code) to a structured MCP error; anything
    // else becomes { status: 500, code: "internal" } — a 500-equivalent.
    const proper = threw && Number.isInteger(threw.status) && typeof threw.code === "string";
    if (!proper) {
      violation(label, "uncaught-throw",
        `${threw?.constructor?.name}: ${String(threw?.message ?? threw).slice(0, 200)}`, callArgs);
    } else {
      const lk = leakKind(String(threw.message ?? ""), secrets);
      if (lk) violation(label, `${lk}-leak-thrown`, "leak in thrown error message", callArgs);
      if (threw.status === 500 || threw.code === "internal")
        violation(label, "500-equivalent-thrown", `status=${threw.status} code=${threw.code}`, callArgs);
    }
    if (snap(store) !== before) violation(label, "mutation-on-throw", "registry state changed despite throw", callArgs);
    return;
  }
  if (!outcome || typeof outcome !== "object" || typeof outcome.isError !== "boolean" || !("value" in outcome)) {
    violation(label, "bad-outcome-shape", String(outcome).slice(0, 200), callArgs);
    return;
  }
  const flat = safeStringify(outcome);
  if (!flat.ok) {
    // The transport does JSON.stringify(value) in toolResult(); an
    // unserializable outcome crashes the MCP boundary.
    violation(label, "unserializable-outcome", flat.text, callArgs);
    return;
  }
  const lk = leakKind(flat.text, secrets);
  if (lk) { violation(label, `${lk}-leak-returned`, "leak in returned outcome", callArgs); return; }
  if (outcome.isError) {
    const v = outcome.value;
    const okShape = v && typeof v === "object" && Number.isInteger(v.status)
      && typeof v.code === "string" && typeof v.message === "string";
    if (!okShape) violation(label, "bad-error-shape", (flat.text ?? "").slice(0, 300), callArgs);
    else if (v.status === 500 || v.code === "internal")
      violation(label, "500-equivalent", `status=${v.status} code=${v.code}`, callArgs);
    if (snap(store) !== before)
      violation(label, "mutation-on-refusal", "registry state changed on isError=true", callArgs);
  }
  // isError === false: the input was (perhaps surprisingly) valid — mutation allowed.
}

const keyFor = tool =>
  tool === "room_set_member_claim_cap" ? (rand() < 0.5 ? "owner" : "agent")
  : tool === "room_close_work_claim" || tool === "room_link_work_claim_pr" ? (rand() < 0.2 ? "owner" : "agent")
  : "agent";

/* ---------------- tests ---------------- */

test("sanity: valid claim-tool calls succeed and stay well-formed", async t => {
  const ctx = fixture();
  t.after(ctx.close);
  const { store, keys } = ctx;
  const basis = basisOf(store, "fuzz-claim-a");
  // validator accepts a fully valid call
  assert.equal(validHostedStdioArgs("room_link_work_claim_pr", { roomId: ROOM,
    claimId: "fuzz-claim-a", pullRequest: PR_URL(9101),
    expectedClaimedAt: basis.claimedAt, expectedHistoryLength: basis.historyLength }), true);
  // validator rejects a malformed call
  assert.equal(validHostedStdioArgs("room_link_work_claim_pr",
    { roomId: ROOM, claimId: "../x", pullRequest: 42 }), false);
  // valid link succeeds
  const link = await callHostedStdioTool(store, keys.agent, "room_link_work_claim_pr",
    { roomId: ROOM, claimId: "fuzz-claim-a", pullRequest: PR_URL(9101),
      expectedClaimedAt: basis.claimedAt, expectedHistoryLength: basis.historyLength });
  assert.equal(link.isError, false);
  assert.ok(link.value.pullRequests.some(pr => pr.url === PR_URL(9101)));
  // the same stale basis now conflicts instead of double-applying
  const stale = await callHostedStdioTool(store, keys.agent, "room_link_work_claim_pr",
    { roomId: ROOM, claimId: "fuzz-claim-a", pullRequest: PR_URL(9102),
      expectedClaimedAt: basis.claimedAt, expectedHistoryLength: basis.historyLength });
  assert.equal(stale.isError, true);
  assert.equal(stale.value.code, "work_claim_conflict");
  // owner sets the cap; a non-owner is refused with a proper error
  const cap = await callHostedStdioTool(store, keys.owner, "room_set_member_claim_cap",
    { roomId: ROOM, maxMemberOpenClaims: 7 });
  assert.equal(cap.isError, false);
  const capDenied = await callHostedStdioTool(store, keys.agent, "room_set_member_claim_cap",
    { roomId: ROOM, maxMemberOpenClaims: 7 }).then(
      outcome => ({ returned: true, outcome }),
      error => ({ returned: false, error }));
  // NOTE: unlike room_link/close_work_claim (which convert ServiceErrors to
  // { value, isError: true }), the cap branch lets the refusal throw. A
  // ServiceError-shaped throw is still a proper MCP error at the transport.
  assert.equal(capDenied.returned, false);
  assert.equal(capDenied.error.status, 403);
  assert.equal(capDenied.error.code, "work_claims_not_permitted");
  // holder closes their own claim
  const closed = await callHostedStdioTool(store, keys.agent, "room_close_work_claim",
    { roomId: ROOM, claimId: "fuzz-claim-a", verb: "close", reason: "sanity" });
  assert.equal(closed.isError, false);
  assert.equal(closed.value.state, "closed");
  // closing again is a proper terminal refusal, not a crash
  const again = await callHostedStdioTool(store, keys.agent, "room_close_work_claim",
    { roomId: ROOM, claimId: "fuzz-claim-a" });
  assert.equal(again.isError, true);
  assert.equal(typeof again.value.code, "string");
});

test("validator fuzz: validHostedStdioArgs returns boolean and never throws", () => {
  const ROUNDS = 260;
  for (let i = 0; i < ROUNDS; i++) {
    for (const tool of TOOL_NAMES) {
      const callArgs = makeCallArgs(tool, { basis: { claimedAt: "2026-10-08T14:53:18.000Z", historyLength: 2 }, prSeq: 0 });
      let result, threw = null;
      try { result = validHostedStdioArgs(tool, callArgs); } catch (error) { threw = error; }
      stats.validatorCalls++;
      if (threw) violation(tool, "validator-throw", `${threw?.constructor?.name}: ${threw?.message}`, callArgs);
      else if (typeof result !== "boolean") violation(tool, "validator-nonboolean", typeof result, callArgs);
    }
  }
  // hostile tool names must be rejected as false, never throw
  for (const name of [123, null, undefined, "", "__proto__", "room_nope", "ROOM_CLOSE_WORK_CLAIM",
    "bounty_post", {}, [], true, "room_close_work_claim "]) {
    let result, threw = null;
    try { result = validHostedStdioArgs(name, { roomId: ROOM }); } catch (error) { threw = error; }
    stats.validatorCalls++;
    const label = `name=${JSON.stringify(name)}`;
    if (threw) violation(label, "validator-throw-name", `${threw?.constructor?.name}: ${threw?.message}`, { roomId: ROOM });
    else if (typeof result !== "boolean") violation(label, "validator-nonboolean-name", typeof result, {});
    else if (result !== false) violation(label, "validator-accepted-bad-name", "non-tool name accepted", {});
  }
  // hostile arg shapes (non-object args) must be rejected as false, never throw
  for (const args of [null, undefined, 42, "x", [], true]) {
    let result, threw = null;
    try { result = validHostedStdioArgs("room_close_work_claim", args); } catch (error) { threw = error; }
    stats.validatorCalls++;
    if (threw) violation("room_close_work_claim", "validator-throw-shape", `${threw?.constructor?.name}`, { shape: typeof args });
    else if (result !== false) violation("room_close_work_claim", "validator-accepted-bad-shape", typeof args, {});
  }
  // Informational probe (not wire-reachable: JSON.parse never yields getters).
  // The transport calls the validator outside try/catch, so a throw here is
  // still worth recording.
  const evil = {};
  Object.defineProperty(evil, "roomId", { enumerable: true, get() { throw new Error("evil getter"); } });
  let evilThrew = null;
  try { validHostedStdioArgs("room_close_work_claim", evil); } catch (error) { evilThrew = error; }
  stats.validatorCalls++;
  observations.push({ probe: "validator-throwing-getter",
    threw: evilThrew ? `${evilThrew.constructor.name}: ${evilThrew.message}` : null });
});

/* Fixed boundary cases that the seeded corpus may or may not hit. */
const FIXED_CASES = {
  room_link_work_claim_pr: [
    { claimId: "a".repeat(128), pullRequest: PR_URL(9201), expectedClaimedAt: "2026-10-08T14:53:18.000Z", expectedHistoryLength: 0 }, // valid pattern, unknown id -> 404
    { claimId: "a".repeat(129), pullRequest: PR_URL(9201), expectedClaimedAt: "2026-10-08T14:53:18.000Z", expectedHistoryLength: 0 }, // over pattern -> 422
    { claimId: "fuzz-claim-a", pullRequest: "x".repeat(301), expectedClaimedAt: "2026-10-08T14:53:18.000Z", expectedHistoryLength: 0 },
    { claimId: "fuzz-claim-a", pullRequest: PR_URL(9201), expectedClaimedAt: "2026-10-08T14:53:18.000Z", expectedHistoryLength: 9007199254740991 },
    { claimId: "fuzz-claim-a", pullRequest: PR_URL(9201), expectedClaimedAt: "9999-12-31T23:59:59.999Z", expectedHistoryLength: 0 },
  ],
  room_close_work_claim: [
    { claimId: "fuzz-claim-a", verb: "cancel", reason: "x" }, // holder cancels own open claim
    { claimId: "fuzz-claim-a", verb: "CLOSE" },
    { claimId: "fuzz-claim-b", verb: "close", reason: "not mine" }, // other's claim, agent key
    { claimId: "fuzz-claim-open", verb: "close" }, // unclaimed, agent key
    { claimId: "a".repeat(128), verb: "close" },
    { claimId: "fuzz-claim-a", reason: "x".repeat(4001) },
    { claimId: "fuzz-claim-a", verb: "close", reason: "x".repeat(4000) },
  ],
  room_set_member_claim_cap: [
    { maxMemberOpenClaims: 1 }, { maxMemberOpenClaims: 10000 },
    { maxMemberOpenClaims: 0 }, { maxMemberOpenClaims: 10001 }, {},
  ],
  room_acquire_claim: [
    { requestId: "ok-1", repository: "o/r", ref: "main", paths: [], expiresAt: FUTURE_ISO() },
    { repository: "o/r", ref: "main", paths: ["a"], expiresAt: FUTURE_ISO() }, // no requestId
    { requestId: "ok-2", repository: "o/r", ref: "main", paths: Array(65).fill("a"), expiresAt: FUTURE_ISO() },
    { requestId: "ok-3", repository: "o/r", ref: "main", paths: ["a"], expiresAt: "not-a-date" },
  ],
  room_release_claim: [{}, { requestId: "nope" }, { requestId: 42 }],
  room_renew_claim: [
    { expiresAt: FUTURE_ISO() },
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    { requestId: "r1", expiresAt: FUTURE_ISO(), progressMessageId: "nope" },
  ],
  room_read_board: [
    { limit: 200 }, { limit: 201 }, { limit: 0 }, { queue: "ready", state: "claimed" },
    { cursor: "x".repeat(2048) }, { cursor: "x".repeat(2049) }, { state: "bogus" },
    { queue: "ready", limit: 1 }, { view: "summary", limit: 5 },
  ],
};

for (const tool of TOOL_NAMES) {
  test(`dispatch fuzz: ${tool} (220 seeded + fixed hostile calls)`, async t => {
    const store_fx = fixture();
    t.after(store_fx.close);
    const ctx = { ...store_fx, basis: basisOf(store_fx.store, "fuzz-claim-a"), prSeq: 0 };
    const secrets = [ctx.keys.agent, ctx.keys.owner, ctx.keys.other];
    // fixed boundary cases first (deterministic)
    for (const params of FIXED_CASES[tool]) {
      await dispatchOnce(ctx, tool, { roomId: ROOM, ...params }, keyFor(tool), secrets);
    }
    // seeded hostile calls
    for (let i = 0; i < 220; i++) {
      await dispatchOnce(ctx, tool, makeCallArgs(tool, ctx), keyFor(tool), secrets);
    }
  });
}

test("fuzz-10 report: call counts and invariant violations", () => {
  const total = stats.validatorCalls + stats.dispatchCalls;
  console.log(`[fuzz-10-mcp-args] calls: validator=${stats.validatorCalls} dispatch=${stats.dispatchCalls} total=${total}`);
  console.log(`[fuzz-10-mcp-args] violations=${violations.length} observations=${observations.length}`);
  for (const o of observations) console.log(`[fuzz-10-mcp-args] observation: ${JSON.stringify(o)}`);
  if (violations.length) {
    const byKind = {};
    for (const v of violations) byKind[`${v.tool} :: ${v.kind} :: ${v.detail.slice(0, 90)}`] = (byKind[`${v.tool} :: ${v.kind} :: ${v.detail.slice(0, 90)}`] ?? 0) + 1;
    console.log(`[fuzz-10-mcp-args] violation groups: ${JSON.stringify(byKind, null, 2)}`);
    const seen = new Set();
    for (const v of violations) {
      const key = `${v.kind} :: ${v.detail.slice(0, 90)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`[fuzz-10-mcp-args] first of group: ${JSON.stringify(v)}`);
    }
  }
  assert.ok(total >= 3000, `only ${total} hostile calls, need >= 3000`);
  assert.equal(violations.length, 0, `${violations.length} invariant violations (see log above)`);
});
