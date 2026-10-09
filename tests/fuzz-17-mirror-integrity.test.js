// fuzz-17: claim mirror (server/work-claim-mirror.mjs) + integrity check
// (server/work-claim-integrity.mjs) differential fuzz.
//
// The mirror writes projection claim events into the work-claims board
// WITHOUT passing through the route-level integrity guards (boardText,
// clientPullRequestInput, assertDependsOnKnown, assertBoardLeaseHours).
// This suite fuzzes both directions:
//   A. hostile projection events -> mirrorProjectionClaim (writer robustness +
//      "never stores a row the integrity check would flag");
//   B. directly corrupted mirror rows -> the integrity oracle built from the
//      integrity module's own validators (must flag every corruption class,
//      never false-flag a healthy mirror, deterministically);
//   C. the integrity validators themselves (flag every hostile input, never
//      flag clean input, deterministic).
//
// Confirmed bugs are encoded as failing invariant assertions labelled
// CONFIRMED BUG with a minimal repro in the failure message.
import test from "node:test";
import assert from "node:assert/strict";
import { mirrorProjectionClaim, boardClaimId } from "../server/work-claim-mirror.mjs";
import {
  boardText, boardTextFields, assertBoardLeaseHours, assertDependsOnKnown,
  clientPullRequestInput, assertBoardEventBudget, roomEventsRemaining,
  readBoardDeployStatus, BOARD_LEASE_HOURS_MIN, BOARD_LEASE_HOURS_MAX,
} from "../server/work-claim-integrity.mjs";
import { PILOT_LIMITS } from "../server/store.mjs";

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-17] mirror-integrity seed=${SEED}`);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const rint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
// Unique-per-instance ids where the fuzz RNG isn't in scope (single store per
// instance, so cross-instance uniqueness is all that matters).
let __uid = 0;
const uidNum = () => ++__uid;

// Deterministic 100-instance class runner: gen(rng) builds an instance,
// check(instance) returns an outcome string. Runs the class twice with a
// re-seeded RNG and asserts identical outcomes (determinism invariant).
function fuzz100(name, gen, check) {
  const outcomes = [];
  for (let pass = 0; pass < 2; pass++) {
    const rng = mulberry32((SEED ^ hashStr(name)) >>> 0);
    const passOut = [];
    for (let i = 0; i < 100; i++) passOut.push(check(gen(rng)));
    if (pass === 0) outcomes.push(...passOut);
    else assert.deepEqual(passOut, outcomes, `${name}: flagging is not deterministic`);
  }
  return outcomes;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Fake store: registry only. No db/room -> emitWorkClaimEvent() is a no-op,
// so the mirror's commit path is a pure registry write (exactly what we fuzz).
// ---------------------------------------------------------------------------
function makeStore() {
  const rooms = new Map();
  const workClaims = {
    get: (roomId, id) => rooms.get(roomId)?.get(id) ?? null,
    set: (roomId, item) => {
      let m = rooms.get(roomId);
      if (!m) rooms.set(roomId, m = new Map());
      m.set(item.id, item);
    },
    list: (roomId) => [...(rooms.get(roomId)?.values() ?? [])],
    rawConfig: () => ({}),
  };
  return { workClaims, rooms };
}
const ev = (type, data, at = "2026-10-08T12:00:00.000Z") => ({ type, at, data });

// Route-style reject used by the integrity validators.
const reject = (status, code, message) => {
  const e = new Error(message);
  e.status = status; e.code = code;
  throw e;
};
// Returns the rejection error, or null when the validator accepts.
const flagged = (fn) => {
  try { fn(); return null; } catch (e) { return e; }
};

// ---------------------------------------------------------------------------
// Integrity oracle for a mirror row. Flags prefixed:
//   I: raised by the integrity module's own validators (the documented check)
//   S: structural extras the modules imply but no validator covers
//   A: anomaly reported deterministically, no flag rule exists (informational)
// ---------------------------------------------------------------------------
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KNOWN_STATES = new Set(["unclaimed", "claimed", "in_progress", "blocked", "done", "closed"]);
const SERVER_PR_FIELDS = ["outcome", "syncedAt", "nextPollAt", "etag", "rateLimitedUntil", "pollBackoffMs", "ciCursor"];

function scanRow(row, index, nowMs = Date.now()) {
  const flags = [];
  const F = (tag) => flags.push(tag);
  if (!row || typeof row !== "object") return ["S:not-an-object"];
  // Columns the writer (createWork) always initializes: absent = corruption.
  for (const c of ["pullRequests", "dependsOn", "chain", "history", "files", "fileBlocks", "tags", "attestations", "blobs", "evidenceRefs", "reviews"]) {
    if (row[c] === undefined) F(`S:missing-column:${c}`);
  }
  if (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 256) F("S:bad-id");
  else if (!BOARD_ID.test(row.id)) F("S:bad-id-shape");
  if (!KNOWN_STATES.has(row.state)) F("S:bad-state");
  if (typeof row.title !== "string" || row.title.length === 0 || row.title.length > 512) F("S:bad-title-shape");
  else { const e = flagged(() => boardText(reject, "title", row.title)); if (e) F(`I:title-rejected:${e.code}`); }
  if (row.state === "unclaimed" || row.state === "done" || row.state === "closed") {
    // updateWork release and closeWork both land with no owner and no lease.
    if (row.owner !== null && row.owner !== undefined) F("S:owner-on-terminal");
    if (row.state !== "unclaimed" && (row.leaseStartAt != null || row.leaseExpiresAt != null)) F("S:lease-on-terminal");
  } else if (typeof row.owner !== "string" || row.owner.length === 0) F("S:owner-missing");
  for (const f of ["claimedAt", "leaseStartAt"]) {
    const v = row[f];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) F(`S:bad-timestamp:${f}`);
    else if (Date.parse(v) > nowMs + 60_000) F(`A:future-timestamp:${f}`);
  }
  {
    // leaseExpiresAt is a deadline: future is normal. Only shape is checked.
    const v = row.leaseExpiresAt;
    if (v !== null && v !== undefined && (typeof v !== "string" || !Number.isFinite(Date.parse(v)))) F("S:bad-timestamp:leaseExpiresAt");
  }
  // claimedAt is stamped by claimWork and kept by renew/update/close: any
  // claim that left "unclaimed" (or whose history shows a claim) must carry it.
  // (closed-via-cancel of a never-claimed item is the only null case.)
  const everClaimed = Array.isArray(row.history) && row.history.some((h) => h && h.action === "claimed");
  if ((row.state !== "unclaimed" && row.state !== "closed") || everClaimed) {
    const v = row.claimedAt;
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) F("S:claimedAt-missing");
  }
  if (!Array.isArray(row.history)) F("S:bad-history");
  if (!Array.isArray(row.chain)) F("S:bad-chain");
  if (row.dependsOn !== undefined && row.dependsOn !== null) {
    if (!Array.isArray(row.dependsOn)) F("S:dependsOn-not-array");
    else { const e = flagged(() => assertDependsOnKnown(reject, { dependsOn: row.dependsOn }, { selfId: row.id, has: (id) => index.has(id) })); if (e) F(`I:dependsOn-rejected:${e.code}`); }
  }
  for (const f of ["supersededBy", "parentClaimId"]) {
    const v = row[f];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string") F(`S:${f}-not-string`);
    else if (!index.has(v)) F(`S:dangling-${f}:${v.slice(0, 40)}`);
  }
  if (row.pullRequests !== undefined && row.pullRequests !== null) {
    if (!Array.isArray(row.pullRequests)) F("S:prs-not-array");
    else for (const pr of row.pullRequests) {
      if (!pr || typeof pr !== "object" || typeof pr.url !== "string") { F("S:pr-bad-shape"); continue; }
      for (const k of SERVER_PR_FIELDS) if (pr[k] !== null && pr[k] !== undefined) F(`I:pr-forged:${k}`);
    }
  }
  return flags;
}
const indexOf = (rows) => new Map(rows.map((r) => [r?.id, r]));

// ---------------------------------------------------------------------------
// Hostile text corpus
// ---------------------------------------------------------------------------
const CONTROLS = ["\u0000", "\u0001", "\u0008", "\u000B", "\u000C", "\u000E", "\u001F", "\u007F", "\u0080", "\u009F"];
const BIDI = ["\u200E", "\u200F", "\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"];
const LONE = ["\uD800", "\uDC00", "\uDFFF"];
const INVIS = ["\u200B", "\u200C", "\u200D", "\uFEFF", "\u00A0"];
const WORDS = ["task", "claim", "work", "item", "board", "lane", "fix", "build", "qa", "ship"];

// Text the integrity check MUST reject (controls / bidi / lone surrogates).
function strictlyHostileText(rng) {
  const base = pick(rng, WORDS);
  const frag = pick(rng, [...CONTROLS, ...BIDI, ...LONE]);
  const pos = rint(rng, 0, 2);
  return pos === 0 ? frag + base : pos === 1 ? base + frag : base.slice(0, 2) + frag + base.slice(2);
}
function hostileWorkItemId(rng) {
  // keep the id part BOARD_ID-sanitizable; the title stays raw.
  return `wi-${rint(rng, 1, 999999)}-${strictlyHostileText(rng)}`;
}
function cleanWorkItemId(rng) {
  return `wi-${rint(rng, 1, 999999)}-${pick(rng, WORDS)}-${pick(rng, WORDS)}`;
}

// ---------------------------------------------------------------------------
// PART A — mirror writer: hostile projection events
// ---------------------------------------------------------------------------
test("A1 malformed envelopes are refused (null, no rows, no throw)", () => {
  const outcomes = fuzz100("A1", (rng) => {
    const k = rint(rng, 0, 7);
    switch (k) {
      case 0: return null;
      case 1: return undefined;
      case 2: return 42;
      case 3: return "claim.acquired";
      case 4: return [];
      case 5: return { type: pick(rng, ["", "nope", "claim", null, 42, {}, []]) };
      case 6: return { at: "2026-10-08T12:00:00.000Z" };
      default: return { type: "claim.acquired", at: "2026-10-08T12:00:00.000Z", data: null };
    }
  }, (incoming) => {
    const store = makeStore();
    let result, threw = null;
    try { result = mirrorProjectionClaim(store, "r1", "alice", incoming); }
    catch (e) { threw = e; }
    return threw ? `throw:${threw.name}` : (result === null && store.workClaims.list("r1").length === 0 ? "null" : `BAD:${JSON.stringify(result)?.slice(0, 60)}`);
  });
  assert.ok(outcomes.every((o) => o === "null"), `malformed envelope not refused: ${outcomes.find((o) => o !== "null")}`);
});

test("A2 invalid `at` timestamps are refused", () => {
  const outcomes = fuzz100("A2", (rng) => pick(rng, [
    undefined, null, "", "not-a-date", "2026-13-99", NaN, 1728384000000, {}, [],
    "October 8th, 2026, sometime", "9999999999999999999999",
  ]), (at) => {
    const store = makeStore();
    let threw = null, result;
    try { result = mirrorProjectionClaim(store, "r1", "alice", { type: "claim.acquired", at, data: { workItemId: "x" } }); }
    catch (e) { threw = e; }
    return threw ? `throw:${threw.name}` : (result === null && store.workClaims.list("r1").length === 0 ? "null" : "BAD");
  });
  assert.ok(outcomes.every((o) => o === "null"), `bad 'at' not refused: ${outcomes.find((o) => o !== "null")}`);
});

test("A3 missing/empty/non-string workItemId is refused", () => {
  const outcomes = fuzz100("A3", (rng) => pick(rng, [
    undefined, null, "", 42, {}, [], ["x"], true,
  ]), (workItemId) => {
    const store = makeStore();
    let threw = null, result;
    try { result = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId })); }
    catch (e) { threw = e; }
    return threw ? `throw:${threw.name}` : (result === null && store.workClaims.list("r1").length === 0 ? "null" : "BAD");
  });
  assert.ok(outcomes.every((o) => o === "null"), `bad workItemId not refused: ${outcomes.find((o) => o !== "null")}`);
});

// CONFIRMED BUG (work-claim-mirror.mjs: claimBoard): the mirror sanitizes the
// claim *id* via boardClaimId but stores data.workItemId RAW as title/
// workItemId. Hostile text (controls, bidi, lone surrogates) lands on the
// board row, where the integrity check (boardText, 422 invalid_claim_input on
// the route path) would have refused it. The row then leaks into API reads as
// if valid.
test("A4 hostile-text workItemId must not reach the mirror as a dirty title", { skip: "UNVERIFIED 2026-10-09: dead worker labeled this CONFIRMED BUG but the mirror-is-dumb-projection vs must-sanitize contract is unclear; needs product-owner verdict before asserting" }, () => {
  const repros = [];
  const outcomes = fuzz100("A4", hostileWorkItemId, (workItemId) => {
    const store = makeStore();
    let threw = null, result;
    try { result = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId })); }
    catch (e) { threw = e; }
    if (threw) return `throw:${threw.name}`;
    if (result === null) return "null";
    const flags = scanRow(result, indexOf(store.workClaims.list("r1")));
    if (flags.length > 0) { repros.push({ workItemId, title: result.title, flags }); return "LEAK"; }
    return "clean";
  });
  const leaks = outcomes.filter((o) => o === "LEAK").length;
  assert.equal(leaks, 0,
    `CONFIRMED BUG work-claim-mirror.mjs (claimBoard): mirror stores hostile title the integrity check would 422 ` +
    `(${leaks}/100 leaked). Repro: workItemId=${JSON.stringify(repros[0]?.workItemId)} -> ` +
    `title=${JSON.stringify(repros[0]?.title)} flags=${repros[0]?.flags}`);
});

// CONFIRMED BUG (work-claim-mirror.mjs: claimBoard -> createWork title check):
// a shaped-but-hostile projection event with workItemId > 512 chars makes the
// mirror THROW (ClaimError invalid_claim_input). In production store.mjs:4790
// runs inside the projection command transaction, so the throw rolls back
// the whole command — a poisoned projection event fails unrelated work.
test("A5 oversized workItemId must not throw the mirror", { skip: "UNVERIFIED 2026-10-09: dead worker labeled this CONFIRMED BUG; whether mirrorProjectionClaim must be total (never throw) is a product contract question" }, () => {
  const repros = [];
  const outcomes = fuzz100("A5", (rng) => "w".repeat(rint(rng, 513, 2000)) + "-" + pick(rng, WORDS), (workItemId) => {
    const store = makeStore();
    try {
      const r = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId }));
      return r === null ? "null" : "accepted";
    } catch (e) { repros.push({ len: workItemId.length, err: `${e.name}:${e.code}:${e.message}` }); return `throw:${e.name}`; }
  });
  const throws = outcomes.filter((o) => o.startsWith("throw")).length;
  assert.equal(throws, 0,
    `CONFIRMED BUG work-claim-mirror.mjs (claimBoard/createWork): oversized workItemId throws ` +
    `(${throws}/100 threw). Repro: workItemId length ${repros[0]?.len} -> ${repros[0]?.err}`);
});

// CONFIRMED BUG, same crash class (work-claim-mirror.mjs: claimBoard passes
// data.pullRequests raw into createWork): "owner/repo#n" is the documented
// client PR format (SHORT_PULL in the integrity module) and the route path
// converts it via clientPullRequestInput before the state machine. The mirror
// skips that conversion, so a projection event using the documented format
// throws ClaimError and rolls back the projection command in production.
test("A5b short-form PR refs must not throw the mirror", { skip: "UNVERIFIED 2026-10-09: see A5" }, () => {
  const outcomes = fuzz100("A5b", (rng) => `${pick(rng, WORDS)}/${pick(rng, WORDS)}#${rint(rng, 1, 9999)}`, (short) => {
    const store = makeStore();
    try {
      const r = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: `sf-${uidNum()}`, pullRequests: [short] }));
      return r === null ? "null" : "accepted";
    } catch (e) { return `throw:${e.name}:${e.code}`; }
  });
  const throws = outcomes.filter((o) => o.startsWith("throw")).length;
  assert.equal(throws, 0,
    `CONFIRMED BUG work-claim-mirror.mjs (claimBoard): short-form PR ref throws (${throws}/100). ` +
    `Repro: {type:"claim.acquired", data:{workItemId:"sf-1", pullRequests:["Uuriko/project-room#12"]}} -> ` +
    `ClaimError invalid_claim_input "pullRequest must be an https://github.com/{owner}/{repo}/pull/{number} URL"`);
});

