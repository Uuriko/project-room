// WAVE-2000 G02 WORKER 16/50 — API fuzz battery.
// Shard (index mod 50)==15 over sorted http.mjs dispatch list:
//   #15: POST /api/account/onboarding/complete (http.mjs:2372)
//   #65: GET  /api/public/rooms/directory      (http.mjs:1722)
// Boots an in-process fixture server (same harness as tests/account-management.test.js)
// and fuzzes both endpoints over HTTP. Results appended to fuzz-results.md.
// Crash/hang/wrong-status -> FAIL line + minimal repro printed.

import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
let failures = 0;
const note = (name, ok, detail) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) { failures++; console.log(`!!! FAIL: ${name} — ${detail}`); }
};
const req = async (method, path, { headers = {}, body = undefined, timeoutMs = 8000 } = {}) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(origin + path, { method, headers, body, signal: ctl.signal, redirect: "manual" });
    const text = await res.text().catch(() => "<unreadable>");
    return { status: res.status, ms: Date.now() - start, text: text.slice(0, 400), headers: res.headers };
  } catch (e) {
    return { status: "ERROR", ms: Date.now() - start, text: String(e).slice(0, 200) };
  } finally { clearTimeout(t); }
};
const shape = r => r.status === "ERROR" ? `transport-error(${r.text})` : `status=${r.status} ms=${r.ms} body=${r.text.slice(0,120)}`;

