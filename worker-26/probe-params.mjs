#!/usr/bin/env node
// WORKER 26 supplemental probe: focused edge cases for
// GET /api/opportunities.json (http.mjs:1820) — the guild's generic target-25
// cases never exercise the route's real params (?room, ?limit, ?since).
// Boots the acceptance fixture, runs cases, prints status/body-head lines.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = [];

async function hit(method, path, { headers = {}, body = null } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  const start = Date.now();
  try {
    const r = await fetch(base + path, { method, headers, body, signal: ctl.signal, redirect: "manual" });
    const text = await r.text().catch(() => "");
    out.push({ method, path, status: r.status, ms: Date.now() - start, head: text.slice(0, 160).replace(/\n/g, " ") });
  } catch (e) {
    out.push({ method, path, status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR", ms: Date.now() - start, head: String(e.message).slice(0, 120) });
  } finally { clearTimeout(t); }
}

const g = (p, o) => hit("GET", p, o);
const J = { "Content-Type": "application/json" };

// baseline
await g("/api/opportunities.json");
// limit edges
for (const lim of ["0", "-5", "abc", "1e3", "1.5", "Infinity", "NaN", "0x10", " 12 ", "9999999999999999999999", "", "null"]) {
  await g(`/api/opportunities.json?limit=${encodeURIComponent(lim)}`);
}
await g("/api/opportunities.json?limit=1&limit=2");       // dup key
await g("/api/opportunities.json?limit[]=5");             // array-style key
// since edges
for (const s of ["0", "-1", "abc-not-a-date", "2026-13-99", "2026-10-09T00:00:00Z", "1780000000000", "1e20", "Infinity", "", " ", "null", "2026-10-09"]) {
  await g(`/api/opportunities.json?since=${encodeURIComponent(s)}`);
}
// room edges
await g("/api/opportunities.json?room=nonexistent-room-xyz");
await g(`/api/opportunities.json?room=${"r".repeat(128)}`);
await g(`/api/opportunities.json?room=${"r".repeat(129)}`);
await g("/api/opportunities.json?room=" + encodeURIComponent("' OR '1'='1"));
await g("/api/opportunities.json?room=" + encodeURIComponent("a/b/c"));
await g("/api/opportunities.json?room=" + encodeURIComponent("🪔"));
await g("/api/opportunities.json?room=&limit=&since=");
await g("/api/opportunities.json?room=1&room=2");
// combined
await g("/api/opportunities.json?room=x&limit=abc&since=nope&extra=1");
// path edges
await g("/api/opportunities.json/");
await g("/API/OPPORTUNITIES.JSON");
await g("/api/opportunities.json%2f");
await g("//api/opportunities.json");
await g("/%2e/api/opportunities.json");
await g("/api//opportunities.json");
await g("/api/opportunities.json?");
await g("/api/opportunities.JSON");
await g("/api/opportunities.json%00");
// method edges
await hit("HEAD", "/api/opportunities.json");
await hit("OPTIONS", "/api/opportunities.json");
await hit("GET", "/api/opportunities.json", { body: '{"a":1}', headers: J });
await hit("POST", "/api/opportunities.json", { body: '{"a":1}', headers: J });
await hit("POST", "/api/opportunities.json", { body: null, headers: {} });
// conditional / cache headers
await g("/api/opportunities.json", { headers: { "If-None-Match": "*" } });
await g("/api/opportunities.json", { headers: { Range: "bytes=0-10" } });
await g("/api/opportunities.json", { headers: { Accept: "text/html" } });
// unknown params
await g("/api/opportunities.json?LIMIT=5");
await g("/api/opportunities.json?" + "x".repeat(8000) + "=1");

for (const r of out) console.log(`${r.status}\t${r.ms}ms\t${r.method} ${r.path.slice(0, 90)}\t${r.head}`);

try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
try { fixture.store.close(); } catch {}