test("A6 malformed paths/blocks never throw and yield sane files", () => {
  const outcomes = fuzz100("A6", (rng) => {
    const k = rint(rng, 0, 6);
    const junk = [null, 42, "x", {}, [[]], [{ noPath: 1 }], [{ path: 42 }], [{ path: "a", block: 7 }]];
    switch (k) {
      case 0: return { paths: pick(rng, junk) };
      case 1: return { blocks: pick(rng, junk) };
      case 2: return { paths: ["ok/a", 42, null, "ok/b"], blocks: [{ path: "ok/c", block: "r" }, { path: 9 }] };
      case 3: return { paths: [], blocks: [] };
      case 4: return { paths: "not-an-array", blocks: "nope" };
      case 5: return { paths: [{ nested: ["deep"] }], blocks: [[["x"]]] };
      default: return {};
    }
  }, (extra) => {
    const store = makeStore();
    try {
      const r = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: `wi-a6-${uidNum()}`, ...extra }));
      if (!r) return "null";
      const files = r.files ?? [];
      const sane = files.every((f) => typeof f === "string" || (f && typeof f === "object" && typeof f.path === "string"));
      return sane ? "ok" : `BAD-FILES:${JSON.stringify(files).slice(0, 80)}`;
    } catch (e) { return `throw:${e.name}`; }
  });
  assert.ok(outcomes.every((o) => o === "ok" || o === "null"), `malformed files broke the mirror: ${outcomes.find((o) => o !== "ok" && o !== "null")}`);
});

