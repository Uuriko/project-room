import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MAC_CHECK_KINDS } from "../src/mac-checks.js";
import { inspectAffectedCheckout } from "./desktop-affected.mjs";

const swift = "/usr/bin/swift";
const marker = "native-room-smoke";
const fixture = '<!doctype html><title>Project Room smoke</title><input id="message-input">';
const script = `if (document.title !== "Project Room smoke" || !document.querySelector("#message-input")) throw Error("fixture not rendered");
document.querySelector("#message-input").value = "${marker}";
return "${marker}";`;

function nativeProcess(file, args, { cwd, signal, timeout }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"],
      env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: tmpdir() } });
    let tail = "", timedOut = false;
    const stop = () => {
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.stdout.setEncoding("utf8").on("data", chunk => { tail = (tail + chunk).slice(-8192); });
    child.once("error", error => { clear(); reject(error); });
    child.once("close", exitCode => {
      clear();
      if (signal?.aborted) reject(signal.reason);
      else resolve({ exitCode, tail, timedOut });
    });
  });
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function smoke(application, scratch, options) {
  const file = join(scratch, "smoke.js");
  await writeFile(file, script, { mode: 0o600 });
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const result = await nativeProcess(application, [url, file], { ...options, timeout: 30_000 });
    const rendered = /^WK_ACCEPTANCE .*native-room-smoke/m.test(result.tail);
    const restored = /^WK_CLOSE_REOPEN passed$/m.test(result.tail);
    return { status: result.exitCode === 0 && rendered && restored ? "passed" : "failed",
      checks: { renderedLoopbackPage: rendered, closeReopenPreservedDraft: restored }, exitCode: result.exitCode,
      ...(result.timedOut ? { reason: "native_smoke_timeout" } : {}) };
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

export function desktopNativeChecks(checkout) {
  let scratch;
  return {
    async verifySupport(checks, signal) {
      if (!checks.some(check => check !== "affected")) return;
      if (process.platform !== "darwin") throw Error("mac_native_checks_unavailable");
      const directory = join(checkout.worktree, "desktop/macos");
      await access(join(directory, "Package.swift"));
      if (checks.includes("native-smoke")) await access(join(directory, "Sources/RoomAcceptance/main.swift"));
      const version = await nativeProcess(swift, ["--version"], { cwd: directory, signal, timeout: 10_000 });
      if (version.exitCode !== 0) throw Error("mac_swift_unavailable");
    },
    async run(check, workRevision, signal) {
      const started = performance.now();
      const { cwd, before, base } = await inspectAffectedCheckout(checkout);
      scratch ??= await mkdtemp(join(tmpdir(), "room-mac-checks-"));
      const nativeCwd = join(cwd, "desktop/macos");
      const options = { cwd: nativeCwd, signal, timeout: 180_000 };
      const target = check === "build" ? "ProjectRoom" : "RoomAcceptance";
      const args = ["build", "--scratch-path", join(scratch, "swift"), "--configuration", "release"];
      const build = await nativeProcess(swift, [...args, "--product", target], options);
      let outcome = { status: "failed", stage: "build", exitCode: build.exitCode,
        ...(build.timedOut ? { reason: "local_build_timeout" } : {}) };
      if (build.exitCode === 0) {
        const bin = await nativeProcess(swift, [...args, "--show-bin-path"], options);
        const location = bin.tail.trim();
        if (bin.exitCode === 0 && isAbsolute(location) && location.startsWith(join(scratch, "swift") + "/")) {
          const artifact = join(location, target);
          const artifactSha256 = await digest(artifact);
          outcome = check === "build" ? { status: "passed", stage: "build", exitCode: 0, artifactSha256 }
            : { ...await smoke(artifact, scratch, options), stage: "smoke", artifactSha256 };
        } else outcome = { status: "failed", stage: "build", reason: "build_artifact_unconfirmed", exitCode: bin.exitCode };
      }
      try {
        const after = await inspectAffectedCheckout(checkout);
        if (before.fingerprint !== after.before.fingerprint) outcome.status = "stale";
      } catch { outcome.status = "stale"; }
      signal?.throwIfAborted();
      return { kind: MAC_CHECK_KINDS[check], workRevisionAtStart: workRevision, head: before.head, base, dirty: false,
        worktreeFingerprint: `sha256:${before.fingerprint}`, target, architecture: process.arch, ...outcome,
        elapsedMs: Math.round(performance.now() - started) };
    },
    async close() { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  };
}
