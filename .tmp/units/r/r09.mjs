// r09: /api/health/tripwires robustness — hostile requests must 4xx, never 500.
import { createRoomServer } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/http.mjs";
import { createAcceptanceFixture } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/scripts/acceptance-fixture.mjs";
import { rmSync } from "node:fs";
const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let bad = 0;
const check = async (name, method, path, body) => {
  const res = await fetch(origin + path, { method, body,
    headers: body ? { "content-type": "application/json" } : {} });
  const ok = res.status >= 400 && res.status < 500 && res.status !== 500;
  console.log(`${ok ? "ok" : "BAD"}: ${name} -> ${res.status}`);
  if (!ok) bad++;
  await res.text().catch(() => {});
};
try {
  await check("POST tripwires", "POST", "/api/health/tripwires", "{}");
  await check("PUT tripwires", "PUT", "/api/health/tripwires");
  await check("huge query", "GET", "/api/health/tripwires?" + "x=".repeat(8000));
  await check("path traversal", "GET", "/api/health/../health/tripwires");
  await check("unknown health path", "GET", "/api/health/nope");
  await check("DELETE tripwires", "DELETE", "/api/health/tripwires");
  const g = await fetch(origin + "/api/health/tripwires");
  const j = await g.json();
  if (g.status !== 200 || !Array.isArray(j.gauges) || j.gauges.length !== 5) { console.log("BAD: happy path broken"); bad++; }
  else console.log("ok: GET happy path -> 200, 5 gauges");
} finally {
  server.closeStreams(); server.closeAllConnections();
  await new Promise(r => server.close(r));
  f.store.close();
  rmSync(f.directory, { recursive: true, force: true });
}
if (bad > 0) { console.log(`R09 FAIL: ${bad} bad responses`); process.exit(1); }
console.log("R09 PASS");
