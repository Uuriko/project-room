// Shared harness for tests/qa2: boots a throwaway local Room server and runs a
// scripts/qa2 checker against it. Skipped unless QA2_E2E=1 (these are slower
// end-to-end checks; the qa2-agent-eval workflow sets it).
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const enabled = process.env.QA2_E2E === "1";

export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "qa2-"));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ROOM_DB: join(dir, "room.sqlite"), ROOM_INSTANCE_LOCK_PATH: join(dir, "lock") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${origin}/api/health`); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    await new Promise(r => setTimeout(r, 200));
  }
  return { origin, stop: () => { child.kill("SIGTERM"); rmSync(dir, { recursive: true, force: true }); }, log: () => log };
}

// Runs node scripts/qa2/<script> with args plus --json <tmp>; resolves { code, stdout, report }.
export function runChecker(script, args, { timeout = 15 * 60_000 } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "qa2-out-")), "report.json");
  return new Promise(resolve => {
    execFile(process.execPath, [join(ROOT, "scripts/qa2", script), ...args, "--json", out], { cwd: ROOT, timeout, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      let report = null; try { report = JSON.parse(readFileSync(out, "utf8")); } catch {}
      resolve({ code: error?.code ?? 0, stdout: `${stdout}${stderr}`, report });
    });
  });
}
