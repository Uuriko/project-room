// Merge train: risk classifier, bisect, state machines, and the full train
// against an in-memory GitHub (queue -> batch -> red -> bisect -> land ->
// smoke -> rollback). No network, no token.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  classifyRisk, globToRegExp, newBisect, bisectNext, bisectApply, bisectDone,
  transition, BATCH_TRANSITIONS, ENTRY_TRANSITIONS, runOutcome
} from "../server/merge-train.mjs";
import { MERGE_TRAIN_PATH_RULES } from "../server/merge-train-paths.mjs";

test("glob-lite matches by segment", () => {
  assert.ok(globToRegExp("tests/**").test("tests/a/b.test.js"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("docs/x/y.md"));
  assert.ok(!globToRegExp("src/*-ui.js").test("src/deep/x-ui.js"));
});

test("risk: tests, docs and UI are safe; sensitive paths need a person", () => {
  assert.deepEqual(classifyRisk(["tests/a.test.js", "docs/x.md"]), { risk: "safe", reasons: ["docs", "tests"] });
  assert.equal(classifyRisk(["src/board.css"]).risk, "safe");
  assert.deepEqual(classifyRisk(["server/github-oauth.mjs"]).reasons, ["auth"]);
  assert.deepEqual(classifyRisk(["server/stripe-webhook.mjs"]).reasons, ["billing"]);
  assert.deepEqual(classifyRisk(["server/account-deletion.mjs"]).reasons, ["deletion"]);
  assert.ok(classifyRisk(["migrations/0042.sql"]).reasons.includes("migration"));
  assert.deepEqual(classifyRisk([".github/workflows/test.yml"]).reasons, ["secrets_config"]);
  assert.deepEqual(classifyRisk(["cloudflare/wrangler.jsonc"]).reasons, ["secrets_config"]);
  // one sensitive file makes the whole PR need a person
  assert.equal(classifyRisk(["docs/a.md", "server/purge-registry.mjs"]).risk, "person");
  // unknown file list is never safe
  assert.deepEqual(classifyRisk([]), { risk: "person", reasons: ["unknown_files"] });
  assert.deepEqual(classifyRisk(null), { risk: "person", reasons: ["unknown_files"] });
  // the rules file itself is config
  assert.equal(classifyRisk(["server/merge-train-paths.mjs"]).risk, "person");
});

test("risk rules are a swappable config", () => {
  const rules = { person: [{ reason: "core", globs: ["core/**"] }], safe: [] };
  assert.equal(classifyRisk(["core/x.js"], rules).risk, "person");
  assert.equal(classifyRisk(["server/github-oauth.mjs"], rules).risk, "safe");
  assert.ok(MERGE_TRAIN_PATH_RULES.person.length >= 5);
});

function runBisect(ids, bad) {
  let state = newBisect(ids);
  let guard = 0;
  while (!bisectDone(state)) {
    const group = bisectNext(state);
    state = bisectApply(state, !group.some(id => bad.includes(id)));
    if (++guard > 100) throw new Error("bisect did not converge");
  }
  return state;
}

test("bisect isolates one breaker in log2 probes", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const out = runBisect(ids, ["f"]);
  assert.deepEqual(out.bad, ["f"]);
  assert.deepEqual([...out.good].sort(), ["a", "b", "c", "d", "e", "g", "h"]);
  assert.ok(out.probes <= 6, `probes ${out.probes}`);
});

test("bisect isolates several breakers and keeps every good PR", () => {
  for (const bad of [["a"], ["h"], ["a", "h"], ["b", "c", "g"], ["a", "b", "c"]]) {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const out = runBisect(ids, bad);
    assert.deepEqual([...out.bad].sort(), [...bad].sort());
    assert.equal(out.bad.length + out.good.length, ids.length);
  }
  assert.deepEqual(runBisect(["a", "b"], ["b"]).bad, ["b"]);
  assert.deepEqual(runBisect(["a", "b", "c"], []).bad, []);
});

test("bisect refuses a single entry and a finished state", () => {
  assert.throws(() => newBisect(["a"]), /two entries/);
  const done = runBisect(["a", "b"], ["a"]);
  assert.throws(() => bisectApply(done, true), /nothing left/);
});

