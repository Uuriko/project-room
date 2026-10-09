#!/usr/bin/env node
// WORKER 27 fuzz: shard (index mod 50)==26 of the sorted route-handler list
// (worker-list.txt, derived from server/http.mjs route dispatch sites).
// Targets:
//   A: POST /api/auth/agent/rooms  (http.mjs:2614)
//   B: POST /api/share-links/join  (http.mjs:2569)
// Boots a local server per batch (acceptance fixture, 127.0.0.1) to keep the
// in-memory rate buckets fresh; reports 500s, hangs, stack leaks, and
// surprising statuses. 401/403/404/405/409/410/413/415/422/429 are all
// expected-shape client errors.
import net from "node:net";
import { writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const TIMEOUT_MS = 8000;
const results = [];
let server = null, fixture = null, base = null, port = null, origin = null;

async function boot() {
  await shutdown();
  fixture = await createAcceptanceFixture();
  server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  origin = `http://127.0.0.1:${port}`;
}
async function shutdown() {
  try {
    if (server) {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  } catch {}
  try { fixture?.store.close(); } catch {}
  server = null; fixture = null;
}
const store = () => fixture.store;

async function call(name, { method = "POST", path = "/", headers = {}, rawBody = null, json = undefined, timeoutMs = TIMEOUT_MS } = {}) {
  const h = { origin, ...headers };
  let body;
  if (rawBody !== null) { body = rawBody; if (!("content-type" in h)) h["content-type"] = "application/json"; }
  else if (json !== undefined) { body = JSON.stringify(json); h["content-type"] = "application/json"; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  const rec = { name, method, path: String(path).slice(0, 160) };
  try {
    const r = await fetch(base + path, { method, headers: h, body, signal: ctl.signal, redirect: "manual" });
    clearTimeout(t);
    const text = await r.text().catch(() => "");
    Object.assign(rec, { status: r.status, ms: Date.now() - start, head: text.slice(0, 400), timeout: false });
  } catch (e) {
    clearTimeout(t);
    Object.assign(rec, { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERR", ms: Date.now() - start,
      head: String(e && e.message || e).slice(0, 200), timeout: e.name === "AbortError" });
  }
  results.push(rec);
  return rec;
}

function rawRequest(name, payload, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1");
    let data = ""; let done = false;
    const rec = { name, method: "RAW", path: "(socket)" };
    const finish = (status) => { if (!done) { done = true; sock.destroy(); Object.assign(rec, { status, head: data.slice(0, 400) }); results.push(rec); resolve(rec); } };
    const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); finish(data ? "CLOSED" : "CLOSED-EMPTY"); });
    sock.on("error", e => { clearTimeout(timer); Object.assign(rec, { status: "SOCKET-ERR", head: e.message.slice(0, 200) }); results.push(rec); if (!done) { done = true; resolve(rec); } });
    setTimeout(() => { if (!done && data) { clearTimeout(timer); finish("RESP"); } }, 2500);
  });
}

const looksLikeStack = h => /at\s+\S+\s*\(|Error:\s.*\.mjs:\d+|node:internal/.test(h || "");

// Full-body variant for setup calls (mint identity, /join) whose JSON must be parsed.
async function callFull(name, opts = {}) {
  const h = { origin, ...(opts.headers || {}) };
  let body;
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); h["content-type"] = "application/json"; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const start = Date.now();
  const rec = { name, method: opts.method || "POST", path: String(opts.path || "/").slice(0, 160) };
  try {
    const r = await fetch(base + (opts.path || "/"), { method: opts.method || "POST", headers: h, body, signal: ctl.signal, redirect: "manual" });
    clearTimeout(t);
    const text = await r.text().catch(() => "");
    Object.assign(rec, { status: r.status, ms: Date.now() - start, head: text.slice(0, 400), full: text, timeout: false });
  } catch (e) {
    clearTimeout(t);
    Object.assign(rec, { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERR", ms: Date.now() - start, head: String(e && e.message || e).slice(0, 200), full: "", timeout: e.name === "AbortError" });
  }
  results.push(rec);
  return rec;
}

// ---- mint helpers (HTTP, acceptance store) ----
async function mintIdentity(displayName) {
  const r = await callFull(`mint:${displayName}`, { path: "/api/agent-identities", json: { displayName } });
  let j = null; try { j = JSON.parse(r.full); } catch {}
  return { status: r.status, identityId: j?.identityId, secret: j?.secret };
}
function fakeBearer(n = 43) { return `Bearer ${randomBytes(33).toString("base64url").slice(0, n)}`; }
const J = (o) => o; // shorthand

// ============ BATCH A0: identity mints + origin matrix on Route A ============
await boot();
console.log("boot A0", base);
const idA = await mintIdentity("w27a");
const idB = await mintIdentity("w27b");
console.log("minted", idA.status, !!idA.identityId, idB.status, !!idB.identityId);
const bearerA = idA.secret ? `Bearer ${idA.secret}` : fakeBearer();
const RA = "/api/auth/agent/rooms";
// origin variants (no rate budget consumed; checkOrigin runs before rate())
await call("A:valid", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA } });
await call("A:no-origin", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA, origin: undefined } });
await call("A:origin-evil", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA, origin: "https://evil.example" } });
await call("A:origin-null", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA, origin: "null" } });
await call("A:origin-trailing-slash", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA, origin: origin + "/" } });
await call("A:origin-noprot-port", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA, origin: "http://127.0.0.1" } });
await call("A:origin-case-host", { path: RA, json: { identityId: idA.identityId }, headers: { authorization: bearerA, origin: `http://127.0.0.1:${port}/`.toUpperCase() } });

