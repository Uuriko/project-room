import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
function fixture(t, hanging) {
  const dir = mkdtempSync(join(tmpdir(), "gh-read-deadline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = hanging
    ? 'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.env.GH_READY_FILE, "ready"); setInterval(() => {}, 1000);'
    : 'const path = process.argv[3]; console.log(path.endsWith("/protection") ? JSON.stringify({required_status_checks:{checks:[]}}) : path === "repos/Uuriko/project-room" ? JSON.stringify({default_branch:"main"}) : "[]");';
  writeFileSync(join(dir, "gh"), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_READY_FILE: join(dir, "ready") } };
}
const scripts = [
  ["claims-index.mjs", 3],
  ["merge-queue-dryrun.mjs", 2],
];
for (const [script, failure] of scripts) {
  test(`${script} kills a stalled gh even when it ignores SIGTERM`, t => {
    const f = fixture(t, true);
    const result = spawnSync(process.execPath, [join(root, "scripts", script), "--gh-timeout-ms", "500", "--out", join(f.dir, "out")], {
      env: f.env, encoding: "utf8", timeout: 2500, killSignal: "SIGKILL",
    });
    assert.equal(result.error, undefined, "the script must stop itself before the outer safety deadline");
    assert.equal(result.status, failure);
    assert.equal(existsSync(join(f.dir, "ready")), true, `fake gh installed its SIGTERM handler before the deadline: ${result.stderr}`);
    assert.match(result.stderr, /timed out after 500ms/);
    assert.equal(existsSync(join(f.dir, "out", "claims-index.json")), false);
    assert.doesNotMatch(result.stdout, /READY|summary:|claims-index: wrote/);
  });
  test(`${script} keeps healthy read-only results`, t => {
    const f = fixture(t, false);
    const result = spawnSync(process.execPath, [join(root, "scripts", script), "--gh-timeout-ms", "1000", "--out", join(f.dir, "out")], {
      env: f.env, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, script === "claims-index.mjs" ? /0 comments/ : /Queue is empty/);
  });
  test(`${script} refuses an invalid deadline before gh runs`, t => {
    const f = fixture(t, true);
    const result = spawnSync(process.execPath, [join(root, "scripts", script), "--gh-timeout-ms", "0"], { env: f.env, encoding: "utf8", timeout: 2500, killSignal: "SIGKILL" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /positive integer/);
  });
}