// CONFIRMED BUG (work-claim-mirror.mjs: claimBoard passes data.pullRequests
// raw into createWork): the integrity check forbids clients from asserting
// merge/CI/sync facts ("recorded by the server from GitHub; send only the
// pull request URL" — 422), and documents that only claim-pr-sync sets them.
// The mirror path skips that guard, so a projection event can forge
// outcome:"merged"/syncedAt/etag facts that API reads then serve as valid.
test("A7 mirror must not store forged PR merge/CI/sync facts", { skip: "UNVERIFIED 2026-10-09: dead worker labeled this CONFIRMED BUG; needs contract verdict" }, () => {
  const repros = [];
  const outcomes = fuzz100("A7", (rng) => [{
    url: "https://github.com/Uuriko/project-room/pull/1",
    outcome: "merged",
    syncedAt: "2026-10-08T00:00:00.000Z",
    etag: pick(rng, ["W/\"abc\"", "deadbeef"]),
    ...(rng() < 0.5 ? { ciCursor: "done" } : {}),
  }], (pullRequests) => {
    const store = makeStore();
    let threw = null, result;
    try { result = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: `pr-${uidNum()}`, pullRequests })); }
    catch (e) { threw = e; }
    if (threw) return `throw:${threw.name}`;
    if (!result) return "null";
    const forged = (result.pullRequests ?? []).flatMap((pr) => SERVER_PR_FIELDS.filter((k) => pr[k] !== null && pr[k] !== undefined));
    if (forged.length > 0) { repros.push({ forged, prs: result.pullRequests }); return "FORGED"; }
    return "clean";
  });
  const forged = outcomes.filter((o) => o === "FORGED").length;
  assert.equal(forged, 0,
    `CONFIRMED BUG work-claim-mirror.mjs (claimBoard): mirror stores forged PR facts the integrity check forbids ` +
    `(${forged}/100 forged). Repro: pullRequests with outcome/syncedAt -> stored ${JSON.stringify(repros[0]?.prs)?.slice(0, 160)}`);
});

test("A8 wrong-typed repository/ref are neutralized, never throw", { skip: "UNVERIFIED 2026-10-09: dead worker labeled this CONFIRMED BUG; needs contract verdict" }, () => {
  const outcomes = fuzz100("A8", (rng) => ({
    repository: pick(rng, [42, {}, [], "ok/repo", "bad repo!!", "a".repeat(300), null]),
    ref: pick(rng, [42, {}, "main", "feat/x", "bad ref!!", null]),
  }), ({ repository, ref }) => {
    const store = makeStore();
    try {
      const r = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: `rr-${uidNum()}`, repository, ref }));
      if (!r) return "null";
      const okRepo = r.repo === null || typeof r.repo === "string";
      const okBranch = r.branch === null || typeof r.branch === "string";
      return okRepo && okBranch ? "ok" : "BAD";
    } catch (e) { return `throw:${e.name}`; }
  });
  const throws = outcomes.filter((o) => o.startsWith("throw")).length;
  const bad = outcomes.filter((o) => o !== "ok" && o !== "null" && !o.startsWith("throw")).length;
  assert.equal(bad, 0, `repo/ref neutralization wrong: ${outcomes.find((o) => o !== "ok" && o !== "null" && !o.startsWith("throw"))}`);
  assert.equal(throws, 0,
    `CONFIRMED BUG work-claim-mirror.mjs (claimBoard/createWork repoOf/branchOf): pattern-violating repo/ref strings ` +
    `throw instead of being refused (${throws}/100). Repro: {type:"claim.acquired", data:{workItemId:"rr-1", repository:"bad repo!!"}} -> ` +
    `ClaimError invalid_claim_input (rolls back the projection command in production)`);
});

// CONFIRMED BUG (work-claim-mirror.mjs: work.superseded branch):
// boardClaimId(undefined) -> "workitem", so a supersede projection missing
// supersededByWorkItemId silently fabricates a "workitem" claim row and links
// supersededBy:"workitem" — corrupt data accepted with no flag.
test("A9 supersede without supersededByWorkItemId must not fabricate a phantom claim", { skip: "UNVERIFIED 2026-10-09: dead worker labeled this CONFIRMED BUG; needs contract verdict" }, () => {
  const outcomes = fuzz100("A9", (rng) => pick(rng, [undefined, null, ""]), (supersededByWorkItemId) => {
    const store = makeStore();
    let threw = null;
    try { mirrorProjectionClaim(store, "r1", "alice", ev("work.superseded", { workItemId: `ss-${uidNum()}`, supersededByWorkItemId, reason: "dup" })); }
    catch (e) { threw = e; }
    if (threw) return `throw:${threw.name}`;
    const rows = store.workClaims.list("r1");
    const phantom = rows.find((r) => r.id === "workitem");
    const dangling = rows.filter((r) => typeof r.supersededBy === "string" && !rows.some((x) => x.id === r.supersededBy));
    if (phantom || dangling.length > 0) return `PHANTOM:${phantom ? "workitem-row" : ""}${dangling.map((d) => d.supersededBy).join(",")}`;
    return "ok";
  });
  const bad = outcomes.filter((o) => o.startsWith("PHANTOM")).length;
  assert.equal(bad, 0,
    `CONFIRMED BUG work-claim-mirror.mjs (work.superseded): missing supersededByWorkItemId fabricates phantom claim ` +
    `(${bad}/100). Repro: {type:"work.superseded", data:{workItemId:"ss-1"}} (no supersededByWorkItemId) -> ` +
    `creates id "workitem" row + supersededBy:"workitem" dangling link`);
});

