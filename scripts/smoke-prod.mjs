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
//   D. deployed revision GET /api/version/worker                 -> 200 + stamped 40-hex sourceRevision
//   E. DO readiness      GET /api/ready                          -> 200 + status "ready"
//
// Probe D pins WHAT build prod serves. It uses /api/version/worker (not
// /api/version): the worker route is answered from module scope and never
// enters the Durable Object, so a wedged or warming DO cannot hide a bad
// deploy behind it. Without --expect-sha it asserts the build is stamped
// (a 40-hex revision, never "unstamped"); with --expect-sha <sha> (or
// SMOKE_EXPECT_SHA) it pins the exact deployed commit — the deploy-lane
// verification mode. The hourly deploy-drift check covers lag-vs-main;
// this pins identity, not freshness.
//
// Probe E is the cold-start signal: /api/health never enters the DO, so only
// /api/ready distinguishes "worker alive" from "Durable Object awake". A 503
// "degraded" here means the DO constructor still holds the input gate (or is
// wedged) — the same semantics as the 5-minute external probe, which fails
// its ready check on any non-200. The probe also records do.ms, the
// storage-probe latency inside the object.
//
// Server-Timing: the worker/DO emit `app;dur=` (handler time inside the DO)
// and `total;dur=` (worker wall time including queueing and DO wake). The
// claims-board probe reports the stall (total - app) — the DO-wake/queue
// component of first-request latency — as measurement, not a budget: a hard
// latency ceiling on shared public infra would be flaky by design.
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
// Usage: node scripts/smoke-prod.mjs [--json] [--base https://room.trydemigod.com] [--room muse-room] [--expect-sha <40-hex>]
// Exit 0 when every probe passes, 1 on any failure. Timeouts: 10s per probe.
const TIMEOUT_MS = 10_000;
const DEFAULT_BASE = "https://room.trydemigod.com";
const DEFAULT_ROOM = "muse-room";
const SHA_RE = /^[0-9a-f]{40}$/i;
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
// Optional deploy-lane pin: fail unless the worker serves exactly this commit.
const EXPECT_SHA = (flag("--expect-sha") ?? process.env.SMOKE_EXPECT_SHA ?? "").toLowerCase();

async function fetchProbe(url, { method = "GET", headers = {}, body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    return { ok: true, status: res.status, contentType: res.headers.get("content-type") ?? "", text, latencyMs: Date.now() - started, serverTiming: res.headers.get("server-timing") ?? "" };
  } catch (error) {
    return { ok: false, status: null, error: error?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(error?.message ?? error), latencyMs: Date.now() - started, serverTiming: "" };
  } finally {
    clearTimeout(timer);
  }
}

// Parse the Server-Timing header the worker/DO emit (`app;dur=N` from the
// DO's fetch, `total;dur=N` from the worker entry). Multiple metrics may be
// comma-joined into one header value by the time fetch sees them.
function parseServerTiming(value) {
  const out = {};
  for (const part of String(value ?? "").split(",")) {
    const m = /^\s*([A-Za-z][\w-]*)\s*;\s*dur=(\d+(?:\.\d+)?)/.exec(part);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// Cold-start decomposition for a DO-backed probe: `total` is worker wall
// time (queueing + DO wake + handler), `app` is handler time inside the DO,
// so the gap is the wake/queue component. Measurement only, never a budget.
function timingDetail(r) {
  const t = parseServerTiming(r.serverTiming);
  if (t.app === undefined && t.total === undefined) return `${r.latencyMs}ms`;
  const stall = t.app !== undefined && t.total !== undefined ? ` stall=${Math.max(0, Math.round(t.total - t.app))}ms` : "";
  return `${r.latencyMs}ms (server app=${t.app ?? "?"}ms total=${t.total ?? "?"}ms${stall})`;
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
    return pass(name, url, `200 JSON, opportunities array in ${timingDetail(r)}`);
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

function probeDeployedRevision() {
  return (async () => {
    const name = "deployed-revision";
    // The worker route, not /api/version: answered from module scope, never
    // enters the Durable Object, so this pins the deployed build even when
    // the DO is warming or wedged (2026-09-25 outage lesson).
    const url = `${BASE}/api/version/worker`;
    const r = await fetchProbe(url);
    if (!r.ok) return fail(name, url, `fetch failed: ${r.error}`);
    if (r.status !== 200) return fail(name, url, `expected HTTP 200, got ${r.status}`);
    let parsed;
    try { parsed = JSON.parse(r.text); }
    catch { return fail(name, url, "response is not JSON"); }
    if (parsed?.servedBy !== "worker")
      return fail(name, url, `expected a worker-served version route, got servedBy ${JSON.stringify(parsed?.servedBy ?? null)}`);
    const rev = parsed?.sourceRevision;
    if (typeof rev !== "string" || !SHA_RE.test(rev))
      return fail(name, url, `deployed build is not stamped: sourceRevision=${JSON.stringify(rev ?? null)} (stamp-version.mjs skipped?)`);
    if (EXPECT_SHA && rev.toLowerCase() !== EXPECT_SHA)
      return fail(name, url, `deployed ${rev} does not match --expect-sha ${EXPECT_SHA}`);
    const build = typeof parsed?.buildId === "string" && parsed.buildId ? ` build ${parsed.buildId}` : "";
    return pass(name, url, `worker build ${rev}${build} in ${r.latencyMs}ms`);
  })();
}

function probeDoReadiness() {
  return (async () => {
    const name = "do-readiness";
    const url = `${BASE}/api/ready`;
    const r = await fetchProbe(url);
    if (!r.ok) return fail(name, url, `fetch failed: ${r.error}`);
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { /* non-JSON can never be ready */ }
    // Same bar as the 5-minute external probe: only 200 + status "ready"
    // passes. A 503 "degraded" is the DO constructor still holding the input
    // gate after a deploy (or a wedged object) — a real signal, not noise.
    if (r.status !== 200 || parsed?.status !== "ready")
      return fail(name, url, `expected HTTP 200 with status "ready", got HTTP ${r.status} status ${JSON.stringify(parsed?.status ?? null)}`);
    const doStatus = parsed?.do?.status;
    if (doStatus !== undefined && doStatus !== "ok")
      return fail(name, url, `ready body reports do.status=${JSON.stringify(doStatus)}`);
    const ms = parsed?.do?.ms;
    return pass(name, url, `DO ready${Number.isFinite(ms) ? ` (do.ms=${ms}ms)` : ""} in ${timingDetail(r)}`);
  })();
}

const results = [await probeLanding(), await probeClaimsBoard(), await probePricedToolRefusal(), await probeDeployedRevision(), await probeDoReadiness()];
const failed = results.filter(r => !r.pass);

if (asJson) {
  console.log(JSON.stringify({ base: BASE, room: ROOM, probedAt: new Date().toISOString(), results, allPass: failed.length === 0 }, null, 2));
} else {
  console.log(`zero-bug smoke ${BASE} (room ${ROOM}) @ ${new Date().toISOString()}`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.name.padEnd(20)} ${r.url} :: ${r.detail}`);
  console.log(failed.length === 0 ? "verdict: all probes passed" : `verdict: ${failed.length} probe(s) failed`);
}
process.exit(failed.length === 0 ? 0 : 1);
