// WAVE-2000 GUILD-02 WORKER 42 — authenticated deep-fuzz of shard 42.
// Shard = server/http.mjs dispatch clauses with (0-based index mod 50)==41
// (the file uses manual url.pathname dispatch, no app.get(...) calls):
//   1. POST /api/auth/methods/enable  (server/http.mjs:2277)
//   2. GET|HEAD /api/updates          (server/http.mjs:3170)
// The guild's generic sweep (fuzz/) covers unauthenticated adversarial
// traffic; this script goes BEHIND auth to reach the deep validation code
// (methodIdFrom, setMethodDisabled, updatesQuery, parseListQuery, page).
// Flags: non-2xx/4xx surprises vs code-derived expectations, 500s, hangs,
// stack/secret leaks in bodies. Findings -> findings.json + stdout.

import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const findings = [];
let server = null, store = null, origin = null, port = null;
let postCount = 0, getCount = 0; // per-boot rate-limit budget guards

async function boot() {
  const f = createAcceptanceFixture();
  store = f.store;
  server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  postCount = 0; getCount = 0;
}
async function shutdown() {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { store.close(); } catch {}
  server = null;
}

// ---- auth setup (store-level, no rate-limit involvement) ----
function makeAccount(email) {
  const accountId = `email:${createHash("sha256").update(`w42-${email}@example.invalid`, "utf8").digest("hex")}`;
  store.createAccount(accountId, "w42-fixture");
  const method = store.accountLogins.linkMagicMethod(accountId, { email: `w42-${email}@example.invalid` });
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, store.issueAccountAccessKey(accountId), slot.session.sessionRevision);
  const csrf = store.accountSessionSlot(slot.token).csrf;
  return { accountId, methodId: method.id, cookie: `account_session=${slot.token}`, csrf, binding: session.sessionBinding };
}
function makeIdentity() {
  return store.identities.create("w42-identity"); // { identityId, secret }
}

