#!/usr/bin/env node
// PERF-0: repeatable page-weight budget for signed-out pages.
// Loads each page cold (fresh browser context, empty cache) and records the
// request count, transferred bytes, DOM node count and the lab Largest
// Contentful Paint with 4x CPU throttling and network throttling over CDP
// (390 px and narrower: 150 ms RTT, 1.6 Mbps down, 750 Kbps up, close to
// Lighthouse mobile; wider: 40 ms RTT, 10 Mbps). Prints one JSON document.
//
//   node scripts/perf-budget.mjs                         # local server, default pages, 390 + 1280 px
//   node scripts/perf-budget.mjs --pages / --viewport 390
//   node scripts/perf-budget.mjs --network none          # CPU throttling only
//   node scripts/perf-budget.mjs --origin https://room.trydemigod.com --out perf.json
//
// Without --origin it starts a throwaway local createRoomServer on an empty
// temporary database. Local bytes are uncompressed; deployed bytes are what
// the CDN sends (compressed), so compare like with like (docs/PERF-BUDGET.md).
// Read-only: GET requests only, no sign-in, no writes.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PAGES = Object.freeze(["/", "/room", "/about", "/agents", "/receipts"]);
export const DEFAULT_VIEWPORTS = Object.freeze([390, 1280]);
const SETTLE_MS = 1500;
// DevTools-style throttling profiles (bytes per second). "none" disables.
export const NETWORK_PROFILES = Object.freeze({
  mobile: Object.freeze({ latency: 150, downloadThroughput: Math.round(1.6 * 1024 * 1024 / 8), uploadThroughput: Math.round(750 * 1024 / 8) }),
  desktop: Object.freeze({ latency: 40, downloadThroughput: Math.round(10 * 1024 * 1024 / 8), uploadThroughput: Math.round(10 * 1024 * 1024 / 8) })
});
export const networkProfileFor = (width, mode = "auto") => mode === "none" ? null : NETWORK_PROFILES[mode === "auto" ? (width < 600 ? "mobile" : "desktop") : mode];

export function parseArgs(argv) {
  const out = { origin: null, pages: [...DEFAULT_PAGES], viewports: [...DEFAULT_VIEWPORTS], cpu: 4, network: "auto", out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    const need = () => { if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value`); i += 1; return value; };
    if (key === "--origin") out.origin = need().replace(/\/$/, "");
    else if (key === "--pages") out.pages = need().split(",").map(page => page.trim()).filter(Boolean);
    else if (key === "--viewport" || key === "--viewports") out.viewports = need().split(",").map(Number);
    else if (key === "--cpu") out.cpu = Number(need());
    else if (key === "--network") out.network = need();
    else if (key === "--out") out.out = need();
    else if (key === "--help" || key === "-h") out.help = true;
    else throw new Error(`unknown argument ${key}`);
  }
  if (out.origin && !/^https?:\/\//.test(out.origin)) throw new Error("--origin must be an http(s) origin");
  if (!out.pages.length || out.pages.some(page => !page.startsWith("/"))) throw new Error("--pages takes paths that start with /");
  if (!out.viewports.length || out.viewports.some(width => !Number.isInteger(width) || width < 200 || width > 3000)) throw new Error("--viewport takes widths in px, for example 390,1280");
  if (!["auto", "none", "mobile", "desktop"].includes(out.network)) throw new Error("--network takes auto, none, mobile or desktop");
  if (!Number.isFinite(out.cpu) || out.cpu < 1 || out.cpu > 20) throw new Error("--cpu takes a throttling rate from 1 to 20");
  return out;
}

export async function startLocalServer() {
  const [{ RoomStore }, { createRoomServer }] = await Promise.all([import("../server/store.mjs"), import("../server/http.mjs")]);
  const directory = mkdtempSync(join(tmpdir(), "perf-budget-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeStreams?.(); server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function measureOne(browser, origin, path, width, cpu, network) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600, hasTouch: width < 600, deviceScaleFactor: width < 600 ? 2 : 1, serviceWorkers: "block"
  });
  try {
    await context.addInitScript(() => {
      globalThis.__perfLcp = null;
      try {
        new PerformanceObserver(list => {
          const entries = list.getEntries();
          if (entries.length) globalThis.__perfLcp = entries[entries.length - 1].startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch { /* LCP not supported: report null */ }
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const profile = networkProfileFor(width, network);
    if (profile) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...profile });
    const requests = new Set();
    let bytes = 0; let failed = 0;
    cdp.on("Network.requestWillBeSent", event => { if (!event.request.url.startsWith("data:")) requests.add(event.requestId); });
    cdp.on("Network.loadingFinished", event => { if (requests.has(event.requestId)) bytes += event.encodedDataLength || 0; });
    cdp.on("Network.loadingFailed", event => { if (requests.has(event.requestId)) failed += 1; });
    const response = await page.goto(origin + path, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const { lcpMs, domNodes } = await page.evaluate(() => ({ lcpMs: globalThis.__perfLcp, domNodes: globalThis.document.getElementsByTagName("*").length }));
    return {
      page: path, viewport: width, network: profile ? (width < 600 && network === "auto" ? "mobile" : network === "auto" ? "desktop" : network) : "none", status: response?.status() ?? null,
      requests: requests.size, failedRequests: failed, bytes, domNodes,
      lcpMs: typeof lcpMs === "number" ? Math.round(lcpMs) : null
    };
  } finally {
    await context.close();
  }
}

export async function measure({ origin, pages = DEFAULT_PAGES, viewports = DEFAULT_VIEWPORTS, cpu = 4, network = "auto", executablePath } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const results = [];
    for (const width of viewports) for (const path of pages) results.push(await measureOne(browser, origin, path, width, cpu, network));
    return results;
  } finally {
    await browser.close();
  }
}

async function sourceRevision(origin) {
  try {
    const response = await fetch(origin + "/api/version", { signal: AbortSignal.timeout(10000) });
    return response.ok ? (await response.json()).sourceRevision ?? null : null;
  } catch { return null; }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("usage: node scripts/perf-budget.mjs [--origin URL] [--pages /,/about] [--viewport 390,1280] [--cpu 4] [--network auto|none|mobile|desktop] [--out file.json]");
    return 0;
  }
  const local = args.origin ? null : await startLocalServer();
  const origin = args.origin ?? local.origin;
  try {
    const results = await measure({ origin, pages: args.pages, viewports: args.viewports, cpu: args.cpu, network: args.network, executablePath: process.env.ROOM_TEST_CHROMIUM_PATH });
    const report = {
      tool: "scripts/perf-budget.mjs", at: new Date().toISOString(), origin: local ? "local" : origin,
      sourceRevision: await sourceRevision(origin), cpuThrottle: args.cpu, network: args.network, cache: "cold", results
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    if (args.out) writeFileSync(args.out, text);
    process.stdout.write(text);
    return 0;
  } finally {
    await local?.close();
  }
}

export function chromiumAvailable(chromium) {
  const path = process.env.ROOM_TEST_CHROMIUM_PATH || chromium.executablePath();
  return Boolean(path) && existsSync(path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => process.exit(code), error => { console.error(`perf-budget: ${error.message}`); process.exit(1); });
}
