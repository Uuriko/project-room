// WAVE-2000 guild-02 worker-13 fuzzer.
// Endpoints: POST /api/auth/email/verify/resend, GET /api/account/retention
const BASE = "http://127.0.0.1:49113";
const ORIGIN = "http://127.0.0.1:49113";
import { readFileSync } from "node:fs";
const fixtures = readFileSync("worker-13/fixtures.json", "utf8").trim().split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
const F = Object.fromEntries(fixtures.map(f => [f.accountId, f]));

const results = [];
async function probe(name, method, path, { headers = {}, body = null, expect, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let rec = { name, method, path, expect };
  try {
    const res = await fetch(BASE + path, {
      method, headers, body,
      signal: ctrl.signal,
      redirect: "manual",
    });
    const text = await res.text().catch(() => "<unreadable>");
    rec.status = res.status;
    rec.body = text.slice(0, 300);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    rec.code = parsed?.code ?? parsed?.error ?? null;
  } catch (e) {
    rec.error = e.name + ": " + e.message;
  } finally { clearTimeout(t); }
  const pass = rec.error ? false : (expect === undefined || rec.status === expect);
  rec.pass = pass;
  results.push(rec);
  console.log(`${pass ? "PASS" : "FAIL"} ${rec.status ?? rec.error} (exp ${expect}) ${name} :: ${rec.code ?? rec.body?.slice(0, 80) ?? ""}`);
  return rec;
}

const O = { Origin: ORIGIN };
const ck = id => `account_session=${F[id].token}`;
const csrfH = id => ({ "x-csrf-token": F[id].csrf });
const authH = id => ({ ...O, Cookie: ck(id), ...csrfH(id) });
const authNoCsrf = id => ({ ...O, Cookie: ck(id) });

const R = "/api/auth/email/verify/resend";
const T = "/api/account/retention";

// ---- /api/auth/email/verify/resend ----
await probe("resend GET no-auth", "GET", R, { expect: 405 });
await probe("resend HEAD no-auth", "HEAD", R, { expect: 405 });
await probe("resend OPTIONS", "OPTIONS", R, { expect: 405 });
await probe("resend POST no-origin no-cookie", "POST", R, { expect: 403 }); // checkOrigin before cookie
await probe("resend POST bad-origin", "POST", R, { headers: { Origin: "https://evil.example.com" }, expect: 403 });
await probe("resend POST origin-case", "POST", R, { headers: { Origin: ORIGIN.toUpperCase() }, expect: 403 });
await probe("resend POST origin+no-cookie", "POST", R, { headers: O, expect: 401 });
await probe("resend POST origin+garbage-cookie", "POST", R, { headers: { ...O, Cookie: "account_session=xxx" }, expect: 401 });
await probe("resend POST origin+empty-cookie", "POST", R, { headers: { ...O, Cookie: "account_session=" }, expect: 401 });
await probe("resend POST origin+cookie-no-csrf", "POST", R, { headers: authNoCsrf("acct-noemail"), expect: 403 });
await probe("resend POST origin+cookie-bad-csrf", "POST", R, { headers: { ...O, Cookie: ck("acct-noemail"), "x-csrf-token": "deadbeef" }, expect: 403 });
await probe("resend POST origin+cookie-csrf-csrf-in-cookie", "POST", R, { headers: { ...O, Cookie: `${ck("acct-noemail")}; x-csrf-token=${F["acct-noemail"].csrf}` }, expect: 403 });
await probe("resend POST origin+cookie-wellformed-wrong-csrf", "POST", R, { headers: { ...O, Cookie: ck("acct-noemail"), "x-csrf-token": "0".repeat(64) }, expect: 403 });
await probe("resend POST noemail-acct", "POST", R, { headers: authH("acct-noemail"), expect: 422 });
await probe("resend POST unverified-acct", "POST", R, { headers: authH("acct-unverified"), expect: 503 });
await probe("resend POST verified-acct", "POST", R, { headers: authH("acct-verified"), expect: 200 });
await probe("resend POST dup-cookie", "POST", R, { headers: { ...O, Cookie: `account_session=${F["acct-noemail"].token}; account_session=${F["acct-unverified"].token}`, ...csrfH("acct-noemail") }, expect: 401 });
await probe("resend POST huge-json-body", "POST", R, { headers: { ...O, ...authH("acct-noemail"), "Content-Type": "application/json" }, body: JSON.stringify({ x: "A".repeat(200000) }), expect: 422 });
await probe("resend POST garbage-body", "POST", R, { headers: { ...O, ...authH("acct-noemail"), "Content-Type": "application/json" }, body: "{not json", expect: 422 });
await probe("resend POST text-body", "POST", R, { headers: { ...O, ...authH("acct-noemail"), "Content-Type": "text/plain" }, body: "hello", expect: 422 });
await probe("resend POST trailing-slash", "POST", R + "/", { headers: authH("acct-verified"), expect: 200 });
await probe("resend POST query-string", "POST", R + "?foo=bar", { headers: authH("acct-verified"), expect: 200 });
await probe("resend POST declared-100MB-nobody", "POST", R, { headers: { ...O, ...authH("acct-noemail") }, body: "", expect: 422 });
// rate limit: acct-noemail consumed 5 units above (noemail, huge, garbage, text, 100MB probes) → next is 429
await probe("resend POST rate-exceed-1", "POST", R, { headers: authH("acct-noemail"), expect: 429 });
await probe("resend POST rate-exceed-2", "POST", R, { headers: authH("acct-noemail"), expect: 429 });
await probe("resend POST other-acct-unaffected", "POST", R, { headers: authH("acct-unverified"), expect: 503 });

// ---- /api/account/retention ----
await probe("retention POST", "POST", T, { headers: O, expect: 405 });
await probe("retention HEAD", "HEAD", T, { expect: 405 });
await probe("retention PUT", "PUT", T, { expect: 405 });
await probe("retention DELETE", "DELETE", T, { expect: 405 });
await probe("retention OPTIONS", "OPTIONS", T, { expect: 405 });
await probe("retention GET no-cookie", "GET", T, { expect: 401 });
await probe("retention GET garbage-cookie", "GET", T, { headers: { Cookie: "account_session=nope" }, expect: 401 });
await probe("retention GET empty-cookie", "GET", T, { headers: { Cookie: "account_session=" }, expect: 401 });
await probe("retention GET noemail-acct", "GET", T, { headers: { Cookie: ck("acct-noemail") }, expect: 200 });
await probe("retention GET unverified-acct", "GET", T, { headers: { Cookie: ck("acct-unverified") }, expect: 200 });
await probe("retention GET dup-cookie", "GET", T, { headers: { Cookie: `account_session=${F["acct-noemail"].token}; account_session=x` }, expect: 401 });
await probe("retention GET query", "GET", T + "?a=1&b=2", { headers: { Cookie: ck("acct-noemail") }, expect: 200 });
await probe("retention GET trailing-slash", "GET", T + "/", { headers: { Cookie: ck("acct-noemail") }, expect: 200 });
await probe("retention GET long-path", "GET", T + "/" + "x".repeat(3000), { headers: { Cookie: ck("acct-noemail") }, expect: 404 });
await probe("retention GET bad-origin-denied", "GET", T, { headers: { Origin: "https://evil.example.com", Cookie: ck("acct-noemail") }, expect: 403 });
await probe("retention GET no-origin-header", "GET", T, { headers: { Cookie: ck("acct-noemail") }, expect: 200 });

const fails = results.filter(r => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
import { writeFileSync } from "node:fs";
writeFileSync("worker-13/fuzz-results.json", JSON.stringify(results, null, 1));