// ---------- setup: real account via the password signup route ----------
const slot = f.store.createAccountSessionSlot();
const email = `w16-fuzz@example.invalid`;
let r = await req("POST", "/api/auth/password/signup", {
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({ email, password: "fixture-password-16-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
});
note("signup sanity", r.status === 202, shape(r));
const freshToken = /account_session=([^;]+)/.exec(r.headers.get?.("set-cookie") || "")?.[1];
const session = f.store.authenticateAccountSession(freshToken);
const cookie = `account_session=${freshToken}`;
const csrf = session.csrf;
note("signup issued session+csrf", !!freshToken && !!csrf, `token=${!!freshToken} csrf=${!!csrf}`);

// ================= A. GET /api/public/rooms/directory =================
const DIR = "/api/public/rooms/directory";
r = await req("GET", DIR);
let dirBody = null;
try { dirBody = JSON.parse(r.text); } catch {}
note("A1 baseline GET 200 + shape", r.status === 200 && dirBody && Array.isArray(dirBody.rooms) && "nextCursor" in dirBody, shape(r));

for (const m of ["POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"]) {
  r = await req(m, DIR);
  note(`A2 method ${m} -> 405`, r.status === 405, shape(r));
}

const limitCases = [
  ["abc", 200], ["-5", 200], ["0", 200], ["999999999999", 200], ["1e3", 200],
  ["Infinity", 200], ["NaN", 200], ["", 200], ["10.9", 200], ["0x10", 200],
  ["\uFF15", 200], ["%00", 200], ["%20", 200], ["1%202", 200],
];
for (const [lv, want] of limitCases) {
  r = await req("GET", `${DIR}?limit=${lv}`);
  note(`A3 limit=${JSON.stringify(lv)} -> ${want}`, r.status === want, shape(r));
}
r = await req("GET", `${DIR}?limit=${"9".repeat(10000)}`);
note("A4 limit=10k-digit string -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?limit=5&limit=999999999999`);
note("A5 duplicate limit -> 200 (first wins)", r.status === 200, shape(r));
r = await req("GET", `${DIR}?limit[]=5`);
note("A6 limit[]=5 -> 200", r.status === 200, shape(r));

const after385 = "a".repeat(385), after384 = "b".repeat(384);
r = await req("GET", `${DIR}?after=${after385}`);
note("A7 after=385 chars -> 422 invalid_cursor", r.status === 422 && r.text.includes("invalid_cursor"), shape(r));
r = await req("GET", `${DIR}?after=${after384}`);
note("A8 after=384 chars -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=${encodeURIComponent("' OR '1'='1")}`);
note("A9 after=SQLi probe -> 200 (prepared stmt)", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=`);
note("A10 after= (empty) -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=%F0%9F%9A%80`);
note("A11 after=emoji -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=a&after=b`);
note("A12 duplicate after -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=%0a%0d`);
note("A13 after=CRLF -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=%00`);
note("A14 after=NUL -> 200", r.status === 200, shape(r));
r = await req("GET", `${DIR}?foo=bar&limit=3`);
note("A15 unknown query param -> 200 (accepted)", r.status === 200, shape(r));
r = await req("GET", `${DIR}?after=zzz&limit=-0`);
note("A16 after=zzz&limit=-0 -> 200", r.status === 200, shape(r));

// ================= B. POST /api/account/onboarding/complete =================
const OB = "/api/account/onboarding/complete";
for (const m of ["GET", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"]) {
  r = await req(m, OB, { headers: { Origin: origin } });
  note(`B1 method ${m} -> 405`, r.status === 405, shape(r));
}
r = await req("POST", OB);
note("B2 POST no Origin no cookie -> 403 origin_denied", r.status === 403 && r.text.includes("origin_denied"), shape(r));
r = await req("POST", OB, { headers: { Origin: "https://evil.example" } });
note("B3 POST foreign Origin -> 403 origin_denied", r.status === 403 && r.text.includes("origin_denied"), shape(r));
r = await req("POST", OB, { headers: { Origin: origin } });
note("B4 POST good Origin no cookie -> 401 account_session_required", r.status === 401 && r.text.includes("account_session_required"), shape(r));
r = await req("POST", OB, { headers: { Origin: origin, Cookie: "account_session=garbage-token" } });
note("B5 POST garbage cookie -> 401 invalid_session", r.status === 401 && r.text.includes("invalid_session"), shape(r));
r = await req("POST", OB, { headers: { Cookie: cookie } });
note("B6 POST valid cookie but no Origin -> 403 (origin checked first)", r.status === 403, shape(r));
r = await req("POST", OB, { headers: { Origin: origin, Cookie: cookie } });
note("B7 POST valid cookie, no CSRF -> 403 csrf_denied", r.status === 403 && r.text.includes("csrf"), shape(r));
r = await req("POST", OB, { headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}" });
note("B8 happy path -> 200 completed=true", r.status === 200 && r.text.includes('"completed":true'), shape(r));
r = await req("POST", OB, { headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}" });
note("B9 idempotent re-complete -> 200 completed=true", r.status === 200 && r.text.includes('"completed":true'), shape(r));
r = await req("POST", OB, { headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf }, body: "this is not json{{{" });
note("B10 invalid JSON body -> 200 (body never parsed)", r.status === 200, shape(r));
const big = "x".repeat(5 * 1024 * 1024);
r = await req("POST", OB, { headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "text/plain" }, body: big });
note("B11 5MB body unread -> 200 fast (<3s)", r.status === 200 && r.ms < 3000, shape(r));
r = await req("POST", OB, { headers: { Origin: origin, Cookie: "account_session=" + "z".repeat(5000), "X-CSRF-Token": csrf } });
note("B12 5k-char garbage cookie -> 401", r.status === 401, shape(r));
r = await req("POST", OB + "?x=1&y=2", { headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}" });
note("B13 query params ignored -> 200", r.status === 200, shape(r));
r = await req("POST", OB, { headers: { Origin: origin + "/", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}" });
note("B14 Origin with trailing slash -> 403 (exact match)", r.status === 403, shape(r));

console.log(`\n==== ${results.length} checks, ${failures} failures ====`);
results.forEach(l => console.log(l));

server.closeStreams(); server.closeAllConnections();
await new Promise(res => server.close(res));
f.store.close();
process.exit(failures ? 1 : 0);