test("state machines reject skipped steps", () => {
  assert.equal(transition(BATCH_TRANSITIONS, "testing", "landing"), "landing");
  assert.throws(() => transition(BATCH_TRANSITIONS, "testing", "confirmed"), /cannot move/);
  assert.throws(() => transition(BATCH_TRANSITIONS, "confirmed", "rolled_back"), /cannot move/);
  assert.equal(transition(ENTRY_TRANSITIONS, "held", "queued"), "queued");
  assert.throws(() => transition(ENTRY_TRANSITIONS, "held", "in_batch"), /cannot move/);
  assert.throws(() => transition(ENTRY_TRANSITIONS, "queued", "landed"), /cannot move/);
  assert.equal(runOutcome(null), "pending");
  assert.equal(runOutcome({ status: "in_progress" }), "pending");
  assert.equal(runOutcome({ status: "completed", conclusion: "success" }), "green");
  assert.equal(runOutcome({ status: "completed", conclusion: "cancelled" }), "red");
});

import { fakeGitHub } from "../scripts/merge-train-fake-github.mjs";

function fixture(t, gh) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-train-"));
  const clock = { now: Date.parse("2026-10-20T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  gh.clock = () => clock.now;
  store.landQueue.add = async () => ({ item: { itemId: null } });
  store.mergeTrain.configure({ token: null, fetchImpl: gh.fetchImpl });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, clock, train: store.mergeTrain, roomId: "commons", owner: store.room("commons").state.room.ownerId };
}

async function drain(train, roomId, clock, max = 40) {
  for (let i = 0; i < max; i += 1) {
    clock.now += 60_000;
    const out = await train.tick(roomId);
    if (out.steps?.every(step => step.idle)) return;
  }
}

test("train: safe PRs land in one run; a breaker is bisected and returned", async (t) => {
  const files = { 1: ["docs/a.md"], 2: ["tests/b.test.js"], 3: ["src/board.css"], 4: ["docs/c.md"] };
  const gh = fakeGitHub({ files, bad: [3] });
  const { train, roomId, clock, owner } = fixture(t, gh);
  for (const n of [1, 2, 3, 4]) {
    const { entry } = await train.enqueue(roomId, owner, { repo: "o/r", prNumber: n });
    assert.equal(entry.state, "queued");
  }
  const dup = await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  assert.equal(dup.duplicate, true);
  await drain(train, roomId, clock);
  const { entries } = train.list(roomId, owner);
  const byPr = Object.fromEntries(entries.map(e => [e.prNumber, e.state]));
  assert.equal(byPr[3], "returned");
  assert.deepEqual([byPr[1], byPr[2], byPr[4]], ["landed", "landed", "landed"]);
  const mainPrs = gh.commits.get(gh.refs.get("main")).prs;
  assert.deepEqual(mainPrs, [1, 2, 4]);
  assert.match(gh.commits.get(gh.refs.get("main")).message, /^\[deploy-production\] /);
  // probe and train branches are cleaned up
  assert.deepEqual([...gh.refs.keys()], ["main"]);
});

test("train: needs-a-person PRs wait for the owner and show in needs-me", async (t) => {
  const gh = fakeGitHub({ files: { 7: ["server/github-oauth.mjs"], 8: ["docs/x.md"] } });
  const { train, roomId, clock, owner } = fixture(t, gh);
  const held = (await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 7 })).entry;
  assert.equal(held.state, "held");
  assert.deepEqual(held.riskReasons, ["auth"]);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 8 });
  assert.deepEqual(train.heldFor(roomId, owner).map(e => e.prNumber), [7]);
  assert.deepEqual(train.heldFor(roomId, "someone-else"), []);
  await drain(train, roomId, clock);
  assert.deepEqual(gh.commits.get(gh.refs.get("main")).prs, [8]);
  // the next batch waits for the landed one to clear prod smoke
  const first = train.list(roomId, owner).batches[0];
  assert.equal(first.state, "smoke");
  await train.recordSmoke(roomId, owner, { batchId: first.batchId, ok: true });
  train.approve(roomId, owner, { entryId: held.entryId });
  assert.deepEqual(train.heldFor(roomId, owner), []);
  await drain(train, roomId, clock);
  assert.deepEqual(gh.commits.get(gh.refs.get("main")).prs, [8, 7]);
});

