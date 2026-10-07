// OpenAPI live sweep (lane F1, 40-lane audit 2026-10-07).
//
// Mechanical spec-vs-live drift check in BOTH directions. The existing gates
// cover spec-vs-code on the working tree (scripts/openapi-method-accuracy.mjs
// probes a scratch server; scripts/route-docs-check.mjs compares route
// templates); this sweep covers spec-vs-DEPLOYED:
//
//   1. spec -> live: every operation in docs/openapi.yaml is probed against a
//      live origin (prod by default) with read-only probes.
//   2. live -> spec: every /api path in the live-served /openapi.json appears
//      in docs/openapi.yaml (template-normalized).
//
// Probe safety: authenticated routes are probed with their documented method
// and an empty/shape-empty body — auth fails before dispatch, so nothing can
// be written. Open (security: []) mutating routes are NEVER sent their
// documented method; they get an alternate-method existence probe only.
// GET/HEAD are always safe to send.
//
// A scratch server built from the working tree cross-checks live misses:
// served-on-scratch-but-not-live = pending deploy (spec is ahead of the
// deployment); missing on both = spec drift (documented but unserved).
//
// Usage:
//   node scripts/openapi-live-sweep.mjs [--origin https://room.trydemigod.com]
//   node scripts/openapi-live-sweep.mjs --check   # CI mode: no network to a
//        # live origin; sweeps the documented ops against a scratch server
//        # and fails on any drift (method mismatch / not served / undocumented
//        # live-served /api path). The live /openapi.json direction is skipped
//        # in --check (no live origin); run without --check for the full sweep.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { openapiOperations, pathParameterSamples } from "./open-routes.mjs";
import { concrete, classify, serveScratch } from "./openapi-method-accuracy.mjs";
import { templateKey } from "./route-docs-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const alternateMethod = (method) => METHODS.find((m) => m !== method) ?? "GET";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// An operation is "open-write" when it is served without a credential and its
// method could mutate: probing it with the documented method could write, so
// the live sweep only ever sends it an alternate method (existence check).
export const isOpenWrite = (op) =>
  op.security !== null && op.security.length === 0 && WRITE_METHODS.has(op.method);

