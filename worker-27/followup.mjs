// Focused follow-up probes for WORKER 27:
// 1. timing oracle check on authenticateIdentitySecret paths (repeats)
// 2. raw-socket probes with correct Host (oversize declared, huge body, trickle, chunked, missing CT)
// 3. GET/405 behavior recheck with origin present (already covered)
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const results = [];
let server = null, fixture = null, port = null, origin = null;
async function boot() {
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port; origin = `http://127.0.0.1:${port}`;
}
async function shutdown() {
  try { if (server) { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } } catch {}
  try { fixture?.store.close(); } catch {}
  server = null; fixture = null;
}

async function timed(name, fn, reps = 6) {
  const times = [];
  for (let i = 0; i < reps; i++) { const t0 = Date.now(); await fn(); times.push(Date.now() - t0); }
  times.sort((a, b) => a - b);
  const rec = { name, reps, min: times[0], p50: times[Math.floor(reps / 2)], max: times[reps - 1], all: times };
  results.push(rec); console.log(name, JSON.stringify({ min: rec.min, p50: rec.p50, max: rec.max }));
}

function raw(name, payload, waitMs = 2500) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const rec = { name, status: null, head: "" };
    const finish = (s) => { if (!done) { done = true; sock.destroy(); rec.status = s; rec.head = data.slice(0, 500); results.push(rec); console.log(name, "->", s, JSON.stringify(rec.head.slice(0, 130))); resolve(rec); } };
    const timer = setTimeout(() => finish("TIMEOUT"), 8000);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish(data ? "CLOSED" : "CLOSED-EMPTY"); });
    sock.on("error", e => { clearTimeout(timer); rec.status = "SOCKET-ERR"; rec.head = e.message; results.push(rec); resolve(rec); });
    setTimeout(() => { if (!done && data) { clearTimeout(timer); finish("RESP"); } }, waitMs);
  });
}

await boot();
console.log("boot", origin);

// mint two identities
async function mint(displayName) {
  const r = await fetch(origin + "/api/agent-identities", { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ displayName }) });
  return r.json();
}
const ia = await mint("w27t1"), ib = await mint("w27t2");
const bA = `Bearer ${ia.secret}`;
const RA = "/api/auth/agent/rooms";
const post = (identityId, authz) => fetch(origin + RA, { method: "POST",
  headers: { origin, "content-type": "application/json", ...(authz ? { authorization: authz } : {}) },
  body: JSON.stringify({ identityId }) }).then(async r => ({ status: r.status, head: (await r.text()).slice(0, 80) }));

// warm up scrypt etc.
await post(ia.identityId, bA);
await timed("valid-id+valid-secret", () => post(ia.identityId, bA));
await timed("valid-id+wrong-secret", () => post(ia.identityId, `Bearer ${randomBytes(33).toString("base64url").slice(0, 43).replace(/^pri/, "pri")}`));
await timed("nonexistent-id+valid-secret", () => post("ai_nonexistent123456", bA));
await timed("whitespace-id+valid-secret", () => post("   ", bA));
await timed("empty-id+valid-secret", () => post("", bA));
await timed("mismatch-id+valid-secret", () => post(ib.identityId, bA));

// ---- raw probes with correct Host ----
const host = `127.0.0.1:${port}`;
await raw("raw:oversize-declared", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nAuthorization: ${bA}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n`);
await raw("raw:huge-body-200k", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nAuthorization: ${bA}\r\nContent-Type: application/json\r\nContent-Length: 200000\r\n\r\n` + "x".repeat(200000));
await raw("raw:missing-content-type", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nAuthorization: ${bA}\r\nContent-Length: 30\r\n\r\n{"identityId":"${ia.identityId}"}`);
await raw("raw:trickle-body", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nAuthorization: ${bA}\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n`, 3000);
await raw("raw:chunked", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nAuthorization: ${bA}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n14\r\n{"identityId":"x"}\r\n0\r\n\r\n`);
await raw("raw:bad-host", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: evil.example\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
await raw("raw:host-case", `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: ${host.toUpperCase()}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);

await shutdown();
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./timing.json", import.meta.url), JSON.stringify(results, null, 1));
console.log("done");
