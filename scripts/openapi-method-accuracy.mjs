// Method-level OpenAPI contract accuracy check (TASKS.md task 16).
//
// scripts/route-docs-check.mjs (the template gate) only compares route
// *templates*: it cannot see method-level drift — e.g. docs/openapi.yaml
// documenting POST on a route the server serves GET-only (the #594
// dogfood bug class). This check closes that half: it boots a scratch
// server (RoomStore + initialRoom in a temp dir, discarded afterwards; no
// fixture or production state is touched) and probes every operation
// declared in docs/openapi.yaml with its documented method:
//
//   documented method -> 405 method_not_allowed        => method mismatch (FAIL)
//   documented method -> 404 not_found, and an        => route not served at all (FAIL)
//     alternate method also 404s
//   documented method -> 404 not_found but an         => served; the 404 is a
//     alternate method does not 404                   resource miss inside the handler (OK)
//   anything else (2xx / 400 / 401 / 403 / 409 / 422  => contract holds (OK)
//   / 429)
//
// A 401/422/400/409/422 answer proves the route matched and dispatched; only
// 405 and the double-404 speak to the contract itself. Probes are anonymous
// with empty/shape-empty bodies so nothing persistent is created (and the
// scratch store is deleted either way).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { openapiOperations, pathParameterSamples, routeCandidates } from "./open-routes.mjs";

// "{roomId}" under /api/rooms/ becomes the seeded room. Every other path
// parameter becomes a dummy value, because route matching is by shape - except
// where the server constrains the segment and the spec says what it allows
// (an `enum` or an `example`), in which case the probe uses that. Without it a
// constrained segment 404s on every method and the check reports a served
// route as unserved.
export const concrete = (template, samples = {}) => template
  .replace(/^\/api\/rooms\/\{[^}]*\}/, "/api/rooms/commons")
  .replace(/\{([^}]*)\}/g, (_, name) => encodeURIComponent(samples[name] ?? "probe-id"));

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const alternateMethod = method => METHODS.find(m => m !== method) ?? "GET";

// Verdict for one probe pair. `other404` is whether the alternate-method
// probe also 404'd with not_found.
export function classify({ status, code, other404 }) {
  if (status === 405) return { verdict: "method_mismatch", detail: "documented method answered 405 method_not_allowed" };
  if (status === 404 && code === "not_found") {
    return other404
      ? { verdict: "not_served", detail: "no method answers this path (404 not_found on two methods)" }
      : { verdict: "ok", detail: "route serves the path; the 404 is a resource miss inside the handler" };
  }
  return { verdict: "ok", detail: `served (${status}${code ? " " + code : ""})` };
}

async function raw(origin, path, { method }) {
  const body = ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined;
  const res = await fetch(`${origin}${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
  // Only the two contract-relevant statuses need their JSON body; every
  // other body is cancelled unread (so an SSE/stream route can never hang
  // the probe on an unauthenticated 401).
  let json = null;
  if (res.status === 404 || res.status === 405) json = await res.json().catch(() => null);
  else await res.body?.cancel().catch(() => null);
  return { status: res.status, code: json?.error?.code ?? null };
}

export async function serveScratch() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-method-accuracy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  };
  return { origin, close };
}

export async function probeMethodAccuracy({ openapi }) {
  const operations = openapiOperations(openapi).filter(op => !op.workerOnly);
  if (operations.length < 50) throw new Error("openapi parse sanity failed");
  const { origin, close } = await serveScratch();
  const results = [];
  try {
    for (const op of operations) {
      const path = concrete(op.path, pathParameterSamples(op.parameterLines));
      const first = await raw(origin, path, { method: op.method });
      let verdict = classify({ status: first.status, code: first.code, other404: false });
      if (first.status === 404 && first.code === "not_found") {
        const alt = await raw(origin, path, { method: alternateMethod(op.method) });
        verdict = classify({ status: first.status, code: first.code, other404: alt.status === 404 && alt.code === "not_found" });
      }
      results.push({ method: op.method, path: op.path, security: op.security, ...verdict });
    }
  } finally {
    await close();
  }
  const failures = results.filter(r => r.verdict !== "ok");
  return { results, failures, checked: results.length };
}

export function renderReport({ results, failures, served }) {
  const lines = [
    "# OpenAPI contract accuracy report",
    "",
    `Generated ${new Date().toISOString()} by scripts/openapi-method-accuracy.mjs (TASKS.md task 16).`,
    "Method: every operation in docs/openapi.yaml is probed against a scratch",
    "server with its documented method; 405 on the documented method (or a",
    "double-404 on an alternate method) is a contract mismatch. Path-template",
    "coverage is enforced separately by scripts/route-docs-check.mjs.",
    "",
    "## Summary",
    "",
    `- Documented operations: ${results.length}`,
    `- Unique paths: ${new Set(results.map(r => r.path)).size}`,
    `- Served route templates (static): ${served}`,
    `- Contract mismatches: ${failures.length}`,
    "",
  ];
  if (failures.length) {
    lines.push("## Mismatches", "");
    for (const f of failures) lines.push(`- **${f.method} ${f.path}** — ${f.verdict}: ${f.detail}`);
    lines.push("");
  }
  lines.push("## Operations", "", "| Method | Path | Security | Verdict |", "| --- | --- | --- | --- |");
  for (const r of results) {
    const sec = r.security === null ? "default" : r.security.length === 0 ? "open" : r.security.join(",");
    lines.push(`| ${r.method} | \`${r.path}\` | ${sec} | ${r.verdict} |`);
  }
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const openapi = readFileSync(join(root, "docs/openapi.yaml"), "utf8");
  const { results, failures, checked } = await probeMethodAccuracy({ openapi });
  if (process.argv.includes("--report")) {
    const served = new Set(routeCandidates(readFileSync(join(root, "server/http.mjs"), "utf8"))).size;
    writeFileSync(join(root, "docs/OPENAPI-CONTRACT-REPORT.md"), renderReport({ results, failures, served }));
    console.log(`Report written to docs/OPENAPI-CONTRACT-REPORT.md (${checked} operations).`);
  }
  if (failures.length) {
    console.error("OpenAPI method-accuracy mismatches:");
    for (const f of failures) console.error(`  ${f.method} ${f.path}: ${f.verdict} — ${f.detail}`);
    process.exit(1);
  }
  console.log(`OpenAPI method accuracy: ${checked} documented operations, all served with their documented method.`);
}
