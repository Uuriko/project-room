// tests/claims-index.test.js — parser/indexer unit tests against hand-built
// #266-style comments, including the known malformed shapes. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "claims-index.mjs");
const NOW = "2026-09-23T20:00:00Z"; // fixed "now" for lease math

const C = (id, at, body, extra = {}) => ({
  id,
  created_at: at,
  html_url: `https://github.com/Uuriko/project-room/issues/266#issuecomment-${id}`,
  body,
  ...extra,
});

const claimBlock = (tid, lane, lease, state = "working") =>
  `[${lane}][claim] test claim (jill, agent, quill)\n\n` +
  "```room-claim\n" +
  `task-id:    ${tid}\n` +
  `lane:       ${lane}\n` +
  `files:      scripts/a.mjs,tests/a.test.js\n` +
  `lease:      ${lease}\n` +
  `state:      ${state}\n` +
  `reason:     testing the indexer\n` +
  "```\n\n· claim:" + tid + " · lane:" + lane;

const fixture = [
  // 1. valid claim, lease=6h at 18:00 -> expires 2026-09-24T00:00:00Z, active
  C(1001, "2026-09-23T18:00:00Z", claimBlock("RC-2026-09-23-101", "jill", "lease=6h")),
  // 2. duplicate task-id -> refused
  C(1002, "2026-09-23T18:05:00Z", claimBlock("RC-2026-09-23-101", "codex", "lease=6h")),
  // 3. bare `lease: 6h` -> unregistered, must not crash
  C(1003, "2026-09-23T18:10:00Z", claimBlock("RC-2026-09-23-102", "jill", "6h")),
  // 4. prose CLAIM: header -> unregistered
  C(1004, "2026-09-23T18:15:00Z", "[jill] CLAIM: fixing the thing, lease 6h, RC-2026-09-23-103"),
  // 5. [lane][claim] without fenced block -> unregistered
  C(1005, "2026-09-23T18:20:00Z", "[jill][claim] fixing RC-2026-09-23-104, files `scripts/b.mjs`"),
  // 6. receipt with PR + merge SHA for the valid claim
  C(1006, "2026-09-23T19:00:00Z",
    "[jill][receipt] RC-2026-09-23-101 done. PR #900 merged.\nMerge SHA: abc1234def567890"),
  // 7. expired claim: claimed 10:00 lease=2h -> expired 12:00, no receipt
  C(1007, "2026-09-23T10:00:00Z", claimBlock("RC-2026-09-23-105", "grokbot", "lease=2h")),
  // 8. heartbeat extends the lease: claim 15:00 lease=2h (expires 17:00),
  //    heartbeat at 16:30 -> new expiry 18:30 -> expired at NOW=20:00
  C(1008, "2026-09-23T15:00:00Z", claimBlock("RC-2026-09-23-106", "jill", "lease=2h")),
  C(1009, "2026-09-23T16:30:00Z",
    "[jill]STATUS: heartbeat RC-2026-09-23-106 — still working (jill, agent, quill)\n\n" +
    "```room-claim\ntask-id: RC-2026-09-23-106\nlane: jill\nfiles: scripts/c.mjs\n" +
    "lease: lease=2h\nstate: working\nreason: testing the indexer\n```"),
  // 9. DONE: completes a claim with receipt fields
  C(1010, "2026-09-23T11:00:00Z", claimBlock("RC-2026-09-23-107", "instinct", "lease=12h")),
  C(1011, "2026-09-23T19:30:00Z",
    "[instinct]DONE: RC-2026-09-23-107\n\n```room-receipt\nmerged: deadbeef1234\nattribution: instinct\n```"),
  // 10. orphan receipt (task never claimed)
  C(1012, "2026-09-23T19:40:00Z", "[codex][receipt] RC-2026-09-23-999 done. PR #901"),
  // 11. null body -> parse error entry, no crash
  C(1013, "2026-09-23T19:50:00Z", null),
  // 12. release via STATUS: releasing (state cancelled in fenced block)
  C(1014, "2026-09-23T13:00:00Z", claimBlock("RC-2026-09-23-108", "jill", "lease=12h")),
  C(1015, "2026-09-23T14:00:00Z",
    "[jill]STATUS: releasing RC-2026-09-23-108 — no longer needed (jill, agent, quill)\n\n" +
    "```room-claim\ntask-id: RC-2026-09-23-108\nlane: jill\nfiles: scripts/d.mjs\n" +
    "lease: lease=12h\nstate: cancelled\nreason: testing the indexer\n```"),
  // 13. path-only comment (the real @/tmp/claim-agent-card.json shape) -> ignored, no crash
  C(1016, "2026-09-23T19:55:00Z", "@/tmp/claim-agent-card.json"),
  // 14. lease out of range -> unregistered
  C(1017, "2026-09-23T19:56:00Z", claimBlock("RC-2026-09-23-109", "jill", "lease=99h")),
];

