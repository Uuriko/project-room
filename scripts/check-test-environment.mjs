// Diagnostic version probes execute trusted local tools on the child PATH.
// No install command is issued; arbitrary launchers may run their own hooks.
// Default warns for optional suite tools; --full requires all prerequisites.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { delimiter, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, createConnection } from "node:net";

const required = ["node", "npm", "gh", "jq", "git", "python3"];
const full = process.argv.includes("--full");
if (process.argv.slice(2).some(arg => arg !== "--full")) {
  console.error("Usage: node scripts/check-test-environment.mjs [--full]");
  process.exit(2);
}
if (process.platform === "win32") {
  console.error("test-environment: native Windows launcher qualification is not implemented; use a qualified Unix environment for the full profile.");
  process.exit(full ? 1 : 0);
}
let failed = false;
function problem(tool, message) {
  const blocking = full || tool === "node";
  console.error(`test-environment: ${blocking ? "error" : "warning"}: ${message}`);
  if (blocking) failed = true;
}
for (const tool of required) {
  const extensions = [""];
  let executable;
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, tool + extension);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) { executable = candidate; break; }
      } catch { /* Try the next PATH entry. */ }
    }
    if (executable) break;
  }
  if (!executable) {
    problem(tool, `missing executable: ${tool}. Add an existing installation to the child PATH before running the suites that require it.`);
    continue;
  }
  // Block Corepack network downloads when npm is a package-manager shim.
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 16384,
    env: { ...process.env, COREPACK_ENABLE_NETWORK: "0" }
  });
  if (result.error || result.status !== 0) {
    problem(tool, `${tool} at ${executable} failed its version probe (${result.error?.code || result.signal || result.status}). Check this launcher before qualification.`);
    continue;
  }
  const version = result.stdout.trim().split(/\r?\n/)[0];
  if (!version) {
    problem(tool, `${tool} at ${executable} returned no version.`);
    continue;
  }
  console.log(`test-environment: ${tool} ${version} (${executable})`);
  if (tool === "node") {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match || +match[1] < 24 || (+match[1] === 24 && +match[2] < 19)) {
      console.error("test-environment: child node must satisfy the project minimum Node 24.19.0.");
      failed = true;
    } else if (version !== `v${process.versions.node}`) {
      console.warn(`test-environment: child node ${version} differs from preflight Node ${process.versions.node}; qualification may not be comparable.`);
    }
  }
}
// Exercise the bridge fixture layout, including a roundtrip: a successful
// bind alone does not prove clients can reach the same socket pathname.
const temporaryRoot = tmpdir();
let probeDirectory, socketPath, client, peer, timeout;
const server = createServer(socket => {
  peer = socket;
  socket.on("error", () => {});
  socket.on("data", data => socket.end(data));
});
try {
  probeDirectory = mkdtempSync(join(temporaryRoot, "hbd-"));
  mkdirSync(join(probeDirectory, "sockets"));
  socketPath = join(probeDirectory, "sockets", "a.sock");
  await new Promise((resolveProbe, reject) => {
    timeout = setTimeout(() => reject(Object.assign(new Error("Socket probe timed out"), { code: "ETIMEDOUT" })), 2000);
    server.once("error", reject);
    server.listen(socketPath, () => {
      client = createConnection(socketPath);
      let received = "";
      client.once("error", reject);
      client.once("connect", () => client.end("room-probe"));
      client.on("data", data => { received += data.toString(); });
      client.once("end", () => received === "room-probe" ? resolveProbe()
        : reject(Object.assign(new Error("Socket roundtrip mismatch"), { code: "EPROTO" })));
    });
  });
  console.log(`test-environment: Unix socket roundtrip usable under ${temporaryRoot}`);
} catch (error) {
  problem("unix-socket", `Unix socket fixture unavailable under ${temporaryRoot} (${error.code || "unknown"}; path ${socketPath ? Buffer.byteLength(socketPath) : "unknown"} bytes). Use a shorter private temporary path or a private short alias to checkout-backed storage, then recheck before full qualification.`);
} finally {
  clearTimeout(timeout);
  client?.destroy(); peer?.destroy();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
  if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
