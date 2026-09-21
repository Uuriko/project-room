import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const roomScript = join(checkout, "scripts/room");

function sh(cmd, cwd, env) {
  const res = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    timeout: 60000,
    cwd,
    env: { ...process.env, ...(env || {}) },
  });
  assert.equal(res.status, 0, `command failed: ${cmd}\nSTDERR: ${res.stderr}\nSTDOUT: ${res.stdout}`);
  return res.stdout;
}

// Scratch remote + clone with the CURRENT scripts/room committed on main.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "room-guard-"));
  const origin = join(dir, "origin.git");
  const wt = join(dir, "wt");
  sh(`git init --bare -q "${origin}"`);
  sh(`git clone -q "${origin}" "${wt}"`);
  sh(`git -C "${wt}" checkout -qb main`);
  sh(`mkdir -p "${wt}/scripts"`);
  sh(`cp "${roomScript}" "${wt}/scripts/room"`);
  sh(`git -C "${wt}" add scripts/room`);
  sh(`git -C "${wt}" -c user.name=t -c user.email=t@t commit -qm "seed canonical scripts/room"`);
  sh(`git -C "${wt}" push -q origin main`);
  return { dir, origin, wt };
}

// Driver: builds a bash -c body that sources scripts/room minus its
// `main "$@"` dispatch, then runs the freshness guard for the given verb.
// argv0 is set to the worktree's scripts/room so $0 matches production,
// where the script is executed directly.
function guardDriver(wt, verb, extraEnv) {
  const d = join(wt, "guard-driver.src.sh");
  const body = [
    "set -euo pipefail",
    `grep -vF 'main "$@"' "${join(wt, "scripts/room")}" > "${d}"`,
    `. "${d}"`,
    `cd "${wt}"`,
    `guard_enforcer_freshness "${verb}"`,
  ].join("\n");
  const res = spawnSync("bash", ["-c", body], {
    encoding: "utf8",
    timeout: 60000,
    argv0: join(wt, "scripts/room"),
    env: { ...process.env, ...(extraEnv || {}) },
  });
  return res;
}

test("enforcer freshness guard: canonical copy passes", () => {
  const { dir, wt } = scratch();
  try {
    const res = guardDriver(wt, "sweep");
    assert.equal(res.status, 0, `guard should pass on canonical copy\nSTDERR: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforcer freshness guard: stale copy fails closed", () => {
  const { dir, wt } = scratch();
  try {
    appendFileSync(join(wt, "scripts/room"), "\n# stale-copy marker\n");
    const res = guardDriver(wt, "sweep");
    assert.equal(res.status, 1, "guard must refuse a stale copy");
    assert.match(res.stderr, /refusing sweep: stale/, `stderr should name the stale refusal, got: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforcer freshness guard: missing origin/main ref fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-guard-"));
  try {
    sh(`git init -qb main "${dir}/wt"`);
    sh(`mkdir -p "${dir}/wt/scripts"`);
    sh(`cp "${roomScript}" "${dir}/wt/scripts/room"`);
    const res = guardDriver(join(dir, "wt"), "metrics");
    assert.equal(res.status, 1, "guard must refuse without origin/main");
    assert.match(res.stderr, /cannot locate origin\/main/, `stderr should name the missing ref, got: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforcer freshness guard: ROOM_ENFORCER_ALLOW_STALE=1 bypasses", () => {
  const { dir, wt } = scratch();
  try {
    appendFileSync(join(wt, "scripts/room"), "\n# stale-copy marker\n");
    const res = guardDriver(wt, "sweep", { ROOM_ENFORCER_ALLOW_STALE: "1" });
    assert.equal(res.status, 0, `escape hatch should bypass the guard\nSTDERR: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforcer freshness guard: full dispatch refuses a stale copy before any network", () => {
  const { dir, wt } = scratch();
  try {
    const stale = join(wt, "scripts/room");
    appendFileSync(stale, "\n# stale-copy marker\n");
    const res = spawnSync(stale, ["sweep", "--dry-run"], {
      encoding: "utf8",
      timeout: 60000,
      cwd: wt,
    });
    assert.equal(res.status, 1, "dispatch must refuse a stale copy");
    assert.match(res.stderr, /refusing sweep: stale/, `stderr should name the stale refusal, got: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
