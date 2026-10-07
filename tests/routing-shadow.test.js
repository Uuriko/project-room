// tests/routing-shadow.test.js — lane B18, design lane D6.
//
// Shadow-mode affinity router. Contracts under test:
//  1. Weights/tunables live in ONE ROUTING_WEIGHTS block in routing-config.json (D6 §2).
//  2. Every score carries machine-readable {signal, text} reasons; empty reason
//     lists are invalid by construction (D6 §3).
//  3. Guard runs before scoring; guard hits veto routing (decision no_route) (D6 §5.1).
//  4. Shadow mode: records are journaled, routing decisions never change, and
//     there is NO auto_route path — no automatic promotion, ever (D6 §4.3).
//  5. routing_records is append-only, immutable, registered in writer-fence.
//  6. Isolation: the scorer is never called from routing paths (unmounted).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  SHADOW_MODE, ROUTER_VERSION, DEFAULT_CONFIG, SIGNAL_KEYS,
  scoreLane, rankCandidates, guardCheck, decide, evaluateBacktest,
} from "../server/routing.mjs";
import {
  SHADOW_MODE as ROUTES_SHADOW, ROUTING_RECORDS_SCHEMA, RoutingJournal, RoutingJournalError,
  createRoutingRoutes,
} from "../server/routing-routes.mjs";

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;
const loadJson = p => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

const workItem = (over = {}) => ({
  taskId: "RC-2026-10-06-118",
  title: "fix claim lease expiry in work-claims",
  brief: "lease expiry sweep misses claims with fileBlocks set",
  files: ["server/work-claims.mjs"],
  tags: ["claims-board"],
  ...over,
});
const lane = (over = {}) => ({ id: "quill", openClaims: [], completedClaims: [], claimsWindow30d: [], ...over });
const board = (over = {}) => ({ claims: [], freshAt: NOW, ...over });
const ctx = (over = {}) => ({ now: NOW, ...over });

// --- 1. config -----------------------------------------------------------------

test("routing-config.json holds all weights in ONE ROUTING_WEIGHTS block (D6 §2)", () => {
  const cfg = loadJson("../server/routing-config.json");
  assert.equal(SHADOW_MODE, true);
  assert.equal(ROUTES_SHADOW, true);
  assert.deepEqual(cfg.ROUTING_WEIGHTS, {
    fileClaimOverlap: 0.35, prRecency: 0.20, capabilityMatch: 0.15,
    keywordOverlap: 0.10, loadPenalty: -0.20, leaseHealthPenalty: -0.10,
  });
  assert.equal(cfg.decay.prHalfLifeDays, 14);
  assert.equal(cfg.decay.prLookbackDays, 60);
  assert.equal(cfg.decay.keywordLookbackDays, 90);
  assert.equal(cfg.decay.leaseWindowDays, 30);
  assert.equal(cfg.memberClaimCap, 20);
  assert.equal(cfg.freshnessMinutes, 15);
  assert.equal(cfg.confidence.highScore, 0.65);
  assert.equal(cfg.confidence.highLead, 0.10);
  assert.equal(cfg.confidence.mediumScore, 0.35);
  assert.equal(cfg.shadow.enabled, true);
  assert.match(cfg.shadow.promotion, /no automatic promotion/i);
});

test("DEFAULT_CONFIG mirrors routing-config.json (drift fails the build)", () => {
  const cfg = loadJson("../server/routing-config.json");
  assert.deepEqual(DEFAULT_CONFIG.ROUTING_WEIGHTS, cfg.ROUTING_WEIGHTS);
  assert.deepEqual(DEFAULT_CONFIG.decay, cfg.decay);
  assert.equal(DEFAULT_CONFIG.memberClaimCap, cfg.memberClaimCap);
});

test("routing-capabilities.json is a lane-editable data file with version + note", () => {
  const caps = loadJson("../server/routing-capabilities.json");
  assert.equal(typeof caps.version, "number");
  assert.equal(typeof caps.lanes, "object");
});

// --- 2. signals + reasons ---------------------------------------------------------

