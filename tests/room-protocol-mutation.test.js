// tests/room-protocol-mutation.test.js
//
// Boundary-condition tests for the protocol trust core of scripts/room that
// no existing test file owns (checked 2026-09-26 against
// room-strike-hardening, room-sweep-dry-run, room-sweep-terminal,
// room-board-grammar, room-prose-claims, claim-validate, claims-index).
// Each test pins one exact-boundary behavior of the strike/lease protocol;
// scripts/room-mutate.mjs verifies that a single-point mutation at the
// corresponding site is killed by the test named here.
//
// Boundaries covered:
//   - heartbeat accepted exactly at lease expiry (L4)
//   - future-dated strike-one stamp clamped to the comment time (S3)
//   - unparseable strike-one stamp refused, never recorded (S4)
//   - strike-two releases at exactly strike_one_at + 14400s (S7)
//   - a heartbeat exactly at strike_one_at does not block strike-two (S9)
//   - sweep strike-one/strike-two emission boundaries (W1..W9)
//
// The sweep tests drive the real `sweep --dry-run` verb with a fake `gh`
// (same technique as room-sweep-dry-run.test.js): canned board comments,
// board clock pinned via the rate_limit Date header. No new production seam.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const ROOM = process.env.ROOM_UNDER_TEST || join(here, "..", "scripts", "room");

