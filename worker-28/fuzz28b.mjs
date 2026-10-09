// WORKER 28 follow-up: re-test H1 body-size/edge cases on a FRESH rate bucket each.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const results = [];
let base = null, server = null, fixture = null, origin = null;

async function boot() {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  origin = `http://127.0.0.1:${server.address().port}`;
}
async function shutdown() {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { fixture.store.close(); } catch {}
}
async function req({ rawBody, body, timeoutMs = 8000 }) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  const opts = { method: "POST", headers: { origin, "content-type": "application/json" }, signal: c.signal };
  opts.body = rawBody !== undefined ? rawBody : JSON.stringify(body);
  const started = Date.now();
  try {
    const r = await fetch(base + "/api/guest-invites/request", opts);
    const text = await r.text(); clearTimeout(t);
    return { status: r.status, body: text.slice(0, 2000), ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", body: e.message.slice(0, 200), ms: Date.now() - started };
  }
}
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}
const codeOf = (r) => { try { const j = JSON.parse(r.body); return j?.error?.code ?? j?.code ?? "(no code)"; } catch { return "(non-json)"; } };

await boot();
let r = await req({ rawBody: JSON.stringify({ card: "x".repeat(20000) }) });
check("F1 20KB body → 413 too_large", r.status === 413 && codeOf(r) === "too_large", `got ${r.status}/${codeOf(r)}`);
await shutdown(); await boot();
r = await req({ body: { card: "x".repeat(100000) } });
check("F2 100KB card string → 4xx, no hang (ms<5000)", r.status >= 400 && r.status < 500 && r.ms < 5000, `got ${r.status}/${codeOf(r)} in ${r.ms}ms`);
await shutdown(); await boot();
r = await req({ body: { card: { joinRequest: { requestId: "x".repeat(5000), room: "commons" } } } });
check("F3 deeply odd card shape → 4xx, no hang", r.status >= 400 && r.status < 500 && r.ms < 5000, `got ${r.status}/${codeOf(r)} in ${r.ms}ms`);
await shutdown(); await boot();
r = await req({ rawBody: '{"card":"x","__proto__":{"polluted":1}}' });
check("F4 __proto__ payload → no pollution, 4xx", ({}).polluted === undefined && r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
await shutdown(); await boot();
r = await req({ rawBody: "x".repeat(20000) });
check("F5 20KB non-JSON → 413 too_large (size before parse)", r.status === 413 && codeOf(r) === "too_large", `got ${r.status}/${codeOf(r)}`);
await shutdown(); await boot();
r = await req({ rawBody: "{" });
check("F6 truncated JSON → 400 invalid_json", r.status === 400 && codeOf(r) === "invalid_json", `got ${r.status}/${codeOf(r)}`);
await shutdown(); await boot();
r = await req({ body: { card: ["not", "a", "card"] } });
check("F7 card=array → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);
await shutdown(); await boot();
r = await req({ body: { card: { joinRequest: null, signature: "zz" } } });
check("F8 card with null joinRequest → 4xx, no 5xx", r.status >= 400 && r.status < 500, `got ${r.status}/${codeOf(r)}`);

const fails = results.filter(x => !x.pass);
console.log(`\n${results.length - fails.length}/${results.length} follow-up checks passed${fails.length ? "; FAILS: " + fails.map(f => f.name).join(" | ") : ""}`);
await shutdown();
process.exit(fails.length ? 1 : 0);
