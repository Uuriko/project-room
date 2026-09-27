// claim-status verb (R5, RC-2026-09-27-1145).
//
// Contract: `scripts/room claim-status --task-id ID [--state PATH]` prints
// one claim's live board state — lane, state, files, lease, lease expiry,
// last heartbeat, open strikes, claim id and claim time — so a lane can
// pre-flight before drafting a follow-up. Unknown task-id or a missing
// --task-id exits 1 with a concrete error.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const room = join(checkout, "scripts/room");

function run(args, stdin) {
  const res = spawnSync(room, args, { input: stdin, encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, `scripts/room ${args.join(" ")} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// claim-status under test: returns {status, stdout, stderr} without asserting.
function claimStatus(args) {
  return spawnSync(room, ["claim-status", ...args], { encoding: "utf8", timeout: 30000 });
}

function parse(comments) {
  return run(["_parse"], JSON.stringify(comments));
}

function stateFileOf(comments, now) {
  const events = JSON.stringify(parse(comments));
  const st = run(["_state", "--now", now], events);
  const dir = mkdtempSync(join(tmpdir(), "room-claim-status-"));
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(st));
  return path;
}

const C = (id, at, body) => ({ id, created_at: at, body });
const claim = (id, at, lane, task, files) => C(id, at,
  `[${lane}][claim]\n\n\`\`\`room-claim\ntask-id:    ${task}\nlane:       ${lane}\nfiles:      ${files}\nlease:      lease=6h\nstate:      working\nreason:     claim-status fixture\n\`\`\``);

function fieldLines(stdout) {
  const out = {};
  for (const line of stdout.trim().split("\n")) {
    const i = line.indexOf(": ");
    assert.ok(i > 0, `expected "key: value" line, got: ${line}`);
    out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
}

test("claim-status prints the claim's live state fields", () => {
  const sf = stateFileOf([
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-800", "scripts/room, tests/x.test.js"),
  ], "2026-09-27T07:00:00Z");
  const res = claimStatus(["--task-id", "RC-2026-09-27-800", "--state", sf]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const f = fieldLines(res.stdout);
  assert.equal(f.task, "RC-2026-09-27-800");
  assert.equal(f.lane, "jill");
  assert.equal(f.state, "working");
  assert.equal(f.files, "scripts/room, tests/x.test.js");
  assert.equal(f.lease, "lease=6h");
  // 6h lease from the 06:00 claim
  assert.equal(f.lease_expires_at, "2026-09-27T12:00:00Z");
  assert.equal(f.last_heartbeat, "(none)");
  assert.equal(f.open_strikes, "(none)");
  assert.equal(f.claim_id, "1");
  assert.equal(f.claim_at, "2026-09-27T06:00:00Z");
});

test("claim-status reflects a heartbeat: last_heartbeat and extended expiry", () => {
  const sf = stateFileOf([
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-810", "scripts/room"),
    C(2, "2026-09-27T08:00:00Z",
      `[jill]STATUS: heartbeat\n\n\`\`\`room-claim\ntask-id:    RC-2026-09-27-810\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     still working\n\`\`\``),
  ], "2026-09-27T09:00:00Z");
  const res = claimStatus(["--task-id", "RC-2026-09-27-810", "--state", sf]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const f = fieldLines(res.stdout);
  assert.equal(f.last_heartbeat, "2026-09-27T08:00:00Z");
  // heartbeat renews the lease: 08:00 + 6h
  assert.equal(f.lease_expires_at, "2026-09-27T14:00:00Z");
});

test("claim-status reports an open strike-one", () => {
  const sf = stateFileOf([
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-820", "scripts/room"),
    C(2, "2026-09-27T12:30:00Z",
      `[quill]RECLAIM (strike 1): @jill lease expired, no heartbeat seen\n\n<!-- room:strike-one:RC-2026-09-27-820:2026-09-27T12:30:00Z -->\n`),
  ], "2026-09-27T13:00:00Z");
  const res = claimStatus(["--task-id", "RC-2026-09-27-820", "--state", sf]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const f = fieldLines(res.stdout);
  assert.match(f.open_strikes, /^strike-one at /);
  // strike-one does not move the files: the claim is still live
  assert.equal(f.state, "working");
  assert.equal(f.lane, "jill");
});

test("claim-status exits 1 on an unknown task-id", () => {
  const sf = stateFileOf([
    claim(1, "2026-09-27T06:00:00Z", "jill", "RC-2026-09-27-800", "scripts/room"),
  ], "2026-09-27T07:00:00Z");
  const res = claimStatus(["--task-id", "RC-2026-09-27-999", "--state", sf]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown task-id RC-2026-09-27-999/);
});

test("claim-status exits 1 when --task-id is missing", () => {
  const res = claimStatus([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--task-id required/);
});
