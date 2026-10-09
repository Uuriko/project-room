// WORKER 19 — close the target-18 gap: fuzz POST /api/account-rooms itself
// (targets.mjs target 18 only ran GET/query/method-matrix on it, not JSON bodies).
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { jsonCases, methodMatrix, headerCases, invalidUtf8Case, queryCases } from "../fuzz/adversarial.mjs";

const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const port = new URL(base).port;
const BIND = "0".repeat(64);

const cases = [
  ...jsonCases("/api/account-rooms", "POST"),
  ...methodMatrix("/api/account-rooms"),
  ...headerCases("/api/account-rooms", "POST"),
  invalidUtf8Case("/api/account-rooms"),
  ...queryCases("/api/account-rooms"),
].map(c => ({ ...c, headers: { "x-session-binding": BIND, ...(c.headers ?? {}) } }));

const looksLikeStack = (h) => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal/.test(h || "");
let findings = 0;
for (const c of cases) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), c.timeoutMs);
    const r = await fetch(base + c.path, { method: c.method, headers: c.headers, body: c.raw ?? c.body ?? undefined, signal: ctl.signal, redirect: "manual" });
    clearTimeout(t);
    const text = await r.text().catch(() => "");
    if (r.status === 500 || looksLikeStack(text)) { findings++; console.log(`FINDING ${c.name}: ${r.status} ${text.slice(0, 120)}`); }
  } catch (e) {
    findings++; console.log(`FINDING ${c.name}: FETCH-ERROR ${e.message.slice(0, 120)}`);
  }
}
console.log(`post-account-rooms gap sweep: ${cases.length} cases, ${findings} findings`);
await new Promise(r => server.close(r));
try { fixture.store.close(); } catch {}
