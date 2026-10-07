// tests/shed-install.test.js — installer contracts for the Project Room shed.
//
// Authoring gate answers:
// 1. Protects: (a) --dry-run is pure — it prints every step and touches
//    nothing; (b) the installer fails closed before installing anything when
//    the saved connection is rejected; (c) re-running never overwrites an
//    existing shed.env (idempotency / no clobbering).
// 2. Credible regressions: an unwrapped mkdir/write added to the dry-run path
//    (the STATE_DIR mkdir was exactly this before the 2026-10-04 hardening);
//    the env-file "keep existing" guard dropped; validation moved after the
//    service install.
// 3. Existing coverage: none — no test executes shed/install.sh. The contract
//    gate only syntax-checks it.
// 4. Production seams: none. The tests shell out to the real script with a
//    stubbed HOME/SHED_DIR/PATH. The external commands (node, git, systemctl)
//    are OS environment, stubbed via PATH the way any installer test must.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(root, "shed", "install.sh");

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "shed-install-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A connection directory the installer will accept as present (0700 dir,
// 0600 connection.json). The origin is unroutable-by-port on purpose: real
// node validation fails fast with "connection refused".
function fakeConn(t, dir) {
  const connDir = join(dir, "conn");
  mkdirSync(connDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(connDir, "connection.json"), JSON.stringify({
    version: 1,
    origin: "http://127.0.0.1:1",
    roomId: "test-room-1",
    memberId: "ai_testmember1",
    token: "rak_0123456789abcdef",
  }) + "\n", { mode: 0o600 });
  return connDir;
}

// A shed dir whose repo step resolves without network: the installer sees
// .git (already cloned) and a shed-loop.mjs, so it never clones.
function fakeRepo(shedDir) {
  const repoDir = join(shedDir, "repo");
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(join(repoDir, "shed"), { recursive: true });
  writeFileSync(join(repoDir, "shed", "shed-loop.mjs"), "// stub\n");
  writeFileSync(join(repoDir, "shed", "project-room-shed.service"),
    "[Service]\nEnvironmentFile=@ENV_FILE@\nExecStart=/usr/bin/env node @REPO_DIR@/shed/shed-loop.mjs\n");
  return repoDir;
}

function runInstaller({ home, shedDir, connDir, pathExtra = "", dryRun = false, stdinClosed = true }) {
  const args = [installer];
  if (dryRun) args.push("--dry-run");
  args.push("--dir", shedDir);
  const env = {
    ...process.env,
    HOME: home,
    SHED_DIR: shedDir,
    ROOM_AGENT_CONFIG: connDir,
    PATH: pathExtra ? `${pathExtra}:${process.env.PATH}` : process.env.PATH,
  };
  const result = spawnSync("bash", args, {
    env,
    input: stdinClosed ? "" : undefined,
    encoding: "utf8",
    timeout: 60000,
  });
  return result;
}

test("shed installer --dry-run is pure: prints steps, touches nothing", t => {
  const dir = scratch(t);
  const home = join(dir, "home");
  const shedDir = join(dir, "shed");
  mkdirSync(home, { recursive: true });
  const connDir = fakeConn(t, dir);
  fakeRepo(shedDir);

  const result = runInstaller({ home, shedDir, connDir, dryRun: true });

  assert.equal(result.status, 0, `dry-run exits 0 (stderr: ${result.stderr})`);
  assert.match(result.stdout, /\[dry-run\]/, "dry-run markers printed");
  assert.match(result.stdout, /shed\.env/, "env step described");

  // Purity: nothing created anywhere.
  assert.deepEqual(readdirSync(home), [], "temp HOME untouched");
  assert.deepEqual(readdirSync(shedDir).sort(), ["repo"], "only the pre-stubbed repo exists; no shed.env, no state dir");
});

test("shed installer fails closed on a rejected connection: installs nothing", t => {
  const dir = scratch(t);
  const home = join(dir, "home");
  const shedDir = join(dir, "shed");
  mkdirSync(home, { recursive: true });
  // Real node runs the real client validation against an origin that refuses
  // connections: the installer must bail before writing config or services.
  const connDir = fakeConn(t, dir);
  fakeRepo(shedDir);

  const result = runInstaller({ home, shedDir, connDir, dryRun: false });

  assert.notEqual(result.status, 0, "exits non-zero on rejected connection");
  assert.match(result.stdout + result.stderr, /rejected|no connection|connection/i, "says why");
  assert.deepEqual(readdirSync(home), [], "no systemd unit installed in HOME");
  assert.ok(!existsSync(join(shedDir, "shed.env")), "no shed.env written");
  assert.deepEqual(readdirSync(shedDir).sort(), ["repo"], "nothing else written to the shed dir");
});

test("shed installer re-run keeps an existing shed.env and re-enables the service", t => {
  const dir = scratch(t);
  const home = join(dir, "home");
  const shedDir = join(dir, "shed");
  mkdirSync(home, { recursive: true });
  const connDir = fakeConn(t, dir);
  // Symlink the repo step at the real checkout so the unit template exists.
  const repoDir = join(shedDir, "repo");
  mkdirSync(shedDir, { recursive: true });
  symlinkSync(root, repoDir);

  // Pre-existing env file with a sentinel the installer must not clobber.
  const envFile = join(shedDir, "shed.env");
  const sentinel = "SHED_AGENT_CMD=sentinel-do-not-clobber\nSHED_POLL_SECS=60\nSHED_EXEC_TIMEOUT_SECS=600\n";
  writeFileSync(envFile, sentinel, { mode: 0o600 });

  // This owner exercises Linux systemd service re-enablement on every host.
  // Stub uname alongside node, git and systemctl so Darwin never starts launchd.
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const ctlLog = join(dir, "systemctl.log");
  writeFileSync(join(binDir, "node"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(binDir, "git"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(binDir, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n", { mode: 0o755 });
  writeFileSync(join(binDir, "systemctl"), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(ctlLog)}\nexit 0\n`, { mode: 0o755 });

  const result = runInstaller({ home, shedDir, connDir, pathExtra: binDir });

  assert.equal(result.status, 0, `install exits 0 (stderr: ${result.stderr})`);
  assert.equal(readFileSync(envFile, "utf8"), sentinel, "existing shed.env byte-identical, not clobbered");
  const unitFile = join(home, ".config", "systemd", "user", "project-room-shed.service");
  assert.ok(existsSync(unitFile), "systemd unit (re)rendered");
  const unit = readFileSync(unitFile, "utf8");
  assert.match(unit, new RegExp(`EnvironmentFile=${shedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/shed\\.env`),
    "unit points at the shed env file");
  const ctlCalls = readFileSync(ctlLog, "utf8");
  assert.match(ctlCalls, /enable --now project-room-shed\.service/, "service enabled");
});
