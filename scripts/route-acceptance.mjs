#!/usr/bin/env node
// scripts/route-acceptance.mjs — prove a route is mounted before a receipt
// says it is live.
//
// On 2026-09-27 two PRs (#1136, #1138) merged with receipts naming GET /events
// and GET /board as endpoints, but the module was imported only by its tests,
// so both paths 404'd on every door. This check starts the real HTTP server on
// a fresh local store and sends each named route one unauthenticated request.
// A route passes when the server answers with anything other than its generic
// unmatched-route 404 ("Not found"). 401, 403, 405, 409, 422 and a
// resource-specific 404 all prove the route is wired; they are not judged.
//
// Usage:
//   node scripts/route-acceptance.mjs "GET /api/rooms/{roomId}/board" "POST /a2a"
//   node scripts/route-acceptance.mjs --file routes.txt      (one "METHOD /path" per line)
//   node scripts/route-acceptance.mjs --json ...
// Placeholders like {roomId} become "commons". Exit 1 when any route is unmounted.
// Limit: a family that validates input before routing (e.g. /api/inbox/*)
// can answer 422 for a path it does not serve, so a pass there is weaker.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function parseRoutes(lines) {
  return lines.map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => {
    const [method, path, ...rest] = line.split(/\s+/);
    if (!METHODS.has(method?.toUpperCase()) || !path?.startsWith("/") || rest.length) throw new Error(`Expected "METHOD /path", got "${line}"`);
    return { method: method.toUpperCase(), path, url: path.replace(/\{[^}/]+\}/g, "commons") };
  });
}

// The generic unmatched-route answer: 404 with code not_found and exactly
// "Not found", or a plain-text 404 from the static fallback.
export function isUnmounted(status, bodyText) {
  if (status !== 404) return false;
  try {
    const body = JSON.parse(bodyText);
    const error = body.error ?? body;
    return error?.code === "not_found" && /^(Not found|Inbox route not found\.)$/.test(error?.message ?? "");
  } catch { return /^not found\.?\s*$/i.test(bodyText.trim()) || bodyText.trim() === ""; }
}

export async function checkRoutes(routes) {
  const { RoomStore } = await import("../server/store.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const directory = mkdtempSync(join(tmpdir(), "route-acceptance-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const results = [];
    for (const route of routes) {
      const hasBody = !["GET", "HEAD", "OPTIONS"].includes(route.method);
      const response = await fetch(origin + route.url, {
        method: route.method, redirect: "manual",
        headers: { Origin: origin, ...(hasBody ? { "Content-Type": "application/json" } : {}) },
        ...(hasBody ? { body: "{}" } : {})
      });
      const text = route.method === "HEAD" ? "" : await response.text();
      results.push({ route: `${route.method} ${route.path}`, status: response.status, mounted: !isUnmounted(response.status, text) });
    }
    return results;
  } finally {
    server.closeStreams?.(); server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
}

async function main(argv) {
  const json = argv.includes("--json");
  const fileAt = argv.indexOf("--file");
  const lines = fileAt >= 0 ? readFileSync(argv[fileAt + 1], "utf8").split("\n")
    : argv.filter(arg => arg !== "--json");
  const routes = parseRoutes(lines);
  if (!routes.length) throw new Error('Name at least one route, e.g. "GET /api/rooms/{roomId}/board"');
  const results = await checkRoutes(routes);
  if (json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else for (const r of results) process.stdout.write(`${r.mounted ? "mounted  " : "MISSING  "} ${r.status}  ${r.route}\n`);
  process.exitCode = results.every(r => r.mounted) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