// ============ BATCH A1: auth matrix + body matrix 1 ============
await boot();
console.log("boot A1", base);
const ia = await mintIdentity("w27a1");
const ib = await mintIdentity("w27b1");
const bA = `Bearer ${ia.secret}`, bB = `Bearer ${ib.secret}`;
await call("A:happy", { path: RA, json: { identityId: ia.identityId }, headers: { authorization: bA } });
await call("A:no-bearer", { path: RA, json: { identityId: ia.identityId } });
await call("A:bearer-short", { path: RA, json: { identityId: ia.identityId }, headers: { authorization: "Bearer x" } });
await call("A:bearer-basic", { path: RA, json: { identityId: ia.identityId }, headers: { authorization: "Basic dXNlcjpwYXNz" } });
await call("A:bearer-empty-scheme", { path: RA, json: { identityId: ia.identityId }, headers: { authorization: "Bearer" } });
await call("A:bearer-lowercase", { path: RA, json: { identityId: ia.identityId }, headers: { authorization: `bearer ${ia.secret}` } });
await call("A:wrong-secret", { path: RA, json: { identityId: ia.identityId }, headers: { authorization: fakeBearer() } });
await call("A:mismatch-id", { path: RA, json: { identityId: ib.identityId }, headers: { authorization: bA } });

// ============ BATCH A2: body matrix 2 ============
await boot();
console.log("boot A2", base);
const ia2 = await mintIdentity("w27a2");
const bA2 = `Bearer ${ia2.secret}`;
const A = (name, opts) => call(name, { path: RA, headers: { authorization: bA2 }, ...opts });
await A("A:body-empty-obj", { json: {} });
await A("A:body-extra-key", { json: { identityId: ia2.identityId, x: 1 } });
await A("A:body-id-number", { json: { identityId: 123 } });
await A("A:body-id-null", { json: { identityId: null } });
await A("A:body-id-bool", { json: { identityId: true } });
await A("A:body-id-empty-str", { json: { identityId: "" } });
await A("A:body-id-long", { json: { identityId: "x".repeat(10000) } });
await A("A:body-id-nul", { json: { identityId: "abc\0def" } });

// ============ BATCH A3: body matrix 3 + methods ============
await boot();
console.log("boot A3", base);
const ia3 = await mintIdentity("w27a3");
const bA3 = `Bearer ${ia3.secret}`;
const A3 = (name, opts) => call(name, { path: RA, headers: { authorization: bA3 }, ...opts });
await A3("A:body-id-unicode", { json: { identityId: "😀".repeat(50) } });
await A3("A:body-id-whitespace", { json: { identityId: "  " } });
await A3("A:body-id-proto-pollution", { rawBody: `{"identityId":"${ia3.identityId}","__proto__":{"polluted":true}}` });
await A3("A:body-dup-keys", { rawBody: `{"identityId":"nope","identityId":"${ia3.identityId}"}` });
await A3("A:body-deep-nest", { rawBody: `{"identityId":${"[".repeat(400)}${"]".repeat(400)}}` });
await A3("A:body-array", { rawBody: `[1,2]` });
await A3("A:body-scalar", { rawBody: `5` });
await A3("A:body-empty-str", { rawBody: `` });

