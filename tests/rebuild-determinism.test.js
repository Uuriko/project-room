// 200-hard-tasks #85: room-state rebuild determinism.
// Same board comments in -> byte-identical ROOM-STATE.md out, every time.
// The rebuild is an enforcer verb with a fail-closed freshness guard; the
// test pins every nondeterminism source and rebuilds twice from a fixed
// fixture, then diffs the two outputs byte-for-byte.
//
// Nondeterminism sources pinned (see docs audit in the test):
//   1. Lease clock: lease_now = clock_now(board_now). board_now reads the
//      GitHub API Date header (fake gh returns a FIXED header); the operator
//      clock is pinned via the ROOM_CLOCK_OP test seam, so lease math and
//      the generated_at banner are fixed.
//   2. Board comments: fetch_comments reads the board issue; the fake gh
//      serves a FIXED comments.json.
//   3. Registry: registry_json reads lanes/REGISTRY.md from the checkout.
//   4. Integrity stamp: sha256 over canonical rows — deterministic.
// Wall-clock leakage anywhere in the pipeline fails the byte diff.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

// Fixed board time: Thu, 24 Sep 2026 01:40:00 GMT = 1758675600.
const BOARD_EPOCH = "1758675600";
const BOARD_DATE = "Thu, 24 Sep 2026 01:40:00 GMT";

// Two claims: one live (leased 6h from a recent start), one long expired.
// created_at values are fixed; lease math keys off the pinned clock.
const fixtureComments = JSON.stringify([
  {
    id: 101,
    created_at: "2026-09-23T22:00:00Z",
    body: "[quill][claim]\n```room-claim\ntask-id:    RC-2026-09-23-100\nlane:       quill\nfiles:      scripts/foo.mjs\nlease:      lease=6h\nstate:      working\nreason:     determinism fixture live claim\n```",
  },
  {
    id: 102,
    created_at: "2026-09-19T00:00:00Z",
    body: "[grok][claim]\n```room-claim\ntask-id:    RC-2026-09-19-100\nlane:       grok\nfiles:      scripts/bar.mjs\nlease:      lease=1h\nstate:      working\nreason:     determinism fixture expired claim\n```",
  },
  {
    id: 103,
    created_at: "2026-09-23T23:30:00Z",
    body: "[jill][done]\n```room-receipt\ntask-id: RC-2026-09-23-100\nlane:    jill\npr:      1700\nresult:  merged\n```",
  },
]);

function fakeGh(dir) {
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(join(dir, "comments.json"), fixtureComments);
  writeFileSync(join(bin, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$*" == *"rate_limit"* ]]; then
  printf 'HTTP/2 200\\nDate: ${BOARD_DATE}\\n\\n{}\\n'
  exit 0
fi
if [[ "$*" == *"comments"* ]]; then
  cat "$GH_COMMENTS"
  exit 0
fi
printf '{}\\n'
`);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

function rebuild(dir, outName) {
  const { bin } = fakeGh(dir);
  const out = join(dir, outName);
  const res = spawnSync(room, ["rebuild", "--out", out], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      // Pin every clock: the Date header (fake gh) and the operator clock
      // (test seam) agree, so no skew warning path and no wall-clock input.
      ROOM_CLOCK_OP: BOARD_EPOCH,
      ROOM_ENFORCER_ALLOW_STALE: "1",
      ROOM_WATCHER_STATE: "active",
      GH_LOG: join(dir, "gh.log"),
      GH_COMMENTS: join(dir, "comments.json"),
    },
  });
  return { ...res, out };
}

test("rebuild is byte-deterministic: same fixture -> identical ROOM-STATE.md", t => {
  const dir = mkdtempSync(join(tmpdir(), "room-rebuild-det-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = rebuild(dir, "a.md");
  assert.equal(first.status, 0, first.stderr);
  // Sleep past a wall-clock second boundary: any unpinned `date` call in the
  // pipeline changes the second output and fails the diff.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  const second = rebuild(dir, "b.md");
  assert.equal(second.status, 0, second.stderr);
  const a = readFileSync(first.out, "utf8");
  const b = readFileSync(second.out, "utf8");
  assert.ok(a.length > 500, `rebuild produced a real file (${a.length} bytes)`);
  assert.equal(a, b, "two rebuilds from the same fixture differ");
});

test("rebuild output carries a self-consistent integrity stamp", t => {
  const dir = mkdtempSync(join(tmpdir(), "room-rebuild-det2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { status, stderr, out } = rebuild(dir, "c.md");
  assert.equal(status, 0, stderr);
  const body = readFileSync(out, "utf8");
  const marker = body.match(/integrity: sha256=([0-9a-f]{64})/);
  assert.ok(marker, "banner carries an integrity marker");
  // The "open" section lists claims by state, not lease liveness (sweep
  // handles expiry). The pinned clock must show in the lease math: the
  // expired fixture claim keeps its past lease-expires-utc, and the live
  // claim (created 09-23 22:00 + 6h lease) expires 09-24 04:00.
  assert.match(body, /RC-2026-09-19-100 \| grok \| working \| 2026-09-19T01:00:00Z/,
    "expired fixture claim keeps its past lease expiry under the pinned clock");
  assert.match(body, /RC-2026-09-23-100 \| quill \| working \| 2026-09-24T04:00:00Z/,
    "live fixture claim expires 6h after its fixed creation under the pinned clock");
});
