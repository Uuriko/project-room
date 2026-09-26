// S1 live file/region claim registry (software-factory brief 2026-09-26).
//
// Contracts under test:
// 1. `scripts/room rebuild` renders `## file-claims` — an inverted index
//    (file -> lane -> task-id -> state) over live claims only.
// 2. `scripts/room rebuild` renders `## overlap-warnings` — every file
//    held by 2+ live claims, `(none)` when clean.
// 3. `scripts/room overlaps` (read-only) reports live holders for
//    --files, `(unclaimed)` for free files, and all overlaps without
//    --files. Closed claims never appear.
//
// Authoring-gate answers:
// 1. Observable behavior: the machine board's file-claim map and the
//    pre-claim overlap check lanes rely on to avoid rebase churn.
// 2. Credible regression: a render_md edit drops the sections or the
//    overlaps verb stops filtering closed claims — lanes would claim
//    blind and collide.
// 3. No existing coverage: these sections and this verb are new in this
//    change; claim-collisions.test.js covers the pure server module, not
//    the board render or the CLI verb.
// 4. No production seam: tests drive the real scripts/room via the same
//    source-minus-dispatch pattern as room-rebuild.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const roomScript = join(checkout, "scripts/room");

// Source scripts/room without its `main "$@"` dispatch, then eval a snippet
// that calls render_md or cmd_overlaps against synthetic state.
function runSnippet(stateJson, snippet) {
  const dir = mkdtempSync(join(tmpdir(), "claim-map-"));
  try {
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify(stateJson));
    const driver = join(dir, "driver.sh");
    writeFileSync(driver, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `grep -vF 'main "$@"' "${roomScript}" > "${dir}/room-src.sh"`,
      `. "${dir}/room-src.sh"`,
      `STATE_JSON=$(cat "${statePath}")`,
      snippet,
    ].join("\n") + "\n");
    const res = spawnSync("bash", [driver], { encoding: "utf8", timeout: 60000 });
    assert.equal(res.status, 0, `driver failed\nSTDERR: ${res.stderr}\nSTDOUT: ${res.stdout}`);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const task = (task_id, lane, state, files) => ({
  task_id, lane, state, files,
  lease_expires_at: "2026-09-27T00:00:00Z",
  receipts: [],
});

const board = (tasks) => ({
  tasks: Object.fromEntries(tasks.map(t => [t.task_id, t])),
  unleased_prose_claims: [],
  prose_receipts: [],
  comments: 100,
  watermark: 123,
  generated_at: "2026-09-26T00:00:00Z",
});

function renderBoard(stateJson) {
  return runSnippet(stateJson, `
    now=$(date +%s)
    printf '%s' "$STATE_JSON" | render_md "$now" "[]" "active"
  `);
}

function overlaps(stateJson, args) {
  return runSnippet(stateJson, `
    state_file=$(mktemp)
    printf '%s' "$STATE_JSON" > "$state_file"
    cmd_overlaps --state "$state_file" ${args}
    rm -f "$state_file"
  `);
}

function section(output, name) {
  const lines = output.split("\n");
  const start = lines.findIndex(l => l === `## ${name}`);
  assert.ok(start >= 0, `missing ## ${name} section`);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i] !== "" && !lines[i].startsWith("## "); i++) {
    rows.push(lines[i]);
  }
  return rows;
}

test("file-claims renders one row per file per live claim, sorted", () => {
  const out = renderBoard(board([
    task("RC-2026-09-26-002", "instinct", "submitted", ["server/b.mjs", "server/c.mjs"]),
    task("RC-2026-09-26-001", "jill", "working", ["server/a.mjs", "server/b.mjs"]),
  ]));
  assert.deepEqual(section(out, "file-claims"), [
    "server/a.mjs | jill | RC-2026-09-26-001 | working",
    "server/b.mjs | jill | RC-2026-09-26-001 | working",
    "server/b.mjs | instinct | RC-2026-09-26-002 | submitted",
    "server/c.mjs | instinct | RC-2026-09-26-002 | submitted",
  ]);
});

test("overlap-warnings flags files held by 2+ live claims", () => {
  const out = renderBoard(board([
    task("RC-2026-09-26-001", "jill", "working", ["server/a.mjs", "server/b.mjs"]),
    task("RC-2026-09-26-002", "instinct", "submitted", ["server/b.mjs"]),
  ]));
  assert.deepEqual(section(out, "overlap-warnings"), [
    "server/b.mjs | instinct, jill | RC-2026-09-26-001, RC-2026-09-26-002",
  ]);
});

test("overlap-warnings renders (none) when no live overlaps", () => {
  const out = renderBoard(board([
    task("RC-2026-09-26-001", "jill", "working", ["server/a.mjs"]),
    task("RC-2026-09-26-002", "instinct", "submitted", ["server/b.mjs"]),
  ]));
  assert.deepEqual(section(out, "overlap-warnings"), ["(none)"]);
});

test("closed claims release their files from the registry", () => {
  const out = renderBoard(board([
    task("RC-2026-09-26-001", "jill", "completed", ["server/a.mjs"]),
    task("RC-2026-09-26-002", "instinct", "working", ["server/a.mjs"]),
  ]));
  // Only the live claim's row appears; no overlap (completed claim ignored).
  assert.deepEqual(section(out, "file-claims"), [
    "server/a.mjs | instinct | RC-2026-09-26-002 | working",
  ]);
  assert.deepEqual(section(out, "overlap-warnings"), ["(none)"]);
});

test("signals line carries files_claimed and overlap_files", () => {
  const out = renderBoard(board([
    task("RC-2026-09-26-001", "jill", "working", ["server/a.mjs", "server/b.mjs"]),
    task("RC-2026-09-26-002", "instinct", "submitted", ["server/b.mjs", "server/c.mjs"]),
  ]));
  const signals = out.split("\n").find(l => l.startsWith("board_comments="));
  assert.ok(signals.includes("files_claimed=3"), `missing files_claimed: ${signals}`);
  assert.ok(signals.includes("overlap_files=1"), `missing overlap_files: ${signals}`);
});

test("overlaps --files reports live holders and (unclaimed) files", () => {
  const st = board([
    task("RC-2026-09-26-001", "jill", "working", ["server/a.mjs"]),
  ]);
  const out = overlaps(st, `--files "server/a.mjs,server/free.mjs"`);
  assert.ok(out.includes("server/a.mjs | jill | RC-2026-09-26-001"), out);
  assert.ok(out.includes("server/free.mjs | (unclaimed)"), out);
});

test("overlaps without --files reports all live overlaps", () => {
  const st = board([
    task("RC-2026-09-26-001", "jill", "working", ["server/shared.mjs"]),
    task("RC-2026-09-26-002", "grokbot", "submitted", ["server/shared.mjs", "server/only-b.mjs"]),
  ]);
  const out = overlaps(st, "");
  assert.ok(out.includes("server/shared.mjs | grokbot, jill | RC-2026-09-26-001, RC-2026-09-26-002"), out);
  assert.ok(!out.includes("server/only-b.mjs"), `non-overlapping file leaked: ${out}`);
});

test("overlaps ignores closed claims", () => {
  const st = board([
    task("RC-2026-09-26-001", "jill", "completed", ["server/done.mjs"]),
  ]);
  const out = overlaps(st, `--files "server/done.mjs"`);
  assert.ok(out.includes("server/done.mjs | (unclaimed)"), out);
});
