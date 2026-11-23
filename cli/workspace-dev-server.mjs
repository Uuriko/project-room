import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { outputBytes } from "../server/workspace-previews.mjs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { portForPath } from "../third_party/buzz-worktree/port.mjs";
import { commandOnPath } from "./which.mjs";

const host = "127.0.0.1";
const supervisor = fileURLToPath(new URL("./workspace-process-supervisor.mjs", import.meta.url));

function reservePort(port) {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen({ host, port, exclusive: true }, () => {
      const bound = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(bound));
    });
  });
}

async function choosePort(cwd, requested) {
  if (requested !== undefined && (!/^\d+$/.test(requested) || Number(requested) < 1024 || Number(requested) > 65535))
    throw new Error("Choose a port from 1024 to 65535");
  const preferred = requested === undefined ? portForPath(cwd) : Number(requested);
  try { return { preferred, port: await reservePort(preferred) }; }
  catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    if (requested !== undefined) throw new Error("The requested preview port is already in use");
    return { preferred, port: await reservePort(0) };
  }
}

function ownsLoopback(lsof, ps, port, group) {
  let result;
  try {
    result = execFileSync(lsof, ["-nP", "-a", "-i4TCP:" + port, "-sTCP:LISTEN", "-Fpn"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (error.status === 1 && !error.stdout) return false;
    throw error;
  }
  let pid;
  for (const line of result.split("\n")) {
    if (/^p\d+$/.test(line)) pid = line.slice(1);
    if (line !== `n${host}:${port}` || !pid) continue;
    try {
      const actual = execFileSync(ps, ["-o", "pgid=", "-p", pid], {
        encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
      });
      if (Number(actual.trim()) === group) return true;
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  return false;
}

function captureRunLog(cwd, file) {
  const target = resolve(cwd, file);
  const folder = realpathSync(dirname(target));
  const within = relative(cwd, folder);
  if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep) || !/\.(?:log|txt)$/i.test(target))
    throw new Error("Choose a new .log or .txt file inside the worktree");
  const path = resolve(folder, basename(target));
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  let tail = Buffer.alloc(0), timer, failure;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const temp = resolve(folder, ".room-run-" + randomUUID());
    try {
      writeFileSync(temp, tail, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } catch (error) {
      failure ??= error;
      try { rmSync(temp, { force: true }); } catch {}
    }
  };
  function append(text) {
    if (!text || failure) return;
    const bytes = Buffer.from(text);
    tail = Buffer.concat([tail, bytes.subarray(-outputBytes)]);
    let start = Math.max(0, tail.length - outputBytes);
    while (start < tail.length && (tail[start] & 0xC0) === 0x80) start++;
    tail = tail.subarray(start);
    timer ??= setTimeout(flush, 125);
  }
  return {
    path,
    observe(stream) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", chunk => { process.stderr.write(chunk); append(decoder.write(chunk)); });
      stream.on("end", () => append(decoder.end()));
    },
    finish() {
      if (timer) flush();
      if (failure) throw new Error("Could not save the local Workspace run log", { cause: failure });
    },
  };
}

// Only invoked by a local operator with an explicit argv. It receives no
// Room credentials and opens no remote port. Child output stays on stderr.
export async function runWorkspaceServer({ cwd, workingDirectory = cwd, command, args, requestedPort, logPath, out, env = process.env }) {
  const lsof = commandOnPath("lsof", env), ps = commandOnPath("ps", env);
  if (!["linux", "darwin"].includes(process.platform) || !lsof || !ps)
    throw new Error("Local preview ownership checks require macOS or Linux with lsof and ps");
  const { preferred, port } = await choosePort(cwd, requestedPort);
  const argv = args.map(arg => arg.replaceAll("{port}", String(port)).replaceAll("{host}", host));
  const localEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]
    .filter(key => typeof env[key] === "string").map(key => [key, env[key]]));
  const log = logPath === undefined ? null : captureRunLog(cwd, logPath);
  const child = fork(supervisor, [command, ...argv], {
    cwd: workingDirectory, env: { ...localEnv, PORT: String(port), HOST: host }, detached: true,
    stdio: ["ignore", log ? "pipe" : 2, log ? "pipe" : 2, "ipc"],
  });
  const outputClosed = log && new Promise(resolveClose => child.once("close", resolveClose));
  if (log) {
    log.observe(child.stdout);
    log.observe(child.stderr);
  }
  let result, stopping = false;
  const exited = new Promise(resolve => {
    child.once("message", message => { result = message; });
    child.once("error", error => { result = { error: error.code ?? "spawn_failed" }; resolve(); });
    child.once("exit", (code, signal) => { result ??= { code, signal }; resolve(); });
  });
  const disconnect = () => { if (child.connected) child.disconnect(); };
  let shutdownTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child.connected && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { disconnect(); }
      shutdownTimer = setTimeout(disconnect, 1500);
    } else disconnect();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let previewFailure;
  try {
    const deadline = performance.now() + 15000;
    while (!result && !stopping && performance.now() < deadline) {
      if (ownsLoopback(lsof, ps, port, child.pid)) {
        out({ state: "ready", path: cwd, ...(workingDirectory !== cwd && { workingDirectory }), preferredPort: preferred, port, previewUrl: `http://${host}:${port}/`, ...(log && { log: log.path }) });
        await exited;
        if (stopping) return 0;
        if (result.error) throw new Error("Preview command failed: " + result.error);
        return result.code ?? 1;
      }
      await delay(100);
    }
    if (stopping) return 0;
    throw new Error(result?.error ? "Preview command failed: " + result.error
      : result ? "Preview command exited before its loopback listener was ready"
        : "The command did not open the assigned loopback port");
  } catch (error) {
    previewFailure = error;
    throw error;
  } finally {
    if (!stopping) disconnect();
    await exited;
    clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await outputClosed;
    try { log?.finish(); }
    catch (error) {
      if (!previewFailure) throw error;
      previewFailure.cause ??= error;
    }
  }
}
