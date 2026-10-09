// WAVE-2000 G02 Worker 43 — fuzz round 2: rate-window-safe batches.
// Boots in-process server; groups POSTs to /api/referral-invites/preview in
// batches of <=18 with 65s sleeps (endpoint allows 20/min per address).
import { mkdirSync, writeFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

mkdirSync(new URL("data", import.meta.url), { recursive: true });
const store = new RoomStore(new URL("data/room.sqlite", import.meta.url).pathname, {});
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log("fuzzing", BASE);

const results = [];
const findings = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(name, method, path, { headers = {}, body = undefined, rawBody = undefined, contentType = "application/json", expect = null } = {}) {
  const h = { ...headers };
  if (rawBody !== undefined || body !== undefined) h["Content-Type"] = contentType;
  let payload = rawBody;
  if (body !== undefined) payload = JSON.stringify(body);
  let status = -1, code = null, text = "";
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(BASE + path, { method, headers: h, body: payload, signal: ctl.signal });
    clearTimeout(timer);
    status = res.status;
    text = await res.text();
    try { const j = JSON.parse(text); code = JSON.stringify(j.error ?? j.code ?? j.message ?? null).slice(0, 80); } catch { code = null; }
  } catch (e) { status = e.name === "AbortError" ? "TIMEOUT" : "ERR"; text = String(e).slice(0, 120); }
  const ms = Date.now() - t0;
  const ok = expect === null ? true : expect === status;
  const rec = { name, method, path, status, code, ms, expect, ok, body: text.slice(0, 160) };
  results.push(rec);
  if (!ok) findings.push(rec);
  console.log(`${ok ? "ok  " : "MISS"} ${name}: ${method} ${path} -> ${status} ${code ?? ""} (expect ${expect}) ${ms}ms`);
  return rec;
}

const b64u = s => Buffer.from(s).toString("base64url");
const forged = bodyObj => `ref1.${b64u(JSON.stringify(bodyObj))}.${b64u("fakesig")}`;
const validBody = o => Object.assign({ v: 1, jti: "x".repeat(16), chainId: "c1", roomId: "nonexistent-room", depth: 0, maxDepth: 5, issuedAt: 1, expiresAt: 99999999999, tier: "chat" }, o);
const P = "/api/referral-invites/preview";

// ---- Batch 1 (19 POSTs, under the 20/min cap) ----
await call("B01 empty-object", "POST", P, { body: {}, expect: 422 });
await call("B02 empty-token", "POST", P, { body: { token: "" }, expect: 404 });
await call("B03 garbage-token", "POST", P, { body: { token: "garbage" }, expect: 404 });
await call("B04 null-token", "POST", P, { body: { token: null }, expect: 422 });
await call("B05 number-token", "POST", P, { body: { token: 12345 }, expect: 422 });
await call("B06 object-token", "POST", P, { body: { token: { x: 1 } }, expect: 422 });
await call("B07 array-token", "POST", P, { body: { token: ["a"] }, expect: 422 });
await call("B08 bool-token", "POST", P, { body: { token: true }, expect: 422 });
await call("B10 probe-token", "POST", P, { body: { token: "ref1.probe.probe" }, expect: 404 });
await call("B11 forged-token", "POST", P, { body: { token: forged(validBody()) }, expect: 404 });
await call("B12 forged-depth-overflow", "POST", P, { body: { token: forged(validBody({ depth: 1e30, maxDepth: 5 })) }, expect: 404 });
await call("B13 forged-depth-negative", "POST", P, { body: { token: forged(validBody({ depth: -1 })) }, expect: 404 });
await call("B14 forged-depth-float", "POST", P, { body: { token: forged(validBody({ depth: 0.5 })) }, expect: 404 });
await call("B15 forged-depth-string", "POST", P, { body: { token: forged(validBody({ depth: "0" })) }, expect: 404 });
await call("B16 forged-wrong-tier", "POST", P, { body: { token: forged(validBody({ tier: "admin" })) }, expect: 404 });
await call("B17 forged-wrong-version", "POST", P, { body: { token: forged(validBody({ v: 2 })) }, expect: 404 });
await call("B18 forged-bad-b64", "POST", P, { body: { token: "ref1.!!!.!!!" }, expect: 404 });
await call("B19 forged-truncated", "POST", P, { body: { token: "ref1." + b64u("{}") }, expect: 404 });
await call("B20 forged-extra-parts", "POST", P, { body: { token: forged(validBody()) + ".extra" }, expect: 404 });
console.log("--- batch 1 done; sleeping 65s for rate window ---");
await sleep(65000);

