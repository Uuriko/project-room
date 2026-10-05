#!/usr/bin/env node
// Prod flow probes: read-only checks of the paths a person or agent walks first.
// Exit 1 on any failure. No credentials. No writes. Safe to run on a schedule.
// Usage: node scripts/prod-flow-probes.mjs [--json]
const ROOM = process.env.ROOM_ORIGIN ?? "https://room.trydemigod.com";
const WWW = process.env.WWW_ORIGIN ?? "https://www.trydemigod.com";
const UA = "project-room-prod-probe/1";

async function get(url, init = {}) {
  const res = await fetch(url, { redirect: "follow", ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const digest = async s => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex").slice(0, 12);

export const PROBES = [
  ["room version is ok", async () => { const r = await get(`${ROOM}/api/version`); return r.status === 200 && JSON.parse(r.text).status === "ok"; }],
  ["public work tasks list", async () => (await get(`${ROOM}/api/public-work/tasks`)).status === 200],
  ["MCP server card", async () => (await get(`${ROOM}/.well-known/mcp.json`)).status === 200],
  ["room llms.txt", async () => (await get(`${ROOM}/llms.txt`)).status === 200],
  ["matchmaking route is mounted (auth error, not 404)", async () => {
    const r = await get(`${ROOM}/api/rooms/probe-room/matchmaking/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return r.status !== 404;
  }],
  ["demigod home", async () => (await get(`${WWW}/`)).status === 200],
  ["demigod roles", async () => (await get(`${WWW}/roles`)).status === 200],
  ["room door on www", async () => (await get(`${WWW}/room`)).status === 200],
  // /join and /hire share the home HTML by design; the page opens the right form on load.
  ["/join serves the talent form entry", async () => { const r = await get(`${WWW}/join`); return r.status === 200 && /data-open="talent"/.test(r.text); }],
  ["/hire serves the company form entry", async () => { const r = await get(`${WWW}/hire`); return r.status === 200 && /data-open="company"/.test(r.text); }],
];

export async function runProbes() {
  const results = [];
  for (const [name, fn] of PROBES) {
    let ok = false, error = null;
    try { ok = Boolean(await fn()); } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
    results.push({ name, ok, error });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runProbes();
  if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.error ? `  (${r.error})` : ""}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
