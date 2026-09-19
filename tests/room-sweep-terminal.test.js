import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

function run(args, stdin) {
  const res = spawnSync(room, args, { input: stdin, encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, `scripts/room ${args.join(" ")} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function parse(comments) {
  return run(["_parse"], JSON.stringify(comments));
}

function stateOf(comments, now) {
  const events = JSON.stringify(parse(comments));
  return run(["_state", "--now", now], events);
}

// Mirror of the cmd_sweep strikeable-claim selection in scripts/room.
function sweepable(state) {
  return state.tasks.filter(
    (t) => t.state === "working" && t.lane != null && !(t.terminal ?? false),
  );
}

const C = (id, at, body) => ({ id, created_at: at, body });

const CLAIM = (tid, at = "2026-09-19T00:00:00Z") => C(1, at, `[quill][claim]
\`\`\`room-claim
task-id:    ${tid}
lane:       quill
files:      scripts/foo.mjs
lease:      lease=1h
state:      working
reason:     test claim
\`\`\``);

test("terminal-by-receipt claim is completed and skipped by sweep", () => {
  const comments = [
    CLAIM("RC-2026-09-19-100"),
    C(2, "2026-09-19T00:10:00Z", `[quill][done]
\`\`\`room-done
task-id: RC-2026-09-19-100
result: done
pr: 700
sha: abc1234
reason: shipped
\`\`\``),
  ];
  const st = stateOf(comments, "2026-09-19T05:00:00Z");
  const task = st.tasks.find((t) => t.task_id === "RC-2026-09-19-100");
  assert.ok(task, "claim must exist");
  assert.equal(task.state, "completed");
  assert.equal(task.terminal, true);
  assert.equal(task.receipts.length, 1);
  assert.deepEqual(sweepable(st).map((t) => t.task_id), [],
    "terminal claim must never appear in the sweep selection");
});

test("MERGED/DEPLOYED/DONE prose completions close claims terminally", () => {
  for (const [tid, body] of [
    ["RC-2026-09-19-101", "[quill] MERGED: PR #701 (RC-2026-09-19-101 thing) merged as d54c9fa"],
    ["RC-2026-09-19-102", "[quill] DEPLOYED: PR #702 (RC-2026-09-19-102 other) merged as 817ba088 and deployed to room."],
    ["RC-2026-09-19-103", "[quill] DONE task-id: RC-2026-09-19-103\nPR: https://github.com/Uuriko/project-room/pull/703"],
  ]) {
    const comments = [CLAIM(tid), C(2, "2026-09-19T00:10:00Z", body)];
    const st = stateOf(comments, "2026-09-19T05:00:00Z");
    const task = st.tasks.find((t) => t.task_id === tid);
    assert.ok(task, `${tid} must exist`);
    assert.equal(task.state, "completed", `${tid} prose completion must be terminal`);
    assert.equal(task.terminal, true);
    assert.deepEqual(sweepable(st).map((t) => t.task_id), [],
      `${tid} must never appear in the sweep selection`);
  }
});

test("prose-terminal MERGED from submitted state also completes", () => {
  const comments = [
    C(1, "2026-09-19T00:00:00Z", `[quill][claim]
\`\`\`room-claim
task-id:    RC-2026-09-19-104
lane:       quill
files:      scripts/foo.mjs
lease:      lease=1h
state:      submitted
reason:     test claim
\`\`\``),
    C(2, "2026-09-19T00:10:00Z", "[quill] DEPLOYED: PR #704 (RC-2026-09-19-104 y) merged as 817ba088"),
  ];
  const st = stateOf(comments, "2026-09-19T05:00:00Z");
  const task = st.tasks.find((t) => t.task_id === "RC-2026-09-19-104");
  assert.equal(task.state, "completed");
});

test("active working claim with expired lease is still sweepable", () => {
  const comments = [CLAIM("RC-2026-09-19-105")];
  // lease=1h from 00:00; at 05:00 the lease has long expired.
  const st = stateOf(comments, "2026-09-19T05:00:00Z");
  const task = st.tasks.find((t) => t.task_id === "RC-2026-09-19-105");
  assert.equal(task.state, "working");
  assert.equal(task.terminal, false);
  assert.deepEqual(sweepable(st).map((t) => t.task_id), ["RC-2026-09-19-105"],
    "expired active claim must remain strike-eligible");
});

test("strike-one/strike-two stamps on a terminal claim are ignored", () => {
  const strike = (id, at, kind, ts) => C(id, at,
    `[quill-s2]RECLAIM (${kind === "strike-one" ? "strike 1" : "strike 2"}): RC-2026-09-19-106 ${kind === "strike-one" ? "nudge" : "released"}.\n\n<!-- room:${kind}:RC-2026-09-19-106:${ts} -->`);
  const comments = [
    CLAIM("RC-2026-09-19-106"),
    C(2, "2026-09-19T00:10:00Z", "[quill] MERGED: PR #706 (RC-2026-09-19-106 z) merged as d54c9fa"),
    // Rogue strikes arrive AFTER the merge, as happened 2026-09-19.
    strike(3, "2026-09-19T01:00:00Z", "strike-one", "2026-09-19T01:00:00Z"),
    strike(4, "2026-09-19T06:00:00Z", "strike-two", "2026-09-19T06:00:00Z"),
  ];
  const st = stateOf(comments, "2026-09-19T07:00:00Z");
  const task = st.tasks.find((t) => t.task_id === "RC-2026-09-19-106");
  assert.equal(task.state, "completed", "rogue strike-two must not flip a done claim");
  assert.equal(task.lane, "quill", "rogue strike-two must not release the lane");
  assert.equal(task.released_at, null);
  assert.deepEqual(sweepable(st).map((t) => t.task_id), []);
});

test("legitimate strike flow still works: expired working claim strikes through", () => {
  const comments = [
    CLAIM("RC-2026-09-19-107"),
    C(2, "2026-09-19T02:00:00Z",
      `[quill-s2]RECLAIM (strike 1): @quill — lease on RC-2026-09-19-107 expired.\n\n<!-- room:strike-one:RC-2026-09-19-107:2026-09-19T02:00:00Z -->`),
    C(3, "2026-09-19T07:00:00Z",
      `[quill-s2]RECLAIM (strike 2): RC-2026-09-19-107 released.\n\n\`\`\`room-claim\ntask-id:    RC-2026-09-19-107\nlane:\nfiles:      scripts/foo.mjs\nlease:      lease=1h\nstate:      submitted\nreason:     released by strike-two reclaim\n\`\`\`\n\n<!-- room:strike-two:RC-2026-09-19-107:2026-09-19T07:00:00Z -->`),
  ];
  const st = stateOf(comments, "2026-09-19T08:00:00Z");
  const task = st.tasks.find((t) => t.task_id === "RC-2026-09-19-107");
  assert.equal(task.state, "submitted");
  assert.equal(task.lane, null);
  assert.equal(task.released_at, "2026-09-19T07:00:00Z");
});

test("prose MERGED without a task-id stays prose and changes nothing", () => {
  const comments = [
    CLAIM("RC-2026-09-19-108"),
    C(2, "2026-09-19T00:10:00Z", "[quill] MERGED: some PR with no claim id at all"),
  ];
  const events = parse(comments);
  const last = events[events.length - 1];
  assert.equal(last.kind, "prose");
  const st = stateOf(comments, "2026-09-19T05:00:00Z");
  const task = st.tasks.find((t) => t.task_id === "RC-2026-09-19-108");
  assert.equal(task.state, "working");
});
