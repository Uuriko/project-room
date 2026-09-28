// Sweep evidence before strike-one (2026-09-27, RC-2026-09-27-2726).
//
// The sweep used to propose strikes from machine-counted signals alone:
// a claim whose files had already merged got a strike-one nudge instead of
// a DONE closeout, and a lane that posted a prose STATUS / strike response
// / receipt got a strike-one or a strike-two release because the machine
// never counted human-format activity.
//
// Regression tests through the real `_sweep-plan` fixture verb (no
// network). ROOM_TEST_PRS_JSON supplies the closed-PR list,
// ROOM_TEST_PR_FILES_JSON the per-PR changed files. Each suppression test
// FAILS on the pre-fix script (the strike is planned); each control test
// guards the semantics that must NOT change (genuine silence still
// strikes, strike-two still releases).
//
// Env: ROOM_SCRIPT overrides the script under test (default: scripts/room).
// Pre-fix check: git show HEAD:scripts/room > .tmp/room-prefix
//                ROOM_SCRIPT=.tmp/room-prefix node --test tests/room-sweep-evidence.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = process.env.ROOM_SCRIPT
  ? resolve(checkout, process.env.ROOM_SCRIPT)
  : join(checkout, "scripts/room");

const header = {
  id: 1, created_at: "2026-09-27T18:00:00Z", updated_at: "2026-09-27T18:00:00Z",
  body: "# Claims board (continued from #266)\n\nFresh claims board.",
};
const claim = (tid, files, at = "2026-09-27T18:00:10Z") => ({
  id: 2, created_at: at, updated_at: at,
  body: `[instinct][claim]\n\n\`\`\`room-claim\ntask-id: ${tid}\n` +
    `lane: instinct\nfiles: ${files}\nlease: lease=2h\nstate: working\n` +
    `reason: sweep evidence test\n\`\`\``,
});
// Expires 2026-09-27T20:00:10Z (2h lease).
const T900 = "RC-2026-09-27-900";
const T901 = "RC-2026-09-27-901";
const T902 = "RC-2026-09-27-902";

const strikeOne = (tid, at, stamp) => ({
  id: 3, created_at: at, updated_at: at,
  body: `[room-watch]RECLAIM (strike 1): @instinct \u2014 lease on ${tid} expired, ` +
    `no heartbeat seen.\n\n<!-- room:strike-one:${tid}:${stamp} -->`,
});

function sweepPlan(comments, nowIso, env = {}) {
  const res = spawnSync(room, ["_sweep-plan", "--now", nowIso], {
    input: JSON.stringify(comments), encoding: "utf8", timeout: 30000,
    env: {
      ...process.env,
      ROOM_TEST_PRS_JSON: "[]",
      ROOM_TEST_PR_FILES_JSON: "{}",
      ...env,
    },
  });
  assert.equal(res.status, 0, `_sweep-plan failed: ${res.stderr}`);
  return res.stdout;
}

const PRS = JSON.stringify([{
  number: 2000, merged_at: "2026-09-27T20:30:00Z",
  merge_commit_sha: "abc123def456",
  title: "fix a", body: "no task ref",
}]);

test("merged PR touching the claim files suppresses strike-one", () => {
  const out = sweepPlan(
    [header, claim(T900, "server/a.mjs")],
    "2026-09-27T21:00:00Z",
    { ROOM_TEST_PRS_JSON: PRS,
      ROOM_TEST_PR_FILES_JSON: JSON.stringify({ 2000: ["server/a.mjs"] }) });
  assert.match(out, new RegExp(
    `strike-one suppressed for ${T900}: deliverable already landed`));
  assert.doesNotMatch(out, new RegExp(`PLAN: strike-one nudge for ${T900}`));
});

test("merged PR touching unrelated files does not suppress strike-one", () => {
  const out = sweepPlan(
    [header, claim(T900, "server/a.mjs")],
    "2026-09-27T21:00:00Z",
    { ROOM_TEST_PRS_JSON: PRS,
      ROOM_TEST_PR_FILES_JSON: JSON.stringify({ 2000: ["server/other.mjs"] }) });
  assert.match(out, new RegExp(`PLAN: strike-one nudge for ${T900}`));
});

test("a drive-by touch of one peripheral file among many is not a landing", () => {
  const out = sweepPlan(
    [header, claim(T900, "server/a.mjs,server/b.mjs,server/c.mjs")],
    "2026-09-27T21:00:00Z",
    { ROOM_TEST_PRS_JSON: PRS,
      ROOM_TEST_PR_FILES_JSON: JSON.stringify({ 2000: ["server/b.mjs"] }) });
  assert.match(out, new RegExp(`PLAN: strike-one nudge for ${T900}`));
});

test("a post-claim touch of the core file among many is a landing", () => {
  // 2026-09-28 (RC-2026-09-28-3110): criterion-3 tightened — a merged PR
  // that merged after the claim opened and touched the claim's core file
  // (first in the files list) is a landed deliverable, even when the
  // claim lists more files.
  const out = sweepPlan(
    [header, claim(T900, "server/a.mjs,server/b.mjs,server/c.mjs")],
    "2026-09-27T21:00:00Z",
    { ROOM_TEST_PRS_JSON: PRS,
      ROOM_TEST_PR_FILES_JSON: JSON.stringify({ 2000: ["server/a.mjs"] }) });
  assert.match(out, new RegExp(
    `strike-one suppressed for ${T900}: deliverable already landed`));
  assert.doesNotMatch(out, new RegExp(`PLAN: strike-one nudge for ${T900}`));
});

