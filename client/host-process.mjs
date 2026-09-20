import { hostReplyBody } from "./host-result.mjs";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export function configuredHost(config) {
  if (!config || !isAbsolute(config.command ?? "") || !isAbsolute(config.cwd ?? "")
    || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string")
    || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 3600000
    || config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env)
      || Object.entries(config.env).some(([key, value]) => typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))))
    throw new Error("Host configuration requires absolute command/cwd, argument array and timeoutMs (100–3600000)");
  const settings = structuredClone(config);
  return ({ signal, ...input }) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Host cancelled")); return; }
    // Reject unusable input before starting a host that may have side effects.
    let payload;
    try { payload = JSON.stringify(input); }
    catch { reject(new Error("Host input must be JSON serializable")); return; }
    let lock;
    try {
      const directory = join(homedir(), ".project-room", "host-locks");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      lock = join(directory, createHash("sha256").update(realpathSync(settings.cwd)).digest("hex"));
      mkdirSync(lock, { mode: 0o700 });
    } catch { reject(new Error("Checkout has an active or unresolved host, or its lock is unavailable; reconcile before running")); return; }
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, settings.env ?? {});
    const grouped = process.platform !== "win32";
    let child;
    try { child = spawn(settings.command, settings.args, { cwd: settings.cwd, env,
      shell: false, detached: grouped, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { rmdirSync(lock); reject(new Error("Host could not start; inspect its configuration")); return; }
    let failure = null, size = 0; const chunks = [];
    const stop = message => {
      failure ??= message;
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const abort = () => stop("Host cancelled; reconcile the original attempt");
    const timer = setTimeout(() => stop("Host timed out; reconcile the original attempt"), settings.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => { failure ??= "Host could not start; inspect its configuration"; });
    child.stdin.on("error", () => stop("Host input failed; reconcile the original attempt"));
    child.stderr.resume(); // Diagnostics may contain secrets. Never echo them.
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 32768) stop("Host output exceeded 32 KiB; reconcile the original attempt");
      else chunks.push(chunk);
    });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      // A clean exit can still leave detached children behind. On POSIX,
      // retire the original process group before releasing checkout ownership.
      if (grouped && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ } }
      try { rmdirSync(lock); } catch { /* leave an unresolved lock intact */ }
      if (failure || code !== 0) { reject(new Error(failure ?? "Host exited unsuccessfully; reconcile the original attempt")); return; }
      try {
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        hostReplyBody(result);
        resolve(result);
      } catch { reject(new Error("Host must return one JSON object with body and optional valid codeResult, totaling at most 4096 reply characters")); }
    });
    child.stdin.end(payload);
  });
}
