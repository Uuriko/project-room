import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

const expiredClaim = JSON.stringify([{
  id: 1,
  created_at: "2026-09-19T00:00:00Z",
  body: `[quill][claim]
\`\`\`room-claim
task-id:    RC-2026-09-19-100
lane:       quill
files:      scripts/foo.mjs
lease:      lease=1h
state:      working
reason:     test claim
\`\`\``,
}]);

function fakeGh(dir) {
  const bin = join(dir, "bin");
  const log = join(dir, "gh.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(join(dir, "comments.json"), expiredClaim);
  writeFileSync(join(bin, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$*" == *"-X POST"* ]]; then
  printf 'posted comment id=1 url=http://example.test/c/1\\n'
  exit 0
fi
if [[ "$*" == *"rate_limit"* ]]; then
  printf 'HTTP/2 200\\nDate: Thu, 24 Sep 2026 01:40:00 GMT\\n\\n{}\\n'
  exit 0
fi
if [[ "$*" == *"comments"* ]]; then
  cat "$GH_COMMENTS"
  exit 0
fi
if [[ "$*" == *"--jq"* ]]; then
  printf '0\\n'
  exit 0
fi
printf '{}\\n'
`);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

function run(args, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "room-dry-run-"));
  const { bin, log } = fakeGh(dir);
  const res = spawnSync(room, args, {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ROOM_ENFORCER_ALLOW_STALE: "1",
      GH_LOG: log,
      GH_COMMENTS: join(dir, "comments.json"),
      ...extra.env,
    },
  });
  const calls = readFileSync(log, "utf8");
  return { ...res, calls, dir };
}

test("sweep --dry-run prints the plan and does not post", () => {
  const res = run(["sweep", "--dry-run"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PLAN: strike-one nudge for RC-2026-09-19-100/);
  assert.match(res.stdout, /room: sweep done, 1 action/);
  assert.equal(res.calls.includes("-X POST"), false, res.calls);
  assert.equal(res.stdout.includes("room: posting:"), false);
  rmSync(res.dir, { recursive: true, force: true });
});

test("sweep without --dry-run posts the strike", () => {
  const res = run(["sweep"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /room: posting: strike-one nudge/);
  assert.equal(res.calls.includes("-X POST"), true, res.calls);
  rmSync(res.dir, { recursive: true, force: true });
});

test("sweep --bogus-flag dies before any board call", () => {
  const res = run(["sweep", "--bogus-flag"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /sweep: unknown flag --bogus-flag/);
  assert.equal(res.calls, "");
  rmSync(res.dir, { recursive: true, force: true });
});

test("claim --dry-run prints the comment and does not post", () => {
  const res = run([
    "claim", "--task-id", "RC-2026-09-24-001", "--lane", "grok",
    "--files", "scripts/room", "--lease", "6h", "--reason", "inspect only",
    "--dry-run",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /```room-claim/);
  assert.match(res.stdout, /task-id:\s+RC-2026-09-24-001/);
  assert.equal(res.calls.includes("-X POST"), false, res.calls);
  rmSync(res.dir, { recursive: true, force: true });
});

test("claim --bogus still names the unknown flag", () => {
  const res = run([
    "claim", "--task-id", "RC-2026-09-24-001", "--lane", "grok",
    "--files", "scripts/room", "--lease", "6h", "--reason", "inspect only",
    "--bogus",
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /claim: unknown flag --bogus/);
  assert.equal(res.calls.includes("-X POST"), false);
  rmSync(res.dir, { recursive: true, force: true });
});

test("claim --lane with a space dies before any board read", () => {
  const res = run([
    "claim", "--task-id", "RC-2026-09-23-001", "--lane", "Grok Bot",
    "--files", "x", "--lease", "6h", "--reason", "t",
  ]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /claim: --lane must match \[A-Za-z0-9_-\]\+/);
  assert.equal(res.calls, "", res.calls);
  rmSync(res.dir, { recursive: true, force: true });
});

test("claim --lane quill-s2 still passes the charset check", () => {
  const res = run([
    "claim", "--task-id", "RC-2026-09-24-001", "--lane", "quill-s2",
    "--files", "scripts/room", "--lease", "6h", "--reason", "inspect only",
    "--dry-run",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr.includes("--lane must match"), false);
  assert.match(res.stdout, /\[quill-s2\]\[claim\]/);
  assert.equal(res.calls.includes("-X POST"), false, res.calls);
  rmSync(res.dir, { recursive: true, force: true });
});
