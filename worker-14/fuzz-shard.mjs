#!/usr/bin/env node
// WAVE-2000 G02 WORKER 14 (respawn). Shard: (index mod 50)==13 over the
// route-dispatch lines of server/http.mjs in file order. (The task's
// `app.(get|post|...)` pattern does not exist in this codebase — it uses a
// giant if-chain on url.pathname + req.method; the shard is taken over the
// 98 literal `if (... url.pathname ... "...")` dispatch lines, in order.)
//   idx 13 -> POST /api/oauth/sessions/revoke-all (http.mjs:1608)
//   idx 63 -> POST /api/guest-invites/rotate    (http.mjs:2519)
// Local-only fuzzing: boots a real server on 127.0.0.1 against a fresh
// RoomStore, hammers both endpoints with adversarial inputs, watches for
// crash (health probe dies), hang (per-request timeout), or wrong status.
// Results JSON -> worker-14/results-shard14.json
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const TIMEOUT_MS = 8000;
const results = { cases: [], anomalies: [] };
const dir = mkdtempSync(join(tmpdir(), "w14-shard-"));
let clock = Date.now();
const store = new RoomStore(join(dir, "room.sqlite"), { now: () => clock });
store.initialize(initialRoom());
const ownerKey = store.issueAccessKey("commons", "owner");
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const outPath = new URL("./results-shard14.json", import.meta.url).pathname;

async function healthy() {
  try {
    const r = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(4000) });
    return r.status === 200;
  } catch { return false; }
}