test("exact open file-claim overlap scores 1.0 with a {signal,text} reason citing the claim", () => {
  const c = scoreLane(workItem(), lane({ openClaims: [{ id: "RC-2026-10-06-112", files: ["server/work-claims.mjs"] }] }), ctx());
  assert.equal(c.signals.fileClaimOverlap, 1.0);
  assert.deepEqual(Object.keys(c.signals).sort(), [...SIGNAL_KEYS].sort());
  const r = c.reasons.find(x => x.signal === "fileClaimOverlap");
  assert.ok(r && /RC-2026-10-06-112/.test(r.text) && /exact/.test(r.text));
  assert.ok(c.reasons.every(x => typeof x.signal === "string" && typeof x.text === "string" && x.text.length > 0));
});

test("same-directory overlap scores 0.4; no overlap still carries a reason", () => {
  const d = scoreLane(workItem(), lane({ openClaims: [{ id: "RC-1", files: ["server/queue.mjs"] }] }), ctx());
  assert.equal(d.signals.fileClaimOverlap, 0.4);
  const n = scoreLane(workItem(), lane(), ctx());
  assert.equal(n.signals.fileClaimOverlap, 0.0);
  assert.ok(n.reasons.length >= 1);
});

test("merged PR recency decays with 14-day half-life; stale PRs score ~0", () => {
  const recent = lane({ mergedPRs: [{ number: 1592, files: ["server/work-claims.mjs"], mergedAt: NOW - 6 * DAY }] });
  const stale = lane({ mergedPRs: [{ number: 900, files: ["server/work-claims.mjs"], mergedAt: NOW - 90 * DAY }] });
  const r = scoreLane(workItem(), recent, ctx());
  const s = scoreLane(workItem(), stale, ctx());
  assert.ok(r.signals.prRecency > 0.5);
  assert.ok(s.signals.prRecency < 0.05);
  assert.ok(r.reasons.some(x => x.signal === "prRecency" && /#1592/.test(x.text)));
});

test("load penalty scales with open/cap; over cap is ineligible with score 0", () => {
  const mkLane = n => lane({
    openClaims: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, files: [] })),
    cap: 20,
    completedClaims: [{ id: "D1", title: "unrelated", files: [], tags: ["claims-board"], completedAt: NOW - DAY }],
  });
  const wi = workItem({ tags: ["claims-board"] }); // positive affinity so scores differ
  const a = scoreLane(wi, mkLane(2), ctx());
  const b = scoreLane(wi, mkLane(14), ctx());
  assert.ok(a.signals.loadPenalty < b.signals.loadPenalty);
  assert.ok(a.score > b.score, `light ${a.score} should beat heavy ${b.score}`);
  assert.ok(a.reasons.some(x => x.signal === "loadPenalty" && /2\/20/.test(x.text)));
  const over = lane({ openClaims: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, files: [] })), cap: 20 });
  const o = scoreLane(workItem(), over, ctx());
  assert.equal(o.score, 0);
  assert.equal(o.ineligible, true);
  assert.ok(o.reasons.some(x => x.signal === "loadPenalty" && /ineligible/.test(x.text)));
});

test("capability match: completed-claim tags augment declared tags (never overridden)", () => {
  const l = lane({
    completedClaims: [{ id: "D1", title: "x", files: [], tags: ["routing"], completedAt: NOW - DAY }],
    capabilities: { tags: ["claims-board"], areas: [] },
  });
  const c = scoreLane(workItem({ tags: ["claims-board", "routing", "leases"] }), l, ctx());
  assert.ok(Math.abs(c.signals.capabilityMatch - 2 / 3) < 1e-9); // {claims-board,routing} over union of 3
  assert.ok(c.reasons.some(x => x.signal === "capabilityMatch" && /'claims-board'/.test(x.text)));
});

test("keyword overlap stems and stop-words the brief against 90d done titles", () => {
  const l = lane({ completedClaims: [{ id: "D1", title: "Fixed claim lease expiry sweep", files: [], tags: [], completedAt: NOW - 2 * DAY }] });
  const c = scoreLane(workItem(), l, ctx());
  assert.ok(c.signals.keywordOverlap > 0);
  assert.ok(c.reasons.some(x => x.signal === "keywordOverlap"));
});

