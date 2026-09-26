// Submitted-state strike lifecycle (2026-09-26 submitted-state rot fix).
//
// Ground truth: ~/workspace/pr-claim-metrics/REPORT.md finding #3 — 29 of 32
// rot claims were stuck in `submitted` state, and strike stamps only bit
// `working`-state claims, so a claim that never moved submitted→working had
// NO expiry path. The fix extends the two-strike takeover (protocol §4) to
// submitted-state held claims: the reducer now accepts strike stamps on
// submitted claims and the sweep nominates them.
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
//   1. Contract: submitted-state held claims have an expiry path via the
//      uniform two-strike lifecycle; stamps still ignored on terminal,
//      suspended, and released claims.
//   2. Credible regression: a guard re-tightened to working-only (or a sweep
//      filter narrowed back) silently reintroduces the rot gap — every S1/S2/
//      S3/S6/S7 test below FAILS on the pre-fix reducer for that reason.
//   3. Existing coverage: tests/room-strike-hardening.test.js covers
//      working-state strikes only; nothing covers submitted strike
//      acceptance. This file owns the submitted-state contract.
//   4. No production seam: real reducer via the _parse/_state test verbs.
//
// Env: ROOM_SCRIPT overrides the script under test (default: scripts/room).
// Pre-fix check: git show origin/main:scripts/room > .tmp/room-prefix
//                ROOM_SCRIPT=.tmp/room-prefix node --test tests/room-submitted-rot.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = process.env.ROOM_SCRIPT
  ? resolve(checkout, process.env.ROOM_SCRIPT)
  : join(checkout, "scripts/room");

const T0 = "2026-09-26T00:00:00Z"; // claim time
const tid = n => `RC-2026-09-26-${n}`;

const claimBlock = (taskId, state = "submitted") =>
  "```room-claim\n" +
  `task-id:    ${taskId}\n` +
  "lane:      jill\n" +
  "files:     server/a.mjs\n" +
  "lease:     lease=6h\n" +
  `state:     ${state}\n` +
  "reason:    submitted-rot test\n" +
  "```";

let nextId = 500;
const comment = (at, body) => ({ id: nextId++, created_at: at, body });
const claimComment = (taskId, state = "submitted", at = T0) =>
  comment(at, `[jill][claim]\n${claimBlock(taskId, state)}\n`);
const statusComment = (taskId, state, at) =>
  comment(at, `[jill]STATUS:\n${claimBlock(taskId, state)}\n`);
const strikeOneComment = (taskId, at, stamp) =>
  comment(at, `[room-watch]RECLAIM (strike 1): @jill nudge\n\n<!-- room:strike-one:${taskId}:${stamp} -->`);
const strikeTwoComment = (taskId, at, stamp) =>
  comment(at, `[room-watch]RECLAIM (strike 2): released\n\n<!-- room:strike-two:${taskId}:${stamp} -->`);

function reduce(comments, nowIso) {
  const parsed = spawnSync(room, ["_parse"], {
    input: JSON.stringify(comments), encoding: "utf8", timeout: 30000,
  });
  assert.equal(parsed.status, 0, `_parse failed: ${parsed.stderr}`);
  const st = spawnSync(room, ["_state", "--now", nowIso], {
    input: parsed.stdout, encoding: "utf8", timeout: 30000,
  });
  assert.equal(st.status, 0, `_state failed: ${st.stderr}`);
  return JSON.parse(st.stdout);
}

const task = (st, taskId) => st.tasks.find(t => t.task_id === taskId);
const logText = st => JSON.stringify(st.log);

// --- S1: strike-one on an expired submitted claim is recorded
test("S1: strike-one stamp on a submitted held claim is recorded, not ignored", () => {
  const id = tid(901);
  const s1 = "2026-09-26T06:00:00Z"; // lease expiry
  const st = reduce([
    claimComment(id),
    strikeOneComment(id, s1, s1),
  ], "2026-09-26T07:00:00Z");
  assert.equal(task(st, id).strike_one_at, s1, "strike-one on submitted claim was ignored");
  assert.match(logText(st), /strike-one recorded/);
});

