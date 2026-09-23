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
  assert.ok(u.errors.includes("lease must be lease=<N>h"), `errors: ${u.errors}`);
  assert.ok(!idx.claims.some((x) => x.task_id === "RC-2026-09-23-102"));
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
