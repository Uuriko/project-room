import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const roomScript = join(checkout, "scripts/room");

function sh(cmd, cwd) {
  const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 60000, cwd });
  assert.equal(res.status, 0, `command failed: ${cmd}\nSTDERR: ${res.stderr}\nSTDOUT: ${res.stdout}`);
  return res.stdout;
}

// Scratch remote + clone with ROOM-STATE.md seeded on main.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "room-rebuild-"));
  const origin = join(dir, "origin.git");
  const wt = join(dir, "wt");
  sh(`git init --bare -q "${origin}"`);
  sh(`git clone -q "${origin}" "${wt}"`);
  sh(`git -C "${wt}" checkout -qb main`);
  writeFileSync(join(wt, "ROOM-STATE.md"), "seed board\n");
  sh(`git -C "${wt}" add ROOM-STATE.md`);
  sh(`git -C "${wt}" -c user.name=t -c user.email=t@t commit -qm "seed board"`);
  sh(`git -C "${wt}" push -q origin main`);
  return { dir, origin, wt };
}

// Driver: sources scripts/room minus its `main "$@"` dispatch, then runs
// rebuild_commit_push against the scratch clone.
function driver(wt, outAbs) {
  const d = join(wt, "driver.sh");
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `grep -vF 'main "$@"' "${roomScript}" > "${d}.src"`,
    `. "${d}.src"`,
    `cd "${wt}"`,
    `rebuild_commit_push "${outAbs}"`,
  ];
  writeFileSync(d, lines.join("\n") + "\n");
  return d;
}

function runDriver(d) {
  const res = spawnSync("bash", [d], { encoding: "utf8", timeout: 60000 });
  assert.equal(res.status, 0, `rebuild_commit_push failed (exit ${res.status})\nSTDERR: ${res.stderr}\nSTDOUT: ${res.stdout}`);
  return res.stdout;
}

test("rebuild --commit-push survives a dirty ROOM-STATE.md on main", () => {
  const { dir, origin, wt } = scratch();
  try {
    // origin/room-state exists with a DIFFERENT board than main's seed
    // (the normal watcher steady state: each tick pushes a new board).
    sh(`git -C "${wt}" checkout -qb room-state`);
    writeFileSync(join(wt, "ROOM-STATE.md"), "previous tick board\n");
    sh(`git -C "${wt}" add ROOM-STATE.md`);
    sh(`git -C "${wt}" -c user.name=t -c user.email=t@t commit -qm "previous tick"`);
    sh(`git -C "${wt}" push -q origin room-state`);
    sh(`git -C "${wt}" checkout -q main`);
    // Simulate cmd_rebuild having just written a fresh board: worktree dirty on main.
    const want = `fresh board ${Date.now()}`;
    writeFileSync(join(wt, "ROOM-STATE.md"), want + "\n");
    const out = runDriver(driver(wt, join(wt, "ROOM-STATE.md")));
    assert.match(out, /pushed room-state branch/);
    // The pushed board is the fresh content, not the stale seed.
    const pushed = sh(`git --git-dir="${origin}" show room-state:ROOM-STATE.md`).trim();
    assert.equal(pushed, want);
    // Back on the starting branch.
    const branch = sh(`git -C "${wt}" rev-parse --abbrev-ref HEAD`).trim();
    assert.equal(branch, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild --commit-push is a no-op when the board is unchanged", () => {
  const { dir, wt } = scratch();
  try {
    sh(`git -C "${wt}" checkout -qb room-state`);
    sh(`git -C "${wt}" push -q origin room-state`);
    sh(`git -C "${wt}" checkout -q main`);
    const out = runDriver(driver(wt, join(wt, "ROOM-STATE.md")));
    assert.match(out, /unchanged; nothing to push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Full-verb driver for issue #834: sources scripts/room minus its main
// dispatch, stubs the board-reading pipeline (no network), then runs the
// REAL cmd_rebuild with a RELATIVE in-repo --out from the repo root — the
// exact scenario that used to abort on a same-file cp before the commit.
function rebuildVerbDriver(wt) {
  const d = join(wt, "rebuild-verb-driver.sh");
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `grep -vF 'main "$@"' "${roomScript}" > "${d}.src"`,
    `. "${d}.src"`,
    `build_state() { printf '{"tasks":{},"unleased_prose_claims":[],"prose_receipts":[],"comments":0,"generated_at":"2026-10-07T00:00:00Z","watermark":1}'; }`,
    `registry_json() { printf '[]'; }`,
    `lease_now() { printf '1790000000'; }`,
    `cd "${wt}"`,
    `cmd_rebuild --out ROOM-STATE.md --commit-push`,
  ];
  writeFileSync(d, lines.join("\n") + "\n");
  return d;
}

test("rebuild --out <in-repo relative path> --commit-push commits and pushes (issue #834)", () => {
  const { dir, origin, wt } = scratch();
  try {
    // Steady state: room-state exists with an older board; main is the
    // starting branch with a tracked (clean) ROOM-STATE.md.
    sh(`git -C "${wt}" checkout -qb room-state`);
    writeFileSync(join(wt, "ROOM-STATE.md"), "previous tick board\n");
    sh(`git -C "${wt}" add ROOM-STATE.md`);
    sh(`git -C "${wt}" -c user.name=t -c user.email=t@t commit -qm "previous tick"`);
    sh(`git -C "${wt}" push -q origin room-state`);
    sh(`git -C "${wt}" checkout -q main`);
    const out = runDriver(rebuildVerbDriver(wt));
    // The write happened and the commit step ran instead of aborting.
    assert.match(out, /wrote ROOM-STATE\.md/);
    assert.match(out, /pushed room-state branch/);
    // The pushed board is the freshly rebuilt one, not the stale tick.
    const pushed = sh(`git --git-dir="${origin}" show room-state:ROOM-STATE.md`);
    assert.match(pushed, /# ROOM-STATE — machine board/);
    assert.match(pushed, /integrity: sha256=/);
    assert.doesNotMatch(pushed, /^previous tick board$/m);
    // The verb restored the starting branch.
    const branch = sh(`git -C "${wt}" rev-parse --abbrev-ref HEAD`).trim();
    assert.equal(branch, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuild --commit-push creates room-state from main when the branch is new", () => {
  const { dir, origin, wt } = scratch();
  try {
    // No origin/room-state yet (first-ever watcher tick).
    const want = `first board ${Date.now()}`;
    writeFileSync(join(wt, "ROOM-STATE.md"), want + "\n");
    const out = runDriver(driver(wt, join(wt, "ROOM-STATE.md")));
    assert.match(out, /pushed room-state branch/);
    const pushed = sh(`git --git-dir="${origin}" show room-state:ROOM-STATE.md`).trim();
    assert.equal(pushed, want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