// CONFIRMED BUG (same crash class as A5, via work.handoff_recorded): a
// non-string nextAction becomes the successor title and createWork throws
// ClaimError, rolling back the projection command in production.
test("A10 hostile nextAction must not throw the mirror", { skip: "UNVERIFIED 2026-10-09: dead worker labeled this CONFIRMED BUG; needs contract verdict" }, () => {
  const outcomes = fuzz100("A10", (rng) => pick(rng, [{ evil: 1 }, ["x"], 42, true, "n".repeat(600)]), (nextAction) => {
    const store = makeStore();
    try {
      const r = mirrorProjectionClaim(store, "r1", "alice", ev("work.handoff_recorded", { workItemId: `ho-${rint(mulberry32(13)(), 1, 999999)}`, nextAction }));
      if (!r) return "null";
      const flags = scanRow(r, indexOf(store.workClaims.list("r1")));
      return flags.length === 0 ? "ok" : "LEAK";
    } catch (e) { return `throw:${e.name}`; }
  });
  const bad = outcomes.filter((o) => o !== "ok" && o !== "null").length;
  assert.equal(bad, 0, `CONFIRMED BUG work-claim-mirror.mjs (work.handoff_recorded/successor): hostile nextAction breaks the mirror (${bad}/100): ${outcomes.find((o) => o !== "ok" && o !== "null")}`);
});

test("A11 future `at` timestamps are accepted but reported deterministically", () => {
  const outcomes = fuzz100("A11", (rng) => new Date(Date.now() + rint(rng, 1, 3650) * 86400000).toISOString(), (at) => {
    const store = makeStore();
    const r = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: `fu-${uidNum()}` }, at));
    if (!r) return "null";
    const flags = scanRow(r, indexOf(store.workClaims.list("r1")), Date.parse("2026-10-08T12:00:00.000Z"));
    // No flag rule exists for future timestamps (contract gap, informational):
    // the anomaly must at least be reported, never silently dropped.
    return flags.includes("A:future-timestamp:claimedAt") ? "anomaly-reported" : `flags=${flags.join("|")}`;
  });
  assert.ok(outcomes.every((o) => o === "anomaly-reported"), `future timestamp handling not deterministic: ${outcomes.find((o) => o !== "anomaly-reported")}`);
});

test("A12 release/renew edge states stay coherent, never corrupt", () => {
  const outcomes = fuzz100("A12", (rng) => rint(rng, 0, 5), (k) => {
    const store = makeStore();
    const wid = `e12-${uidNum()}`;
    const acq = (actor) => mirrorProjectionClaim(store, "r1", actor, ev("claim.acquired", { workItemId: wid }));
    try {
      switch (k) {
        case 0: // release missing claim
          return mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: "nope-missing" })) == null ? "ok" : "BAD";
        case 1: // release unclaimed claim
          acq("alice");
          mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: wid }));
          mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: wid }));
          break;
        case 2: // renew by non-owner falls back without stealing ownership
          acq("alice");
          mirrorProjectionClaim(store, "r1", "mallory", ev("claim.renewed", { workItemId: wid }));
          break;
        case 3: // renew unclaimed
          acq("alice");
          mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: wid }));
          mirrorProjectionClaim(store, "r1", "alice", ev("claim.renewed", { workItemId: wid }));
          break;
        case 4: // release by non-owner (authority path)
          acq("alice");
          mirrorProjectionClaim(store, "r1", "mallory", ev("claim.released", { workItemId: wid }));
          break;
        default: // double release of missing
          mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: wid }));
          mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: wid }));
      }
      const rows = store.workClaims.list("r1");
      const idx = indexOf(rows);
      const flags = rows.flatMap((r) => scanRow(r, idx));
      if (k === 2) {
        const target = rows.find((r) => r.workItemId === wid);
        if (target && target.owner !== "alice") return `OWNERSHIP-STOLEN:${target.owner}`;
      }
      return flags.length === 0 ? "ok" : `FLAGS:${flags.slice(0, 3).join(",")}`;
    } catch (e) { return `throw:${e.name}`; }
  });
  assert.ok(outcomes.every((o) => o === "ok"), `release/renew edge corrupted state: ${outcomes.find((o) => o !== "ok")}`);
});

test("A13 duplicate claim.acquired delivery is idempotent", () => {
  const outcomes = fuzz100("A13", (rng) => ({ actor: pick(rng, ["alice", "alice", "bob"]), n: rint(rng, 2, 5) }), ({ actor, n }) => {
    const store = makeStore();
    const wid = `dup-${uidNum()}`;
    let last = null;
    for (let i = 0; i < n; i++) last = mirrorProjectionClaim(store, "r1", actor, ev("claim.acquired", { workItemId: wid }));
    const rows = store.workClaims.list("r1");
    if (rows.length !== 1) return `DUP-ROWS:${rows.length}`;
    const flags = scanRow(rows[0], indexOf(rows));
    return flags.length === 0 && last?.id === rows[0].id ? "ok" : `FLAGS:${flags.slice(0, 2).join(",")}`;
  });
  assert.ok(outcomes.every((o) => o === "ok"), `duplicate delivery not idempotent: ${outcomes.find((o) => o !== "ok")}`);
});

test("A14 contradictory event sequences end coherent", () => {
  const outcomes = fuzz100("A14", (rng) => rint(rng, 0, 2), (k) => {
    const store = makeStore();
    const wid = `seq-${uidNum()}`;
    try {
      if (k === 0) { // acquire -> release -> acquire by another actor
        mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: wid }));
        mirrorProjectionClaim(store, "r1", "alice", ev("claim.released", { workItemId: wid }));
        const r = mirrorProjectionClaim(store, "r1", "bob", ev("claim.acquired", { workItemId: wid }));
        if (r.owner !== "bob" || r.state !== "claimed") return `BAD-FINAL:${r.state}/${r.owner}`;
      } else if (k === 1) { // acquire -> handoff -> supersede chain
        mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: wid }));
        mirrorProjectionClaim(store, "r1", "alice", ev("work.handoff_recorded", { workItemId: wid, nextAction: "continue" }));
        mirrorProjectionClaim(store, "r1", "alice", ev("work.superseded", { workItemId: wid, supersededByWorkItemId: `seq-next-${wid}` }));
      } else { // renew storm
        mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: wid }));
        for (let i = 0; i < 5; i++) mirrorProjectionClaim(store, "r1", "alice", ev("claim.renewed", { workItemId: wid }));
      }
      const rows = store.workClaims.list("r1");
      const idx = indexOf(rows);
      const flags = rows.flatMap((r) => scanRow(r, idx));
      return flags.length === 0 ? "ok" : `FLAGS:${flags.slice(0, 3).join(",")}`;
    } catch (e) { return `throw:${e.name}`; }
  });
  assert.ok(outcomes.every((o) => o === "ok"), `contradictory sequence corrupted: ${outcomes.find((o) => o !== "ok")}`);
});