function run(fx, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "claims-index-test-"));
  const fxPath = join(dir, "comments.json");
  writeFileSync(fxPath, JSON.stringify(fx));
  const out = join(dir, "out");
  execFileSync("node", [script, "--comments", fxPath, "--out", out, "--now", NOW, "--format", "json", ...extraArgs],
    { encoding: "utf8" });
  return JSON.parse(readFileSync(join(out, "claims-index.json"), "utf8"));
}

test("valid claim registers with correct lease expiry", () => {
  const idx = run(fixture);
  const c = idx.claims.find((x) => x.task_id === "RC-2026-09-23-101");
  assert.ok(c, "claim present");
  assert.equal(c.lane, "jill");
  assert.equal(c.lease_h, 6);
  assert.equal(c.expires_at, "2026-09-24T00:00:00.000Z");
  assert.equal(c.status, "receipted"); // receipt #1006 attached
  assert.equal(c.receipts.length, 1);
  assert.equal(c.receipts[0].pr, "900");
  assert.equal(c.receipts[0].merged_sha, "abc1234def567890");
});

test("duplicate task-id is refused, not double-registered", () => {
  const idx = run(fixture);
  assert.equal(idx.claims.filter((x) => x.task_id === "RC-2026-09-23-101").length, 1);
  assert.equal(idx.refused.length, 1);
  assert.match(idx.refused[0].reason, /duplicate claim refused/);
  assert.equal(idx.refused[0].by_lane, "codex");
});

test("bare `lease: 6h` is unregistered with the exact enforcer error", () => {
  const idx = run(fixture);
  const u = idx.unregistered.find((x) => x.comment_id === 1003);
  assert.ok(u, "unregistered entry present");
  assert.ok(u.errors.some(error => error.includes("did you mean lease=6h?")), `errors: ${u.errors}`);
  assert.ok(!idx.claims.some((x) => x.task_id === "RC-2026-09-23-102"));
});

test("spaced and swapped [lane][claim] headers are recognized", () => {
  const spaced = C(2001, "2026-09-23T18:00:00Z",
    "[ claim ][ jill ] spaced\n\n```room-claim\ntask-id: RC-2026-09-23-110\nlane: jill\nfiles: scripts/e.mjs\nlease: lease=6h\nstate: working\nreason: spaced\n```");
  const swapped = C(2002, "2026-09-23T18:01:00Z", "[claim][jill] swapped RC-2026-09-23-111");
  const idx = run([spaced, swapped]);
  const claim = idx.claims.find(x => x.task_id === "RC-2026-09-23-110");
  assert.ok(claim, "spaced header with a fence registers");
  assert.equal(claim.lane, "jill");
  const unfenced = idx.unregistered.find(x => x.comment_id === 2002);
  assert.ok(unfenced && /without a fenced room-claim/.test(unfenced.reason));
});