// --- S2: full lifecycle — strike-one + 4h grace + silence releases a submitted claim
test("S2: strike-two releases an expired submitted claim with no heartbeat", () => {
  const id = tid(902);
  const s1 = "2026-09-26T06:00:00Z";
  const st = reduce([
    claimComment(id),
    strikeOneComment(id, s1, s1),
    strikeTwoComment(id, "2026-09-26T10:00:01Z", "2026-09-26T10:00:01Z"),
  ], "2026-09-26T11:00:00Z");
  assert.equal(task(st, id).state, "submitted", "submitted claim should stay submitted");
  assert.equal(task(st, id).lane, null, "submitted claim was not released by strike-two");
  assert.equal(task(st, id).released_at, "2026-09-26T10:00:01Z");
  assert.equal(task(st, id).strike_one_at, null);
  assert.match(logText(st), /strike-two release: 4h grace elapsed/);
});

// --- S3: post-nudge STATUS heartbeat defends a submitted claim (heartbeat defense is uniform)
test("S3: strike-two after a post-nudge STATUS heartbeat on a submitted claim is ignored", () => {
  const id = tid(903);
  const s1 = "2026-09-26T06:00:00Z";
  const st = reduce([
    claimComment(id),
    strikeOneComment(id, s1, s1),
    statusComment(id, "submitted", "2026-09-26T07:00:00Z"), // lane alive after the nudge
    strikeTwoComment(id, "2026-09-26T10:00:01Z", "2026-09-26T10:00:01Z"),
  ], "2026-09-26T11:00:00Z");
  assert.equal(task(st, id).lane, "jill", "submitted claim released despite post-nudge heartbeat");
  assert.match(logText(st), /strike-two after a post-nudge heartbeat/);
});

// --- S4 (control): strike-one on a terminal claim-as-completed is still ignored
test("S4: strike-one on a terminal (completed) claim is still ignored", () => {
  const id = tid(904);
  const st = reduce([
    claimComment(id, "completed"),
    strikeOneComment(id, "2026-09-26T06:00:00Z", "2026-09-26T06:00:00Z"),
  ], "2026-09-26T07:00:00Z");
  assert.equal(task(st, id).strike_one_at, null, "strike-one bit a terminal claim");
  assert.equal(task(st, id).state, "completed");
});

// --- S5 (control): strike-one on a suspended claim is still ignored (out of scope)
test("S5: strike-one on a suspended claim is still ignored", () => {
  const id = tid(905);
  const st = reduce([
    claimComment(id, "suspended"),
    strikeOneComment(id, "2026-09-26T06:00:00Z", "2026-09-26T06:00:00Z"),
  ], "2026-09-26T07:00:00Z");
  assert.equal(task(st, id).strike_one_at, null, "strike-one bit a suspended claim");
  assert.equal(task(st, id).state, "suspended");
});

// --- S6: re-strike after a submitted release is ignored (claim no longer held)
test("S6: strike-one on an already-released submitted claim is ignored", () => {
  const id = tid(906);
  const s1 = "2026-09-26T06:00:00Z";
  const st = reduce([
    claimComment(id),
    strikeOneComment(id, s1, s1),
    strikeTwoComment(id, "2026-09-26T10:00:01Z", "2026-09-26T10:00:01Z"), // releases
    strikeOneComment(id, "2026-09-26T11:00:00Z", "2026-09-26T11:00:00Z"), // re-strike
  ], "2026-09-26T12:00:00Z");
  assert.equal(task(st, id).lane, null, "submitted claim was never released");
  assert.equal(task(st, id).strike_one_at, null, "re-strike-one recorded on a released claim");
  assert.match(logText(st), /strike_one ignored: claim not held \(working\/submitted\)/);
});

// --- S7: prose claims (state submitted, 12h lease) are strike-eligible too
test("S7: strike-one is recorded on an expired lease-bearing prose claim", () => {
  const id = tid(907);
  const st = reduce([
    comment(T0, `[jill][claim] ${id}: picking up \`server/b.mjs\` for the rot fix`),
    strikeOneComment(id, "2026-09-26T12:00:00Z", "2026-09-26T12:00:00Z"), // 12h lease expiry
  ], "2026-09-26T13:00:00Z");
  assert.equal(task(st, id).state, "submitted", "prose claim did not register as submitted");
  assert.equal(
    task(st, id).strike_one_at, "2026-09-26T12:00:00Z",
    "strike-one on expired prose claim was ignored",
  );
});
