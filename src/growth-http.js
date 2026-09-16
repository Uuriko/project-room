// Track C slice C14 — Growth HTTP surface.
//
// Read-only JSON endpoints over the C2 collector, C5 summaries, the C7
// digest renderer, and C13 scheduler status. Every route here is a pure
// read: no event emission, no state mutation, no timers, no I/O. A GET never
// changes observable state.
//
// The module never touches the scheduler object itself — it only calls the
// getSchedulerStatus() getter supplied at creation, so no internal handles
// (timers, watchers) can leak into responses. Unknown /growth/* subpaths
// are an explicit 404, not a fall-through, so the surface stays explicit.

import { summarize } from "./growth-summary.js";
import { renderDigest, DIGEST_FORMATS } from "./growth-digest.js";

export const GROWTH_ROUTE_PREFIX = "/growth/";
export const GROWTH_ROUTES = Object.freeze(["/growth/summary", "/growth/digest", "/growth/health"]);

const isCollector = value =>
  value !== null &&
  typeof value === "object" &&
  typeof value.query === "function" &&
  typeof value.stats === "function";

const isSearchParams = value =>
  value !== null && typeof value === "object" && typeof value.get === "function";

// Create the read-only growth HTTP surface over a C2 collector.
// getSchedulerStatus is an optional () => { running, tickCount, intervalMs }
// getter; it is called per request so the status is always current, and the
// scheduler object itself is never exposed.
export function createGrowthHttp({ collector, getSchedulerStatus } = {}) {
  if (!isCollector(collector)) {
    throw new TypeError("growth-http: collector must be a collector object exposing query() and stats()");
  }
  if (getSchedulerStatus !== undefined && typeof getSchedulerStatus !== "function") {
    throw new TypeError("growth-http: getSchedulerStatus must be a function");
  }

  // Scheduler status, defensive: a throwing or misshapen getter degrades to
  // a stopped/zeroed status rather than failing the health route.
  function schedulerStatus() {
    try {
      const status = getSchedulerStatus ? getSchedulerStatus() : null;
      if (status === null || typeof status !== "object") {
        return { running: false, tickCount: 0, intervalMs: 0 };
      }
      return {
        running: status.running === true,
        tickCount: Number.isInteger(status.tickCount) && status.tickCount >= 0 ? status.tickCount : 0,
        intervalMs: typeof status.intervalMs === "number" && Number.isFinite(status.intervalMs) ? status.intervalMs : 0
      };
    } catch {
      return { running: false, tickCount: 0, intervalMs: 0 };
    }
  }

  // Collector size only: totals, never envelopes, never internals.
  function collectorSize() {
    const stats = collector.stats();
    return { total: stats.total, recorded: stats.recorded, dropped: stats.dropped };
  }

  function summaryRoute() {
    return { status: 200, body: summarize(collector, {}) };
  }

  function digestRoute(searchParams) {
    const format = isSearchParams(searchParams) ? (searchParams.get("format") ?? "text") : "text";
    if (!DIGEST_FORMATS.includes(format)) {
      return { status: 400, body: { error: "unsupported_format", supported: [...DIGEST_FORMATS] } };
    }
    return { status: 200, body: { format, digest: renderDigest(summarize(collector, {}), { format }) } };
  }

  function healthRoute() {
    return {
      status: 200,
      body: { status: "ok", scheduler: schedulerStatus(), collector: collectorSize() }
    };
  }

  // Handle one request. Returns { status, body } for /growth/* paths and
  // null for anything else so the caller can fall through to its own routing.
  // Only GET is served; anything else on a known route is a 405.
  function handle(pathname, method, searchParams) {
    if (typeof pathname !== "string" || !pathname.startsWith(GROWTH_ROUTE_PREFIX)) return null;
    if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    if (pathname === "/growth/summary") return summaryRoute();
    if (pathname === "/growth/digest") return digestRoute(searchParams);
    if (pathname === "/growth/health") return healthRoute();
    return { status: 404, body: { error: "not_found" } };
  }

  return Object.freeze({ handle });
}