test("train: prod smoke confirms or rolls back the batch", async (t) => {
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"] } });
  const { train, roomId, clock, owner } = fixture(t, gh);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  await drain(train, roomId, clock, 3);
  let batch = train.list(roomId, owner).batches[0];
  assert.equal(batch.state, "smoke");
  // waits for a deploy before dispatching the smoke
  await train.tick(roomId);
  assert.ok(!gh.dispatches.some(d => d.workflow === "live-smoke.yml"));
  gh.runs.push({ workflow: "deploy-prod.yml", branch: "main", event: "workflow_run", status: "completed", conclusion: "success", created_at: new Date(clock.now).toISOString() });
  gh.smokeOk = false;
  await train.tick(roomId);
  clock.now += 60_000;
  await train.tick(roomId);
  batch = train.list(roomId, owner).batches[0];
  assert.equal(batch.state, "rolled_back");
  const main = gh.commits.get(gh.refs.get("main"));
  assert.equal(main.tree, gh.commits.get(gh.base).tree);
  assert.match(main.message, /^\[deploy-production\] Roll back merge train/);
  assert.equal(train.list(roomId, owner).entries[0].state, "rolled_back");
});

test("train: external smoke hook confirms; only the owner may report", async (t) => {
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"] } });
  const { train, roomId, clock, owner } = fixture(t, gh);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  await drain(train, roomId, clock, 3);
  const { batchId } = train.list(roomId, owner).batches[0];
  await assert.rejects(train.recordSmoke(roomId, owner, { batchId, ok: "yes" }), /ok must be/);
  const out = await train.recordSmoke(roomId, owner, { batchId, ok: true });
  assert.equal(out.state, "confirmed");
  await assert.rejects(train.recordSmoke(roomId, owner, { batchId, ok: true }), /not waiting/);
});

test("train: main moving during the run requeues instead of force-pushing", async (t) => {
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"] } });
  const { train, roomId, clock, owner } = fixture(t, gh);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  clock.now += 60_000;
  await train.tick(roomId);
  const other = "f".repeat(40);
  gh.commits.set(other, { prs: [99], parents: [gh.base], tree: "tother" });
  gh.refs.set("main", other);
  clock.now += 60_000;
  await train.tick(roomId);
  assert.equal(gh.refs.get("main"), other);
  assert.equal(train.list(roomId, owner).batches[0].state, "failed");
  assert.equal(train.list(roomId, owner).entries[0].state, "queued");
});

function cards(store) {
  return store.db.prepare("SELECT body FROM events WHERE room_id='commons'").all()
    .map(row => JSON.parse(row.body)).filter(e => e.type === "message.posted").map(e => e.data.body);
}

test("kill switch: owner pause stops every batch and landing; resume continues", async (t) => {
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"], 2: ["docs/b.md"] } });
  const { store, train, roomId, clock, owner } = fixture(t, gh);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  clock.now += 60_000;
  await train.tick(roomId); // batch is testing
  train.setPaused(roomId, owner, true, "incident");
  assert.equal(train.list(roomId, owner).paused, true);
  await drain(train, roomId, clock, 5);
  assert.equal(gh.refs.get("main"), gh.base, "paused train never lands");
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 2 });
  await drain(train, roomId, clock, 5);
  assert.equal(gh.commits.get(gh.refs.get("main")).prs.length, 0);
  assert.ok(cards(store).some(body => /paused by the owner/.test(body)));
  train.setPaused(roomId, owner, false);
  await drain(train, roomId, clock, 5);
  assert.deepEqual(gh.commits.get(gh.refs.get("main")).prs, [1]);
});

test("flaky: a red batch re-runs once; a pass lands it and records the flipped job", async (t) => {
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"], 2: ["tests/b.test.js"] }, flakyFirst: true });
  const { train, roomId, clock, owner } = fixture(t, gh);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 2 });
  await drain(train, roomId, clock, 4);
  assert.deepEqual(gh.commits.get(gh.refs.get("main")).prs, [1, 2], "no bisect for a flake");
  const testRuns = gh.dispatches.filter(d => d.workflow === "test.yml").length;
  assert.equal(testRuns, 2);
  const m = train.metrics(roomId, owner);
  assert.deepEqual(m.flaky.map(f => [f.name, f.flips]), [["unit (shard 3)", 1]]);
});

