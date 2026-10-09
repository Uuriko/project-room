// WORKER-15 follow-up: re-run the h2 cases that were masked by the 20/min
// per-address rate limiter, on fresh servers (<=12 cases per boot).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const TIMEOUT = 10000;
const J = o => JSON.stringify(o);
const findings = [], results = [];

async function boot() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-w15b-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey, directory };
}
async function close(s, store, dir) {
  try { s.closeStreams(); s.closeAllConnections(); await new Promise(r => s.close(r)); } catch {}
  try { store.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
async function req(origin, c) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(origin + c.path, { method: c.method, headers: c.headers || {}, body: c.body, signal: ctl.signal });
    const text = await res.text().catch(() => "");
    let code = null, detail = null;
    try { const e = JSON.parse(text)?.error; code = e?.code ?? null; detail = e?.message ?? null; } catch {}
    return { status: res.status, code, detail, ms: Date.now() - started };
  } catch (e) { return { status: "FETCH-ERROR", code: e.name, detail: e.message, ms: Date.now() - started }; }
  finally { clearTimeout(t); }
}

const rid = `w15b-${Date.now()}`;
const CASES = [
  { name: "h2:extra-field", body: { roomId: "commons", evil: 1 }, expect: [422] },
  { name: "h2:proto-pollution", raw: '{"roomId":"commons","__proto__":{"x":1}}', expect: [201, 422] },
  { name: "h2:requestid-short", body: { roomId: "commons", requestId: "abc" }, expect: [422] },
  { name: "h2:requestid-badchars", body: { roomId: "commons", requestId: "bad id!!" }, expect: [422] },
  { name: "h2:requestid-nonstring", body: { roomId: "commons", requestId: 12345678 }, expect: [422] },
  { name: "h2:requestid-minlen", body: { roomId: "commons", requestId: "abcdefgh" }, expect: [201] },
  { name: "h2:valid-mint", body: { roomId: "commons", requestId: rid }, expect: [201] },
  { name: "h2:idempotent-retry", body: { roomId: "commons", requestId: rid }, expect: [200], needs: rid },
  { name: "h2:idempotent-conflict", body: { roomId: "commons", requestId: rid, maxDepth: 2 }, expect: [409], needs: rid },
  { name: "h2:valid-keyless", body: { roomId: "commons" }, expect: [201] },
  { name: "h2:malformed-json", raw: "{oops", expect: [400] },
  { name: "h2:huge-json", body: { roomId: "commons", pad: "p".repeat(2_000_000) }, expect: [413, 422] },
  { name: "h2:no-origin", body: { roomId: "commons" }, noOrigin: true, expect: [201, 403] },
];

async function main() {
  let b = await boot();
  let used = 0;
  const minted = new Set();
  for (const c of CASES) {
    if (used >= 12) { await close(b.server, b.store, b.directory); b = await boot(); used = 0; }
    if (c.needs && !minted.has(c.needs)) {
      // mint the prerequisite on this fresh server first
      const bh0 = { "Content-Type": "application/json", Origin: b.origin, Authorization: `Bearer ${b.ownerKey}` };
      await req(b.origin, { method: "POST", path: "/api/referral-invites/mint", headers: bh0, body: J({ roomId: "commons", requestId: c.needs }) });
      used++; minted.add(c.needs);
    }
    const headers = { "Content-Type": "application/json", ...(c.noOrigin ? {} : { Origin: b.origin }), Authorization: `Bearer ${b.ownerKey}` };
    const r = await req(b.origin, { method: "POST", path: "/api/referral-invites/mint", headers, body: c.raw ?? J(c.body) });
    used++;
    const ok = c.expect.includes(r.status);
    const rec = { name: c.name, status: r.status, code: r.code, detail: r.detail, ms: r.ms, expect: c.expect, ok };
    results.push(rec);
    if (!ok) findings.push(rec);
    console.log((ok ? "ok  " : "FAIL") + " " + c.name + " -> " + r.status + (r.code ? " " + r.code : "") + (r.detail ? " | " + String(r.detail).slice(0, 120) : ""));
  }
  await close(b.server, b.store, b.directory);
  const fs = await import("node:fs");
  fs.writeFileSync("worker-15/results-h2b.json", JSON.stringify({ total: results.length, failed: findings.length, results, findings }, null, 1));
  console.log(`total=${results.length} failed=${findings.length}`);
}
main().catch(e => { console.error("HARNESS-ERROR", e); process.exit(1); });