test("prose CLAIM: and unfenced [claim] are unregistered, never crash", () => {
  const idx = run(fixture);
  const u4 = idx.unregistered.find((x) => x.comment_id === 1004);
  const u5 = idx.unregistered.find((x) => x.comment_id === 1005);
  assert.ok(u4 && /prose CLAIM/.test(u4.reason));
  assert.ok(u5 && /without a fenced room-claim/.test(u5.reason));
});

test("lease out of range is unregistered", () => {
  const idx = run(fixture);
  const u = idx.unregistered.find((x) => x.comment_id === 1017);
  assert.ok(u && u.errors.includes("lease out of range 1-72h"));
});

test("expired lease with no receipt -> expired status", () => {
  const idx = run(fixture);
  const c = idx.claims.find((x) => x.task_id === "RC-2026-09-23-105");
  assert.equal(c.status, "expired");
  assert.equal(c.expires_at, "2026-09-23T12:00:00.000Z");
});

test("heartbeat renews the lease from the heartbeat comment", () => {
  const idx = run(fixture);
  const c = idx.claims.find((x) => x.task_id === "RC-2026-09-23-106");
  assert.equal(c.heartbeat_at, "2026-09-23T16:30:00Z");
  assert.equal(c.expires_at, "2026-09-23T18:30:00.000Z");
  assert.equal(c.status, "expired"); // 18:30 < NOW 20:00
});

test("DONE: completes the claim and attaches the receipt", () => {
  const idx = run(fixture);
  const c = idx.claims.find((x) => x.task_id === "RC-2026-09-23-107");
  assert.equal(c.state, "completed");
  assert.equal(c.status, "receipted");
  assert.equal(c.receipts[0].merged_sha, "deadbeef1234");
});

test("receipt for an unknown task becomes an orphan receipt", () => {
  const idx = run(fixture);
  assert.equal(idx.orphan_receipts.length, 1);
  assert.equal(idx.orphan_receipts[0].task_hint, "RC-2026-09-23-999");
});

test("null body is recorded as unregistered, path-only comments ignored, no crash", () => {
  const idx = run(fixture);
  const u = idx.unregistered.find((x) => x.comment_id === 1013);
  assert.ok(u && /body missing/.test(u.reason), "null-body comment is visible as unregistered");
  assert.equal(idx.parse_errors.length, 0);
  // path-only comment is simply ignored prose
  assert.ok(!idx.unregistered.some((x) => x.comment_id === 1016));
});

test("STATUS: releasing transitions the claim to cancelled", () => {
  const idx = run(fixture);
  const c = idx.claims.find((x) => x.task_id === "RC-2026-09-23-108");
  assert.equal(c.status, "cancelled");
  assert.equal(c.state, "cancelled");
});

test("watermark and stats are consistent", () => {
  const idx = run(fixture);
  assert.equal(idx.watermark, 1017);
  assert.equal(idx.comment_count, fixture.length);
  assert.equal(idx.stats.total, idx.claims.length);
  assert.equal(
    idx.stats.unregistered,
    idx.unregistered.length,
  );
});

const strikeOne = (tid, stamp) =>
  `[room-watch]RECLAIM (strike 1): @jill lease on ${tid} expired, no heartbeat seen\n\n<!-- room:strike-one:${tid}:${stamp} -->\n`;
const strikeTwo = (tid, stamp) =>
  `[room-watch]RECLAIM (strike 2): ${tid} released. No heartbeat 4h after the strike-one nudge.\n\n<!-- room:strike-two:${tid}:${stamp} -->\n`;

