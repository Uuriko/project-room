// Setup diagnostic only: a fixed --version probe may expose sandbox startup
// diagnostics. Actual untrusted host stderr remains suppressed by the adapter.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isolatedHostCommand } from "../client/host-subprocess.mjs";

try {
  const command = isolatedHostCommand({ command: process.execPath, args: ["--version"] }, process.cwd());
  const result = spawnSync(command.command, command.args, { env: {}, encoding: "utf8", timeout: 10000 });
  if (result.status !== 0 || result.error) {
    console.error("Automatic host isolation is unavailable. Linux bubblewrap must support mount, user, and network namespaces; no unsandboxed fallback is allowed.");
    console.error(result.stderr || result.error?.code || "Sandbox probe did not exit successfully.");
    for (const name of ["unprivileged_userns_clone", "apparmor_restrict_unprivileged_userns"]) {
      try { console.error(`${name}=${readFileSync(`/proc/sys/kernel/${name}`, "utf8").trim()}`); }
      catch { console.error(`${name}=unavailable`); }
    }
    process.exitCode = 1;
  } else {
    console.log("Isolated host namespace probe passed:", result.stdout.trim());
  }
} catch {
  console.error("Automatic host isolation is unavailable. Run on a supported Linux workspace with /usr/bin/bwrap; no unsandboxed fallback is allowed.");
  process.exitCode = 1;
}
