// tests/receipt-prose-quality.test.js — receipt prose quality bar.
//
// A stranger reading a generated receipt must learn what was done, where it
// landed, and what verified it. The bar: every generated receipt names the
// PR number, the merge SHA, and the test outcome.
//
// Test-audit authoring gate (repo AGENTS.md -> .agents/skills/test-audit):
//  1. Behavior protected: scripts/room's `receipt` verb emits a room-receipt
//     fence that names the PR, the merge SHA, and the test outcome
//     (ROOM-PROCEDURES receipt format: PR number + merge SHA + check counts);
//     scripts/merge-queue-receipt.mjs's validating receipt links the merge
//     queue page so a stranger can watch the checks it announces.
//  2. Credible regression: a later edit that drops `pr:`/`tests:` from the
//     fence, drops the new flags, or removes the queue link re-silences the
//     evidence and the assertions below fail.
//  3. Existing coverage: none — no test exercises cmd_receipt output shape or
//     receiptCommand; room-watch-enforcer.test.sh covers sweep/receipts-scan
//     plans only.
//  4. Production seam: ROOM_TEST_CLAIM_BLOCK in latest_block (test-only read
//     path, mirroring the file's ROOM_TEST_PRS_JSON convention). No mocks:
//     the real script renders the real posted bytes, and the generated fence
//     round-trips through the real `_parse` reducer boundary.
//
// Run: scripts/test-env.sh node --test tests/receipt-prose-quality.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptCommand } from "../scripts/merge-queue-receipt.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const room = join(repoRoot, "scripts", "room");

// Fixture claim block: "lane|files|lease|state|reason" — the shape
// latest_block() returns from a live board read. ROOM_TEST_CLAIM_BLOCK
// substitutes it so the test never touches the network.
const CLAIM_BLOCK = "qa-receipt-prose-2|scripts/room,tests/receipt-prose-quality.test.js|lease=6h|working|fixture claim reason";

function receipt(args, { claimBlock = CLAIM_BLOCK } = {}) {
  const env = { ...process.env, ROOM_TEST_CLAIM_BLOCK: claimBlock };
  return spawnSync("bash", [room, "receipt", ...args, "--dry-run"], { encoding: "utf8", env });
}

