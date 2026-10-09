// WAVE-2000 GUILD-02 fuzz runner. Usage: node fuzz/run.mjs <from> <to> <outjson>
// Boots a local server (acceptance fixture, 127.0.0.1), runs targets from..to
// sequentially, detects crashes via health probe, restarts on death.
import net from "node:net";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { TARGETS } from "./targets.mjs";

const [from, to, outPath] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const findings = [];
let server = null, fixture = null, base = null, crashes = 0;

async function boot() {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function shutdown() {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { fixture.store.close(); } catch {}
}
async function healthOk() {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(base + "/api/health", { signal: c.signal }); clearTimeout(t);
    return r.status === 200;
  } catch { return false; }
}

function rawRequest(port, payload, timeoutMs) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const finish = (result) => { if (!done) { done = true; sock.destroy(); resolve(result); } };
    const timer = setTimeout(() => finish({ status: "TIMEOUT", head: data.slice(0, 300), ms: timeoutMs }), timeoutMs);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish({ status: "CLOSED", head: data.slice(0, 300), ms: null }); });
    sock.on("error", e => { clearTimeout(timer); finish({ status: "SOCKET-ERROR", head: e.message.slice(0, 200), ms: null }); });
    // give the server a beat to respond, then read what we got
    setTimeout(() => { if (!done && data) { clearTimeout(timer); finish({ status: "RESP", head: data.slice(0, 300), ms: null }); } }, Math.min(timeoutMs, 2500));
  });
}

async function sendRawTrickle(port, c) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const finish = (r) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
    const timer = setTimeout(() => finish({ status: "TIMEOUT", head: data.slice(0, 300), ms: c.timeoutMs }), c.timeoutMs);
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish({ status: "CLOSED", head: data.slice(0, 300), ms: null }); });
    sock.on("error", e => { clearTimeout(timer); finish({ status: "SOCKET-ERROR", head: e.message.slice(0, 200), ms: null }); });
    sock.on("connect", async () => {
      const body = c.body || "";
      sock.write(`${c.method} ${c.path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
      if (c.trickle) {
        for (let i = 0; i < body.length; i += 2) { sock.write(body.slice(i, i + 2)); await new Promise(r => setTimeout(r, 30)); if (done) return; }
      } else if (c.abortAfterMs) {
        sock.write(body.slice(0, Math.floor(body.length / 2)));
        setTimeout(() => { sock.destroy(); }, c.abortAfterMs);
        return;
      }
      setTimeout(() => { if (!done && data) { clearTimeout(timer); finish({ status: "RESP", head: data.slice(0, 300), ms: null }); } }, 2000);
    });
  });
}

async function runCase(t, c) {
  const started = Date.now();
  const port = new URL(base).port;
  try {
    if (c.raw === true) {
      const r = await rawRequest(Number(port), c.payload, c.timeoutMs);
      return { ...r, ms: Date.now() - started };
    }
    if (c.trickle || c.abortAfterMs) {
      const r = await sendRawTrickle(Number(port), c);
      return { ...r, ms: Date.now() - started };
    }
    const headers = { ...c.headers };
    if (c.rawHeaders && c.headers.Host) { /* node fetch forbids Host; skip marker */ delete headers.Host; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
    const r = await fetch(base + c.path, {
      method: c.method, headers,
      body: c.raw ?? c.body ?? undefined,
      signal: ctl.signal, redirect: "manual",
    });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 300), ms: Date.now() - started };
  } catch (e) {
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", head: String(e.message).slice(0, 200), ms: Date.now() - started };
  }
}

const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h);

await boot();
console.log(`booted ${base} for targets ${from}-${to}`);

for (const t of TARGETS.filter(t => t.id >= from && t.id <= to)) {
  const cases = t.make();
  console.log(`T${t.id} ${t.name}: ${cases.length} cases`);
  for (const c of cases) {
    const r = await runCase(t, c);
    const rec = { target: t.id, tname: t.name, case: c.name, method: c.method || "RAW", path: (c.path || "").slice(0, 160), status: r.status, ms: r.ms, head: r.head };
    // Raw-socket probes that deliberately send truncated/malformed bytes:
    // TIMEOUT/CLOSED/SOCKET-ERROR with the server still alive is expected
    // (node holds incomplete requests until its own timeout); only a dead
    // server (caught by the health probe below) counts.
    const rawBenign = c.raw === true && ["TIMEOUT", "CLOSED", "SOCKET-ERROR"].includes(r.status);
    // Client-side fetch rejections (bad case construction) are harness noise.
    const clientNoise = r.status === "FETCH-ERROR" && /GET\/HEAD method cannot have body|Failed to parse URL|Invalid/.test(r.head || "");
    if (!rawBenign && !clientNoise && (r.status === 500 || r.status === "TIMEOUT" || r.status === "FETCH-ERROR" || r.status === "SOCKET-ERROR" || looksLikeStack(r.head || ""))) {
      rec.verdict = r.status === 500 ? "unexpected-500" : r.status === "TIMEOUT" ? "hang" : "transport-anomaly";
      if (looksLikeStack(r.head || "")) rec.leak = "possible-stack-leak";
      findings.push(rec);
      console.log(`  FINDING T${t.id} ${c.name}: ${r.status} ${(r.head || "").slice(0, 120)}`);
    }
  }
  if (!(await healthOk())) {
    crashes++;
    findings.push({ target: t.id, tname: t.name, case: "*", verdict: "crash", note: "server dead after target — restarted" });
    console.log(`  CRASH after T${t.id} — restarting server`);
    await shutdown(); await boot();
  }
}
await shutdown();

const summary = { from, to, crashes, findingCount: findings.length, findings };
await import("node:fs").then(fs => fs.writeFileSync(outPath, JSON.stringify(summary, null, 1)));
console.log(`done: ${findings.length} findings, ${crashes} crashes -> ${outPath}`);
