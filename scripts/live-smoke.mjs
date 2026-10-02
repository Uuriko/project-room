// live-smoke.mjs — production smoke for the deployed Project Room.
//
// Complements scripts/live-audit.mjs (auth/route guardrails). This file checks
// what an outside visitor or agent actually meets on the live origin:
//   1. deploy lag: live /api/version sourceRevision vs GitHub main;
//   2. discovery integrity: every machine file is 200, the right media type,
//      parses, and every same-host URL it advertises resolves;
//   3. human doors: public pages are 200 HTML, unknown paths give a 404;
//   4. optional browser pass (--browser): page errors, CSP console errors,
//      horizontal overflow at 390 px, and axe WCAG 2.2 A/AA violations.
//
// Findings are "fail" (a regression: the run exits 1) or "warn" (an open,
// already-triaged audit finding listed in KNOWN). When a KNOWN item is fixed,
// delete it here so it becomes a hard gate: the list only shrinks.
//
// The origin and GitHub API base are configurable (ROOM_SMOKE_ORIGIN,
// ROOM_SMOKE_GITHUB_API), so tests/live-smoke.test.js runs the real script
// against a local server instead of production.
import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

export const LIVE_ORIGIN = "https://room.trydemigod.com";
export const REPO = "Uuriko/project-room";
export const GITHUB_API = "https://api.github.com";
export const SAME_HOSTS = ["room.trydemigod.com", "www.getdasha.com", "getdasha.com"];

export const PUBLIC_PAGES = ["/", "/about", "/offers", "/receipts", "/join"];

export const DISCOVERY = [
  { path: "/llms.txt", type: "text/plain" },
  { path: "/llms-full.txt", type: "text/plain" },
  { path: "/.well-known/agent-card.json", type: "application/json", json: true },
  { path: "/.well-known/agent.json", type: "application/json", json: true },
  { path: "/.well-known/ai-catalog.json", type: "application/json", json: true },
  { path: "/.well-known/mcp.json", type: "json", json: true },
  { path: "/mcp/server-card", type: "json", json: true },
  { path: "/agents.json", type: "application/json", json: true },
  { path: "/openapi.json", type: "application/json", json: true },
  { path: "/robots.txt", type: "text/plain" },
  { path: "/sitemap.xml", type: "xml" },
];

// Open findings from the 2026-10-01 audit (see docs/QA-SYSTEM.md). Key: finding
// code, optionally "code:detail-prefix". Delete an entry when it is fixed.
export const KNOWN = new Map([
  ["html_404", "AUDIT P2-5: unknown paths return agent JSON to browsers"],
  ["advertised_url:https://room.trydemigod.com/extensions/", "AUDIT P3: A2A extension URIs do not resolve to a spec page"],
  ["noindex_public", "AUDIT P1-9: public pages send noindex while robots.txt allows crawling"],
  ["csp_console:/about", "AUDIT P2-4: CSP blocks the injected analytics beacon"],
  ["csp_console:/receipts", "AUDIT P2-4: CSP blocks the injected analytics beacon"],
  ["csp_console:/join", "AUDIT P2-4: /join inline style blocked by its CSP"],
]);

const knownReason = (code, detail = "") => {
  for (const [key, reason] of KNOWN) {
    const [k, ...rest] = key.split(":"); const prefix = rest.join(":");
    if (k === code && (!prefix || String(detail).startsWith(prefix))) return reason;
  }
  return null;
};

function makeRecorder() {
  const findings = [];
  const add = (code, detail, { severity = "fail" } = {}) => {
    const known = knownReason(code, detail);
    findings.push({ code, detail: String(detail).slice(0, 300), severity: known ? "warn" : severity, ...(known ? { known } : {}) });
  };
  return { findings, add };
}