test("a pre-claim merged PR touching the core file is not a landing", () => {
  // 2026-09-28 (RC-2026-09-28-3110): RC-2026-09-28-2873 was suppressed by
  // PRs #1128/#1146, merged a day before the claim. A PR that merged
  // before the claim opened cannot be the claim's deliverable.
  const early = JSON.stringify([{
    number: 2000, merged_at: "2026-09-27T17:00:00Z",
    merge_commit_sha: "abc123def456",
    title: "fix a", body: "no task ref",
  }]);
  const out = sweepPlan(
    [header, claim(T900, "server/a.mjs,server/b.mjs,server/c.mjs")],
    "2026-09-27T21:00:00Z",
    { ROOM_TEST_PRS_JSON: early,
      ROOM_TEST_PR_FILES_JSON: JSON.stringify({ 2000: ["server/a.mjs"] }) });
  assert.match(out, new RegExp(`PLAN: strike-one nudge for ${T900}`));
});

test("prose receipt after expiry suppresses strike-one as human-format activity", () => {
  const receipt = {
    id: 3, created_at: "2026-09-27T20:15:00Z", updated_at: "2026-09-27T20:15:00Z",
    body: `[instinct] merged PR #2001 for ${T901} \u2014 the fix is live, writing the receipt next.`,
  };
  const out = sweepPlan(
    [header, claim(T901, "server/b.mjs"), receipt],
    "2026-09-27T21:00:00Z");
  assert.match(out, new RegExp(
    `strike-one suppressed for ${T901}: human-format board activity since lease expiry`));
  assert.doesNotMatch(out, new RegExp(`PLAN: strike-one nudge for ${T901}`));
});

test("human activity before the window does not suppress strike-one", () => {
  const early = {
    id: 3, created_at: "2026-09-27T19:00:00Z", updated_at: "2026-09-27T19:00:00Z",
    body: `[instinct] status update for ${T901}: still working, heartbeat to follow.`,
  };
  const out = sweepPlan(
    [header, claim(T901, "server/b.mjs"), early],
    "2026-09-27T21:00:00Z");
  assert.match(out, new RegExp(`PLAN: strike-one nudge for ${T901}`));
});

test("prose STATUS after strike-one suppresses strike-two", () => {
  const status = {
    id: 4, created_at: "2026-09-27T20:39:00Z", updated_at: "2026-09-27T20:39:00Z",
    body: `[instinct]STATUS: ${T902} \u2014 still working the fix, heartbeat shortly.`,
  };
  const out = sweepPlan(
    [header, claim(T902, "server/c.mjs"),
     strikeOne(T902, "2026-09-27T20:30:00Z", "2026-09-27T20:30:00Z"), status],
    "2026-09-28T01:00:00Z");
  assert.match(out, new RegExp(
    `strike-two suppressed for ${T902}: human-format board activity since strike-one`));
  assert.doesNotMatch(out, new RegExp(`PLAN: strike-two release for ${T902}`));
});

test("prose STATUS exactly at the strike instant does not suppress strike-two", () => {
  // Boundary: the window is strict (created_at > strike instant), matching
  // the machine heartbeat boundary (room-protocol-mutation W7). A comment
  // simultaneous with the strike is not a post-strike heartbeat.
  const status = {
    id: 4, created_at: "2026-09-27T20:30:00Z", updated_at: "2026-09-27T20:30:00Z",
    body: `[instinct]STATUS: ${T902} \u2014 still working the fix, heartbeat shortly.`,
  };
  const out = sweepPlan(
    [header, claim(T902, "server/c.mjs"),
     strikeOne(T902, "2026-09-27T20:30:00Z", "2026-09-27T20:30:00Z"), status],
    "2026-09-28T01:00:00Z");
  assert.match(out, new RegExp(`PLAN: strike-two release for ${T902}`));
});

test("the production-format strike-one nudge does not self-suppress strike-two", () => {
  // 2026-09-28 (RC-2026-09-28-3110): RC-2026-09-27-2742's strike-two was
  // self-suppressed. The real nudge is authored as [quill-s2] (not
  // [room-watch]), names the task, carries strike/heartbeat/status
  // language, and lands strictly after strike_one_at — human_board_activity
  // counted it as lane activity. Machine-stamped comments must never
  // count; only lane-authored activity suppresses.
  const prodNudge = {
    id: 3, created_at: "2026-09-27T20:30:01Z", updated_at: "2026-09-27T20:30:01Z",
    body: `[quill-s2]RECLAIM (strike 1): @instinct \u2014 lease on ${T902} expired, ` +
      `no heartbeat seen. Please post STATUS within 4h or the claim releases. ` +
      `(quill-s2, scheduled, quill)\n\n<!-- room:strike-one:${T902}:2026-09-27T20:30:00Z -->\n\n` +
      `· claim:${T902} · lane:instinct`,
  };
  const out = sweepPlan(
    [header, claim(T902, "server/c.mjs"), prodNudge],
    "2026-09-28T01:00:00Z");
  assert.match(out, new RegExp(`PLAN: strike-two release for ${T902}`));
  assert.doesNotMatch(out, new RegExp(`strike-two suppressed for ${T902}`));
});

test("genuine silence after strike-one still releases (strike-two semantics unchanged)", () => {
  // The strike-one nudge itself names the task and says "strike": it must
  // not count as human activity, or no strike-two could ever fire.
  const out = sweepPlan(
    [header, claim(T902, "server/c.mjs"),
     strikeOne(T902, "2026-09-27T20:30:00Z", "2026-09-27T20:30:00Z")],
    "2026-09-28T01:00:00Z");
  assert.match(out, new RegExp(`PLAN: strike-two release for ${T902}`));
});

test("genuine silence after expiry still nudges (strike-one semantics unchanged)", () => {
  const out = sweepPlan(
    [header, claim(T900, "server/a.mjs")],
    "2026-09-27T21:00:00Z");
  assert.match(out, new RegExp(`PLAN: strike-one nudge for ${T900}`));
});