// ---- request ----
async function req({ method = "GET", path, headers = {}, body = null, raw = null, timeoutMs = 8000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(origin + path, {
      method, headers, body: raw ?? body ?? undefined,
      signal: ctl.signal, redirect: "manual",
    });
    clearTimeout(timer);
    const text = await r.text().catch(() => "");
    return { status: r.status, head: text.slice(0, 400), ms: Date.now() - t0,
             allow: r.headers.get("allow"), ctype: r.headers.get("content-type") };
  } catch (e) {
    clearTimeout(timer);
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERROR",
             head: String(e.message).slice(0, 200), ms: Date.now() - t0 };
  }
}
const looksLikeStack = h => /at\s+\S+\s*\(|Error:\s|\.mjs:\d+|node:internal|secret|csrf/i.test(h || "");

function check(name, got, expectedStatuses, note = "") {
  const ok = expectedStatuses.includes(got.status);
  const leak = looksLikeStack(got.head) && !["TIMEOUT", "FETCH-ERROR"].includes(got.status);
  if (!ok || leak || got.status === "TIMEOUT" || got.status === "FETCH-ERROR") {
    findings.push({ name, status: got.status, expected: expectedStatuses, ms: got.ms,
                    head: got.head, allow: got.allow, note, leak: leak || undefined });
    console.log(`  !! ${name}: got ${got.status} (expected ${expectedStatuses.join("|")}) ms=${got.ms} ${note}`);
  } else {
    console.log(`  ok ${name}: ${got.status}`);
  }
}

const J = { "Content-Type": "application/json" };
const postEnable = (creds, data, extra = {}) => {
  postCount++;
  return req({ method: "POST", path: "/api/auth/methods/enable",
    headers: { ...J, Origin: origin, Cookie: creds.cookie, "X-CSRF-Token": creds.csrf, ...extra.hdrs },
    body: extra.rawBody !== undefined ? undefined : JSON.stringify(data), raw: extra.rawBody });
};

// ================= BATCH A: POST /api/auth/methods/enable =================
async function batchA() {
  console.log("== BATCH A: POST /api/auth/methods/enable ==");
  const acct = makeAccount("a1");
  const other = makeAccount("a2");

  // A1 sanity
  let r = await postEnable(acct, { id: acct.methodId });
  check("A1 sanity enable", r, [200], r.head.slice(0, 120));

  // A2 unknown id
  r = await postEnable(acct, { id: "method-does-not-exist" });
  check("A2 unknown id", r, [404], r.head.slice(0, 120));

  // A3 other account's method id
  r = await postEnable(acct, { id: other.methodId });
  check("A3 foreign method id", r, [404], r.head.slice(0, 120));

  // A4-A11 body shapes
  r = await postEnable(acct, {});
  check("A4 empty object", r, [422]);
  r = await postEnable(acct, { id: null });
  check("A5 id null", r, [422]);
  r = await postEnable(acct, { id: 123 });
  check("A6 id number", r, [422]);
  r = await postEnable(acct, { id: ["x"] });
  check("A7 id array", r, [422]);
  r = await postEnable(acct, { id: "" });
  check("A8 id empty string", r, [422]);
  r = await postEnable(acct, { id: acct.methodId, extra: 1 });
  check("A9 extra key", r, [422]);
  r = await postEnable(acct, { id: "x".repeat(5000) });
  check("A10 id 5k chars", r, [404]);
  r = await postEnable(acct, { id: "🪔-unicode-id" });
  check("A11 unicode id", r, [404]);

  // A12 proto pollution
  r = await postEnable(acct, JSON.parse('{"__proto__":{"x":1},"id":"z"}'), {});
  check("A12 proto-pollution", r, [422]);

  // A13-A16 transport-level bodies
  r = await postEnable(acct, null, { rawBody: '{"id":"x"}', hdrs: { "Content-Type": "text/plain" } });
  check("A13 text/plain", r, [415]);
  r = await postEnable(acct, null, { rawBody: "" });
  check("A14 empty body", r, [400]);
  r = await postEnable(acct, null, { rawBody: "null" });
  check("A15 body null literal", r, [400]);
  r = await postEnable(acct, null, { rawBody: '{"id":' });
  check("A16 truncated json", r, [400]);

  await shutdown(); await boot(); // reset rate budget (A: 17 POSTs used)
  console.log("== BATCH A2 ==");
  const acct2 = makeAccount("a1b");

  let r2 = await postEnable(acct2, null, { rawBody: '{"a":'.repeat(600) + "1" + "}".repeat(600) });
  check("A17 deep-nest json", r2, [400]);
  r2 = await postEnable(acct2, null, { rawBody: JSON.stringify({ id: "x", a: "y".repeat(20000) }) });
  check("A18 oversize 20k", r2, [413]);
  r2 = await postEnable(acct2, null, { rawBody: Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]) });
  check("A19 invalid utf8", r2, [400]);
  r2 = await postEnable(acct2, { id: "x" }, { hdrs: { "Content-Type": "" } });
  check("A20 empty content-type", r2, [415]);

  // A21-A24 wrong methods
  for (const m of ["GET", "PUT", "DELETE", "PATCH"]) {
    r2 = await req({ method: m, path: "/api/auth/methods/enable", headers: { Cookie: acct2.cookie } });
    check(`A21 method ${m}`, r2, [405]);
  }
  r2 = await req({ method: "OPTIONS", path: "/api/auth/methods/enable", headers: { Origin: origin, Cookie: acct2.cookie } });
  check("A22 OPTIONS", r2, [405, 204, 200]);

  // A25-A26 no/bogus session
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Origin: origin }, body: JSON.stringify({ id: "x" }) });
  check("A23 no cookie", r2, [401]);
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Origin: origin, Cookie: "account_session=bogus" }, body: JSON.stringify({ id: "x" }) });
  check("A24 bogus cookie", r2, [401]);

  // A27-A29 CSRF
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Origin: origin, Cookie: acct2.cookie }, body: JSON.stringify({ id: acct2.methodId }) });
  check("A25 missing CSRF", r2, [403]);
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Origin: origin, Cookie: acct2.cookie, "X-CSRF-Token": "0".repeat(64) }, body: JSON.stringify({ id: acct2.methodId }) });
  check("A26 wrong CSRF", r2, [403]);
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Origin: origin, Cookie: acct2.cookie, "X-CSRF-Token": "short" }, body: JSON.stringify({ id: acct2.methodId }) });
  check("A27 short CSRF", r2, [403]);

  // A28-A30 origin
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Cookie: acct2.cookie, "X-CSRF-Token": acct2.csrf }, body: JSON.stringify({ id: acct2.methodId }) });
  check("A28 missing origin", r2, [403]);
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable", headers: { ...J, Origin: "https://evil.example.com", Cookie: acct2.cookie, "X-CSRF-Token": acct2.csrf }, body: JSON.stringify({ id: acct2.methodId }) });
  check("A29 evil origin", r2, [403]);

  await shutdown(); await boot();
  console.log("== BATCH A3 ==");
  const acct3 = makeAccount("a1c");

  // A30 idempotent enable of already-enabled method
  r2 = await postEnable(acct3, { id: acct3.methodId });
  check("A30 enable twice", r2, [200]);
  r2 = await postEnable(acct3, { id: acct3.methodId });
  check("A31 enable twice again", r2, [200]);

  // A32 duplicate id keys (last wins -> unknown -> 404)
  r2 = await postEnable(acct3, null, { rawBody: `{"id":"nope","id":"${acct3.methodId}"}` });
  check("A32 dup id keys", r2, [200, 404], r2.head.slice(0, 120));

  // A33 duplicate cookie headers -> 401 ambiguous
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable",
    headers: { ...J, Origin: origin, Cookie: `${acct3.cookie}; account_session=other`, "X-CSRF-Token": acct3.csrf },
    body: JSON.stringify({ id: acct3.methodId }) });
  check("A33 duplicate session cookie", r2, [401]);

  // A34 id with null byte / control chars
  r2 = await postEnable(acct3, { id: "a b" });
  check("A34 id with control char", r2, [404]);

  // A35 Authorization bearer on cookie route (should be ignored by this route)
  r2 = await req({ method: "POST", path: "/api/auth/methods/enable",
    headers: { ...J, Origin: origin, Cookie: acct3.cookie, "X-CSRF-Token": acct3.csrf, Authorization: "Bearer <redacted>" },
    body: JSON.stringify({ id: acct3.methodId }) });
  check("A35 bearer header ignored", r2, [200]);

  await shutdown();
}

