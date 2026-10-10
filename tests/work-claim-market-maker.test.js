// FIX-75 (WAVE-300, rank 34): named market-maker — difficulty labels +
// anti-cherry-picking ownership. Playbook: muse-room seq 7021 asked, never
// answered — starvation-by-cherry-picking has no owner.
//
// Part 1: the poster sets a `difficulty` label at create
// (trivial|easy|medium|hard|epic); it is validated as an enum (malformed ->
// 422), rides the claim record durably (FIX-46 pattern), and is returned by
// the board.
//
// Part 2: the board listing surfaces starvation — claims unclaimed (or
// claimed but never started) for longer than WORK_CLAIM_STARVE_AFTER_MS
// carry starving:true plus the wait measurements, so whoever owns the board
// (the market-maker) can see what is being cherry-picked around. The
// mechanism is the signal; the policy (auto-assignment, nudges) is the
// market-maker's call and is explicitly NOT built here.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, claimWork, updateWork, CLAIM_DIFFICULTIES,
  WORK_CLAIM_STARVE_AFTER_MS, starvationOf } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { buildWorkClaimPage, handleWorkClaims } from "../server/work-claim-routes.mjs";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-09T20:00:00.000Z");

// --- difficulty labels ------------------------------------------------

test("the poster's difficulty label is stored and normalized; unset means null", () => {
  assert.deepEqual(CLAIM_DIFFICULTIES, ["trivial", "easy", "medium", "hard", "epic"]);
  for (const difficulty of CLAIM_DIFFICULTIES) {
    const item = createWork({ id: `diff-${difficulty}`, difficulty }, { now: NOW, agentId: "jill" });
    assert.equal(item.difficulty, difficulty, `createWork stores ${difficulty}`);
  }
  assert.equal(createWork({ id: "diff-unset" }, { now: NOW, agentId: "jill" }).difficulty, null);
  assert.equal(createWork({ id: "diff-null", difficulty: null }, { now: NOW, agentId: "jill" }).difficulty, null);
});

test("a malformed difficulty is refused, not stored", () => {
  for (const bad of ["impossible", "HARD", " Hard", 3, ["hard"], { label: "hard" }]) {
    assert.throws(
      () => createWork({ id: `diff-bad-${String(bad)}`, difficulty: bad }, { now: NOW, agentId: "jill" }),
      /difficulty must be one of/, `difficulty ${JSON.stringify(bad)} must be refused`);
  }
});

// --- durable registry + HTTP create ------------------------------------

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const members = {
  jill: { id: "jill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const httpCall = (registry, member, route, id, body, { method = "POST" } = {}) => handleWorkClaims({
  req: { method, body }, res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ members }) },
  roomId: "room1", auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});
const durable = t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "market-maker-"));
  const db = new DatabaseSync(join(dir, "room.sqlite"));
  db.exec(workClaimSchema);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return createDurableWorkClaimRegistry(db);
};

test("POST /work-claims stores a difficulty label; a malformed one is 422", async t => {
  const registry = durable(t);
  const created = await httpCall(registry, "jill", "create", null, { id: "mk-1", title: "Hard one", difficulty: "hard" });
  assert.equal(created.status, 201);
  assert.equal(created.value.difficulty, "hard");
  assert.equal(registry.get("room1", "mk-1").difficulty, "hard", "difficulty rides the durable record");
  const plain = await httpCall(registry, "jill", "create", null, { id: "mk-2", title: "No label" });
  assert.equal(plain.status, 201);
  assert.equal(plain.value.difficulty, null);
  await assert.rejects(
    httpCall(registry, "jill", "create", null, { id: "mk-3", title: "Bogus", difficulty: "extreme" }),
    error => error.status === 422 && error.code === "invalid_claim_input",
    "a malformed difficulty is 422, not stored");
  assert.equal(registry.get("room1", "mk-3"), null);
});

test("difficulty survives the durable registry round-trip (restart)", async t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "market-maker-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => { const db = new DatabaseSync(join(dir, "room.sqlite")); db.exec(workClaimSchema); return db; };
  const first = open();
  const registry = createDurableWorkClaimRegistry(first);
  await httpCall(registry, "jill", "create", null, { id: "mk-r", title: "Epic one", difficulty: "epic" });
  first.close();
  const second = open();
  t.after(() => second.close());
  const restarted = createDurableWorkClaimRegistry(second);
  assert.equal(restarted.get("room1", "mk-r").difficulty, "epic", "difficulty persists across a restart");
});

// --- starvation signal -------------------------------------------------