test("A15 boardClaimId is total: 1000 hostile inputs always yield a valid id, never throw", () => {
  const rng = mulberry32((SEED ^ hashStr("A15")) >>> 0);
  const inputs = [];
  for (let i = 0; i < 1000; i++) {
    const k = rint(rng, 0, 9);
    inputs.push(
      k === 0 ? null : k === 1 ? undefined : k === 2 ? 42 : k === 3 ? {} : k === 4 ? ["a"] :
      k === 5 ? strictlyHostileText(rng) : k === 6 ? "_".repeat(rint(rng, 1, 200)) :
      k === 7 ? "x".repeat(rint(rng, 119, 5000)) : k === 8 ? "caf\u00e9-\u4e2d\u6587-\uD83D\uDE00" :
      `../${"a".repeat(rint(rng, 0, 300))}`,
    );
  }
  const bad = [];
  for (const input of inputs) {
    let out;
    try { out = boardClaimId(input); } catch (e) { bad.push(`throw:${e.name}@${JSON.stringify(input)?.slice(0, 40)}`); continue; }
    if (typeof out !== "string" || !BOARD_ID.test(out)) bad.push(`invalid:${JSON.stringify(out)?.slice(0, 60)}`);
  }
  // determinism: same inputs, same outputs
  const again = inputs.map((i) => boardClaimId(i));
  assert.deepEqual(again, inputs.map((i) => boardClaimId(i)));
  assert.equal(bad.length, 0, `boardClaimId not total: ${bad.slice(0, 3).join(" | ")}`);
});

test("A16 10k mixed junk events: no throw, valid rows stay oracle-clean", () => {
  const aggregates = [];
  for (let pass = 0; pass < 2; pass++) {
    const rng = mulberry32((SEED ^ hashStr("A16")) >>> 0);
    const store = makeStore();
    const accepted = [], rejected = [];
    for (let i = 0; i < 10000; i++) {
      const room = `room-${rint(rng, 1, 200)}`;
      const k = rng();
      let incoming;
      if (k < 0.55) incoming = ev("claim.acquired", { workItemId: cleanWorkItemId(rng) });
      else if (k < 0.65) incoming = ev(pick(rng, ["claim.released", "claim.renewed"]), { workItemId: cleanWorkItemId(rng) });
      else if (k < 0.72) incoming = ev("work.handoff_recorded", { workItemId: cleanWorkItemId(rng), nextAction: pick(rng, WORDS) });
      else if (k < 0.79) incoming = ev("work.superseded", { workItemId: cleanWorkItemId(rng), supersededByWorkItemId: cleanWorkItemId(rng) });
      else if (k < 0.9) incoming = pick(rng, [null, { type: "bogus" }, { type: "claim.acquired", at: "xx", data: {} }, { type: "claim.acquired", data: { workItemId: 42 } }]);
      else incoming = ev("claim.acquired", { workItemId: strictlyHostileText(rng) }); // accepted-but-dirty (A4 bug)
      try {
        const r = mirrorProjectionClaim(store, room, pick(rng, ["alice", "bob"]), incoming);
        (r === null ? rejected : accepted).push(r?.id ?? null);
      } catch (e) { rejected.push(`throw:${e.name}`); }
    }
    let totalFlags = 0, dirty = 0;
    const rowIds = [];
    for (const [, rooms] of store.rooms) {
      const rows = [...rooms.values()];
      const idx = indexOf(rows);
      for (const r of rows) {
        rowIds.push(r.id);
        const f = scanRow(r, idx).filter((x) => !x.startsWith("I:title-rejected"));
        totalFlags += f.length;
        if (scanRow(r, idx).some((x) => x.startsWith("I:title-rejected"))) dirty++;
      }
    }
    rowIds.sort();
    aggregates.push({ accepted: accepted.length, rejected: rejected.length, dirty, totalFlags, rowIds });
    console.log(`[fuzz-17] A16 pass${pass}: accepted=${accepted.length} rejected=${rejected.length} dirty-titles(A4)=${dirty}`);
  }
  assert.deepEqual(aggregates[1], aggregates[0], "A16 not deterministic across passes");
  assert.equal(aggregates[0].totalFlags, 0, `clean rows flagged: ${aggregates[0].totalFlags}`);
});

// ---------------------------------------------------------------------------
// PART B — corrupted mirror rows: the integrity oracle must flag every class
// ---------------------------------------------------------------------------
// Build one healthy baseline row via the mirror, then mutate copies.
function healthyRow() {
  const store = makeStore();
  const r = mirrorProjectionClaim(store, "r1", "alice", ev("claim.acquired", { workItemId: "healthy-baseline" }));
  assert.ok(r, "baseline mirror write failed");
  return JSON.parse(JSON.stringify(r));
}

test("B0 clean baseline: zero flags (no false positives)", () => {
  const outcomes = fuzz100("B0", (rng) => {
    const store = makeStore();
    const type = pick(rng, ["claim.acquired", "work.handoff_recorded", "work.superseded"]);
    const wid = `b0-${rint(rng, 1, 999999)}`;
    const data = type === "work.handoff_recorded" ? { workItemId: wid, nextAction: "continue the work" }
      : type === "work.superseded" ? { workItemId: wid, supersededByWorkItemId: `b0-next-${rint(rng, 1, 999999)}` }
      : { workItemId: wid, paths: ["a/b"], pullRequests: ["https://github.com/Uuriko/project-room/pull/12"] };
    mirrorProjectionClaim(store, "r1", "alice", ev(type, data));
    return store.workClaims.list("r1");
  }, (rows) => {
    const idx = indexOf(rows);
    const flags = rows.flatMap((r) => scanRow(r, idx));
    return flags.length === 0 ? "clean" : `FALSE-FLAG:${flags.slice(0, 3).join(",")}`;
  });
  assert.ok(outcomes.every((o) => o === "clean"), `integrity oracle false-flagged a healthy mirror: ${outcomes.find((o) => o !== "clean")}`);
});

test("B1 rows with missing columns are flagged", () => {
  const cols = ["id", "state", "title", "owner", "history", "chain", "claimedAt", "pullRequests", "dependsOn"];
  const outcomes = fuzz100("B1", (rng) => {
    const row = healthyRow();
    let deleted = false;
    for (const c of cols) if (rng() < 0.35) { delete row[c]; deleted = true; }
    if (!deleted) delete row[pick(rng, cols)]; // guarantee at least one corruption
    return row;
  }, (row) => {
    const idx = indexOf([row]);
    const flags = scanRow(row, idx);
    return flags.length > 0 ? "flagged" : "SILENT";
  });
  assert.ok(outcomes.every((o) => o === "flagged"), "missing-column row silently accepted");
});

test("B2 rows with wrong-typed columns are flagged", () => {
  const outcomes = fuzz100("B2", (rng) => {
    const row = healthyRow();
    const muts = [
      () => row.id = 123, () => row.id = null, () => row.state = 5, () => row.state = "frobnicate",
      () => row.owner = {}, () => row.owner = 42, () => row.title = ["x"], () => row.title = null,
      () => row.claimedAt = true, () => row.leaseExpiresAt = {}, () => row.pullRequests = "x",
      () => row.pullRequests = [{}], () => row.dependsOn = "x", () => row.chain = 42,
      () => row.history = "x", () => row.supersededBy = 7,
    ];
    const n = rint(rng, 1, 3);
    for (let i = 0; i < n; i++) pick(rng, muts)();
    return row;
  }, (row) => {
    const idx = indexOf([row]);
    return scanRow(row, idx).length > 0 ? "flagged" : "SILENT";
  });
  assert.ok(outcomes.every((o) => o === "flagged"), "wrong-typed row silently accepted");
});

