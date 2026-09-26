import { spawn } from "node:child_process";
import { isAbsolute, dirname, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";

export const validHostCommand = config => config && isAbsolute(config.command ?? "")
  && Array.isArray(config.args) && config.args.every(arg => typeof arg === "string")
  && Number.isInteger(config.timeoutMs) && config.timeoutMs >= 100 && config.timeoutMs <= 3600000;

// No shell, no inherited credentials, bounded output and process-group lifetime.
// A nonzero exit is an observation; startup, timeout and cancellation are errors.
// The automated host is untrusted code. A missing sandbox must fail before
// spawning it, rather than silently degrading to an ordinary local process.
const BWRAP = "/usr/bin/bwrap";
export function isolatedHostCommand(config, cwd) {
  if (!existsSync(BWRAP) || !isAbsolute(cwd ?? "")) throw new Error("Host isolation is unavailable");
  const root = realpathSync(cwd), executable = realpathSync(config.command);
  if (config.env && Object.keys(config.env).length)
    throw new Error("Automatic host policy refuses configured environment variables; use a brokered, reviewed tool path");
  if (root === "/" || root === "/usr" || root.startsWith("/usr/") || !root.startsWith("/home/") && !root.startsWith("/tmp/"))
    throw new Error("Host checkout must be a private workspace under /home or /tmp");
  if (!executable.startsWith("/usr/") && !executable.startsWith(root + sep))
    throw new Error("Host executable must be system-provided or inside the checkout");
  // Parent mount points are empty directories. Only the checkout is writable.
  const parents = [];
  for (let parent = dirname(root); parent !== "/"; parent = dirname(parent)) parents.unshift(parent);
  const args = ["--die-with-parent", "--unshare-all", "--new-session", "--clearenv",
    "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...parents.flatMap(parent => ["--dir", parent]), "--bind", root, root,
    "--chdir", root, "--", executable, ...config.args];
  return { command: BWRAP, args };
}

export function hostSubprocess(config, { cwd, env, signal, input = "", maxBytes = 32768, isolate = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Host cancelled")); return; }
    const grouped = process.platform !== "win32";
    let child;
    try {
      const target = isolate ? isolatedHostCommand(config, cwd) : config;
      const selectedEnv = isolate ? {} : env;
      child = spawn(target.command, target.args, { cwd, env: selectedEnv, shell: false, detached: grouped, stdio: [input.length ? "pipe" : "ignore", "pipe", "pipe"] });
    }
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
    child.stdin?.on("error", () => stop("Host input failed; reconcile the original attempt"));
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
    child.stdin?.end(input);
  });
}
