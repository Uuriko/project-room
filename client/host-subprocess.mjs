import { spawn, spawnSync } from "node:child_process";
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
// Probe the same isolation launcher before a caller accepts Room work. The
// probe runs only a system no-op, never the configured untrusted executable.
export function hostExecutionReadiness(config, { platform = process.platform, exists = existsSync,
  build = isolatedHostCommand, launch = spawnSync } = {}) {
  const base = { version: 1, backend: "linux-bwrap", platform, ready: false };
  const refused = (code, message) => ({ ...base, code, message });
  if (platform !== "linux") return refused("unsupported_platform", "The generic command host requires Linux. Use a qualified native Codex host or an explicitly selected Linux worker.");
  if (!exists(BWRAP)) return refused("sandbox_missing", "Install Linux bubblewrap before accepting generic host work.");
  if (!validHostCommand(config) || !isAbsolute(config.cwd ?? "")) return refused("configuration_invalid", "Host executable, arguments, timeout and absolute workspace must be configured.");
  let target;
  try { target = build(config, config.cwd); }
  catch { return refused("configuration_invalid", "Host configuration does not satisfy the isolated workspace and executable policy."); }
  const separator = target.args.indexOf("--");
  if (separator < 0) return refused("configuration_invalid", "Sandbox launcher has no command boundary.");
  let result;
  try { result = launch(target.command, [...target.args.slice(0, separator + 1), "/usr/bin/true"],
    { cwd: config.cwd, env: {}, shell: false, stdio: "ignore", timeout: 3000, killSignal: "SIGKILL" }); }
  catch { return refused("sandbox_probe_failed", "The sandbox could not start. Check Linux namespace support and launcher permissions."); }
  if (result.error || result.signal || result.status !== 0)
    return refused("sandbox_probe_failed", "The sandbox could not complete its startup probe. Check Linux namespace support and launcher permissions.");
  return { ...base, ready: true, code: "ready", message: "Linux sandbox startup probe passed.",
    guarantees: { workspaceWrite: true, network: "none", ambientSecrets: "none" },
    modelExecuted: false };
}

export function isolatedHostCommand(config, cwd) {
  if (config.env && Object.keys(config.env).length)
    throw new Error("Automatic host policy refuses configured environment variables; use a brokered, reviewed tool path");
  if (!existsSync(BWRAP) || !isAbsolute(cwd ?? "")) throw new Error("Host isolation is unavailable");
  const root = realpathSync(cwd), executable = realpathSync(config.command);
  if (root === "/" || root === "/usr" || root.startsWith("/usr/") || !root.startsWith("/home/") && !root.startsWith("/tmp/"))
    throw new Error("Host checkout must be a private workspace under /home or /tmp");
  const runnerNode = executable.startsWith("/opt/hostedtoolcache/node/")
    && /\/bin\/node$/.test(executable);
  if (!executable.startsWith("/usr/") && !executable.startsWith(root + sep) && !runnerNode)
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
    // GitHub setup-node stores its executable in hostedtoolcache. Expose only
    // that one read-only binary, never the rest of the runner tool cache.
    ...(runnerNode ? ["--dir", "/opt", "--dir", "/opt/hostedtoolcache",
      "--dir", "/opt/hostedtoolcache/node",
      ...executable.slice("/opt/hostedtoolcache/node/".length).split("/").slice(0, -1)
        .reduce((state, part) => { state.path += "/" + part; state.args.push("--dir", state.path); return state; },
          { path: "/opt/hostedtoolcache/node", args: [] }).args,
      "--ro-bind", executable, executable] : []),
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
