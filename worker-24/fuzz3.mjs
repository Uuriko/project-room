// WAVE-2000 worker-24 third pass: deep edges on POST /api/rooms/{roomId}/commands
// and path-length edges on the room router. Fails open -> writes fuzz3-results.json.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const out = [];
async function go(origin, name, method, path, headers, body, expect) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  let got, snippet;
  try {
    const r = await fetch(origin + path, { method, headers, body, signal: ctrl.signal });
    got = r.status; snippet = (await r.text()).slice(0, 160);
  } catch (e) { got = e.name === "AbortError" ? "HANG" : "ERROR"; snippet = e.message.slice(0, 160); }
  clearTimeout(t);
  const flag = got === "HANG" || got === "ERROR" || (got >= 500 && got < 600) || (expect != null && got !== expect);
  out.push({ name, method, path: path.slice(0, 70), expect, got, flag, snippet });
  console.log((flag ? "FLAG " : "ok   "), name, "| expect", expect, "got", got, "|", snippet.slice(0, 110));
}

const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const json = { "Content-Type": "application/json", Authorization: `Bearer ${f.keys.owner}` };
const P = "/api/rooms/commons/commands";

// prototype pollution probe
await go(origin, "proto key in data", "POST", P, json,
  '{"id":"pp1","type":"message.posted","data":{"__proto__":{"pp_polluted":1}}}', null);
console.log("POLLUTION-CHECK:", ({}).pp_polluted === undefined ? "clean" : "POLLUTED");
await go(origin, "constructor key in data", "POST", P, json,
  '{"id":"pp2","type":"message.posted","data":{"constructor":{"prototype":{"pp2":1}}}}}', null);
console.log("POLLUTION-CHECK2:", ({}).pp2 === undefined ? "clean" : "POLLUTED");
await go(origin, "data as string", "POST", P, json,
  JSON.stringify({ id: "e1", type: "message.posted", data: "not-an-object" }), null);
await go(origin, "id as number", "POST", P, json,
  JSON.stringify({ id: 42, type: "message.posted", data: {} }), null);
await go(origin, "type 100KB string", "POST", P, json,
  JSON.stringify({ id: "e2", type: "x".repeat(100000), data: {} }), null);
await go(origin, "data 1000 keys", "POST", P, json,
  JSON.stringify({ id: "e3", type: "message.posted", data: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["k" + i, i])) }), null);
await go(origin, "auth query param bogus", "POST", P + "?auth=bogus", json,
  JSON.stringify({ id: "e4", type: "message.posted", data: {} }), null);
await go(origin, "roomId 385 chars", "GET", `/api/rooms/${"r".repeat(385)}/capabilities`, { Authorization: `Bearer ${f.keys.owner}` }, null, 404);
await go(origin, "roomId 384 chars", "GET", `/api/rooms/${"r".repeat(384)}/capabilities`, { Authorization: `Bearer ${f.keys.owner}` }, null, 403);
await go(origin, "roomId encoded slash", "GET", "/api/rooms/a%2Fb/capabilities", { Authorization: `Bearer ${f.keys.owner}` }, null, null);
await go(origin, "commands valid baseline", "POST", P, json,
  JSON.stringify({ id: "base1", type: "message.posted", data: { text: "hello" } }), null);
await go(origin, "commands dup id replay", "POST", P, json,
  JSON.stringify({ id: "base1", type: "message.posted", data: { text: "hello" } }), null);

server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
f.store.close();
const fs = await import("node:fs");
fs.writeFileSync(new URL("./fuzz3-results.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("flagged:", out.filter(o => o.flag).length, "/", out.length);