test("strike-two alone never releases; grace boundary is strict; then release lands", () => {
  const tid = "RC-2026-09-23-301";
  const fx = [
    C(4001, "2026-09-23T08:00:00Z", claimBlock(tid, "jill", "lease=72h")),
    // lone strike-two, no prior strike-one -> ignored, claim stays held
    C(4002, "2026-09-23T09:00:00Z", strikeTwo(tid, "2026-09-23T09:00:00Z")),
    // strike-one recorded
    C(4003, "2026-09-23T10:00:00Z", strikeOne(tid, "2026-09-23T10:00:00Z")),
    // strike-two at exactly strike_one_at + 14400s -> still inside grace, ignored
    C(4004, "2026-09-23T14:00:00Z", strikeTwo(tid, "2026-09-23T14:00:00Z")),
    // one second past the grace -> release lands
    C(4005, "2026-09-23T14:00:01Z", strikeTwo(tid, "2026-09-23T14:00:01Z")),
  ];
  const idx = run(fx);
  const c = idx.claims.find((x) => x.task_id === tid);
  assert.ok(c, "claim present");
  assert.equal(c.state, "submitted");
  assert.equal(c.lane, null);
  assert.equal(c.released_at, "2026-09-23T14:00:01Z");
  assert.equal(c.status, "released");
  const ignored = idx.unregistered.filter((x) => x.kind === "ignored-strike");
  assert.deepEqual(ignored.map((x) => x.comment_id), [4002, 4004],
    "lone and early strike-two stamps are visible as ignored");
  assert.match(ignored[0].reason, /no prior strike-one/);
  assert.match(ignored[1].reason, /grace/);
});

test("strike-one records its stamp (set-once); post-strike-one heartbeat blocks strike-two", () => {
  const tid = "RC-2026-09-23-302";
  const fx = [
    C(4101, "2026-09-23T08:00:00Z", claimBlock(tid, "jill", "lease=72h")),
    // comment posted 10:10 but stamped 10:00 -> strike_one_at is the stamp
    C(4102, "2026-09-23T10:10:00Z", strikeOne(tid, "2026-09-23T10:00:00Z")),
    // duplicate strike-one must not reset the grace clock
    C(4103, "2026-09-23T10:20:00Z", strikeOne(tid, "2026-09-23T10:20:00Z")),
    // holder heartbeats after the strike-one
    C(4104, "2026-09-23T11:00:00Z",
      `[jill]STATUS: heartbeat ${tid} — still working (jill)\n\n` +
      "```room-claim\n" +
      `task-id: ${tid}\nlane: jill\nfiles: scripts/a.mjs\n` +
      "lease: lease=72h\nstate: working\nreason: testing the indexer\n```"),
    // 5h after the (first) strike-one the grace has elapsed, but the
    // post-strike-one heartbeat blocks the release
    C(4105, "2026-09-23T15:00:00Z", strikeTwo(tid, "2026-09-23T15:00:00Z")),
  ];
  const idx = run(fx);
  const c = idx.claims.find((x) => x.task_id === tid);
  assert.ok(c, "claim present");
  assert.equal(c.strike_one_at, "2026-09-23T10:00:00.000Z",
    "strike_one_at is the first stamp, not the comment time, never reset by a replay");
  assert.equal(c.state, "working", "strike-two blocked by the post-strike-one heartbeat");
  assert.equal(c.lane, "jill");
  assert.equal(c.released_at, null);
  const ignored = idx.unregistered.filter((x) => x.kind === "ignored-strike");
  assert.deepEqual(ignored.map((x) => x.comment_id), [4103, 4105]);
  assert.match(ignored[0].reason, /replay ignored/);
  assert.match(ignored[1].reason, /heartbeat after strike-one/);
});