test("lease health: lapsed share in 30d penalizes; open red-CI PRs count against", () => {
  const mk = (id, state, at) => ({ id, state, claimedAt: at });
  const healthy = lane({ claimsWindow30d: [mk("A", "done", NOW - 5 * DAY), mk("B", "done", NOW - 4 * DAY)] });
  const flaky = lane({
    claimsWindow30d: [mk("A", "done", NOW - 5 * DAY), mk("B", "released", NOW - 4 * DAY)],
    openRedCiPRs: [{ number: 1716, files: ["server/work-claims.mjs"] }],
  });
  assert.equal(scoreLane(workItem(), healthy, ctx()).signals.leaseHealthPenalty, 0);
  const f = scoreLane(workItem(), flaky, ctx());
  assert.ok(f.signals.leaseHealthPenalty > 0);
  assert.ok(f.reasons.some(x => x.signal === "leaseHealthPenalty" && /#1716/.test(x.text)));
});

test("score is the weighted sum clamped to [0,1]; deterministic incl. tie-breaks", () => {
  const l = lane({
    openClaims: [{ id: "RC-112", files: ["server/work-claims.mjs"] }],
    mergedPRs: [{ number: 1592, files: ["server/work-claims.mjs"], mergedAt: NOW - DAY }],
    completedClaims: [{ id: "D1", title: "fix claim lease expiry in work-claims", files: ["server/work-claims.mjs"], tags: ["claims-board"], completedAt: NOW - 2 * DAY }],
  });
  const a = scoreLane(workItem(), l, ctx());
  const b = scoreLane(workItem(), l, ctx());
  assert.deepEqual(a, b);
  assert.ok(a.score >= 0 && a.score <= 1 && a.score > 0.5);
  const ranked = rankCandidates(workItem(), [lane({ id: "zeta" }), lane({ id: "alpha" })], ctx());
  assert.equal(ranked.ranked[0].lane, "alpha");
  assert.ok(ranked.ranked[1].reasons.some(r => r.signal === "tiebreak"),
    "the candidate ordered later by the tie-break carries the explanation");
});

// --- 3. guard ---------------------------------------------------------------------

test("guard: already-claimed task vetoes routing (decision no_route, owner named)", () => {
  const b = board({ claims: [{ id: "RC-2026-10-06-118", state: "claimed", owner: "codex", files: [] }] });
  const g = guardCheck(workItem(), b);
  assert.equal(g.alreadyClaimedBy, "codex");
  assert.equal(g.overlapsChecked, true);
  const rec = decide({ workItem: workItem(), lanes: [lane()], boardState: b, ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-g1" });
  assert.equal(rec.decision.action, "no_route");
  assert.equal(rec.decision.routedTo, null);
  assert.match(rec.decision.note, /codex/);
});

test("guard: file-lease conflict with another lane's open claim vetoes a second owner", () => {
  const b = board({ claims: [{ id: "RC-111", state: "in_progress", owner: "fo", files: ["server/work-claims.mjs"] }] });
  const g = guardCheck(workItem(), b);
  assert.equal(g.fileLeaseConflicts.length, 1);
  assert.equal(g.fileLeaseConflicts[0].owner, "fo");
  const rec = decide({ workItem: workItem(), lanes: [lane()], boardState: b, ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-g2" });
  assert.equal(rec.decision.action, "no_route");
});

test("guard: duplicate-of vetoes routing", () => {
  const b = board({ duplicates: [{ id: "RC-100", of: "RC-2026-10-06-118" }] });
  const rec = decide({ workItem: workItem(), lanes: [lane()], boardState: b, ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-g3" });
  assert.equal(rec.decision.action, "no_route");
  assert.match(rec.decision.note, /RC-100/);
});

// --- 4. record shape, confidence, shadow --------------------------------------------

const strongLane = () => lane({
  id: "quill",
  openClaims: [{ id: "RC-112", files: ["server/work-claims.mjs"] }],
  mergedPRs: [{ number: 1592, files: ["server/work-claims.mjs"], mergedAt: NOW - 6 * DAY }],
  completedClaims: [{ id: "D1", title: "fix claim lease expiry in work-claims", files: ["server/work-claims.mjs"], tags: ["claims-board"], completedAt: NOW - 2 * DAY }],
});

test("routing record matches the D6 §3 schema", () => {
  const rec = decide({ workItem: workItem(), lanes: [strongLane(), lane({ id: "codex" })], boardState: board(), ctx: ctx(), now: NOW, roomId: "room-1", routingId: "route-s1", reporter: "fo" });
  assert.equal(rec.routingId, "route-s1");
  assert.equal(rec.roomId, "room-1");
  assert.equal(rec.shadow, true);
  assert.equal(rec.routerVersion, ROUTER_VERSION);
  assert.equal(rec.boardFreshAt, new Date(NOW).toISOString());
  assert.deepEqual(Object.keys(rec.guard).sort(), ["alreadyClaimedBy", "duplicateOf", "fileLeaseConflicts", "overlapsChecked", "staleBoard"].sort());
  assert.ok(rec.candidates.length >= 1 && rec.candidates.length <= 3);
  for (const c of rec.candidates) {
    assert.deepEqual(Object.keys(c.signals).sort(), [...SIGNAL_KEYS].sort());
    assert.ok(c.reasons.length >= 1, "empty reason lists are invalid");
    assert.ok(c.reasons.every(r => typeof r.signal === "string" && typeof r.text === "string" && r.text.length > 0));
    assert.ok(["high", "medium", "low"].includes(c.confidence));
  }
  assert.ok(["suggest", "broadcast", "no_route"].includes(rec.decision.action));
  // reporter fo is not a candidate → expectedButRejected carries the why-not
  assert.equal(rec.expectedButRejected.length, 1);
  assert.equal(rec.expectedButRejected[0].lane, "fo");
  assert.match(rec.expectedButRejected[0].whyNot, /reported the work/);
});

test("high confidence needs score ≥0.65 AND lead ≥0.10 AND a clean guard", () => {
  const mkLane = id => lane({ id, openClaims: [{ id: `RC-${id}`, files: ["server/work-claims.mjs"] }] });
  const rec = decide({ workItem: workItem(), lanes: [mkLane("quill"), mkLane("codex")], boardState: board(), ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-c1" });
  // two lanes hold the same file → lead < 0.10 → cannot be high
  assert.notEqual(rec.candidates[0].confidence, "high");
  const solo = decide({ workItem: workItem(), lanes: [strongLane()], boardState: board(), ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-c2" });
  assert.equal(solo.candidates[0].confidence, "high");
  assert.equal(solo.decision.action, "suggest");
  assert.equal(solo.decision.routedTo, "quill");
});

test("low confidence announces broadcast — uncertainty is never routed silently", () => {
  const rec = decide({ workItem: workItem({ files: ["server/totally-new-area.mjs"] }), lanes: [lane({ id: "quill" })], boardState: board(), ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-c3" });
  assert.equal(rec.decision.action, "broadcast");
  assert.equal(rec.decision.routedTo, null);
  assert.ok(rec.decision.note.length > 0);
});

test("stale board (>15min) downgrades confidence one level instead of scoring silently", () => {
  const b = board({ freshAt: NOW - 16 * 60_000 });
  const rec = decide({ workItem: workItem(), lanes: [strongLane()], boardState: b, ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-c4" });
  assert.equal(rec.guard.staleBoard, true);
  assert.equal(rec.candidates[0].confidence, "medium"); // was high
  assert.equal(rec.decision.action, "suggest");
  assert.match(rec.decision.note, /downgraded/);
  const weak = decide({ workItem: workItem({ files: ["server/new.mjs"] }), lanes: [lane({ id: "quill" })], boardState: b, ctx: ctx(), now: NOW, roomId: "r1", routingId: "route-c5" });
  assert.equal(weak.decision.action, "broadcast"); // medium→low on stale
});

test("there is no auto_route path — requesting it throws (no promotion, ever)", () => {
  assert.throws(() => decide({ workItem: workItem(), lanes: [lane()], boardState: board(), ctx: ctx(), now: NOW, enableAutoRoute: true }), /no automatic promotion/);
});

// --- 5. journal ---------------------------------------------------------------------

test("routing_records DDL is registered in writer-fence unfencedAdditiveTables", () => {
  assert.match(ROUTING_RECORDS_SCHEMA, /CREATE TABLE IF NOT EXISTS routing_records\s*\(/);
  const fence = readFileSync(new URL("../server/writer-fence.mjs", import.meta.url), "utf8");
  assert.ok(fence.includes('"routing_records"'));
});

const openJournal = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(ROUTING_RECORDS_SCHEMA);
  return { db, j: new RoutingJournal({ db }) };
};

test("journal is append-only and immutable: record/get/listByTask, duplicates rejected", () => {
  const { db, j } = openJournal();
  const entry = { routingId: "route-1", roomId: "room-1", taskId: "RC-1", shadow: true, boardFreshAt: new Date(NOW).toISOString(), recordJson: JSON.stringify({ routedTo: "quill" }), createdAt: NOW };
  assert.equal(j.record(entry), "route-1");
  const got = j.get("route-1");
  assert.equal(got.shadow, true);
  assert.equal(got.taskId, "RC-1");
  assert.deepEqual(JSON.parse(got.recordJson), { routedTo: "quill" });
  assert.throws(() => j.record(entry), err => err instanceof RoutingJournalError && /immutable/.test(err.message));
  assert.equal(j.listByTask("RC-1").length, 1);
  assert.equal(j.listByTask("RC-nope").length, 0);
  assert.equal(j.get("route-nope"), null);
  db.close();
});

test("journal exposes no update/delete surface and writes no UPDATE/DELETE SQL", () => {
  const proto = Object.getOwnPropertyNames(RoutingJournal.prototype);
  assert.ok(!proto.some(n => /update|delete|remove|mutate/i.test(n)), `journal must be append-only, saw: ${proto}`);
  const { db } = openJournal();
  const stmts = [];
  const spy = { exec: s => db.exec(s), prepare: s => { stmts.push(s); return db.prepare(s); } };
  new RoutingJournal({ db: spy }).record({ routingId: "r1", roomId: "room-1", recordJson: "{}", createdAt: NOW });
  for (const s of stmts) {
    assert.ok(!/UPDATE|DELETE/i.test(s));
    assert.ok(!/work_claim/i.test(s), "journal must not touch claim tables");
  }
  db.close();
});

// --- 6. routes (unmounted) ------------------------------------------------------------

const harness = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(ROUTING_RECORDS_SCHEMA);
  const journal = new RoutingJournal({ db });
  const calls = { boardReads: 0 };
  const readBoardState = async roomId => {
    calls.boardReads++;
    return {
      claims: [
        { id: "RC-112", title: "router shadow", state: "in_progress", owner: "quill", files: ["server/queue.mjs"], tags: ["claims-board"], claimedAt: NOW - DAY },
        { id: "RC-900", title: "old work", state: "done", owner: "codex", files: ["server/queue.mjs"], tags: ["queue"], claimedAt: NOW - 10 * DAY, completedAt: NOW - 9 * DAY },
      ],
      freshAt: NOW,
    };
  };
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  let nextBody = null;
  const routes = createRoutingRoutes({
    json, reject, body: async () => nextBody, pathId: x => x,
    readBoardState, journal, now: () => NOW,
  });
  const call = async (method, pathname, bodyData, search = "") => {
    nextBody = bodyData;
    const res = {};
    const url = new URL(`http://x${pathname}${search}`);
    const handled = await routes({ method, headers: {} }, res, { url });
    return { handled, res, calls, journal };
  };
  return { call, db };
};

test("POST /routing/suggest journals the record and returns it (shadow: no side effects)", async () => {
  const { call } = harness();
  const { handled, res, calls, journal } = await call("POST", "/api/rooms/room-1/routing/suggest",
    { task: { taskId: "RC-new", title: "fix lease sweep", files: ["server/work-claims.mjs"], tags: ["claims-board"] } });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.shadow, true);
  assert.ok(res.body.record.routingId);
  assert.equal(calls.boardReads, 1);
  // journaled exactly once
  assert.equal(journal.listByRoom("room-1").length, 1);
  assert.equal(journal.get(res.body.record.routingId).taskId, "RC-new");
});

test("POST /routing/suggest without a title is 422 (invalid_routing_input)", async () => {
  const { call } = harness();
  await assert.rejects(
    call("POST", "/api/rooms/room-1/routing/suggest", { task: { files: [] } }),
    err => err.status === 422 && err.code === "invalid_routing_input"
  );
});

test("guard veto on suggest returns 409 AND still journals the no_route record", async () => {
  const { call } = harness();
  const { res, journal } = await call("POST", "/api/rooms/room-1/routing/suggest",
    { task: { taskId: "RC-112", title: "router shadow", files: ["server/work-claims.mjs"] } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "routing_guard_veto");
  assert.equal(res.body.record.decision.action, "no_route");
  assert.equal(journal.listByTask("RC-112").length, 1);
});

test("GET /routing/history?taskId=… returns the journaled records for the eval loop", async () => {
  const { call } = harness();
  await call("POST", "/api/rooms/room-1/routing/suggest", { task: { taskId: "RC-h", title: "history check", files: [] } });
  const { res } = await call("GET", "/api/rooms/room-1/routing/history", null, "?taskId=RC-h");
  assert.equal(res.status, 200);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.records[0].record.workItem.taskId, "RC-h");
});

// --- 7. isolation -----------------------------------------------------------------------

test("routing.mjs is pure: zero imports", () => {
  const src = readFileSync(new URL("../server/routing.mjs", import.meta.url), "utf8");
  assert.ok(!/^import /m.test(src), "pure scorer must not import anything");
});

test("no server/ or scripts/ file outside the routing pair touches it (unmounted)", () => {
  const offenders = [];
  for (const [rel, skip] of [["../server/", new Set(["routing.mjs", "routing-routes.mjs"])], ["../scripts/", new Set(["routing-eval.mjs"])]]) {
    const dir = new URL(rel, import.meta.url).pathname;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".mjs") || skip.has(name)) continue;
      const src = readFileSync(dir + name, "utf8");
      if (/from\s+["']\.\/routing(-routes)?\.mjs["']/.test(src) || /require\(["']\.\/routing/.test(src)) offenders.push(rel + name);
    }
  }
  assert.deepEqual(offenders, [], `router must stay unwired: ${offenders.join(", ")}`);
});

test("routing.mjs exports scores/guard/record/metrics only — no routing-action verbs", () => {
  const src = readFileSync(new URL("../server/routing.mjs", import.meta.url), "utf8");
  const exported = [...src.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
  for (const name of exported) {
    assert.ok(!/^(claim|settle|dispatch|post|enforce|transition|notify|assign)/i.test(name), `export ${name} looks like a routing action`);
  }
  for (const need of ["scoreLane", "rankCandidates", "guardCheck", "decide", "evaluateBacktest"]) {
    assert.ok(exported.includes(need), `missing export ${need}`);
  }
});

// --- 8. eval harness ----------------------------------------------------------------------

test("routing-eval --synthetic runs the pre-registered metric table and clears the gate", () => {
  const out = execFileSync("node", ["scripts/routing-eval.mjs", "--synthetic", "120"],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  assert.match(out, /top-3 hit rate:/);
  assert.match(out, /mean recip rank:/);
  assert.match(out, /gate: ≥70% → PASS/);
}, { timeout: 120_000 });

test("routing-eval --refit prints human-review output and never writes routing-config.json", () => {
  const cfgPath = new URL("../server/routing-config.json", import.meta.url).pathname;
  const before = readFileSync(cfgPath, "utf8");
  const hist = "/tmp/routing-eval-test-cases.json";
  const now = Date.now();
  const cases = Array.from({ length: 30 }, (_, i) => ({
    workItem: { taskId: `RC-r${i}`, title: "fix claims board bug", files: ["server/work-claims.mjs"], tags: ["claims-board"] },
    lanes: [
      { id: "quill", openClaims: [{ id: `RC-q${i}`, files: ["server/work-claims.mjs"] }], completedClaims: [], claimsWindow30d: [] },
      { id: "codex", openClaims: [], completedClaims: [], claimsWindow30d: [] },
    ],
    boardState: { claims: [], freshAt: now },
    eventualClaimant: "quill",
    at: now,
  }));
  writeFileSync(hist, JSON.stringify(cases));
  const out = execFileSync("node", ["scripts/routing-eval.mjs", "--history", hist, "--refit"],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  assert.match(out, /HUMAN REVIEW REQUIRED/);
  assert.match(out, /ROUTING_WEIGHTS/);
  assert.equal(readFileSync(cfgPath, "utf8"), before, "refit must not modify routing-config.json");
});

test("evaluateBacktest reports precision@k and MRR on labeled cases", () => {
  const now = NOW;
  const cases = [0, 1, 2].map(i => ({
    workItem: workItem({ taskId: `RC-e${i}` }),
    lanes: [strongLane(), lane({ id: "codex" }), lane({ id: "fo" })],
    boardState: board(),
    eventualClaimant: "quill",
    at: now,
    ctx: { now },
  }));
  const m = evaluateBacktest(cases, { topK: 3 });
  assert.equal(m.n, 3);
  assert.equal(m.precisionAt1, 1);
  assert.equal(m.precisionAt3, 1);
  assert.equal(m.mrr, 1);
});