const mediaType = res => (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
const typeMatches = (actual, expected) => expected === "json" ? /(^|[+/])json$/.test(actual)
  : expected === "xml" ? /xml$/.test(actual) : actual === expected;

// Collect same-host absolute URLs a discovery document advertises.
// A route that exists but wants POST or auth answers 401/403/405; only a
// missing route (404/410) or a server error means the document is lying.
const brokenStatus = status => status === 404 || status === 410 || status >= 500;

function advertisedUrls(value, hosts = SAME_HOSTS, out = new Set()) {
  if (typeof value === "string") {
    if (/^https?:\/\/[^\s"'<>]+$/.test(value)) {
      // Templated URLs ({roomId}) are documentation, not fetchable endpoints.
      try { const url = new URL(value); if (hosts.includes(url.hostname) && !value.includes("{")) out.add(url.href); } catch { /* not a URL */ }
    }
  } else if (Array.isArray(value)) for (const item of value) advertisedUrls(item, hosts, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) advertisedUrls(item, hosts, out);
  return out;
}

async function timed(url, init) {
  const started = Date.now();
  const res = await fetch(url, { redirect: "manual", ...init });
  const text = await res.text();
  return { res, text, ms: Date.now() - started };
}

async function deployLag({ liveRevision, githubApi = GITHUB_API, repo = REPO, token = null, now = Date.now(), maxLagHours = 24 }) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "project-room-live-smoke", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const main = await fetch(`${githubApi}/repos/${repo}/commits/main`, { headers });
  if (!main.ok) return { status: "unknown", reason: `github ${main.status}` };
  const head = await main.json();
  if (head.sha === liveRevision) return { status: "current", mainRevision: head.sha, aheadBy: 0, lagHours: 0 };
  const compare = await fetch(`${githubApi}/repos/${repo}/compare/${liveRevision}...${head.sha}`, { headers });
  if (!compare.ok) return { status: "unknown", mainRevision: head.sha, reason: `compare ${compare.status}` };
  const diff = await compare.json();
  const undeployed = (diff.commits ?? []).map(c => Date.parse(c.commit?.committer?.date ?? c.commit?.author?.date)).filter(Number.isFinite);
  const oldest = undeployed.length ? Math.min(...undeployed) : now;
  const lagHours = Math.round((now - oldest) / 36e5 * 10) / 10;
  return { status: diff.status === "ahead" && lagHours > maxLagHours ? "stale" : diff.status === "ahead" ? "pending" : diff.status,
    mainRevision: head.sha, aheadBy: diff.ahead_by ?? null, behindBy: diff.behind_by ?? null, lagHours };
}

export async function liveSmoke({ origin = LIVE_ORIGIN, githubApi = GITHUB_API, githubToken = null, now = Date.now(), maxLagHours = 24, slowMs = 2000 } = {}) {
  const { findings, add } = makeRecorder();
  const hosts = [...SAME_HOSTS, new URL(origin).hostname];
  const timings = [];
  const get = async (path, init = {}) => {
    try { const r = await timed(new URL(path, origin).href, init); timings.push({ path, ms: r.ms }); return r; }
    catch (error) { add("fetch_failed", `${path}: ${error instanceof Error ? error.message : String(error)}`); return null; }
  };

  // 1. Version and deploy lag.
  const version = await get("/api/version");
  let liveRevision = null, lag = null;
  if (version) {
    let body = null; try { body = JSON.parse(version.text); } catch { /* reported below */ }
    liveRevision = typeof body?.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(body.sourceRevision) ? body.sourceRevision : null;
    if (version.res.status !== 200 || !liveRevision) add("version", `${version.res.status} ${version.text.slice(0, 80)}`);
    if (liveRevision) {
      try { lag = await deployLag({ liveRevision, githubApi, token: githubToken, now, maxLagHours }); }
      catch (error) { lag = { status: "unknown", reason: error instanceof Error ? error.message : String(error) }; }
      if (lag.status === "stale") add("deploy_lag", `live ${liveRevision.slice(0, 8)} is ${lag.aheadBy} commits / ${lag.lagHours} h behind main ${lag.mainRevision.slice(0, 8)}`);
      else if (lag.status === "diverged") add("deploy_diverged", `live ${liveRevision.slice(0, 8)} is not an ancestor of main`);
      else if (lag.status === "unknown") add("deploy_unknown", `deploy lag not measured: ${lag.reason}`, { severity: "warn" });
      else if (lag.status === "pending") add("deploy_pending", `${lag.aheadBy} commits awaiting deploy (${lag.lagHours} h)`, { severity: "warn" });
    }
  }

  // 2. Discovery integrity.
  const advertised = new Set();
  for (const item of DISCOVERY) {
    const r = await get(item.path, { headers: { accept: item.json ? "application/json" : "*/*" } });
    if (!r) continue;
    if (r.res.status !== 200) { add("discovery_status", `${item.path} -> ${r.res.status}`); continue; }
    if (!typeMatches(mediaType(r.res), item.type)) add("discovery_type", `${item.path} -> ${mediaType(r.res)} (expected ${item.type})`);
    if (item.json) {
      let doc; try { doc = JSON.parse(r.text); } catch { add("discovery_json", `${item.path} does not parse`); continue; }
      for (const url of advertisedUrls(doc, hosts)) advertised.add(url);
    }
  }
  for (const url of [...advertised].sort()) {
    try {
      const r = await timed(url, { method: "GET", headers: { accept: "*/*" } });
      if (brokenStatus(r.res.status)) add("advertised_url", `${url} -> ${r.res.status}`);
    } catch (error) { add("advertised_url", `${url} -> ${error instanceof Error ? error.message : String(error)}`); }
  }

  // 3. Human doors.
  const robots = timings.length ? await get("/robots.txt") : null;
  const crawlAllowed = robots ? !/^\s*Disallow:\s*\/\s*$/im.test(robots.text) : false;
  for (const path of PUBLIC_PAGES) {
    const r = await get(path, { headers: { accept: "text/html" } });
    if (!r) continue;
    if (r.res.status !== 200) add("page_status", `${path} -> ${r.res.status}`);
    else if (mediaType(r.res) !== "text/html") add("page_type", `${path} -> ${mediaType(r.res)}`);
    if (path === "/about" && crawlAllowed && /noindex/i.test(r.res.headers.get("x-robots-tag") || "")) add("noindex_public", `${path} sends X-Robots-Tag noindex`);
  }
  const missing = await get(`/__live-smoke-missing-${now}`, { headers: { accept: "text/html" } });
  if (missing && (missing.res.status !== 404 || mediaType(missing.res) !== "text/html")) add("html_404", `${missing.res.status} ${mediaType(missing.res)}`);
  const favicon = await get("/favicon.ico");
  if (favicon && favicon.res.status >= 400) add("favicon", `/favicon.ico -> ${favicon.res.status}`);

  for (const t of timings) if (t.ms > slowMs) add("slow_response", `${t.path} ${t.ms} ms`, { severity: "warn" });
  const sorted = timings.map(t => t.ms).sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;

  return { ok: !findings.some(f => f.severity === "fail"), origin, liveRevision, deploy: lag, p95Ms: p95, findings };
}

// Optional browser pass. browserFactory returns a Playwright Browser; axe is
// an optional AxeBuilder class. Missing axe is reported, not silently skipped.
export async function browserSmoke({ origin = LIVE_ORIGIN, browserFactory, AxeBuilder = null, pages = PUBLIC_PAGES, viewports = [390, 1280] }) {
  const { findings, add } = makeRecorder();
  if (!AxeBuilder) add("axe_missing", "install @axe-core/playwright to run accessibility checks", { severity: "warn" });
  const browser = await browserFactory();
  try {
    for (const path of pages) for (const width of viewports) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const pageErrors = [], cspErrors = [];
      page.on("pageerror", error => pageErrors.push(String(error?.message ?? error)));
      page.on("console", message => { if (message.type() === "error" && /Content Security Policy/i.test(message.text())) cspErrors.push(message.text()); });
      try {
        await page.goto(new URL(path, origin).href, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(1500);
        for (const error of pageErrors) add("page_error", `${path}@${width}: ${error}`);
        if (cspErrors.length) add("csp_console", `${path}@${width}: ${cspErrors[0]}`);
        const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
        if (width <= 400 && overflow > 1) add("overflow", `${path}@${width}: ${overflow}px wider than the viewport`);
        if (AxeBuilder && width === 1280) {
          const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
          for (const v of result.violations) {
            const severity = ["serious", "critical"].includes(v.impact) ? "fail" : "warn";
            add("axe", `${path}:${v.id} (${v.impact}, ${v.nodes.length} nodes) ${v.help}`, { severity });
          }
        }
      } catch (error) { add("page_load", `${path}@${width}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
  return { ok: !findings.some(f => f.severity === "fail"), findings };
}

function summaryMarkdown(report) {
  const rows = report.findings.map(f => `| ${f.severity === "fail" ? "FAIL" : "warn"} | \`${f.code}\` | ${f.detail.replaceAll("|", "\\|")} | ${f.known ?? ""} |`);
  const deploy = report.deploy ? `${report.deploy.status}${report.deploy.aheadBy ? ` (${report.deploy.aheadBy} commits, ${report.deploy.lagHours} h)` : ""}` : "unknown";
  return [`## Live smoke: ${report.ok ? "pass" : "FAIL"}`, "", `Origin ${report.origin} · live ${report.liveRevision?.slice(0, 8) ?? "?"} · deploy ${deploy} · p95 ${report.p95Ms ?? "?"} ms`, "",
    rows.length ? "| | Code | Detail | Known |\n| --- | --- | --- | --- |\n" + rows.join("\n") : "No findings.", ""].join("\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = new Set(process.argv.slice(2));
  const origin = process.env.ROOM_SMOKE_ORIGIN || LIVE_ORIGIN;
  const report = await liveSmoke({ origin, githubApi: process.env.ROOM_SMOKE_GITHUB_API || GITHUB_API,
    githubToken: process.env.GITHUB_TOKEN || null, maxLagHours: Number(process.env.ROOM_SMOKE_MAX_LAG_HOURS || 24) });
  if (args.has("--browser")) {
    const { chromium } = await import("playwright");
    let AxeBuilder = null;
    try { AxeBuilder = (await import("@axe-core/playwright")).default; } catch { /* reported as axe_missing */ }
    const browserReport = await browserSmoke({ origin, browserFactory: () => chromium.launch({ headless: true }), AxeBuilder });
    report.findings.push(...browserReport.findings);
    report.ok = report.ok && browserReport.ok;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(report));
  process.exit(report.ok ? 0 : 1);
}
