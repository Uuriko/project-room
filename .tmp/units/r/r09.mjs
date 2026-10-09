// r09: /api/health/tripwires robustness — hostile requests must 4xx, never 500.
import { createRoomServer } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/http.mjs";
import { createAcceptanceFixture } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/scripts/acceptance-fixture.mjs";
import { rmSync } from "node:fs";
const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let bad = 0;
const check = async (name, method, path, body, want) => {
  const res = await fetch(origin + path, { method, body,
    headers: body ? { "content-type": "application/json" } : {} });
  const ok = res.status === want && res.status !== 500;
  console.log(`${ok ? "ok" : "BAD"}: ${name} -> ${res.status} (want ${want})`);
  if (!ok) bad++;
  await res.text().catch(() => {});
};
try {
  await check("POST tripwires", "POST", "/api/health/tripwires", "{}", 405);
  await check("PUT tripwires", "PUT", "/api/health/tripwires", null, 405);
  await check("DELETE tripwires", "DELETE", "/api/health/tripwires", null, 405);
  await check("unknown health path", "GET", "/api/health/nope", null, 404);
  // The endpoint ignores query strings: a huge query must still 200, never 500.
  await check("huge query", "GET", "/api/health/tripwires?" + "x=".repeat(8000), null, 200);
  // Encoded traversal normalizes back onto the same safe route (200). The
  // routing/normalization behavior belongs to server/http.mjs (out of slice);
  // the invariant under test is never-500.
  await check("encoded traversal", "GET", "/api/health/%2e%2e/health/tripwires", null, 200);
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
