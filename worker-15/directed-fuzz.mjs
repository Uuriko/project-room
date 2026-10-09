// WORKER-15 directed fuzz — shard handlers:
//   H1: POST /api/account/onboarding/complete  (server/http.mjs:2373)
//   H2: POST /api/referral-invites/mint        (server/http.mjs:2973/2988)
// Method: local loopback servers (acceptance fixture / bootstrap store).
// Every case carries expected statuses; anything else (esp. 500/hang) is a finding.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const findings = [];
const TIMEOUT = 10000;

async function listen(server) {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server, store) {
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
  try { store.close(); } catch {}
}
async function req(origin, c) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(origin + c.path, {
      method: c.method, headers: c.headers || {}, body: c.body, signal: ctl.signal,
    });
    const text = await res.text().catch(() => "");
    let code = null;
    try { code = JSON.parse(text)?.error?.code ?? null; } catch {}
    return { status: res.status, code, ms: Date.now() - started, truncated: text.length };
  } catch (e) {
    return { status: "FETCH-ERROR", code: e.name, ms: Date.now() - started, truncated: 0 };
  } finally { clearTimeout(t); }
}

// ---------- H1 server: account session ----------
async function bootOnboarding() {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  const origin = await listen(server);
  const email = `w15-${Date.now()}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(origin + "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, password: "fixture-password-w15-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  if (res.status !== 202) throw new Error("signup failed: " + res.status);
  const freshToken = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(freshToken);
  const creds = { cookie: `account_session=${freshToken}`, csrf: session.csrf };
  return { f, server, origin, creds };
}

// ---------- H2 server: owner room key ----------
async function bootReferral() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-w15-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  const origin = await listen(server);
  return { server, store, origin, ownerKey, directory };
}

const J = o => JSON.stringify(o);
const authH = (origin, creds, extra = {}) => ({ "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie, "X-CSRF-Token": creds.csrf, ...extra });

async function runCase(origin, c) {
  const r = await req(origin, c);
  const ok = c.expect.includes(r.status);
  const rec = { name: c.name, method: c.method, path: c.path, status: r.status, code: r.code, ms: r.ms, expect: c.expect, ok };
  if (!ok) findings.push(rec);
  return rec;
}

const results = [];
async function batch(origin, cases) { for (const c of cases) results.push(await runCase(origin, c)); }

async function main() {
  // ================= H1: onboarding/complete =================
  const o = await bootOnboarding();
  const { origin, creds } = o;
  await batch(origin, [
    { name: "h1:no-cookie", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Origin: origin }, body: J({}), expect: [401] },
    { name: "h1:bogus-cookie", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Origin: origin, Cookie: "account_session=bogus" }, body: J({}), expect: [401] },
    { name: "h1:empty-cookie", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Origin: origin, Cookie: "account_session=" }, body: J({}), expect: [401] },
    { name: "h1:no-origin", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Cookie: creds.cookie, "X-CSRF-Token": creds.csrf }, body: J({}), expect: [403] },
    { name: "h1:foreign-origin", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: creds.cookie, "X-CSRF-Token": creds.csrf }, body: J({}), expect: [403] },
    { name: "h1:no-csrf", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie }, body: J({}), expect: [403] },
    { name: "h1:bad-csrf", method: "POST", path: "/api/account/onboarding/complete", headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie, "X-CSRF-Token": "wrong" }, body: J({}), expect: [403] },
    { name: "h1:valid", method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [200] },
    { name: "h1:repeat-complete", method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [200] },
    { name: "h1:garbage-body-not-read", method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: J({ junk: [1, 2, { deep: true }], x: "y".repeat(5000) }), expect: [200] },
    { name: "h1:non-json-body", method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds, { "Content-Type": "text/plain" }), body: "not json at all {{{", expect: [200] },
    { name: "h1:huge-body-unread", method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: "x".repeat(2_000_000), expect: [200, 413] },
    { name: "h1:query-string", method: "POST", path: "/api/account/onboarding/complete?x=1&y=%00", headers: authH(origin, creds), body: J({}), expect: [200] },
    { name: "h1:trailing-slash", method: "POST", path: "/api/account/onboarding/complete/", headers: authH(origin, creds), body: J({}), expect: [404] },
    { name: "h1:case-variant", method: "POST", path: "/api/account/Onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [404] },
    { name: "h1:double-slash", method: "POST", path: "/api//account/onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [404] },
    { name: "h1:get", method: "GET", path: "/api/account/onboarding/complete", headers: { Cookie: creds.cookie }, expect: [405] },
    { name: "h1:put", method: "PUT", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [405] },
    { name: "h1:delete", method: "DELETE", path: "/api/account/onboarding/complete", headers: authH(origin, creds), expect: [405] },
    { name: "h1:patch", method: "PATCH", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [405] },
    { name: "h1:head", method: "HEAD", path: "/api/account/onboarding/complete", headers: { Cookie: creds.cookie }, expect: [405] },
    { name: "h1:options", method: "OPTIONS", path: "/api/account/onboarding/complete", headers: authH(origin, creds), expect: [405] },
    { name: "h1:trace", method: "TRACE", path: "/api/account/onboarding/complete", headers: authH(origin, creds), expect: [405] },
    { name: "h1:malformed-json-valid-auth", method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: "{oops", expect: [200, 400] },
  ]);
  // rate probe: 35 rapid valid posts (limit 30/60s per address) — expect 429 tail, never 500
  const rateCases = [];
  for (let i = 0; i < 35; i++) rateCases.push({ name: `h1:rate-${i}`, method: "POST", path: "/api/account/onboarding/complete", headers: authH(origin, creds), body: J({}), expect: [200, 429] });
  await batch(origin, rateCases);
  await close(o.server, o.f.store);

  // ================= H2: referral-invites/mint =================
  const r2 = await bootReferral();
  const o2 = r2.origin, key = r2.ownerKey;
  const bh = (extra = {}) => ({ "Content-Type": "application/json", Origin: o2, Authorization: `Bearer ${key}`, ...extra });
  const rid = `w15-${Date.now()}`;
  await batch(o2, [
    { name: "h2:no-bearer", method: "POST", path: "/api/referral-invites/mint", headers: { "Content-Type": "application/json", Origin: o2 }, body: J({ roomId: "commons" }), expect: [401] },
    { name: "h2:garbage-bearer", method: "POST", path: "/api/referral-invites/mint", headers: { "Content-Type": "application/json", Origin: o2, Authorization: "Bearer garbage" }, body: J({ roomId: "commons" }), expect: [401] },
    { name: "h2:empty-bearer", method: "POST", path: "/api/referral-invites/mint", headers: { "Content-Type": "application/json", Origin: o2, Authorization: "Bearer " }, body: J({ roomId: "commons" }), expect: [401] },
    { name: "h2:missing-roomid", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({}), expect: [422] },
    { name: "h2:roomid-nonstring", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: 42 }), expect: [422] },
    { name: "h2:roomid-null", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: null }), expect: [422] },
    { name: "h2:roomid-object", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: { id: "commons" } }), expect: [422] },
    { name: "h2:roomid-array", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: ["commons"] }), expect: [422] },
    { name: "h2:roomid-empty", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "" }), expect: [401, 403, 404, 422] },
    { name: "h2:roomid-unknown", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "no-such-room" }), expect: [401, 403, 404] },
    { name: "h2:roomid-huge", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "c".repeat(10000) }), expect: [401, 403, 404, 422] },
    { name: "h2:roomid-traversal", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "../../etc" }), expect: [401, 403, 404] },
    { name: "h2:maxdepth-string", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: "3" }), expect: [422] },
    { name: "h2:maxdepth-zero", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: 0 }), expect: [422] },
    { name: "h2:maxdepth-negative", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: -5 }), expect: [422] },
    { name: "h2:maxdepth-fraction", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: 2.5 }), expect: [422] },
    { name: "h2:maxdepth-huge", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: 999999 }), expect: [422, 409] },
    { name: "h2:maxdepth-bool", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: true }), expect: [422] },
    { name: "h2:maxdepth-null", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: null }), expect: [422] },
    { name: "h2:maxdepth-nan-str", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", maxDepth: NaN }), expect: [422] },
    { name: "h2:extra-field", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", evil: 1 }), expect: [422] },
    { name: "h2:proto-pollution", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: '{"roomId":"commons","__proto__":{"x":1}}', expect: [201, 422] },
    { name: "h2:requestid-short", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", requestId: "abc" }), expect: [422] },
    { name: "h2:requestid-badchars", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", requestId: "bad id!!" }), expect: [422] },
    { name: "h2:requestid-nonstring", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", requestId: 12345678 }), expect: [422] },
    { name: "h2:valid-mint", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", requestId: rid }), expect: [201] },
    { name: "h2:idempotent-retry", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", requestId: rid }), expect: [200] },
    { name: "h2:idempotent-conflict", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", requestId: rid, maxDepth: 2 }), expect: [409] },
    { name: "h2:valid-keyless", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons" }), expect: [201] },
    { name: "h2:malformed-json", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: "{oops", expect: [400] },
    { name: "h2:huge-json", method: "POST", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons", pad: "p".repeat(2_000_000) }), expect: [413, 422] },
    { name: "h2:get", method: "GET", path: "/api/referral-invites/mint", headers: { Authorization: `Bearer ${key}` }, expect: [405] },
    { name: "h2:put", method: "PUT", path: "/api/referral-invites/mint", headers: bh(), body: J({ roomId: "commons" }), expect: [405] },
    { name: "h2:delete", method: "DELETE", path: "/api/referral-invites/mint", headers: bh(), expect: [405] },
    { name: "h2:options", method: "OPTIONS", path: "/api/referral-invites/mint", headers: bh(), expect: [405] },
    { name: "h2:no-origin", method: "POST", path: "/api/referral-invites/mint", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: J({ roomId: "commons" }), expect: [201, 403] },
    { name: "h2:foreign-origin", method: "POST", path: "/api/referral-invites/mint", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Authorization: `Bearer ${key}` }, body: J({ roomId: "commons" }), expect: [403] },
  ]);
  await close(r2.server, r2.store);
  rmSync(r2.directory, { recursive: true, force: true });

  const out = { total: results.length, failed: findings.length, results, findings };
  const fs = await import("node:fs");
  fs.writeFileSync("worker-15/results.json", JSON.stringify(out, null, 1));
  console.log(`total=${results.length} failed=${findings.length}`);
  for (const fnd of findings) console.log("FINDING", JSON.stringify(fnd));
}

main().catch(e => { console.error("HARNESS-ERROR", e); process.exit(1); });
