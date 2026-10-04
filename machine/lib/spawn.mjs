import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

// Callers can bind the environment children see for the current async
// operation. The allowlist still drops secrets.
export const spawnContext = new AsyncLocalStorage();

// Children inherit a short environment. Secrets, tokens, and the rest of the
// parent environment stay in this process.
const PASSTHROUGH = Object.freeze([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "TERM",
]);

export function childEnv(base = spawnContext.getStore()?.env ?? process.env) {
  const env = {};
  for (const key of PASSTHROUGH) {
    if (typeof base[key] === "string") env[key] = base[key];
  }
  return env;
}

function killGroup(child) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

// Run a command with no shell. The secret-bearing value, when there is one,
// is `input` (stdin), never an argument. Nonzero exits resolve; they are
// observations. Timeout and oversize output resolve with flags set.
export function runCommand(command, args, {
  input = null, timeoutMs = 30_000, maxBytes = 1024 * 1024, cwd,
} = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, capped: false, error: error.message });
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let capped = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    child.stdout.on("data", chunk => {
      outLen += chunk.length;
      if (outLen > maxBytes) { capped = true; killGroup(child); return; }
      out.push(chunk);
    });
    // L-5: stderr used to accumulate without bound — a noisy child could grow
    // memory without limit over the timeout window. Same cap as stdout.
    child.stderr.on("data", chunk => {
      errLen += chunk.length;
      if (errLen > maxBytes) { capped = true; killGroup(child); return; }
      err.push(chunk);
    });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, capped, error: error.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, capped, error: null,
      });
    });
    if (input == null) child.stdin.end();
    else {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

export function spawnCommand(command, args, { cwd } = {}) {
  return spawn(command, args, {
    cwd,
    env: childEnv(),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
