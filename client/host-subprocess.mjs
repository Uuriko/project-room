import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export const validHostCommand = config => config && isAbsolute(config.command ?? "")
  && Array.isArray(config.args) && config.args.every(arg => typeof arg === "string")
  && Number.isInteger(config.timeoutMs) && config.timeoutMs >= 100 && config.timeoutMs <= 3600000;

// No shell, no inherited credentials, bounded output and process-group lifetime.
// A nonzero exit is an observation; startup, timeout and cancellation are errors.
export function hostSubprocess(config, { cwd, env, signal, input = "", maxBytes = 32768 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Host cancelled")); return; }
    const grouped = process.platform !== "win32";
    let child;
    try { child = spawn(config.command, config.args, { cwd, env, shell: false, detached: grouped, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(new Error("Host could not start; inspect its configuration")); return; }
    let failure = null, size = 0; const chunks = [];
    const kill = () => {
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const stop = message => { failure ??= message; kill(); };
    const abort = () => stop("Host cancelled; reconcile the original attempt");
    const timer = setTimeout(() => stop("Host timed out; reconcile the original attempt"), config.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => { failure ??= "Host could not start; inspect its configuration"; });
    child.stdin.on("error", () => stop("Host input failed; reconcile the original attempt"));
    child.stderr.resume(); // Never disclose diagnostics; they may contain secrets.
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) stop(`Host output exceeded ${maxBytes / 1024} KiB; reconcile the original attempt`);
      else chunks.push(chunk);
    });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); kill();
      if (failure || code === null) reject(new Error(failure ?? "Host exited unsuccessfully; reconcile the original attempt"));
      else resolve({ stdout: Buffer.concat(chunks), exitCode: code });
    });
    child.stdin.end(input);
  });
}