test("an old unclaimed hard claim is flagged starving; a fresh easy one is not", () => {
  const old = createWork({ id: "starve-old", difficulty: "hard" }, { now: NOW - 8 * DAY, agentId: "jill" });
  const fresh = createWork({ id: "starve-fresh", difficulty: "easy" }, { now: NOW - 1 * DAY, agentId: "jill" });
  const page = buildWorkClaimPage([old, fresh], "room1", "jill", new URLSearchParams(), NOW);
  const flagged = page.claims.find(item => item.id === "starve-old");
  assert.equal(flagged.difficulty, "hard", "difficulty rides the board listing");
  assert.equal(flagged.starving, true);
  assert.ok(typeof flagged.waitingSince === "string" && flagged.waitingSince.length > 0);
  assert.ok(flagged.unclaimedForMs > WORK_CLAIM_STARVE_AFTER_MS, "unclaimedForMs measures the wait");
  assert.equal(flagged.unstartedForMs, null);
  const calm = page.claims.find(item => item.id === "starve-fresh");
  assert.equal(calm.difficulty, "easy");
  assert.equal(calm.starving, false);
  assert.ok(calm.unclaimedForMs < WORK_CLAIM_STARVE_AFTER_MS);
});

test("a claim held but never started also starves; an in-progress claim does not", () => {
  let stuck = createWork({ id: "starve-stuck", difficulty: "medium" }, { now: NOW - 9 * DAY, agentId: "jill" });
  stuck = claimWork(stuck, "grokbot", { now: NOW - 8 * DAY });
  let moving = createWork({ id: "starve-moving", difficulty: "hard" }, { now: NOW - 9 * DAY, agentId: "jill" });
  moving = claimWork(moving, "grokbot", { now: NOW - 8 * DAY });
  moving = updateWork(moving, "grokbot", { state: "in_progress", now: NOW - 7 * DAY });
  const page = buildWorkClaimPage([stuck, moving], "room1", "jill", new URLSearchParams(), NOW);
  const held = page.claims.find(item => item.id === "starve-stuck");
  assert.equal(held.state, "claimed");
  assert.equal(held.starving, true, "claimed-but-never-started starves");
  assert.ok(held.unstartedForMs > WORK_CLAIM_STARVE_AFTER_MS);
  assert.equal(held.unclaimedForMs, null);
  const busy = page.claims.find(item => item.id === "starve-moving");
  assert.equal(busy.state, "in_progress");
  assert.equal(busy.starving, false);
  assert.equal(busy.waitingSince, null);
  assert.equal(busy.unclaimedForMs, null);
  assert.equal(busy.unstartedForMs, null);
});

test("a released claim restarts its wait clock; a done claim never starves", () => {
  let churn = createWork({ id: "starve-churn", difficulty: "hard" }, { now: NOW - 30 * DAY, agentId: "jill" });
  churn = claimWork(churn, "grokbot", { now: NOW - 29 * DAY });
  churn = updateWork(churn, "grokbot", { state: "unclaimed", now: NOW - 1 * DAY });
  let done = createWork({ id: "starve-done", difficulty: "hard" }, { now: NOW - 30 * DAY, agentId: "jill" });
  done = claimWork(done, "grokbot", { now: NOW - 29 * DAY });
  done = updateWork(done, "grokbot", { state: "in_progress", now: NOW - 28 * DAY });
  done = updateWork(done, "grokbot", { state: "done", now: NOW - 27 * DAY });
  const page = buildWorkClaimPage([churn, done], "room1", "jill", new URLSearchParams(), NOW);
  const recycled = page.claims.find(item => item.id === "starve-churn");
  assert.equal(recycled.starving, false, "a release one day ago resets the wait");
  assert.ok(recycled.unclaimedForMs < WORK_CLAIM_STARVE_AFTER_MS);
  const finished = page.claims.find(item => item.id === "starve-done");
  assert.equal(finished.starving, false);
  assert.equal(finished.waitingSince, null);
});

test("starvationOf is a documented, threshold-driven signal", () => {
  assert.ok(Number.isFinite(WORK_CLAIM_STARVE_AFTER_MS) && WORK_CLAIM_STARVE_AFTER_MS > 0);
  const signal = starvationOf(createWork({ id: "s1" }, { now: NOW - 30 * DAY, agentId: "jill" }), NOW);
  assert.equal(signal.starving, true);
  assert.ok(signal.unclaimedForMs > WORK_CLAIM_STARVE_AFTER_MS);
  assert.equal(signal.unstartedForMs, null);
  const fresh = starvationOf(createWork({ id: "s2" }, { now: NOW, agentId: "jill" }), NOW);
  assert.equal(fresh.starving, false);
});