// ================= BATCH B: GET|HEAD /api/updates =================
async function batchB() {
  await boot();
  console.log("== BATCH B: /api/updates ==");
  const acct = makeAccount("b1");
  const ident = makeIdentity();
  const acctH = { Cookie: acct.cookie, "X-Session-Binding": acct.binding };

  const g = (path, headers = {}, method = "GET") => { getCount++; return req({ method, path, headers }); };

  // auth matrix
  let r = await g("/api/updates");
  check("B1 no auth", r, [401]);
  r = await g("/api/updates", { Authorization: "Bearer <redacted>" });
  check("B2 garbage bearer", r, [401]);
  r = await g("/api/updates", { Authorization: "Bearer " + "z".repeat(43) });
  check("B3 unknown 43-char bearer", r, [401], r.head.slice(0, 120));
  r = await g("/api/updates", { Authorization: `Bearer ${ident.secret}` });
  check("B4 valid identity secret", r, [200], r.head.slice(0, 120));
  r = await g("/api/updates", { Cookie: acct.cookie });
  check("B5 cookie no binding", r, [422], r.head.slice(0, 120));
  r = await g("/api/updates", { Cookie: acct.cookie, "X-Session-Binding": "0".repeat(64) });
  check("B6 wrong binding", r, [401, 422], r.head.slice(0, 120));
  r = await g("/api/updates", acctH);
  check("B7 cookie + binding", r, [200], r.head.slice(0, 120));
  r = await g(`/api/updates?binding=${acct.binding}`, { Cookie: acct.cookie });
  check("B8 binding via query", r, [200], r.head.slice(0, 120));
  r = await g(`/api/updates?binding=${acct.binding}&binding=${acct.binding}`, { Cookie: acct.cookie });
  check("B9 dup binding params", r, [422]);
  r = await g(`/api/updates?binding=${"0".repeat(64)}`, { ...acctH });
  check("B10 header+query binding mismatch", r, [422]);
  r = await g("/api/updates?binding=zzz", { Cookie: acct.cookie });
  check("B11 malformed binding", r, [422]);

  // limit matrix (authed as identity)
  const IH = { Authorization: `Bearer ${ident.secret}` };
  const limits = { "5": 200, "1": 200, "100": 200, "0": 422, "-1": 422, "abc": 422, "": 422,
    "1.5": 422, "101": 422, "9999999999999999999999": 422, "Infinity": 422, "NaN": 422,
    "0x10": 200, "+5": 200, " 5 ": 200, "1e2": 200, "007": 200, "1_0": 422 };
  for (const [v, exp] of Object.entries(limits)) {
    r = await g(`/api/updates?limit=${encodeURIComponent(v)}`, IH);
    check(`B12 limit=${JSON.stringify(v)}`, r, [exp], r.head.slice(0, 120));
  }

  await shutdown(); await boot(); // B used ~30 GETs; reset
  console.log("== BATCH B2 ==");
  const acct2 = makeAccount("b2");
  const ident2 = makeIdentity();
  const IH2 = { Authorization: `Bearer ${ident2.secret}` };
  const g2 = (path, headers = {}, method = "GET") => { getCount++; return req({ method, path, headers }); };

  // state matrix
  for (const [v, exp] of [["actionable", 200], ["all", 200], ["", 422], ["ACTIONABLE", 422], ["bogus", 422], ["all ", 422]]) {
    r = await g2(`/api/updates?state=${encodeURIComponent(v)}`, IH2);
    check(`B13 state=${JSON.stringify(v)}`, r, [exp], r.head.slice(0, 120));
  }
  // kinds matrix
  for (const [v, exp] of [["mention", 200], ["bogus", 422], ["", 200], ["mention,mention", 200],
       ["mention,", 200], ["mention, mention", 200], [",", 422], ["a".repeat(200), 422]]) {
    r = await g2(`/api/updates?kinds=${encodeURIComponent(v)}`, IH2);
    check(`B14 kinds=${JSON.stringify(v).slice(0, 40)}`, r, [exp], r.head.slice(0, 120));
  }
  // cursor matrix
  for (const [v, exp] of [["!!!", 422], [Buffer.from("not-json").toString("base64url"), 422],
       [Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"), 422],
       [Buffer.from(JSON.stringify({ v: 2, viewer: "x", id: "y", updatedAt: "z", createdAt: "w" })).toString("base64url"), 422]]) {
    r = await g2(`/api/updates?cursor=${encodeURIComponent(v)}`, IH2);
    check(`B15 cursor=${v.slice(0, 30)}`, r, [exp], r.head.slice(0, 120));
  }
  // real cursor from identity A used by account B -> wrong-reader 422
  const acct3 = makeAccount("b3");
  const cur = await g2("/api/updates?limit=1", IH2).then(x => x.head);
  // (cursor only present when hasMore; instead craft a well-formed cursor for another viewer)
  const forged = Buffer.from(JSON.stringify({ v: 1, viewer: "identity:someone-else", updatedAt: "2026-01-01T00:00:00.000Z", id: "x".repeat(8) })).toString("base64url");
  r = await g2(`/api/updates?cursor=${forged}`, { Cookie: acct3.cookie, "X-Session-Binding": acct3.binding });
  check("B16 forged cursor wrong viewer", r, [422], r.head.slice(0, 120));

  // duplicate/unknown params
  r = await g2("/api/updates?limit=5&limit=5", IH2);
  check("B17 dup limit param", r, [422]);
  r = await g2("/api/updates?foo=1", IH2);
  check("B18 unknown param", r, [422]);
  r = await g2("/api/updates?auth=x", IH2);
  check("B19 auth param ignored", r, [200, 422], r.head.slice(0, 120));
  r = await g2("/api/updates?LIMIT=5", IH2);
  check("B20 uppercase LIMIT", r, [422]);

  await shutdown(); await boot(); // reset again
  console.log("== BATCH B3 ==");
  const acct4 = makeAccount("b4");
  const ident4 = makeIdentity();
  const IH4 = { Authorization: `Bearer ${ident4.secret}` };
  const g3 = (path, headers = {}, method = "GET") => { getCount++; return req({ method, path, headers }); };

  // methods
  r = await g3("/api/updates", IH4, "HEAD");
  check("B21 HEAD", r, [200]);
  r = await g3("/api/updates", IH4, "POST");
  check("B22 POST", r, [405], `allow=${r.allow}`);
  if (r.allow && !/GET/i.test(r.allow)) findings.push({ name: "B22 Allow header", status: "missing-GET", expected: ["GET in Allow"], head: r.allow });
  r = await g3("/api/updates", IH4, "PUT");
  check("B23 PUT", r, [405]);
  r = await g3("/api/updates", IH4, "OPTIONS");
  check("B24 OPTIONS", r, [405, 204]);

  // huge query
  r = await g3("/api/updates?" + "q=" + "y".repeat(8192), IH4);
  check("B25 huge query 8k", r, [200, 400, 414, 422], r.head.slice(0, 120));
  r = await g3("/api/updates?limit=%005", IH4);
  check("B26 limit null-byte", r, [200, 422], r.head.slice(0, 120));
  r = await g3("/api/updates?limit=5%00", IH4);
  check("B27 limit trailing null", r, [200, 422], r.head.slice(0, 120));

  // combo
  r = await g3("/api/updates?state=all&kinds=mention,dm&limit=10", { Cookie: acct4.cookie, "X-Session-Binding": acct4.binding });
  check("B28 full combo", r, [200], r.head.slice(0, 160));

  await shutdown();
}

await boot();
await batchA();
await batchB();
writeFileSync("worker-42/findings.json", JSON.stringify({ findings }, null, 1));
console.log(`\nDONE: ${findings.length} findings -> worker-42/findings.json`);
