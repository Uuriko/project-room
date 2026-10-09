// WAVE-2000 guild-02 worker-24 API fuzzer.
// Shard 24 (index mod 50 == 23) of the sorted route-handler list in server/http.mjs:
//   idx 23  -> line 1631: GET/HEAD /api/ready
//   idx 73  -> line 2519: POST /api/guest-invites/rotate
//   idx 123 -> line 4039: GET /api/rooms/{roomId}/capabilities
//   idx 173 -> line 4529: GET /api/rooms/{roomId}/agent-pause
//   idx 223 -> line 4880: POST /api/rooms/{roomId}/commands
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const TIMEOUT_MS = 6000;
const results = [];
let crashedAt = null;

function record(group, name, method, path, expect, got, extra) {
  const flag = got === "HANG" || got === "ERROR" || got === "CRASH" || (got >= 500 && got < 600) || (expect != null && got !== expect);
  results.push({ group, name, method, path, expect, got, flag, extra: String(extra ?? "").slice(0, 200) });
}

async function rawFetch(origin, method, path, { headers = {}, body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(origin + path, { method, headers, body, signal: ctrl.signal });
    let snippet = "";
    try { snippet = (await res.text()).slice(0, 200); } catch { snippet = "<body unreadable>"; }
    return { status: res.status, snippet };
  } catch (e) {
    if (e.name === "AbortError") return { status: "HANG", snippet: `no response in ${TIMEOUT_MS}ms` };
    return { status: "ERROR", snippet: e.message.slice(0, 200) };
  } finally { clearTimeout(timer); }
}

async function alive(origin) {
  try { const r = await rawFetch(origin, "GET", "/api/health"); return r.status === 200; } catch { return false; }
}

const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const owner = f.keys.owner;
const bearer = { Authorization: `Bearer ${owner}` };
const json = { "Content-Type": "application/json" };
const roomId = "commons";

// ---------------- 1. /api/ready ----------------
{
  const G = "api-ready";
  let r = await rawFetch(origin, "GET", "/api/ready");
  record(G, "get ok", "GET", "/api/ready", 200, r.status, r.snippet);
  r = await rawFetch(origin, "HEAD", "/api/ready");
  record(G, "head ok", "HEAD", "/api/ready", 200, r.status, r.snippet);
  r = await rawFetch(origin, "POST", "/api/ready");
  record(G, "post method", "POST", "/api/ready", null, r.status, r.snippet);
  r = await rawFetch(origin, "GET", "/api/ready?x=1&x=1&" + "y=".repeat(50));
  record(G, "junk query", "GET", "/api/ready?...", 200, r.status, r.snippet);
  r = await rawFetch(origin, "GET", "/API/READY");
  record(G, "uppercase path", "GET", "/API/READY", null, r.status, r.snippet);
  r = await rawFetch(origin, "OPTIONS", "/api/ready");
  record(G, "options", "OPTIONS", "/api/ready", null, r.status, r.snippet);
  if (!(await alive(origin))) crashedAt = "after api-ready batch";
}

