// Claims-board strike-protocol hardening (2026-09-24 fuzzer findings F1-F5).
//
// Regression tests against scripts/room's REAL reducer via the _parse/_state
// test verbs (no network). Each test mirrors a minimal repro from
// ~/workspace/claims-fuzzer/REPORT.md and FAILS on the pre-fix reducer.
//
// Env: ROOM_SCRIPT overrides the script under test (default: scripts/room).
// Pre-fix check: git show HEAD:scripts/room > .tmp/room-prefix
//                ROOM_SCRIPT=.tmp/room-prefix node --test tests/room-strike-hardening.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = process.env.ROOM_SCRIPT
  ? resolve(checkout, process.env.ROOM_SCRIPT)
  : join(checkout, "scripts/room");

const TID = "RC-2026-09-24-901";
const T0 = "2026-09-24T00:00:00Z"; // claim time

const claimBlock = (state = "working") =>
  "```room-claim\n" +
  `task-id:    ${TID}\n` +
  "lane:      jill\n" +
  "files:     server/a.mjs\n" +
  "lease:     lease=6h\n" +
  `state:     ${state}\n` +
  "reason:    hardening test\n" +
  "```";

let nextId = 100;
const comment = (at, body) => ({ id: nextId++, created_at: at, body });
const claimComment = (at = T0) => comment(at, `[jill][claim]\n${claimBlock()}\n`);
const heartbeatComment = at => comment(at, `[jill]STATUS:\n${claimBlock("working")}\n`);
const strikeOneComment = (at, stamp) =>
  comment(at, `[room-watch]RECLAIM (strike 1): @jill nudge\n\n<!-- room:strike-one:${TID}:${stamp} -->`);
const strikeTwoComment = (at, stamp) =>
  comment(at, `[room-watch]RECLAIM (strike 2): released\n\n<!-- room:strike-two:${TID}:${stamp} -->`);

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

const task = st => st.tasks.find(t => t.task_id === TID);
const logText = st => JSON.stringify(st.log);

// --- F1: fresh-stamp strike-one replay must not nullify the heartbeat defense
test("F1: replayed strike-one with a fresher stamp does not move strike_one_at", () => {
  const genuine = "2026-09-24T06:00:00Z"; // genuine nudge at lease expiry
  const st = reduce([
    claimComment(),
    strikeOneComment(genuine, genuine),
    heartbeatComment("2026-09-24T06:23:20Z"), // heartbeat 1400s after the nudge
    strikeOneComment("2026-09-24T06:35:00Z", "2026-09-24T06:30:00Z"), // forged replay
  ], "2026-09-24T07:00:00Z");
  assert.equal(task(st).strike_one_at, genuine, "strike_one_at moved by forged replay");
  assert.match(logText(st), /strike-one replay ignored/);
});

// --- F2: stale-stamp strike-one replay must not shorten the 4h grace
test("F2: replayed strike-one with an older stamp does not move strike_one_at backwards", () => {
  const genuine = "2026-09-24T06:00:00Z";
  const st = reduce([
    claimComment(),
    strikeOneComment(genuine, genuine),
    strikeOneComment("2026-09-24T06:05:00Z", "2026-09-24T04:00:00Z"), // stale replay
  ], "2026-09-24T07:00:00Z");
  assert.equal(task(st).strike_one_at, genuine, "strike_one_at moved backwards by stale replay");
  assert.match(logText(st), /strike-one replay ignored/);
});

// --- F3: lone strike-two (no prior strike-one) must not release the claim
test("F3: forged strike-two with no prior strike-one is ignored", () => {
  const st = reduce([
    claimComment(),
    heartbeatComment("2026-09-24T05:00:00Z"),
    strikeTwoComment("2026-09-24T05:30:00Z", "2026-09-24T05:30:00Z"),
  ], "2026-09-24T06:00:00Z");
  assert.equal(task(st).state, "working", "claim released by lone strike-two");
  assert.equal(task(st).lane, "jill");
  assert.match(logText(st), /strike-two without a prior strike-one/);
});

// --- F3: strike-two before the 4h grace elapses is ignored
test("F3: strike-two inside the 4h grace window is ignored", () => {
  const s1 = "2026-09-24T06:00:00Z";
  const st = reduce([
    claimComment(),
    strikeOneComment(s1, s1),
    strikeTwoComment("2026-09-24T07:00:00Z", "2026-09-24T07:00:00Z"), // only 1h later
  ], "2026-09-24T07:30:00Z");
  assert.equal(task(st).state, "working", "claim released before grace elapsed");
  assert.match(logText(st), /before the 4h strike grace elapsed/);
});

// --- F3: strike-two racing a live agent's post-nudge heartbeat is ignored
test("F3: strike-two after a post-nudge heartbeat is ignored", () => {
  const s1 = "2026-09-24T06:00:00Z";
  const st = reduce([
    claimComment(),
    strikeOneComment(s1, s1),
    heartbeatComment("2026-09-24T06:23:20Z"), // agent alive after the nudge
    strikeTwoComment("2026-09-24T11:00:01Z", "2026-09-24T11:00:01Z"), // 5h after nudge
  ], "2026-09-24T12:00:00Z");
  assert.equal(task(st).state, "working", "claim released despite post-nudge heartbeat");
  assert.equal(task(st).lane, "jill");
  assert.match(logText(st), /strike-two after a post-nudge heartbeat/);
});

// --- F3 (control): the legitimate sweep lifecycle still releases
test("F3 control: strike-one + 4h grace + no heartbeat still releases via strike-two", () => {
  const s1 = "2026-09-24T06:00:00Z";
  const st = reduce([
    claimComment(),
    strikeOneComment(s1, s1),
    // no heartbeat after the nudge; strike-two lands after the grace
    strikeTwoComment("2026-09-24T10:00:01Z", "2026-09-24T10:00:01Z"),
  ], "2026-09-24T11:00:00Z");
  assert.equal(task(st).state, "submitted", "legitimate strike-two lifecycle no longer releases");
  assert.equal(task(st).lane, null);
  assert.match(logText(st), /strike-two release: 4h grace elapsed/);
});

// --- F4: lease_expires_at must be heartbeat-aware (sweep reads this field)
test("F4: lease_expires_at extends from the last heartbeat, not claim_at", () => {
  const st = reduce([
    claimComment(T0),
    heartbeatComment("2026-09-24T05:00:00Z"), // 5h in, 6h lease
  ], "2026-09-24T06:30:00Z"); // past claim_at+6h, inside heartbeat+6h
  assert.equal(
    task(st).lease_expires_at, "2026-09-24T11:00:00Z",
    "sweep would read a claim_at-based expiry and post a spurious strike-one",
  );
});

// --- F5: malformed STATUS is logged loudly, never silently absorbed
test("F5: STATUS with no fenced block and no ACK produces a loud log entry", () => {
  const st = reduce([
    claimComment(),
    comment("2026-09-24T01:00:00Z", `[jill]STATUS: still working on ${TID}`),
  ], "2026-09-24T02:00:00Z");
  const entries = st.log.filter(e => e.kind === "malformed");
  assert.equal(entries.length, 1, "malformed STATUS produced no log entry");
  assert.equal(entries[0].ok, false);
  assert.ok(entries[0].errors.length > 0, "malformed log entry has no error text");
  assert.equal(task(st).state, "working", "malformed STATUS should not touch the claim");
});