function runRoom(args, stdin) {
  const res = spawnSync(ROOM, args, { input: stdin, encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, `room ${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

const parse = (comments) => JSON.parse(runRoom(["_parse"], JSON.stringify(comments)));
const reduce = (events, nowIso) =>
  JSON.parse(runRoom(["_state", "--now", nowIso], JSON.stringify(events)));
const stateOf = (comments, nowIso) => reduce(parse(comments), nowIso);
const taskOf = (state, id = TID) => state.tasks.find((t) => t.task_id === id);

const C = (id, at, body) => ({ id, created_at: at, body });

// ---- fixtures -----------------------------------------------------------

const TID = "RC-2026-09-26-9001";
const CLAIM_FILES = "tests/room-protocol-mutation.test.js";

function claimComment(id, at, { taskId = TID, lease = "lease=6h", state = "working" } = {}) {
  return C(id, at,
    `[jill][claim] verify-1 fixture\n\n\`\`\`room-claim\ntask-id:    ${taskId}\nlane:       jill\nfiles:      ${CLAIM_FILES}\nlease:      ${lease}\nstate:      ${state}\nreason:     mutation test fixture\n\`\`\`\n`);
}

function statusComment(id, at, taskId = TID, state = "working") {
  return C(id, at,
    `[jill]STATUS: heartbeat\n\n\`\`\`room-claim\ntask-id:    ${taskId}\nlane:       jill\nfiles:      ${CLAIM_FILES}\nlease:      lease=6h\nstate:      ${state}\nreason:     mutation test fixture\n\`\`\`\n`);
}

function strikeOneComment(id, at, taskId = TID, stamp = at) {
  return C(id, at,
    `[jill]RECLAIM (strike 1): @jill lease expired, no heartbeat seen\n\n<!-- room:strike-one:${taskId}:${stamp} -->\n`);
}

function strikeTwoComment(id, at, taskId = TID, stamp = at) {
  return C(id, at,
    `[jill]RECLAIM (strike 2): ${taskId} released\n\n<!-- room:strike-two:${taskId}:${stamp} -->\n`);
}

// ---- reducer boundaries -------------------------------------------------

test("L4: heartbeat exactly at lease expiry is accepted, not void", () => {
  const t0 = "2026-09-26T20:00:00Z";   // claim, lease=6h -> expires 02:00:00Z
  const exp = "2026-09-27T02:00:00Z";
  const st = stateOf(
    [claimComment(1, t0), statusComment(2, exp)],
    "2026-09-27T03:00:00Z"
  );
  assert.equal(taskOf(st).heartbeat_at, exp);
  assert.ok(!st.log.some((e) => (e.errors || []).join(" ").includes("void")),
    "heartbeat at the exact expiry instant must not be voided");
});

test("S3: future-dated strike-one stamp is clamped to the comment time", () => {
  const t1 = "2026-09-27T02:00:01Z";
  const st = stateOf(
    [claimComment(1, "2026-09-26T20:00:00Z"),
     strikeOneComment(2, t1, TID, "2026-09-27T03:00:01Z")], // stamp 1h in the future
    "2026-09-27T04:00:00Z"
  );
  assert.equal(taskOf(st).strike_one_at, t1);
});

// S4 documents a REAL BUG found 2026-09-26 while writing this suite (not a
// mutant): the "unparseable stamp refused" branch is unreachable because
// `def epoch($s): (($s | fromdate) // 0)` does not catch jq errors (`//`
// only handles empty/false/null). A genuinely unparseable strike-one stamp
// crashes the whole _state/rebuild/sweep pipeline (jq exit 5) instead of
// being refused. Minimal fix: `def epoch($s): (try ($s | fromdate) catch 0)`.
// Filed as a bug for the scripts/room-owning lane (this lane may not edit
// scripts/room: live claims RC-2026-09-17-001/006, RC-2026-09-16-004,
// RC-2026-09-26-969). Unskip when the owner repairs epoch().
test("S4: unparseable strike-one stamp is refused, never recorded", { skip: "BUG-2026-09-26: unparseable stamp crashes _state (jq exit 5) instead of refusing; owner must make epoch() total" }, () => {
  const st = stateOf(
    [claimComment(1, "2026-09-26T20:00:00Z"),
     strikeOneComment(2, "2026-09-27T02:00:01Z", TID, "not-a-date")],
    "2026-09-27T04:00:00Z"
  );
  assert.equal(taskOf(st).strike_one_at, null);
  assert.ok(st.log.some((e) => (e.errors || []).join(" ").includes("unparseable stamp")),
    "expected a refused-stamp log entry");
});

test("S7: strike-two at exactly strike_one_at + 14400s releases the claim", () => {
  const s1 = "2026-09-27T02:00:01Z";
  const s2 = "2026-09-27T06:00:01Z"; // exactly 14400s later
  const st = stateOf(
    [claimComment(1, "2026-09-26T20:00:00Z"),
     strikeOneComment(2, s1),
     strikeTwoComment(3, s2)],
    "2026-09-27T07:00:00Z"
  );
  assert.equal(taskOf(st).state, "submitted");
  assert.equal(taskOf(st).lane, null);
  assert.equal(taskOf(st).strike_one_at, null);
});

test("S9: heartbeat exactly at strike_one_at does not block strike-two", () => {
  const s1 = "2026-09-27T02:00:01Z";
  const st = stateOf(
    [claimComment(1, "2026-09-26T20:00:00Z"),
     strikeOneComment(2, s1),
     statusComment(3, s1),                       // heartbeat at the strike instant
     strikeTwoComment(4, "2026-09-27T06:00:02Z")],
    "2026-09-27T07:00:00Z"
  );
  assert.equal(taskOf(st).state, "submitted",
    "a heartbeat simultaneous with the nudge is not a post-nudge heartbeat");
});

// ---- sweep boundaries (fake-gh end-to-end) -------------------------------
// Board clock is pinned by the rate_limit Date header:
//   Thu, 24 Sep 2026 01:40:00 GMT  ==  2026-09-24T01:40:00Z  (skew >> 300s vs
// the operator clock, so lease math runs on the board reading exactly).

const BOARD_DATE_HDR = "Thu, 24 Sep 2026 01:40:00 GMT";

function fakeGh(dir, commentsJson) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const commentsFile = join(dir, "comments.json");
  writeFileSync(commentsFile, commentsJson);
  writeFileSync(join(bin, "gh"), `#!/bin/bash
if [[ "$*" == *"-X POST"* ]]; then
  printf 'posted comment id=1 url=http://example.test/c/1\\n'
  exit 0
fi
if [[ "$*" == *"rate_limit"* ]]; then
  printf 'HTTP/2 200\\nDate: ${BOARD_DATE_HDR}\\n\\n{}\\n'
  exit 0
fi
if [[ "$*" == *"comments"* ]]; then
  cat "${commentsFile}"
  exit 0
fi
printf '{}\\n'
`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function sweepDry(comments) {
  const dir = mkdtempSync(join(tmpdir(), "room-mut-sweep-"));
  try {
    const bin = fakeGh(dir, JSON.stringify(comments));
    mkdirSync(join(dir, "tmp"), { recursive: true });
    const res = spawnSync(ROOM, ["sweep", "--dry-run"], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ROOM_ENFORCER_ALLOW_STALE: "1",
        TMPDIR: join(dir, "tmp"),
      },
    });
    assert.equal(res.status, 0, `sweep --dry-run failed: ${res.stderr}`);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// claim at 18:00Z 9/23; lease=6h -> expired 00:00Z 9/24, before the pinned sweep clock (2026-09-24T01:40:00Z).
// The 1h variant expires 19:00Z 9/23, so a same-evening heartbeat does not
// push lease_expires_at past the pinned sweep clock (needed for W4/W6/W7 to reach the
// strike-two branch at all).
const expiredWorking = (lease = "lease=6h", at = "2026-09-23T18:00:00Z") =>
  [claimComment(1, at, { lease })];

test("W1: sweep plans strike-one for a working claim past its lease", () => {
  const out = sweepDry(expiredWorking());
  assert.match(out, /PLAN: strike-one nudge for RC-2026-09-26-9001/);
});

test("W2: sweep plans nothing when now is exactly the lease expiry instant", () => {
  // claim at 19:40Z + 6h = 01:40:00Z == the pinned sweep clock; strike-one fires only AFTER expiry
  const out = sweepDry([claimComment(1, "2026-09-23T19:40:00Z")]);
  assert.doesNotMatch(out, /PLAN: strike-one/);
});

test("W3: sweep plans strike-one for expired submitted claims (2026-09-26 submitted-state rot fix)", () => {
  // Submitted claims now have an expiry path: the two-strike takeover
  // applies uniformly to working and submitted states.
  const out = sweepDry([claimComment(1, "2026-09-23T18:00:00Z", { state: "submitted" })]);
  assert.match(out, /PLAN: strike-one nudge for RC-2026-09-26-9001/);
});

test("W4: sweep plans strike-two when the 4h grace elapsed with no heartbeat", () => {
  const out = sweepDry([
    ...expiredWorking("lease=1h"),
    strikeOneComment(2, "2026-09-23T19:00:01Z"), // 6h40m before the pinned clock
  ]);
  assert.match(out, /PLAN: strike-two release for RC-2026-09-26-9001/);
});

test("W5: sweep plans nothing at exactly 14400s after strike-one", () => {
  const out = sweepDry([
    ...expiredWorking(),
    strikeOneComment(2, "2026-09-23T21:40:00Z"), // exactly 14400s before the pinned clock
  ]);
  assert.doesNotMatch(out, /PLAN:/);
});

test("W6: sweep plans nothing when a heartbeat followed the strike-one nudge", () => {
  const out = sweepDry([
    ...expiredWorking("lease=1h"),
    strikeOneComment(2, "2026-09-23T19:00:01Z"),
    statusComment(3, "2026-09-23T20:00:00Z"),
  ]);
  assert.doesNotMatch(out, /PLAN:/);
});

test("W7: sweep still releases when the heartbeat is exactly at the strike instant", () => {
  const out = sweepDry([
    ...expiredWorking("lease=1h"),
    strikeOneComment(2, "2026-09-23T19:00:01Z"),
    statusComment(3, "2026-09-23T19:00:01Z"),
  ]);
  assert.match(out, /PLAN: strike-two release for RC-2026-09-26-9001/);
});

test("W8: sweep ignores terminal (completed) claims", () => {
  const out = sweepDry([
    claimComment(1, "2026-09-23T18:00:00Z"),
    C(2, "2026-09-23T20:00:00Z",
      `[jill][done] finished\n\n\`\`\`room-done\ntask-id:    ${TID}\nsha:        abc1234\npr:         9999\n\`\`\`\n`),
  ]);
  assert.doesNotMatch(out, /PLAN:/);
});

test("W9: sweep does not re-nudge a claim that already has strike-one recorded", () => {
  const out = sweepDry([
    ...expiredWorking(),
    strikeOneComment(2, "2026-09-24T00:30:00Z"), // 1h10m before the pinned clock: grace not elapsed
  ]);
  assert.doesNotMatch(out, /PLAN:/);
});