// ---------------- 2. /api/guest-invites/rotate ----------------
{
  const G = "guest-invites-rotate";
  const P = "/api/guest-invites/rotate";
  const cases = [
    ["no auth at all", "POST", null, { Origin: origin }, 401],
    ["text/plain body", "POST", '{"roomId":"commons"}', { "Content-Type": "text/plain", Origin: origin }, 415],
    ["malformed json", "POST", '{"roomId":', { ...json, Origin: origin }, 400],
    ["json array", "POST", '["roomId"]', { ...json, Origin: origin }, 401],
    ["json null", "POST", 'null', { ...json, Origin: origin }, 401],
    ["json string", "POST", '"x"', { ...json, Origin: origin }, 401],
    ["empty object unauth", "POST", '{}', { ...json, Origin: origin }, 401],
    ["empty object bearer", "POST", '{}', { ...json, ...bearer }, 422],
    ["roomId number", "POST", '{"roomId":123}', { ...json, ...bearer }, 422],
    ["roomId null", "POST", '{"roomId":null}', { ...json, ...bearer }, 422],
    ["roomId empty", "POST", '{"roomId":""}', { ...json, ...bearer }, 422],
    ["roomId array", "POST", '{"roomId":["commons"]}', { ...json, ...bearer }, 422],
    ["roomId traversal", "POST", '{"roomId":"../secrets"}', { ...json, ...bearer }, 422],
    ["roomId huge", "POST", `{"roomId":"${"x".repeat(5000)}"}`, { ...json, ...bearer }, 422],
    ["roomId valid unknown room", "POST", '{"roomId":"no-such-room-xyz"}', { ...json, ...bearer }, null],
    ["roomId commons", "POST", `{"roomId":"${roomId}"}`, { ...json, ...bearer }, null],
    ["extra keys", "POST", `{"roomId":"${roomId}","evil":true}`, { ...json, ...bearer }, null],
    ["duplicate keys", "POST", '{"roomId":"a","roomId":"commons"}', { ...json, ...bearer }, null],
    ["GET method", "GET", null, { ...bearer }, null],
    ["bearer malformed", "POST", `{"roomId":"${roomId}"}`, { ...json, Authorization: "Bearer short" }, 401],
    ["oversize body", "POST", `{"roomId":"${roomId}","pad":"${"p".repeat(300000)}"}`, { ...json, ...bearer }, 413],
  ];
  for (const [name, method, body, headers, expect] of cases) {
    const r = await rawFetch(origin, method, P, { headers, body });
    record(G, name, method, P, expect, r.status, r.snippet);
    if (!(await alive(origin))) { crashedAt = `after ${G}:${name}`; break; }
  }
}

// ---------------- 3. /api/rooms/{roomId}/capabilities ----------------
{
  const G = "capabilities";
  const P = `/api/rooms/${roomId}/capabilities`;
  const cases = [
    ["no auth", "GET", P, {}, 401],
    ["owner", "GET", P, bearer, 200],
    ["unknown room", "GET", "/api/rooms/no-such-room-xyz/capabilities", bearer, 404],
    ["room traversal", "GET", "/api/rooms/../capabilities", bearer, null],
    ["search normal", "GET", P + "?search=test", bearer, 200],
    ["search special", "GET", P + "?search=%22%3E%3Cscript%3E%F0%9F%98%80", bearer, 200],
    ["search nul", "GET", P + "?search=a%00b", bearer, 200],
    ["search dup", "GET", P + "?search=a&search=b", bearer, null],
    ["search many dup", "GET", P + "?search=" + "a&search=".repeat(200), bearer, null],
    ["unknown param", "GET", P + "?bogus=1", bearer, null],
    ["head", "HEAD", P, bearer, 200],
    ["post", "POST", P, bearer, null],
    ["search huge", "GET", P + "?search=" + encodeURIComponent("s".repeat(10000)), bearer, null],
  ];
  for (const [name, method, path, headers, expect] of cases) {
    const r = await rawFetch(origin, method, path, { headers });
    record(G, name, method, path.slice(0, 80), expect, r.status, r.snippet);
    if (!(await alive(origin))) { crashedAt = `after ${G}:${name}`; break; }
  }
}