async function req(method, path, { headers = {}, rawBody = undefined } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(origin + path, { method, headers, body: rawBody, signal: ctl.signal });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - start, head: text.slice(0, 260) };
  } catch (e) {
    return { status: e.name === "AbortError" ? "TIMEOUT" : "FETCH-ERR", ms: Date.now() - start, head: String(e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

const j = obj => req("POST", obj.path, {
  headers: { "Content-Type": "application/json", Origin: origin, ...(obj.extraHeaders || {}) },
  rawBody: obj.body === undefined ? undefined : (typeof obj.body === "string" ? obj.body : JSON.stringify(obj.body)),
});

async function logCase(name, res, expect) {
  const up = await healthy();
  const c = { name, ...res, expect, serverAlive: up };
  const okStatus = expect ? (expect.includes(res.status) ? true : false) : true;
  if (!up || !okStatus || res.status === "TIMEOUT" || res.status === "FETCH-ERR") {
    c.anomaly = true; results.anomalies.push(c);
  }
  results.cases.push(c);
  console.log(`${c.anomaly ? "!! " : "   "}${name} -> ${res.status} (${res.ms}ms)`);
}

// ---- fixtures ----
// 1) password account -> account_session cookie + csrf
const slot = store.createAccountSessionSlot();
const signup2 = await fetch(origin + "/api/auth/password/signup", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ email: "w14-fuzz@example.invalid", password: "fixture-password-1-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }) });
const setCookie = signup2.headers.get("set-cookie") || "";
const acctToken = (/account_session=([^;]+)/.exec(setCookie) || [])[1] || null;
// account routes require x-session-binding + (for writes) x-csrf-token;
// derive both from the store's own auth object (same value the client would hold)
let acctSession = null;
try { acctSession = acctToken ? store.authenticateAccountSession(acctToken) : null; } catch {}
const authCookie = acctToken ? { Cookie: `account_session=${acctToken}` } : {};
const authHeaders = acctSession ? { ...authCookie, "x-session-binding": acctSession.sessionBinding, "X-CSRF-Token": acctSession.csrf } : authCookie;
console.log("account cookie minted:", !!acctToken, "(signup status", signup2.status + ")", "binding:", !!acctSession?.sessionBinding);

// 2) guest credential: owner mints invite, agent redeems
const ident = store.identities.create("w14guest");
const keys = generateKeyPair();
const cardBody = { name: "w14guest", description: "fuzz guest", capabilities: ["chat"] };
const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: ident.identityId, card: cardBody, privateKey: keys.privateKey }) };
const mint = await (async () => {
  const r = await fetch(origin + "/api/rooms/commons/guest-invites", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ requestId: crypto.randomUUID(), guestLabel: "w14", expectedOwnerRevision: 0, tier: "observer" }) });
  return r.json();
})();
const redeemRes = await fetch(origin + "/api/guest-invites/redeem", { method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ident.secret}` },
  body: JSON.stringify({ inviteCode: mint.code, card }) });
const guest = redeemRes.status === 201 ? await redeemRes.json() : null;
console.log("guest minted:", !!guest?.token, "(redeem status", redeemRes.status + ")");
const guestAuth = guest?.token ? { Authorization: `Bearer ${guest.token}` } : {};

const R = "/api/oauth/sessions/revoke-all";
const G = "/api/guest-invites/rotate";
const ORIGIN = { Origin: origin };

// ===== TARGET 1: POST /api/oauth/sessions/revoke-all =====
console.log("\n--- POST /api/oauth/sessions/revoke-all ---");
// method matrix
// NOTE: DELETE /api/oauth/sessions/revoke-all ALSO matches the DELETE
// /api/oauth/sessions/:familyId regex (familyId="revoke-all") — expected 404 after binding.
for (const m of ["GET", "PUT", "PATCH", "OPTIONS", "HEAD"]) {
  const r = await req(m, R, { headers: { ...ORIGIN, ...authHeaders } });
  await logCase(`revoke-all method=${m} (authed)`, r, [404, 405]);
}
const delAlias = await req("DELETE", R, { headers: { ...ORIGIN, ...authHeaders } });
await logCase("revoke-all DELETE (authed) — hits :familyId regex alias", delAlias, [404]);
// unauthenticated
await logCase("revoke-all no cookie", await req("POST", R, { headers: ORIGIN }), [401]);
await logCase("revoke-all garbage cookie + binding hdr", await req("POST", R, { headers: { ...ORIGIN, Cookie: "account_session=" + "a".repeat(43), "x-session-binding": "b".repeat(64) } }), [401]);
await logCase("revoke-all garbage cookie, no binding hdr", await req("POST", R, { headers: { ...ORIGIN, Cookie: "account_session=not-a-real-token" } }), [422]); // binding gate fires first by design
await logCase("revoke-all empty cookie value", await req("POST", R, { headers: { ...ORIGIN, Cookie: "account_session=" } }), [401]);
await logCase("revoke-all malformed binding header", await req("POST", R, { headers: { ...ORIGIN, ...authCookie, "x-session-binding": "zzz" } }), [422]);
await logCase("revoke-all no csrf", await req("POST", R, { headers: { ...ORIGIN, ...authCookie, "x-session-binding": acctSession?.sessionBinding ?? "" }, rawBody: undefined }), [403]);
// body abuse — handler never reads the body, so all of these must be 200 (authed)
const bodyCases = [
  ["{} JSON object", "{}", 200],
  ["empty body no content-type", undefined, 200],
  ["JSON array", "[1,2,3]", 200],
  ["JSON scalar number", "42", 200],
  ["JSON string", '"x"', 200],
  ["JSON null", "null", 200],
  ["malformed JSON", "{nope", 200],
  ["empty body with JSON ct", "", 200],
  ["null bytes", "\u0000\u0000{}", 200],
  ["deep nesting", JSON.stringify(nest(500)), 200],
  ["text/plain body", "hello", 200],
  ["huge body 200KB", "x".repeat(200 * 1024), 200],
];
for (const [name, b, exp] of bodyCases) {
  const r = await req("POST", R, { headers: { ...ORIGIN, ...authHeaders, ...(b === undefined ? {} : (name.includes("text/plain") ? { "Content-Type": "text/plain" } : { "Content-Type": "application/json" })) }, rawBody: b });
  await logCase(`revoke-all body: ${name}`, r, [exp]);
}
// header attacks
await logCase("revoke-all 16KB cookie", await req("POST", R, { headers: { ...ORIGIN, Cookie: "account_session=" + "A".repeat(16 * 1024) } }), [401, 422, 431]);
await logCase("revoke-all oversize bearer", await req("POST", R, { headers: { ...ORIGIN, ...authHeaders, Authorization: "Bearer x".repeat(2000) } }), [200, 400, 401]);

// functional check: create oauth sessions, revoke-all kills them
// (mint a session via oauth provider if possible)
let oauthSessionCount = "n/a";
try {
  const list = await req("GET", "/api/oauth/sessions", { headers: { ...ORIGIN, ...authCookie } });
  oauthSessionCount = list.head;
  await logCase("sessions list (authed, pre-revoke)", list, [200]);
} catch (e) { results.cases.push({ name: "sessions list probe", err: String(e) }); }
const rr = await req("POST", R, { headers: { ...ORIGIN, ...authCookie, "Content-Type": "application/json" }, rawBody: "{}" });
await logCase("revoke-all authed valid", rr, [200]);
try {
  const parsed = JSON.parse(rr.head);
  results.cases.push({ name: "revoke-all response shape", revoked: parsed.revoked, type: typeof parsed.revoked });
} catch { /* non-json */ }

// double-revoke idempotence
const rr2 = await req("POST", R, { headers: { ...ORIGIN, ...authCookie, "Content-Type": "application/json" }, rawBody: "{}" });
await logCase("revoke-all authed second call", rr2, [200]);

// ===== TARGET 2: POST /api/guest-invites/rotate =====
console.log("\n--- POST /api/guest-invites/rotate ---");
// method matrix (no auth needed for 404/405 determination; use guest auth)
for (const m of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
  const r = await req(m, G, { headers: { ...ORIGIN, ...guestAuth } });
  await logCase(`rotate method=${m}`, r, [404, 405]);
}
await logCase("rotate no bearer", await req("POST", G, { headers: { ...ORIGIN, "Content-Type": "application/json" }, rawBody: "{}" }), [401]);
await logCase("rotate malformed bearer shape", await req("POST", G, { headers: { ...ORIGIN, Authorization: "Bearer garbage-token", "Content-Type": "application/json" }, rawBody: JSON.stringify({ roomId: "commons" }) }), [401]); // bearer() shape gate by design
await logCase("rotate shape-valid fake guest token", await req("POST", G, { headers: { ...ORIGIN, Authorization: `Bearer ga1.${"A".repeat(43)}`, "Content-Type": "application/json" }, rawBody: JSON.stringify({ roomId: "commons" }) }), [410]);
await logCase("rotate owner key as bearer", await req("POST", G, { headers: { ...ORIGIN, Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" }, rawBody: JSON.stringify({ roomId: "commons" }) }), [403, 410]);
if (guest?.token) {
  const rb = (b, ct = "application/json") => req("POST", G, { headers: { ...ORIGIN, ...guestAuth, ...(ct ? { "Content-Type": ct } : {}) }, rawBody: b });
  await logCase("rotate missing roomId", await rb(JSON.stringify({})), [422]);
  await logCase("rotate roomId number", await rb(JSON.stringify({ roomId: 42 })), [422]);
  await logCase("rotate roomId null", await rb(JSON.stringify({ roomId: null })), [422]);
  await logCase("rotate roomId empty", await rb(JSON.stringify({ roomId: "" })), [422]);
  await logCase("rotate roomId array", await rb(JSON.stringify({ roomId: ["commons"] })), [422]);
  await logCase("rotate roomId bad chars", await rb(JSON.stringify({ roomId: "../../etc" })), [422]);
  await logCase("rotate roomId 384 chars", await rb(JSON.stringify({ roomId: "r".repeat(384) })), [404, 410, 422]);
  await logCase("rotate roomId unknown", await rb(JSON.stringify({ roomId: "no-such-room" })), [404, 410, 422]);
  await logCase("rotate non-JSON body", await rb("{bad", "application/json"), [400]);
  await logCase("rotate text/plain", await rb("hello", "text/plain"), [415]);
  await logCase("rotate huge body", await rb("x".repeat(200 * 1024)), [413]);
  await logCase("rotate null bytes", await rb("\u0000{}"), [400]);
  await logCase("rotate JSON array body", await rb(JSON.stringify([1, 2])), [422]);
  await logCase("rotate no content-type", await rb(JSON.stringify({ roomId: "commons" }), null), [415]);
  // the happy path (do this AFTER the negative cases — rotate revokes the old token)
  const ok = await rb(JSON.stringify({ roomId: "commons" }));
  await logCase("rotate happy path", ok, [200]);
  let newToken = null;
  try { newToken = JSON.parse(ok.head).token; } catch {}
  results.cases.push({ name: "rotate new token shape", ga1Prefix: !!newToken?.startsWith("ga1."), differs: !!newToken && newToken !== guest.token });
  // old token must now be dead
  const dead = await req("POST", G, { headers: { ...ORIGIN, Authorization: `Bearer ${guest.token}`, "Content-Type": "application/json" }, rawBody: JSON.stringify({ roomId: "commons" }) });
  await logCase("rotate with revoked old token", dead, [410]);
  // double-rotate with new token
  if (newToken) {
    const ok2 = await req("POST", G, { headers: { ...ORIGIN, Authorization: `Bearer ${newToken}`, "Content-Type": "application/json" }, rawBody: JSON.stringify({ roomId: "commons" }) });
    await logCase("rotate again with new token", ok2, [200]);
  }
} else {
  results.cases.push({ name: "guest mint failed — rotate auth cases skipped", mintCode: redeemRes.status });
}

// cross-target sanity: server still alive
await logCase("final health check", await req("GET", "/api/health"), [200]);

writeFileSync(outPath, JSON.stringify({ startedAt: new Date().toISOString(), totals: { cases: results.cases.length, anomalies: results.anomalies.length }, cases: results.cases, anomalies: results.anomalies }, null, 2));
console.log(`\n${results.cases.length} cases, ${results.anomalies.length} anomalies -> ${outPath}`);

server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
store.close();
rmSync(dir, { recursive: true, force: true });

function nest(n) { let o = {}; let c = o; for (let i = 0; i < n; i++) { c.a = {}; c = c.a; } return o; }
