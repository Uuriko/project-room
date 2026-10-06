// Production smoke probes (Zero-Bug System, Phase 2). Zero dependencies.
// Synthetic READ-ONLY probes against the live Project Room deployment.
// Never writes or mutates production data, never spends, never charges,
// never authenticates as any user or agent. Every probe only reads a
// status code / response shape.
//
// Probes:
//   A. landing page      GET /                                   -> 200 + HTML
//   B. claims-board read GET /api/opportunities.json?room=...    -> 200 + JSON with `opportunities` array
//   C. priced-tool MCP   POST /mcp tools/call add_land_item     -> 401 auth_required JSON-RPC (never 500)
//
// Notes on probe C: the spend primitive's honest 402 (payment_required,
// server/spend-grants.mjs paymentRefusal) fires for an authenticated agent
// holding no spend grant. Creating or borrowing an agent identity would
// write to production (or impersonate one), so this credential-less probe
// asserts the adjacent refusal invariant instead: calling a priced tool
// with NO identity must be refused honestly (401 auth_required) and must
// never execute the tool and must never 500. A priced tool that returned
// a result without identity, or a 5xx, fails the probe. Upgrade path: a
// standing grant-less smoke identity provisioned by the owner would allow
// a true 402-vs-500 assertion; that belongs in an authenticated variant,
// never in the unattended cron.
//
// Usage: node scripts/smoke-prod.mjs [--json] [--base https://room.trydemigod.com] [--room muse-room]
// Exit 0 when every probe passes, 1 on any failure. Timeouts: 10s per probe.
const TIMEOUT_MS = 10_000;
const DEFAULT_BASE = "https://room.trydemigod.com";
const DEFAULT_ROOM = "muse-room";
// A priced MCP tool (server/spend-grants.mjs PRICED_MCP_TOOLS): calling it
// with no identity must be refused, never executed, never charged.
const PRICED_TOOL = "add_land_item";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const BASE = (flag("--base") ?? process.env.SMOKE_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
const ROOM = flag("--room") ?? process.env.SMOKE_ROOM ?? DEFAULT_ROOM;

async function fetchProbe(url, { method = "GET", headers = {}, body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    return { ok: true, status: res.status, contentType: res.headers.get("content-type") ?? "", text, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, status: null, error: error?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(error?.message ?? error), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const pass = (name, url, detail) => ({ name, url, pass: true, detail });
const fail = (name, url, detail) => ({ name, url, pass: false, detail });

function probeLanding() {
  return (async () => {
    const name = "landing-page";
    const url = `${BASE}/`;
    const r = await fetchProbe(url);
    if (!r.ok) return fail(name, url, `fetch failed: ${r.error}`);
    if (r.status !== 200) return fail(name, url, `expected HTTP 200, got ${r.status}`);
    if (!/text\/html/i.test(r.contentType)) return fail(name, url, `expected HTML, got content-type ${r.contentType || "(none)"}`);
    if (!/<html[\s>]/i.test(r.text)) return fail(name, url, "body is not an HTML document");
    return pass(name, url, `200 HTML in ${r.latencyMs}ms`);
  })();
}

function probeClaimsBoard() {
  return (async () => {
    const name = "claims-board-read";
    const url = `${BASE}/api/opportunities.json?room=${encodeURIComponent(ROOM)}&limit=1`;
    const r = await fetchProbe(url);
    if (!r.ok) return fail(name, url, `fetch failed: ${r.error}`);
    if (r.status !== 200) return fail(name, url, `expected HTTP 200, got ${r.status}`);
    let parsed;
    try { parsed = JSON.parse(r.text); }
    catch { return fail(name, url, "response is not JSON"); }
    if (!Array.isArray(parsed?.opportunities)) return fail(name, url, "JSON lacks an `opportunities` array");
    return pass(name, url, `200 JSON, opportunities array in ${r.latencyMs}ms`);
  })();
}

function probePricedToolRefusal() {
  return (async () => {
    const name = "priced-tool-refusal";
    const url = `${BASE}/mcp`;
    const rpc = {
      jsonrpc: "2.0", id: "zero-bug-smoke", method: "tools/call",
      params: { name: PRICED_TOOL, arguments: { roomId: ROOM } },
    };
    const r = await fetchProbe(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(rpc),
    });
    if (!r.ok) return fail(name, url, `fetch failed: ${r.error}`);
    if (r.status >= 500) return fail(name, url, `priced-tool refusal returned HTTP ${r.status} (regression: refusals must be 4xx, never 5xx)`);
    let parsed;
    try { parsed = JSON.parse(r.text); }
    catch { return fail(name, url, `expected JSON-RPC body, got HTTP ${r.status} non-JSON`); }
    // The tool must never have executed: a result payload is a hard failure.
    if (parsed?.result !== undefined && parsed?.error === undefined)
      return fail(name, url, `priced tool ${PRICED_TOOL} returned a result with no identity — it must be refused`);
    const code = parsed?.error?.code;
    const reason = parsed?.error?.data?.reason;
    if (r.status === 401 && code === -32001 && reason === "auth_required")
      return pass(name, url, `401 auth_required (JSON-RPC -32001) for ${PRICED_TOOL} in ${r.latencyMs}ms — refused before the spend gate, nothing charged`);
    return fail(name, url, `expected 401 auth_required JSON-RPC, got HTTP ${r.status} code ${code ?? "?"} reason ${reason ?? "?"}`);
  })();
}

const results = [await probeLanding(), await probeClaimsBoard(), await probePricedToolRefusal()];
const failed = results.filter(r => !r.pass);

if (asJson) {
  console.log(JSON.stringify({ base: BASE, room: ROOM, probedAt: new Date().toISOString(), results, allPass: failed.length === 0 }, null, 2));
} else {
  console.log(`zero-bug smoke ${BASE} (room ${ROOM}) @ ${new Date().toISOString()}`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.name.padEnd(20)} ${r.url} :: ${r.detail}`);
  console.log(failed.length === 0 ? "verdict: all probes passed" : `verdict: ${failed.length} probe(s) failed`);
}
process.exit(failed.length === 0 ? 0 : 1);