// ---------------- 4. /api/rooms/{roomId}/agent-pause ----------------
{
  const G = "agent-pause";
  const P = `/api/rooms/${roomId}/agent-pause`;
  const cases = [
    ["no auth", "GET", P, {}, 401],
    ["owner", "GET", P, bearer, 200],
    ["unknown room", "GET", "/api/rooms/no-such-room-xyz/agent-pause", bearer, 404],
    ["unknown param", "GET", P + "?bogus=1", bearer, 422],
    ["dup memberId", "GET", P + "?memberId=a&memberId=b", bearer, 422],
    ["memberId empty", "GET", P + "?memberId=", bearer, null],
    ["memberId weird", "GET", P + "?memberId=" + encodeURIComponent("../x"), bearer, null],
    ["memberId huge", "GET", P + "?memberId=" + encodeURIComponent("m".repeat(5000)), bearer, null],
    ["head", "HEAD", P, bearer, 200],
  ];
  for (const [name, method, path, headers, expect] of cases) {
    const r = await rawFetch(origin, method, path, { headers });
    record(G, name, method, path.slice(0, 80), expect, r.status, r.snippet);
    if (!(await alive(origin))) { crashedAt = `after ${G}:${name}`; break; }
  }
}

// ---------------- 5. /api/rooms/{roomId}/commands ----------------
{
  const G = "commands";
  const P = `/api/rooms/${roomId}/commands`;
  const cmd = id => JSON.stringify({ id, type: "message.posted", data: { text: "fuzz ping" } });
  const deep = d => { let s = '{"a":'; for (let i = 0; i < d; i++) s += '{"a":'; s += "1"; for (let i = 0; i <= d; i++) s += "}"; return s; };
  const cases = [
    ["no auth", "POST", P, { ...json }, JSON.stringify({ type: "message.posted", data: {} }), 401],
    ["malformed json", "POST", P, { ...json, ...bearer }, '{"type":', 400],
    ["text/plain", "POST", P, { "Content-Type": "text/plain", ...bearer }, "{}", 415],
    ["json null", "POST", P, { ...json, ...bearer }, "null", 400],
    ["json array", "POST", P, { ...json, ...bearer }, "[]", 400],
    ["json string", "POST", P, { ...json, ...bearer }, '"x"', 400],
    ["empty object", "POST", P, { ...json, ...bearer }, "{}", null],
    ["unknown type", "POST", P, { ...json, ...bearer }, JSON.stringify({ id: "x1", type: "nope.nothing", data: {} }), null],
    ["type number", "POST", P, { ...json, ...bearer }, JSON.stringify({ id: "x2", type: 42, data: {} }), null],
    ["type missing", "POST", P, { ...json, ...bearer }, JSON.stringify({ id: "x3", data: {} }), null],
    ["dup keys", "POST", P, { ...json, ...bearer }, '{"type":"a","type":"message.posted","data":{},"id":"x4"}', null],
    ["oversize body", "POST", P, { ...json, ...bearer }, JSON.stringify({ id: "x5", type: "message.posted", data: { pad: "p".repeat(2000000) } }), 413],
    ["deep nesting 5000", "POST", P, { ...json, ...bearer }, deep(5000), null],
    ["deep nesting 100000", "POST", P, { ...json, ...bearer }, deep(100000), null],
    ["trailing garbage", "POST", P, { ...json, ...bearer }, '{"type":"x"} garbage', 400],
    ["unknown room", "POST", "/api/rooms/no-such-room-xyz/commands", { ...json, ...bearer }, cmd("x6"), 404],
    ["get method", "GET", P, { ...bearer }, null, null],
  ];
  for (const [name, method, path, headers, body, expect] of cases) {
    const r = await rawFetch(origin, method, path, { headers, body });
    record(G, name, method, path.slice(0, 80), expect, r.status, r.snippet);
    if (!(await alive(origin))) { crashedAt = `after ${G}:${name}`; break; }
  }
}

const flagged = results.filter(r => r.flag);
console.log(JSON.stringify({ total: results.length, flagged: flagged.length, crashedAt }, null, 1));
for (const r of flagged) console.log("FLAG", r.group, "|", r.name, "|", r.method, r.path, "| expect", r.expect, "got", r.got, "|", r.extra);
server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
f.store.close();
const fs = await import("node:fs");
fs.writeFileSync(new URL("./fuzz-results.json", import.meta.url), JSON.stringify({ results, crashedAt }, null, 1));