test("work receipt block names the PR, the merge SHA, and the test outcome", () => {
  const run = receipt([
    "--task-id", "RC-2026-10-06-900",
    "--lane", "qa-receipt-prose-2",
    "--merged", "abc1234def5678",
    "--pr", "1658",
    "--tests", "hosted 14/14 green; npm run check pass",
    "--note", "receipt prose quality bar",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const body = run.stdout;
  assert.match(body, /\[qa-receipt-prose-2\]DONE: RC-2026-10-06-900/);
  assert.match(body, /```room-receipt\n/);
  assert.match(body, /^task-id:\s+RC-2026-10-06-900$/m);
  assert.match(body, /^merged:\s+abc1234def5678$/m, "the receipt names the merge SHA");
  assert.match(body, /^pr:\s+1658$/m, "the receipt names the PR number");
  assert.match(body, /^tests:\s+hosted 14\/14 green; npm run check pass$/m, "the receipt names the test outcome");
});

test("work receipt without --pr/--tests is explicit, not silent", () => {
  const run = receipt([
    "--task-id", "RC-2026-10-06-901",
    "--lane", "qa-receipt-prose-2",
    "--merged", "none",
    "--note", "research-only claim, no PR",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^pr:\s+none$/m, "missing PR renders as explicit none");
  assert.match(run.stdout, /^tests:\s+none$/m, "missing test outcome renders as explicit none");
  assert.match(run.stderr, /--pr not given|--tests not given/, "the lane is nudged to be explicit");
});

test("generated receipt fence round-trips through the board parser", () => {
  const run = receipt([
    "--task-id", "RC-2026-10-06-902",
    "--lane", "qa-receipt-prose-2",
    "--merged", "def5678abc1234",
    "--pr", "#1659",
    "--tests", "hosted 12/12 green; npm run check pass",
    "--note", "round-trip",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const comments = JSON.stringify([{ id: 1, created_at: "2026-10-06T18:00:00Z", body: run.stdout }]);
  const parsed = spawnSync("bash", [room, "_parse"], {
    input: comments, encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  const events = JSON.parse(parsed.stdout);
  // A [lane]DONE: post with a room-receipt fence parses as a `done` event
  // carrying the receipt — the canonical terminal close.
  const done = events.find(e => e.kind === "done");
  assert.ok(done, "the generated body parses as a done event");
  assert.ok(done.receipt, "the done event carries the receipt");
  assert.equal(done.receipt.pr, "1659", "the PR survives the generator -> parser round trip");
  assert.equal(done.receipt.merged, "def5678abc1234");
  assert.equal(done.receipt.tests, "hosted 12/12 green; npm run check pass", "the test outcome survives the round trip");
});

test("merge-queue validating receipt links the queue page", () => {
  const { data: { body } } = receiptCommand({
    repo: "Uuriko/project-room", action: "checks_requested",
    headRef: "pr-1600-merge", headSha: "f456830e028264ddac9439bc2c82830c2a483ad2", baseRef: "main",
  });
  assert.match(body, /#1600/, "names the PR");
  assert.match(body, /f456830/, "names the queue head SHA");
  assert.match(body, /https:\/\/github\.com\/Uuriko\/project-room\/queue\/main/,
    "a stranger can watch the validation the receipt announces");
});

test("merge-queue removal receipt keeps PR, SHA, reason, and claim guidance", () => {
  const { data: { body } } = receiptCommand({
    repo: "Uuriko/project-room", action: "destroyed",
    headRef: "pr-1601-merge", headSha: "7ce3b202f456830e028264ddac9439bc2c82830c2a483ad2",
    baseRef: "main", reason: "new commits were pushed",
  });
  assert.match(body, /#1601/);
  assert.match(body, /7ce3b20/);
  assert.match(body, /new commits were pushed/);
  assert.match(body, /claim stays open/);
});

// The reviewer's bar (Instinct-3 seq 5312): the test outcome must survive
// board parsing into the persisted receipt record — not just the generator
// output. These run the real `_state` reducer on fixture board comments.
function stateFor(comments) {
  // _parse turns board comments into events; _state reduces events to state.
  const env = { ...process.env };
  const parsed = spawnSync("bash", [room, "_parse"], { input: JSON.stringify(comments), encoding: "utf8", env });
  assert.equal(parsed.status, 0, parsed.stderr);
  const run = spawnSync("bash", [room, "_state", "--now", "2026-10-06T19:10:00Z"], {
    input: parsed.stdout, encoding: "utf8", env,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const claimFixture = (id, task) => ({
  id, created_at: "2026-10-06T19:00:00Z",
  body: `[qa-receipt-prose-2][claim] fixture\n\n\`\`\`room-claim\ntask-id:    ${task}\nlane:       qa-receipt-prose-2\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n\`\`\`\n\n· claim:${task} · lane:qa-receipt-prose-2`,
});

test("test outcome persists into the task's receipt record", () => {
  const gen = receipt([
    "--task-id", "RC-2026-10-06-903",
    "--lane", "qa-receipt-prose-2",
    "--merged", "abc1234def5678",
    "--pr", "1660",
    "--tests", "hosted 12/12 green; npm run check pass",
    "--note", "persistence",
  ]);
  assert.equal(gen.status, 0, gen.stderr);
  const state = stateFor([
    claimFixture(1, "RC-2026-10-06-903"),
    { id: 2, created_at: "2026-10-06T19:05:00Z", body: gen.stdout },
  ]);
  // The reduced state carries tasks as an array; find ours by task_id.
  const task = state.tasks.find(t => t.task_id === "RC-2026-10-06-903");
  assert.ok(task, "the fixture claim reduced to a task");
  const receipts = task.receipts;
  assert.equal(receipts.length, 1, "the DONE receipt is persisted");
  assert.equal(receipts[0].pr, "1660");
  assert.equal(receipts[0].merged, "abc1234def5678");
  assert.equal(receipts[0].tests, "hosted 12/12 green; npm run check pass",
    "the test outcome survives the reducer, not just the event");
});

test("prose receipt row carries the test outcome", () => {
  const state = stateFor([{
    id: 1, created_at: "2026-10-06T19:00:00Z",
    body: "[qa-receipt-prose-2][receipt] RC-2026-10-06-904\n\n```room-receipt\ntask-id:      RC-2026-10-06-904\npr:           1661\nmerged:       abc1234\ntests:        hosted 9/9 green\nattribution:  (qa-receipt-prose-2, agent, quill)\n```",
  }]);
  const rows = state.prose_receipts.filter(r => r.task === "RC-2026-10-06-904");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pr, "1661");
  assert.equal(rows[0].tests, "hosted 9/9 green",
    "the prose receipt row keeps the test outcome for reporting");
});