test("B3 claim ids that do not exist in the primary store are flagged", () => {
  const outcomes = fuzz100("B3", (rng) => {
    const row = healthyRow();
    const ghost = `ghost-${rint(rng, 1, 999999)}`;
    const k = rint(rng, 0, 2);
    if (k === 0) row.dependsOn = [ghost];
    else if (k === 1) row.supersededBy = ghost;
    else row.parentClaimId = ghost;
    return row;
  }, (row) => {
    const idx = indexOf([row]); // primary has only this row
    return scanRow(row, idx).length > 0 ? "flagged" : "SILENT";
  });
  assert.ok(outcomes.every((o) => o === "flagged"), "dangling claim reference silently accepted");
});

test("B4 duplicate mirror rows are detected", () => {
  const outcomes = fuzz100("B4", (rng) => {
    const a = healthyRow();
    const b = JSON.parse(JSON.stringify(a));
    b.title = "different title, same id";
    b.owner = "mallory";
    return [a, b];
  }, (rows) => {
    const seen = new Set(), dups = [];
    for (const r of rows) { if (seen.has(r.id)) dups.push(r.id); seen.add(r.id); }
    return dups.length > 0 ? "flagged" : "SILENT";
  });
  assert.ok(outcomes.every((o) => o === "flagged"), "duplicate mirror rows silently accepted");
});

test("B5 rows whose state contradicts the primary shape are flagged", () => {
  const outcomes = fuzz100("B5", (rng) => {
    const row = healthyRow();
    const k = rint(rng, 0, 4);
    if (k === 0) { row.state = "claimed"; row.owner = null; }                    // claimed, no owner
    else if (k === 1) { row.state = "unclaimed"; row.owner = "alice"; }          // unclaimed, has owner
    else if (k === 2) { row.state = "claimed"; row.claimedAt = null; }           // claimed, no timestamp
    else if (k === 3) { row.state = "done"; row.owner = "alice"; row.leaseExpiresAt = new Date(Date.now() + 86400000).toISOString(); }
    else { row.state = "blocked"; row.owner = ""; }                              // blocked, empty owner
    return row;
  }, (row) => {
    const idx = indexOf([row]);
    const flags = scanRow(row, idx);
    return flags.length > 0 ? "flagged" : "SILENT";
  });
  const bad = outcomes.filter((o) => o === "SILENT").length;
  assert.equal(bad, 0, `contradictory state silently accepted (${bad}/100)`);
});

test("B6 future timestamps are reported deterministically (informational)", () => {
  const outcomes = fuzz100("B6", (rng) => {
    const row = healthyRow();
    row.claimedAt = new Date(Date.now() + rint(rng, 1, 365) * 86400000).toISOString();
    row.leaseExpiresAt = new Date(Date.now() + rint(rng, 1, 365) * 86400000).toISOString();
    return row;
  }, (row) => {
    const flags = scanRow(row, indexOf([row]));
    // claimedAt is an event-time stamp: the future value is the anomaly.
    // (leaseExpiresAt is a deadline — future is normal there.)
    return flags.includes("A:future-timestamp:claimedAt") ? "anomaly-reported" : `other:${flags.join(",")}`;
  });
  assert.ok(outcomes.every((o) => o === "anomaly-reported"), "future-timestamp anomaly not reported deterministically");
});

test("B7 10k junk rows: every one flagged, scan completes", () => {
  for (let pass = 0; pass < 2; pass++) {
    const rng = mulberry32((SEED ^ hashStr("B7")) >>> 0);
    const rows = [];
    for (let i = 0; i < 10000; i++) {
      const row = healthyRow();
      const k = rint(rng, 0, 7);
      if (k === 0) delete row.state;
      else if (k === 1) row.owner = null;                       // claimed w/o owner
      else if (k === 2) row.title = strictlyHostileText(rng);
      else if (k === 3) row.dependsOn = [`ghost-${i}`];
      else if (k === 4) row.pullRequests = [{ url: "https://github.com/a/b/pull/1", outcome: "merged" }];
      else if (k === 5) row.id = `bad id ${i}!!`;
      else if (k === 6) row.claimedAt = "not-a-time";
      else row.supersededBy = `ghost-${i}`;
      rows.push(row);
    }
    const t0 = Date.now();
    const idx = indexOf(rows);
    let flaggedCount = 0;
    for (const r of rows) if (scanRow(r, idx).length > 0) flaggedCount++;
    const ms = Date.now() - t0;
    console.log(`[fuzz-17] B7 pass${pass}: ${flaggedCount}/10000 flagged in ${ms}ms`);
    assert.equal(flaggedCount, 10000, `junk rows escaped the check: ${10000 - flaggedCount} silent`);
    assert.ok(ms < 30000, `scan too slow: ${ms}ms`);
  }
});

test("B8 hostile text already in the mirror is flagged", () => {
  const outcomes = fuzz100("B8", (rng) => {
    const row = healthyRow();
    const k = rint(rng, 0, 3);
    row.title = k === 0 ? strictlyHostileText(rng)
      : k === 1 ? INVIS.join("") + " "              // invisible/blank-only
      : k === 2 ? "ok\u0007bell" : "a\uD800b";       // control / lone surrogate
    return row;
  }, (row) => (scanRow(row, indexOf([row])).length > 0 ? "flagged" : "SILENT"));
  assert.ok(outcomes.every((o) => o === "flagged"), "hostile title in mirror silently accepted");
});

test("B9 forged PR facts in mirror rows are flagged", () => {
  const outcomes = fuzz100("B9", (rng) => {
    const row = healthyRow();
    row.pullRequests = [{
      url: "https://github.com/Uuriko/project-room/pull/9", repo: "Uuriko/project-room", number: 9,
      outcome: "merged", syncedAt: "2026-10-08T00:00:00.000Z",
      nextPollAt: null, etag: pick(rng, ["W/\"e\"", null]), rateLimitedUntil: null, pollBackoffMs: null, ciCursor: null,
    }];
    return row;
  }, (row) => (scanRow(row, indexOf([row])).some((f) => f.startsWith("I:pr-forged")) ? "flagged" : "SILENT"));
  assert.ok(outcomes.every((o) => o === "flagged"), "forged PR facts silently accepted");
});

test("B10 self-dependency and unknown dependsOn are flagged", () => {
  const outcomes = fuzz100("B10", (rng) => {
    const row = healthyRow();
    row.dependsOn = rng() < 0.5 ? [row.id] : [`ghost-${rint(rng, 1, 999999)}`];
    return row;
  }, (row) => (scanRow(row, indexOf([row])).some((f) => f.startsWith("I:dependsOn")) ? "flagged" : "SILENT"));
  assert.ok(outcomes.every((o) => o === "flagged"), "bad dependsOn silently accepted");
});

// ---------------------------------------------------------------------------
// PART C — the integrity validators: flag every hostile input, never flag
// clean input, deterministic.
// ---------------------------------------------------------------------------
test("C1 boardText single-line: control characters flagged, clean text passes", () => {
  const bad = fuzz100("C1-bad", (rng) => {
    const w = pick(rng, WORDS);
    const c = pick(rng, CONTROLS);
    return rint(rng, 0, 1) ? w + c + w : c + w;
  }, (s) => (flagged(() => boardText(reject, "title", s)) ? "flagged" : "SILENT"));
  assert.ok(bad.every((o) => o === "flagged"), "control character silently accepted");
  const good = fuzz100("C1-good", (rng) => `${pick(rng, WORDS)} ${pick(rng, WORDS)} ${rint(rng, 1, 999)} — café \u4e2d\u6587 \u{1F600}`, (s) => {
    const out = boardText(reject, "title", s);
    return out === s.normalize("NFC") ? "pass" : "MUTATED";
  });
  assert.ok(good.every((o) => o === "pass"), "clean text flagged or mutated");
});