// ---- Batch 2: the anomaly + remaining POSTs ----
await call("B09 100k-token-RETRY", "POST", P, { body: { token: "a".repeat(100000) }, expect: 404 });
await call("B09b 100k-token-RETRY2", "POST", P, { body: { token: "a".repeat(100000) }, expect: 404 });
await call("B21 forged-bad-json", "POST", P, { body: { token: "ref1." + b64u("not json") + "." + b64u("s") }, expect: 404 });
await call("B22 invalid-json", "POST", P, { rawBody: "not json at all", expect: 400 });
await call("B23 array-body", "POST", P, { rawBody: "[1,2,3]", expect: 400 });
await call("B24 null-body", "POST", P, { rawBody: "null", expect: 400 });
await call("B25 empty-body", "POST", P, { rawBody: "", expect: 400 });
await call("B26 no-content-type", "POST", P, { rawBody: "{}", contentType: "", expect: 415 });
await call("B27 text-content-type", "POST", P, { rawBody: "{}", contentType: "text/plain", expect: 415 });
await call("B32 oversized-body", "POST", P, { rawBody: JSON.stringify({ token: "x".repeat(2_000_000) }), expect: 413 });
await call("B33 extra-keys", "POST", P, { body: { token: "x", extra: 1 }, expect: 422 });
await call("B34 sqli-token", "POST", P, { body: { token: "'; DROP TABLE referral_invites;--" }, expect: 404 });
await call("B35 nullbyte-token", "POST", P, { body: { token: "ref1.\u0000.\u0000" }, expect: 404 });
await call("B36 emoji-token", "POST", P, { body: { token: "😀".repeat(50) }, expect: 404 });
await call("B37 unicode-token", "POST", P, { body: { token: "ref1.éèê.üñ" }, expect: 404 });
await call("B38 nested-object-token", "POST", P, { rawBody: JSON.stringify({ token: { a: { b: "x" } } }), expect: 422 });
await call("B40 forged-expired-times", "POST", P, { body: { token: forged(validBody({ issuedAt: 99999999999, expiresAt: 1 })) }, expect: 404 });
await call("B41 forged-huge-ints", "POST", P, { body: { token: forged(validBody({ issuedAt: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER })) }, expect: 404 });
await call("B42 whitespace-token", "POST", P, { body: { token: "   " }, expect: 404 });
// non-POST methods (405 branch, no rate cost)
await call("B28 GET", "GET", P, { expect: 405 });
await call("B29 PUT", "PUT", P, { rawBody: "{}", expect: 405 });
await call("B30 DELETE", "DELETE", P, { expect: 405 });
await call("B31 HEAD", "HEAD", P, { expect: 405 });

// verify referral_invites table survived the sqli vector
const row = store.db.prepare("SELECT count(*) AS n FROM referral_invites").get();
console.log("referral_invites row count after sqli vector:", row.n);

// ---- Handler A vectors ----
const A = "/api/account/ensure-default-room";
const bind64 = "ab".repeat(32); // well-formed 64-hex binding
await call("A01b binding-no-cookie", "POST", A, { headers: { "X-Session-Binding": bind64 }, body: {}, expect: 401 });
await call("A01c malformed-binding-no-cookie", "POST", A, { headers: { "X-Session-Binding": "bogus" }, body: {}, expect: 422 });

async function signup(n) {
  const slot = await fetch(BASE + "/api/account-session");
  const slotToken = /account_session=([^;]+)/.exec(slot.headers.get("set-cookie") || "")?.[1];
  const slotBody = await slot.json();
  const res = await fetch(BASE + "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, Cookie: `account_session=${slotToken}` },
    body: JSON.stringify({ email: `fuzz-w43-b2-${n}@example.invalid`, password: `fixture-password-${n}-long-enough`, sessionToken: slotToken, sessionRevision: slotBody.sessionRevision })
  });
  const fresh = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  if (res.status !== 202 || !fresh) throw new Error(`signup failed: ${res.status}`);
  const view = await (await fetch(BASE + "/api/account-session", { headers: { Cookie: `account_session=${fresh}` } })).json();
  return { cookie: `account_session=${fresh}`, csrf: view.csrf, binding: view.sessionBinding };
}
const creds = await signup(2);
const ah = { Cookie: creds.cookie, Origin: BASE, "X-CSRF-Token": creds.csrf, "X-Session-Binding": creds.binding };
await call("A15b wellformed-wrong-binding", "POST", A, { headers: { ...ah, "X-Session-Binding": bind64 }, body: {}, expect: 409 });
await call("A10b authed-first-b2", "POST", A, { headers: ah, body: {}, expect: 201 });
await call("A11b authed-idempotent-b2", "POST", A, { headers: ah, body: {}, expect: 200 });

writeFileSync(new URL("fuzz-results-round2.json", import.meta.url), JSON.stringify({ results, findings }, null, 1));
console.log(`\nROUND2 TOTAL ${results.length} vectors, ${findings.length} findings/mismatches`);
server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close();
process.exit(findings.length ? 1 : 0);