// Probe one path with one method. Only 404/405 bodies are read (the two
// contract-relevant statuses); everything else is cancelled unread so an
// SSE/stream route can never hang the probe.
export async function rawProbe(origin, path, { method, userAgent }) {
  const body = ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined;
  const res = await fetch(`${origin}${path}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": userAgent ?? "openapi-live-sweep/1.0",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  let json = null;
  if (res.status === 404 || res.status === 405) json = await res.json().catch(() => null);
  else await res.body?.cancel().catch(() => null);
  return { status: res.status, code: json?.error?.code ?? null };
}

// Classify one documented operation against one origin.
// Returns { verdict, detail, status, code } where verdict is one of:
//   ok               — the route answers (any non-404/405, or a 404 that is a
//                      resource miss because an alternate method does not 404)
//   method_mismatch  — documented method answered 405 method_not_allowed
//   not_served       — 404 not_found on the documented method AND on an
//                      alternate method (nothing answers this path)
//   exists_unverified — open-write route on a live origin: alternate method
//                      proves the route exists; the documented method is never
//                      sent (see isOpenWrite).
//   needs_review     — open-write route on a live origin where the alternate
//                      method also 404s. Exact pathname+method matches (the
//                      /api/join family) 404 on a wrong method by design, so
//                      this is NOT proof of absence — it needs a human or a
//                      scratch-server cross-check, not a blind fail.
//
// allowWriteMethods exists for scratch servers only (CI --check mode): the
// store is disposable, so every operation is probed with its documented
// method and the sweep is fully strict. NEVER set it for a live origin.
export async function classifyLive(origin, op, { userAgent, allowWriteMethods = false } = {}) {
  const path = concrete(op.path, pathParameterSamples(op.parameterLines));
  if (isOpenWrite(op) && !allowWriteMethods) {
    const alt = alternateMethod(op.method);
    const probe = await rawProbe(origin, path, { method: alt, userAgent });
    if (probe.status === 404 && probe.code === "not_found") {
      return { verdict: "needs_review", detail: `open-write route: alternate method ${alt} 404s not_found; exact pathname+method matches 404 on a wrong method by design — verify against a scratch server or the deployed source before calling this drift (documented ${op.method} never sent)`, status: probe.status, code: probe.code };
    }
    return { verdict: "exists_unverified", detail: `open-write route: alternate method ${alt} answered ${probe.status} (documented ${op.method} never sent)`, status: probe.status, code: probe.code };
  }
  const first = await rawProbe(origin, path, { method: op.method, userAgent });
  let verdict = classify({ status: first.status, code: first.code, other404: false });
  if (first.status === 404 && first.code === "not_found") {
    const alt = await rawProbe(origin, path, { method: alternateMethod(op.method), userAgent });
    verdict = classify({ status: first.status, code: first.code, other404: alt.status === 404 && alt.code === "not_found" });
  }
  return { verdict: verdict.verdict, detail: verdict.detail, status: first.status, code: first.code };
}

// Direction 2: every /api path in the live-served /openapi.json must have a
// template match in docs/openapi.yaml. Returns the undocumented templates.
// Non-/api discovery paths (/.well-known/*, /llms.txt, /openapi.json itself)
// are static files, not API operations, and are out of scope by design.
export function undocumentedLivePaths(servedOpenapi, documentedPaths) {
  const documented = new Set([...documentedPaths].map(templateKey));
  const missing = [];
  for (const p of Object.keys(servedOpenapi.paths ?? {})) {
    if (!p.startsWith("/api/")) continue;
    if (!documented.has(templateKey(p))) missing.push(p);
  }
  return missing.sort();
}

// Full sweep against an origin. Returns { results, failures, summary }.
// failures are the hard drift verdicts (method_mismatch, not_served on a
// non-open-write op, undocumented live /api paths). needs_review items are
// reported in the summary but do not fail the sweep.
export async function sweepLive({ openapiText, origin, onProgress, userAgent, probeDelayMs = 25, allowWriteMethods = false, skipWorkerOnly = false }) {
  const allOps = openapiOperations(openapiText);
  // x-worker-only operations are served by the Cloudflare worker edge, not by
  // server/http.mjs: a scratch server built from the working tree cannot
  // serve them, so CI --check mode skips them (they are covered by the live
  // sweep against a real deployment instead).
  const ops = skipWorkerOnly ? allOps.filter((o) => !o.workerOnly) : allOps;
  const results = [];
  let i = 0;
  for (const op of ops) {
    i++;
    const r = await classifyLive(origin, op, { userAgent, allowWriteMethods });
    results.push({ method: op.method, path: op.path, workerOnly: !!op.workerOnly, ...r });
    if (onProgress && i % 100 === 0) onProgress(i, ops.length);
    if (probeDelayMs) await new Promise((r2) => setTimeout(r2, probeDelayMs));
  }
  // Direction 2: live-served spec coverage.
  let servedDoc = null, undocumented = [];
  try {
    const res = await fetch(`${origin}/openapi.json`, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": userAgent ?? "openapi-live-sweep/1.0" },
    });
    if (res.ok) {
      servedDoc = await res.json();
      undocumented = undocumentedLivePaths(servedDoc, ops.map((o) => o.path));
    }
  } catch { /* served spec unavailable; direction 2 skipped */ }
  await servedDoc; // no-op; keeps the shape obvious
  const failures = results.filter((r) => r.verdict === "method_mismatch" || r.verdict === "not_served");
  const summary = {
    checked: results.length,
    skippedWorkerOnly: allOps.length - ops.length,
    ok: results.filter((r) => r.verdict === "ok").length,
    existsUnverified: results.filter((r) => r.verdict === "exists_unverified").length,
    needsReview: results.filter((r) => r.verdict === "needs_review").length,
    methodMismatch: results.filter((r) => r.verdict === "method_mismatch").length,
    notServed: results.filter((r) => r.verdict === "not_served").length,
    undocumentedLiveApiPaths: undocumented,
    servedSpecChecked: servedDoc !== null,
  };
  return { results, failures, summary };
}

export function renderSummary({ summary, failures }) {
  const lines = [
    `live sweep: ${summary.checked} documented operations probed${summary.skippedWorkerOnly ? ` (${summary.skippedWorkerOnly} x-worker-only skipped)` : ""}`,
    `  ok=${summary.ok} exists_unverified(open-write)=${summary.existsUnverified} needs_review=${summary.needsReview} method_mismatch=${summary.methodMismatch} not_served=${summary.notServed}`,
    `  served /openapi.json ${summary.servedSpecChecked ? `checked, undocumented live /api paths: ${summary.undocumentedLiveApiPaths.length}` : "unavailable (direction 2 skipped)"}`,
  ];
  for (const f of failures) lines.push(`  FAIL ${f.verdict} ${f.method} ${f.path} — ${f.detail}`);
  for (const p of summary.undocumentedLiveApiPaths) lines.push(`  FAIL undocumented_live ${p}`);
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const originArg = args.indexOf("--origin");
  const origin = originArg >= 0 ? args[originArg + 1] : "https://room.trydemigod.com";
  const checkMode = args.includes("--check");
  const openapiText = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");

  if (checkMode) {
    // CI mode: sweep the documented operations against a scratch server built
    // from this working tree. No live origin is touched.
    const { origin: scratch, close } = await serveScratch();
    try {
      const { failures, summary } = await sweepLive({
        openapiText, origin: scratch, probeDelayMs: 0,
        userAgent: "openapi-live-sweep-check/1.0",
        allowWriteMethods: true, // scratch store is disposable: probe every
        // documented method directly for a fully strict check
        skipWorkerOnly: true, // the edge worker serves these, not the scratch server
        onProgress: (i, n) => console.log(`  ...${i}/${n}`),
      });
      console.log(renderSummary({ summary, failures }));
      if (failures.length || summary.undocumentedLiveApiPaths.length) {
        console.error(`OPENAPI LIVE-SWEEP DRIFT: ${failures.length} operation failures, ${summary.undocumentedLiveApiPaths.length} undocumented live paths`);
        process.exit(1);
      }
      console.log("openapi live-sweep --check: no drift.");
    } finally { await close(); }
  } else {
    const { failures, summary } = await sweepLive({
      openapiText, origin,
      onProgress: (i, n) => console.log(`  ...${i}/${n}`),
    });
    console.log(renderSummary({ summary, failures }));
    if (failures.length || summary.undocumentedLiveApiPaths.length) process.exit(1);
    console.log("openapi live sweep: no drift.");
  }
}