test("strikes against terminal or suspended claims are ignored", () => {
  const done = "RC-2026-09-23-303";
  const susp = "RC-2026-09-23-304";
  const fx = [
    C(4201, "2026-09-23T08:00:00Z", claimBlock(done, "instinct", "lease=12h")),
    C(4202, "2026-09-23T09:00:00Z",
      `[instinct]DONE: ${done}\n\n` + "```room-receipt\nmerged: deadbeef1234\n```"),
    // strike stamps replayed against the completed claim must not flip it
    // back to submitted (2026-09-19 incident class)
    C(4203, "2026-09-23T10:00:00Z", strikeOne(done, "2026-09-23T10:00:00Z")),
    C(4204, "2026-09-23T15:00:00Z", strikeTwo(done, "2026-09-23T15:00:00Z")),
    // a suspended claim is not a strike target either
    C(4205, "2026-09-23T08:30:00Z", claimBlock(susp, "jill", "lease=12h", "suspended")),
    C(4206, "2026-09-23T10:00:00Z", strikeOne(susp, "2026-09-23T10:00:00Z")),
  ];
  const idx = run(fx);
  const cDone = idx.claims.find((x) => x.task_id === done);
  assert.equal(cDone.state, "completed", "completed claim is not flipped back to submitted");
  assert.equal(cDone.lane, "instinct");
  assert.equal(cDone.released_at, null);
  assert.equal(cDone.strike_one_at, null);
  const cSusp = idx.claims.find((x) => x.task_id === susp);
  assert.equal(cSusp.state, "suspended");
  assert.equal(cSusp.strike_one_at, null, "no strike recorded against a suspended claim");
  const ignored = idx.unregistered.filter((x) => x.kind === "ignored-strike");
  // entries land in event (chronological) order: 4203, 4206, then 4204
  assert.deepEqual(ignored.map((x) => x.comment_id), [4203, 4206, 4204]);
  assert.ok(ignored.every((x) => /not held/.test(x.reason)));
});

test("M-49: cross-lane STATUS:/DONE:/[receipt] transitions are ignored, same-lane apply", () => {
  const fx = [
    // jill holds the claim
    C(3001, "2026-09-23T18:00:00Z", claimBlock("RC-2026-09-23-201", "jill", "lease=12h")),
    // codex tries a heartbeat on jill's claim -> ignored, no lease renewal
    C(3002, "2026-09-23T18:30:00Z",
      "[codex]STATUS: heartbeat RC-2026-09-23-201 — still working (codex)\n\n" +
      "```room-claim\ntask-id: RC-2026-09-23-201\nlane: codex\nfiles: scripts/a.mjs\n" +
      "lease: lease=12h\nstate: working\nreason: cross-lane heartbeat\n```"),
    // codex tries a DONE: on jill's claim -> ignored, claim not completed
    C(3003, "2026-09-23T19:00:00Z", "[codex]DONE: RC-2026-09-23-201\n\n```room-receipt\nmerged: beefcafe1234\n```"),
    // codex tries a [receipt] on jill's claim -> ignored, no receipt attached
    C(3004, "2026-09-23T19:10:00Z", "[codex][receipt] RC-2026-09-23-201 done. PR #902"),
    // jill's own heartbeat still applies
    C(3005, "2026-09-23T19:20:00Z",
      "[jill]STATUS: heartbeat RC-2026-09-23-201 — still working (jill)\n\n" +
      "```room-claim\ntask-id: RC-2026-09-23-201\nlane: jill\nfiles: scripts/a.mjs\n" +
      "lease: lease=12h\nstate: working\nreason: own heartbeat\n```"),
  ];
  const idx = run(fx);
  const c = idx.claims.find((x) => x.task_id === "RC-2026-09-23-201");
  assert.ok(c, "claim present");
  // only jill's heartbeat (3005) renewed the lease: expires 2026-09-24T07:20:00Z
  assert.equal(c.heartbeat_at, "2026-09-23T19:20:00Z");
  assert.equal(c.expires_at, "2026-09-24T07:20:00.000Z");
  assert.equal(c.state, "working", "codex DONE: did not complete the claim");
  assert.equal(c.receipts.length, 0, "codex [receipt] did not attach");
  const xl = idx.unregistered.filter((x) => x.kind === "cross-lane-transition");
  assert.equal(xl.length, 3, `cross-lane attempts recorded, got ${xl.length}`);
  assert.ok(xl.every((x) => x.lane === "codex"));
});