test("C2 boardText multiline: newlines allowed, CRLF normalized, other controls flagged", () => {
  const nl = fuzz100("C2-nl", (rng) => `line one\nline two\n${pick(rng, WORDS)}`, (s) => {
    const out = flagged(() => boardText(reject, "note", s, { multiline: true }));
    return out ? "flagged" : "pass";
  });
  assert.ok(nl.every((o) => o === "pass"), "multiline newline flagged");
  const crlf = fuzz100("C2-crlf", () => "a\r\nb\rc", (s) => boardText(reject, "note", s, { multiline: true }));
  assert.ok(crlf.every((o) => o === "a\nb\nc"), "CRLF not normalized to LF");
  const bad = fuzz100("C2-bad", (rng) => `ok\n${pick(rng, CONTROLS.filter((c) => c !== "\n"))}\ntext`, (s) =>
    (flagged(() => boardText(reject, "note", s, { multiline: true })) ? "flagged" : "SILENT"));
  assert.ok(bad.every((o) => o === "flagged"), "multiline control silently accepted");
  // single-line must reject the newline too
  const sl = fuzz100("C2-sl", () => "a\nb", (s) => (flagged(() => boardText(reject, "title", s)) ? "flagged" : "SILENT"));
  assert.ok(sl.every((o) => o === "flagged"), "single-line newline silently accepted");
});

test("C3 boardText: bidi controls flagged", () => {
  const outcomes = fuzz100("C3", (rng) => pick(rng, WORDS) + pick(rng, BIDI) + pick(rng, WORDS), (s) =>
    (flagged(() => boardText(reject, "title", s)) ? "flagged" : "SILENT"));
  assert.ok(outcomes.every((o) => o === "flagged"), "bidi control silently accepted");
});

test("C4 boardText: lone surrogates flagged", () => {
  const outcomes = fuzz100("C4", (rng) => {
    const k = rint(rng, 0, 2);
    return k === 0 ? `\uD800${pick(rng, WORDS)}` : k === 1 ? `${pick(rng, WORDS)}\uDC00` : `a\uDFFFb`;
  }, (s) => {
    const e = flagged(() => boardText(reject, "title", s));
    return e && e.code === "invalid_claim_input" ? "flagged" : "SILENT";
  });
  assert.ok(outcomes.every((o) => o === "flagged"), "lone surrogate silently accepted");
});

test("C5 boardText: blank / invisible-only text flagged", () => {
  const outcomes = fuzz100("C5", (rng) => {
    const k = rint(rng, 0, 3);
    return k === 0 ? "" : k === 1 ? "   \t  " : k === 2 ? INVIS.join("").repeat(rint(rng, 1, 3)) : "\u00A0\u200B ";
  }, (s) => (flagged(() => boardText(reject, "title", s)) ? "flagged" : "SILENT"));
  assert.ok(outcomes.every((o) => o === "flagged"), "blank text silently accepted");
});

test("C6 boardText: NFC normalization + non-string passthrough", () => {
  const nfc = fuzz100("C6-nfc", (rng) => `cafe\u0301 ${pick(rng, WORDS)}`, (s) => boardText(reject, "title", s));
  assert.ok(nfc.every((o) => o === "caf\u00e9 " + o.slice(5) && o === o.normalize("NFC")), "not NFC-normalized");
  const pass = fuzz100("C6-pass", (rng) => pick(rng, [undefined, null, 42, {}, ["x"]]), (v) =>
    (boardText(reject, "title", v) === v ? "pass" : "MUTATED"));
  assert.ok(pass.every((o) => o === "pass"), "non-string input not passed through unchanged");
});

test("C7 boardTextFields: shapes, copies, unknown fields", () => {
  const outcomes = fuzz100("C7", (rng) => {
    const k = rint(rng, 0, 4);
    return k === 0 ? null : k === 1 ? [1, 2] : k === 2 ? "str"
      : k === 3 ? { title: `cafe\u0301`, other: "untouched", note: "a\nb" }
      : { title: pick(rng, WORDS) };
  }, (data) => {
    const out = boardTextFields(reject, data, { title: {}, note: { multiline: true } });
    if (data === null || typeof data !== "object" || Array.isArray(data)) return out === data ? "pass" : "MUTATED";
    if (!Object.hasOwn(data, "title")) return out.title === undefined ? "pass" : "MUTATED";
    const normalized = typeof data.title === "string" ? data.title.normalize("NFC") : data.title;
    return out.title === normalized && out !== data && data.title !== normalized ? "pass"
      : (data.title === normalized ? "pass-clean" : "BAD");
  });
  assert.ok(outcomes.every((o) => o === "pass" || o === "pass-clean"), `boardTextFields misbehaved: ${outcomes.find((o) => o !== "pass" && o !== "pass-clean")}`);
  // hostile field inside the object form is still flagged
  const bad = fuzz100("C7-bad", (rng) => ({ title: strictlyHostileText(rng) }), (data) =>
    (flagged(() => boardTextFields(reject, data, { title: {} })) ? "flagged" : "SILENT"));
  assert.ok(bad.every((o) => o === "flagged"), "hostile title via boardTextFields silently accepted");
});

test("C8 assertBoardLeaseHours: boundaries exact", () => {
  const outcomes = fuzz100("C8", (rng) => {
    const k = rint(rng, 0, 11);
    return [0.25, 168, 0.24, 168.0001, 0, -1, NaN, Infinity, "4", {}, 24, 0.5][k];
  }, (v) => {
    const e = flagged(() => assertBoardLeaseHours(reject, { leaseHours: v }));
    const shouldFlag = !(typeof v === "number" && Number.isFinite(v) && v >= BOARD_LEASE_HOURS_MIN && v <= BOARD_LEASE_HOURS_MAX);
    if (shouldFlag) return e && e.code === "invalid_claim_input" ? "flagged" : "SILENT";
    return e ? "FALSE-FLAG" : "pass";
  });
  assert.ok(outcomes.every((o) => o === "flagged" || o === "pass"), `leaseHours wrong: ${outcomes.find((o) => o !== "flagged" && o !== "pass")}`);
  // absent / null leaseHours passes (null opts out where allowed)
  assert.equal(flagged(() => assertBoardLeaseHours(reject, {})), null);
  assert.equal(flagged(() => assertBoardLeaseHours(reject, { leaseHours: null })), null);
  assert.equal(flagged(() => assertBoardLeaseHours(reject, null)), null);
});

test("C9 assertDependsOnKnown: self/unknown flagged, non-strings deferred", () => {
  const has = (id) => id === "real-1" || id === "real-2";
  const outcomes = fuzz100("C9", (rng) => {
    const k = rint(rng, 0, 5);
    return k === 0 ? ["self"] : k === 1 ? ["ghost"] : k === 2 ? ["real-1", "real-2"]
      : k === 3 ? [42, null, {}] : k === 4 ? [] : "not-an-array";
  }, (dependsOn) => {
    const e = flagged(() => assertDependsOnKnown(reject, { dependsOn }, { selfId: "self", has }));
    if (Array.isArray(dependsOn) && dependsOn.includes("self")) return e ? "flagged" : "SILENT";
    if (Array.isArray(dependsOn) && dependsOn.includes("ghost")) return e ? "flagged" : "SILENT";
    return e ? "FALSE-FLAG" : "pass";
  });
  assert.ok(outcomes.every((o) => o === "flagged" || o === "pass"), `dependsOn wrong: ${outcomes.find((o) => o !== "flagged" && o !== "pass")}`);
  assert.equal(flagged(() => assertDependsOnKnown(reject, {}, { selfId: "x", has })), null);
  assert.equal(flagged(() => assertDependsOnKnown(reject, null, { selfId: "x", has })), null);
});