// ============ BATCH A4: methods + content-type + raw ============
await boot();
console.log("boot A4", base);
const ia4 = await mintIdentity("w27a4");
const bA4 = `Bearer ${ia4.secret}`;
for (const m of ["GET", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"])
  await call(`A:method-${m}`, { method: m, path: RA, headers: { authorization: bA4 }, ...(m === "GET" || m === "HEAD" || m === "OPTIONS" ? {} : { json: { identityId: ia4.identityId } }) });
await call("A:ct-text-plain", { path: RA, headers: { authorization: bA4, "content-type": "text/plain" }, rawBody: `{"identityId":"${ia4.identityId}"}` });
await call("A:ct-charset", { path: RA, headers: { authorization: bA4, "content-type": "application/json; charset=utf-8" }, rawBody: `{"identityId":"${ia4.identityId}"}` });
await call("A:ct-upper", { path: RA, headers: { authorization: bA4, "content-type": "APPLICATION/JSON" }, rawBody: `{"identityId":"${ia4.identityId}"}` });
await call("A:ct-missing", { path: RA, headers: { authorization: bA4 }, rawBody: `{"identityId":"${ia4.identityId}"}` });
await rawRequest("A:raw-oversize-declared",
  `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n`);
await rawRequest("A:raw-huge-body",
  `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nAuthorization: ${bA4}\r\nContent-Type: application/json\r\nContent-Length: 200000\r\n\r\n` + "x".repeat(200000));
await rawRequest("A:raw-trickle",
  `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nAuthorization: ${bA4}\r\nContent-Type: application/json\r\nContent-Length: 60\r\n\r\n`, 3000);
await rawRequest("A:raw-chunked",
  `POST /api/auth/agent/rooms HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nAuthorization: ${bA4}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n14\r\n{"identityId":"x"}\r\n0\r\n\r\n`);

// ============ BATCH B0: Route B pre-auth matrix ============
await boot();
console.log("boot B0", base);
const RB = "/api/share-links/join";
const slot0 = store().createAccountSessionSlot();
const slotCookie0 = `account_session=${slot0.token}`;
const B0 = (name, opts) => call(name, { path: RB, ...opts });
await B0("B:no-cookie", { json: { linkToken: "x", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B0("B:cookie-garbage", { headers: { cookie: "account_session=garbage" }, json: { linkToken: "x", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B0("B:slot-no-csrf", { headers: { cookie: slotCookie0 }, json: { linkToken: "x", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B0("B:slot-bad-csrf", { headers: { cookie: slotCookie0, "x-csrf-token": "wrong" }, json: { linkToken: "x", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B0("B:slot-ok-no-binding", { headers: { cookie: slotCookie0, "x-csrf-token": slot0.session.csrf }, json: { linkToken: "x", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });

// ============ BATCH B1: Route B body matrix (valid headers) ============
await boot();
console.log("boot B1", base);
const s1 = store().createAccountSessionSlot();
const H1 = { cookie: `account_session=${s1.token}`, "x-csrf-token": s1.session.csrf, "x-session-binding": s1.session.sessionBinding };
const B1 = (name, opts) => call(name, { path: RB, headers: H1, ...opts });
const bogusLink = randomBytes(33).toString("base64url").slice(0, 43);
await B1("B:body-missing-all", { json: {} });
await B1("B:body-extra-key", { json: { linkToken: bogusLink, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0, x: 1 } });
await B1("B:body-link-missing", { json: { displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B1("B:bogus-link", { json: { linkToken: bogusLink, displayName: "fuzz-guest", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B1("B:link-null", { json: { linkToken: null, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B1("B:name-empty", { json: { linkToken: bogusLink, displayName: "   ", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B1("B:name-long", { json: { linkToken: bogusLink, displayName: "x".repeat(500), redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B1("B:redemption-bad-uuid", { json: { linkToken: bogusLink, displayName: "n", redemptionId: "not-a-uuid", expectedSessionRevision: 0 } });

// ============ BATCH B2: Route B revision + methods + deeper linkToken fuzz ============
await boot();
console.log("boot B2", base);
const s2 = store().createAccountSessionSlot();
const H2 = { cookie: `account_session=${s2.token}`, "x-csrf-token": s2.session.csrf, "x-session-binding": s2.session.sessionBinding };
const B2 = (name, opts) => call(name, { path: RB, headers: H2, ...opts });
await B2("B:revision-float", { json: { linkToken: bogusLink, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 1.5 } });
await B2("B:revision-string", { json: { linkToken: bogusLink, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: "0" } });
await B2("B:revision-negative", { json: { linkToken: bogusLink, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: -1 } });
await B2("B:revision-huge", { json: { linkToken: bogusLink, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 9007199254740993 } });
await B2("B:revision-mismatch", { json: { linkToken: bogusLink, displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 7 } });
await B2("B:link-sql", { json: { linkToken: "' OR '1'='1", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B2("B:link-long", { json: { linkToken: "x".repeat(10000), displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });
await B2("B:link-nul", { json: { linkToken: "abc\0def", displayName: "n", redemptionId: randomUUID(), expectedSessionRevision: 0 } });

// ============ BATCH B3: methods + origin + happy path via real share link ============
await boot();
console.log("boot B3", base);
// happy path setup: /join a personal room, mint share link in-process
const jr = await callFull("join:setup", { path: "/join", json: { displayName: "w27owner" } });
let jj = null; try { jj = JSON.parse(jr.full); } catch {}
console.log("join setup", jr.status, !!jj?.roomId);
let linkToken = null, roomId = jj?.roomId, ownerSecret = jj?.identitySecret;
if (jr.status === 201 && jj?.roomId && jj?.identitySecret) {
  try {
    linkToken = randomBytes(33).toString("base64url").slice(0, 43);
    const owner = store().authenticate(jj.identitySecret, jj.roomId, null);
    const created = store().shareLinks.create(jj.identitySecret, jj.roomId,
      { requestId: randomUUID(), linkToken, expiresAt: store().now() + 3600000, maxJoins: 5, expectedMemberRevision: owner.member.revision }, null);
    console.log("link created", JSON.stringify({ dup: created.duplicate, id: created.link?.id }).slice(0, 120));
  } catch (e) { console.log("link create failed:", String(e).slice(0, 200)); linkToken = null; }
}
const s3 = store().createAccountSessionSlot();
const H3 = { cookie: `account_session=${s3.token}`, "x-csrf-token": s3.session.csrf, "x-session-binding": s3.session.sessionBinding };
for (const m of ["GET", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"])
  await call(`B:method-${m}`, { method: m, path: RB, headers: H3, ...(m === "GET" || m === "HEAD" || m === "OPTIONS" ? {} : { json: {} }) });
await call("B:origin-missing", { path: RB, headers: { ...H3, origin: undefined }, json: {} });
await call("B:origin-evil", { path: RB, headers: { ...H3, origin: "https://evil.example" }, json: {} });
if (linkToken) {
  const rid = randomUUID();
  const r1 = await call("B:happy-join", { path: RB, headers: H3, json: { linkToken, displayName: "fuzz guest", redemptionId: rid, expectedSessionRevision: 0 } });
  console.log("happy join", r1.status, r1.head.slice(0, 120));
  const r2 = await call("B:replay-same-redemption", { path: RB, headers: H3, json: { linkToken, displayName: "fuzz guest", redemptionId: rid, expectedSessionRevision: 0 } });
  console.log("replay", r2.status, r2.head.slice(0, 120));
  // second join with a fresh slot but SAME redemptionId -> join_session_lost expected (409)
  const s4 = store().createAccountSessionSlot();
  const H4 = { cookie: `account_session=${s4.token}`, "x-csrf-token": s4.session.csrf, "x-session-binding": s4.session.sessionBinding };
  const r3 = await call("B:cross-session-replay", { path: RB, headers: H4, json: { linkToken, displayName: "fuzz guest", redemptionId: rid, expectedSessionRevision: 0 } });
  console.log("cross-session replay", r3.status, r3.head.slice(0, 120));
}

await shutdown();

// ---- verdicts ----
const EXPECTED = new Set([200, 201, 400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429]);
const interesting = results.filter(r => {
  if (r.status === "TIMEOUT" || r.status === "FETCH-ERR") return true;
  if (typeof r.status === "number" && !EXPECTED.has(r.status)) return true;
  if (typeof r.status === "number" && r.status === 500) return true;
  if (looksLikeStack(r.head)) return true;
  return false;
});
for (const r of interesting) r.flag = true;
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ results, interesting: interesting.length }, null, 1));
console.log(`\ntotal=${results.length} interesting=${interesting.length}`);
for (const r of interesting) console.log("FLAG:", r.name, r.status, r.ms + "ms", (r.head || "").slice(0, 160));
// status census
const census = {};
for (const r of results) census[r.status] = (census[r.status] || 0) + 1;
console.log("census:", JSON.stringify(census));
