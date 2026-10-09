// WAVE-2000 worker-24 second pass: /api/guest-invites/rotate under the rate limit
// (10/min per IP) — fresh fixture per run, 8s spacing between cases.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
const P = "/api/guest-invites/rotate";
const origin0 = null;

async function go(origin, name, method, headers, body, expect) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  let got, snippet;
  try {
    const r = await fetch(origin + P, { method, headers, body, signal: ctrl.signal });
    got = r.status; snippet = (await r.text()).slice(0, 160);
  } catch (e) { got = e.name === "AbortError" ? "HANG" : "ERROR"; snippet = e.message.slice(0, 160); }
  clearTimeout(t);
  const flag = got === "HANG" || got === "ERROR" || (got >= 500 && got < 600) || (expect != null && got !== expect);
  out.push({ name, method, expect, got, flag, snippet });
  console.log((flag ? "FLAG " : "ok   "), name, "| expect", expect, "got", got, "|", snippet.slice(0, 120));
  await sleep(8000);
}

const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const json = { "Content-Type": "application/json" };
const fakeGuest = "ga1." + "A".repeat(43); // valid format, not a real credential
const B = tok => ({ Authorization: `Bearer ${tok}`, ...json });

await go(origin, "valid-format bearer + malformed json", "POST", B(fakeGuest), '{"roomId":', 400);
await go(origin, "valid-format bearer + text/plain", "POST", { "Content-Type": "text/plain", Authorization: `Bearer ${fakeGuest}` }, '{"roomId":"commons"}', 415);
await go(origin, "valid-format bearer + empty object", "POST", B(fakeGuest), '{}', 422);
await go(origin, "valid-format bearer + unknown room", "POST", B(fakeGuest), '{"roomId":"no-such-room-xyz"}', 410);
await go(origin, "valid-format bearer + commons", "POST", B(fakeGuest), '{"roomId":"commons"}', 410);
await go(origin, "no origin no bearer", "POST", json, '{"roomId":"commons"}', 403);
await go(origin, "duplicate keys", "POST", B(fakeGuest), '{"roomId":"a","roomId":"commons"}', 410);
await go(origin, "head", "HEAD", { Authorization: `Bearer ${fakeGuest}` }, null, null);

server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
f.store.close();
const fs = await import("node:fs");
fs.writeFileSync(new URL("./fuzz2-results.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("flagged:", out.filter(o => o.flag).length, "/", out.length);