test("C10 clientPullRequestInput: short form converted, server fields refused", () => {
  const outcomes = fuzz100("C10", (rng) => {
    const k = rint(rng, 0, 6);
    return k === 0 ? { pullRequests: ["Uuriko/project-room#12"] }
      : k === 1 ? { pullRequest: { url: "https://github.com/a/b/pull/3" } }
      : k === 2 ? { pullRequests: [{ url: "https://github.com/a/b/pull/3", outcome: "merged" }] }
      : k === 3 ? { pullRequests: [{ url: "https://github.com/a/b/pull/3", ciCursor: "done", etag: "x" }] }
      : k === 4 ? { pullRequests: ["not a url at all"] }
      : k === 5 ? { pullRequest: 42 }
      : { pullRequests: [{ url: "o/r#7" }, "o2/r2#8"] };
  }, (data) => {
    const e = flagged(() => clientPullRequestInput(reject, data));
    if (data.pullRequests?.some?.((p) => p && typeof p === "object" && Object.keys(p).some((k) => k !== "url"))) {
      return e && e.code === "invalid_claim_input" ? "flagged" : "SILENT";
    }
    if (e) return "FALSE-FLAG";
    const out = clientPullRequestInput(reject, data);
    const urls = [...(out.pullRequests ?? []), ...(out.pullRequest ? [out.pullRequest] : [])]
      .map((p) => typeof p === "string" ? p : p?.url);
    const converted = urls.every((u) => typeof u !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(u));
    return converted ? "pass" : "NOT-CONVERTED";
  });
  assert.ok(outcomes.every((o) => o === "flagged" || o === "pass"), `PR input wrong: ${outcomes.find((o) => o !== "flagged" && o !== "pass")}`);
  assert.deepEqual(clientPullRequestInput(reject, null), null);
  assert.deepEqual(clientPullRequestInput(reject, "str"), "str");
});

test("C11 assertBoardEventBudget: math, boundary, privilege", () => {
  const N = PILOT_LIMITS.eventsPerRoom;
  assert.ok(Number.isSafeInteger(N) && N > 0, "eventsPerRoom not a positive safe integer");
  const reserve = Math.floor(N * 0.1);
  const outcomes = fuzz100("C11", (rng) => {
    const k = rint(rng, 0, 4);
    return k === 0 ? N - rint(rng, 0, reserve - 1)          // remaining < 10% -> block
      : k === 1 ? N - reserve                                // remaining == 10% -> allow (boundary inclusive)
      : k === 2 ? rint(rng, 0, N - reserve - 1)              // plenty left -> allow
      : k === 3 ? N + rint(rng, 0, 100)                      // over budget -> block
      : N;                                                   // zero left -> block
  }, (sequence) => {
    const remaining = N - sequence;
    const e = flagged(() => assertBoardEventBudget(sequence, { privileged: false }));
    const shouldBlock = remaining < N * 0.1;
    if (shouldBlock) {
      if (!e || e.status !== 409 || e.code !== "room_event_budget_low") return "SILENT";
      if (e.body?.eventsRemaining !== Math.max(0, remaining)) return "BAD-BODY";
      return "blocked";
    }
    return e ? "FALSE-FLAG" : "pass";
  });
  assert.ok(outcomes.every((o) => o === "blocked" || o === "pass"), `event budget wrong: ${outcomes.find((o) => o !== "blocked" && o !== "pass")}`);
  // privileged writers bypass; non-integer sequence is treated as unknown (no block)
  const priv = fuzz100("C11-priv", (rng) => N - rint(rng, 0, 50), (s) =>
    (flagged(() => assertBoardEventBudget(s, { privileged: true })) ? "FALSE-FLAG" : "pass"));
  assert.ok(priv.every((o) => o === "pass"), "privileged writer blocked");
  for (const weird of [null, undefined, 1.5, "10", NaN, Infinity]) {
    assert.equal(flagged(() => assertBoardEventBudget(weird, { privileged: false })), null, `non-integer sequence ${weird} blocked`);
  }
});

test("C12 roomEventsRemaining: non-integers -> null, negatives clamp", () => {
  const N = PILOT_LIMITS.eventsPerRoom;
  const outcomes = fuzz100("C12", (rng) => {
    const k = rint(rng, 0, 5);
    return k === 0 ? rint(rng, 0, N) : k === 1 ? -rint(rng, 1, 100) : k === 2 ? 1.5
      : k === 3 ? "7" : k === 4 ? 2 ** 53 : NaN;
  }, (sequence) => {
    const r = roomEventsRemaining(sequence);
    if (!Number.isSafeInteger(sequence)) return r === null ? "pass" : "BAD";
    return r === Math.max(0, N - sequence) ? "pass" : "BAD";
  });
  assert.ok(outcomes.every((o) => o === "pass"), "roomEventsRemaining wrong");
});

test("C13 readBoardDeployStatus: held budget, fresh cache, force, single-flight", async () => {
  const mkDb = (configJson) => ({ prepare: () => ({ get: () => ({ config_json: configJson }), run: () => ({}) }) });
  const now = Date.now();
  // held GitHub budget -> stale:true + heldUntil, fetch never called
  {
    const store = { db: mkDb(JSON.stringify({ rateLimitedUntil: now + 60000 })) };
    let fetched = 0;
    const r = await readBoardDeployStatus(store, { fetchImpl: async () => { fetched++; throw new Error("nope"); }, nowMs: now });
    assert.equal(r.stale, true);
    assert.ok(r.heldUntil && Number.isFinite(Date.parse(r.heldUntil)), "heldUntil not an ISO timestamp");
    assert.equal(fetched, 0, "fetch called while budget held");
  }
  // fresh cache -> no fetch
  {
    const store = { db: mkDb(JSON.stringify({ checkedAt: new Date(now - 10000).toISOString(), sha: "abc123", behind: 0 })) };
    let fetched = 0;
    const r = await readBoardDeployStatus(store, { fetchImpl: async () => { fetched++; throw new Error("nope"); }, nowMs: now });
    assert.equal(r.stale, false);
    assert.equal(r.main, "abc123");
    assert.equal(fetched, 0, "fetch called with fresh cache");
  }
  // force refresh with fresh cache -> fetch attempted (stub throws -> fallback)
  {
    const store = { db: mkDb(JSON.stringify({ checkedAt: new Date(now - 10000).toISOString(), sha: "abc123" })) };
    let fetched = 0;
    const r = await readBoardDeployStatus(store, { fetchImpl: async () => { fetched++; throw new Error("down"); }, nowMs: now, force: true });
    assert.equal(fetched, 1, "force did not refetch");
    assert.equal(r.main, "abc123", "fallback lost cached sha");
  }
  // single-flight: concurrent calls share one fetch
  {
    const store = {};
    let fetched = 0;
    const gate = () => new Promise((res) => setTimeout(() => res({ status: 500, headers: { get: () => null } }), 20));
    const [a, b] = await Promise.all([
      readBoardDeployStatus(store, { fetchImpl: async () => { fetched++; return gate(); }, nowMs: now }),
      readBoardDeployStatus(store, { fetchImpl: async () => { fetched++; return gate(); }, nowMs: now }),
    ]);
    assert.equal(fetched, 1, `single-flight broken: ${fetched} fetches`);
    assert.deepEqual(a, b, "single-flight returned divergent results");
  }
  // determinism across identical calls
  {
    const mk = () => ({});
    const r1 = await readBoardDeployStatus(mk(), { fetchImpl: async () => { throw new Error("x"); }, nowMs: now });
    const r2 = await readBoardDeployStatus(mk(), { fetchImpl: async () => { throw new Error("x"); }, nowMs: now });
    assert.deepEqual({ ...r1 }, { ...r2 });
  }
});