test("receipt card and metrics after land and rollback", async (t) => {
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"] } });
  const { store, train, roomId, clock, owner } = fixture(t, gh);
  await train.enqueue(roomId, owner, { repo: "o/r", prNumber: 1 });
  await drain(train, roomId, clock, 3);
  const landed = cards(store).find(body => /landed on main/.test(body));
  assert.match(landed, /PRs: #1/);
  assert.match(landed, /Merged SHA: [0-9a-f]{40}/);
  assert.match(landed, /Test run: https:\/\/github.com\/o\/r\/actions\/runs\/\d+/);
  assert.match(landed, new RegExp(`Rollback target: ${gh.base}`));
  const { batchId } = train.list(roomId, owner).batches[0];
  await train.recordSmoke(roomId, owner, { batchId, ok: false });
  assert.ok(cards(store).some(body => /rolled back to/.test(body) && /Smoke: red/.test(body)));
  const m = train.metrics(roomId, owner);
  assert.equal(m.merges, 1);
  assert.equal(m.mainBreaks, 1);
  assert.equal(m.prodRollbacks, 1);
  assert.equal(Object.values(m.perDay)[0], 1);
});

test("rollback drill script passes against the in-memory GitHub", async () => {
  const { runDrill } = await import("../scripts/merge-train-rollback-drill.mjs");
  const out = await runDrill({});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.state, "rolled_back");
});

test("bench task T11 drives enqueue to land over the tool surface", async () => {
  const { MERGE_TRAIN_TASK } = await import("../bench/room-bench/merge-train-task.mjs");
  assert.equal(MERGE_TRAIN_TASK.id, "T11-land");
  assert.deepEqual(MERGE_TRAIN_TASK.steps.map(step => step.tool), ["room_land", "room_land"]);
  const s = { room: "r1", repo: "o/r", pr: 5 };
  assert.deepEqual(MERGE_TRAIN_TASK.steps[0].args(s), { roomId: "r1", action: "enqueue", repo: "o/r", prNumber: 5 });
  assert.equal(MERGE_TRAIN_TASK.check(s, [{ ok: true, out: { entry: { state: "queued" } } }, { ok: true, out: { entries: [{ prNumber: 5, state: "landed" }] } }]), true);
});

test("REST twin: GET lists or returns metrics, POST runs the same actions", async (t) => {
  const { MERGE_TRAIN_ROUTES } = await import("../server/routes/merge-train.mjs");
  assert.deepEqual(MERGE_TRAIN_ROUTES.map(r => `${r.method} ${r.path} ${r.parity}`), [
    "GET /api/rooms/{roomId}/room_land mcp:room_land", "POST /api/rooms/{roomId}/room_land mcp:room_land"]);
  const gh = fakeGitHub({ files: { 1: ["docs/a.md"] } });
  const { store, roomId, owner } = fixture(t, gh);
  const sent = [];
  const ctx = (method, payload, query = "") => ({
    params: { roomId }, req: { method }, res: {}, url: new URL(`http://x/api/rooms/${roomId}/room_land${query}`), store,
    roomCredentials: () => ({ mode: "room", bearer: true }), expectedBinding: () => null, accountBinding: () => null,
    roomAuth: () => ({ kind: "room", credentialScope: "room", credentialHash: "h", member: { id: owner } }),
    rate() {}, protectWrite() {}, reject: (status, code) => { throw Object.assign(new Error(code), { status }); },
    body: async () => payload, json: (_res, status, body) => { sent.push({ status, body }); return body; }
  });
  const [list, post] = MERGE_TRAIN_ROUTES.map(r => r.handler);
  await post(ctx("POST", { action: "enqueue", repo: "o/r", prNumber: 1 }));
  assert.equal(sent.at(-1).status, 201);
  list(ctx("GET"));
  assert.equal(sent.at(-1).body.entries.length, 1);
  list(ctx("GET", null, "?view=metrics"));
  assert.equal(sent.at(-1).body.merges, 0);
  await assert.rejects(post(ctx("POST", { action: "list", junk: 1 })), /invalid_request/);
});
