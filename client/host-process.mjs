import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

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
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, settings.env ?? {});
    const grouped = process.platform !== "win32";
    const child = spawn(settings.command, settings.args, { cwd: settings.cwd, env,
      shell: false, detached: grouped, stdio: ["pipe", "pipe", "pipe"] });
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
      if (failure || code !== 0) { reject(new Error(failure ?? "Host exited unsuccessfully; reconcile the original attempt")); return; }
      try {
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!result || Object.keys(result).length !== 1 || typeof result.body !== "string"
          || !result.body.trim() || result.body.length > 4096 || !result.body.isWellFormed()) throw new Error();
        resolve(result);
      } catch { reject(new Error("Host must return one JSON object containing a nonempty body of at most 4096 characters")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
