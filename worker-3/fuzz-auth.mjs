#!/usr/bin/env node
// Authenticated fuzz for /api/account/profile (POST) and /api/updates (GET).
import http from "node:http";

const HOST = "127.0.0.1", PORT = 4773, ORIGIN = `http://${HOST}:${PORT}`;
const TIMEOUT = 10000;

function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "TIMEOUT", method, path }), TIMEOUT);
    const r = http.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      let chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(t); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8").slice(0, 300), method, path }); });
    });
    r.on("error", (e) => { clearTimeout(t); resolve({ error: e.code || e.message, method, path }); });
    if (body) r.write(body);
    r.end();
  });
}

// 1) mint a session slot (raw helper captures set-cookie)
function rawreq(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "TIMEOUT" }), TIMEOUT);
    const r = http.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      let chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(t); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }); });
    });
    r.on("error", (e) => { clearTimeout(t); resolve({ error: e.code || e.message }); });
    if (body) r.write(body);
    r.end();
  });
}

let jar = "";
async function reqj(method, path, opts = {}) {
  const r = await req(method, path, { ...opts, headers: { ...opts.headers, cookie: jar } });
  return r;
}

// The slot endpoint mints a NEW cookie per request; do it in one request:
const s1 = await rawreq("GET", "/api/account-session");
jar = (s1.headers["set-cookie"] || [""])[0].split(";")[0];
const view = JSON.parse(s1.text);
console.log("view:", JSON.stringify(view).slice(0, 200));

// 2) signup
const signup = await rawreq("POST", "/api/auth/password/signup", {
  headers: { "content-type": "application/json", origin: ORIGIN, cookie: jar },
  body: JSON.stringify({ email: "fuzz3@example.invalid", password: "fuzz-password-long-enough-123", sessionToken: jar.split("=")[1], sessionRevision: view.sessionRevision ?? view.session?.sessionRevision ?? view.revision }),
});
console.log("signup:", signup.status, signup.text.slice(0, 200));
const fresh = (signup.headers["set-cookie"] || []).map(String).join("; ");
const m = /account_session=([^;]+)/.exec(fresh);
if (m) jar = `account_session=${m[1]}`;
console.log("authed:", !!m);

// 3) complete login (signup leaves slot unconfirmed; login binds it)
const login = await rawreq("POST", "/api/auth/password/login", {
  headers: { "content-type": "application/json", origin: ORIGIN, cookie: jar },
  body: JSON.stringify({ email: "fuzz3@example.invalid", password: "fuzz-password-long-enough-123", sessionToken: jar.split("=")[1], sessionRevision: view.sessionRevision ?? view.session?.sessionRevision ?? view.revision }),
});
console.log("login:", login.status, login.text.slice(0, 200));
const lm = /account_session=([^;]+)/.exec((login.headers["set-cookie"] || []).map(String).join("; "));
if (lm) jar = `account_session=${lm[1]}`;
console.log("login-authed:", !!lm);
const loginView = JSON.parse(login.text);
const CSRF = loginView.csrf;
const BINDING = loginView.sessionBinding;
console.log("csrf:", String(CSRF).slice(0, 12), "binding:", String(BINDING).slice(0, 12));

const P = (label, method, path, opts = {}) => reqj(method, path, opts).then((r) => console.log(`${r.status ?? r.error}  ${label}  ${JSON.stringify(r.text ?? "").slice(0,160)}`));

// ---- profile POST body shapes (authed) ----
const json = (o) => JSON.stringify(o);
const profileBodies = [
  ["valid", json({ displayName: "fuzz" })],
  ["empty-obj", json({})],
  ["array", json([])],
  ["null", "null"],
  ["num-name", json({ displayName: 123 })],
  ["obj-name", json({ displayName: { x: 1 } })],
  ["arr-name", json({ displayName: ["x"] })],
  ["huge-name", json({ displayName: "n".repeat(100000) })],
  ["huge-avatar", json({ avatarUrl: "https://x/" + "a".repeat(100000) })],
  ["proto", json({ "__proto__": { polluted: true } })],
  ["proto-name", '{"displayName":"x","__proto__":{"a":1}}'],
  ["constructor", json({ constructor: { prototype: { p: 1 } } })],
  ["deep-nest", "[".repeat(5000) + "]".repeat(5000)],
  ["deep-obj", '{"a":'.repeat(3000) + '1' + '}'.repeat(3000)],
  ["unicode", json({ displayName: "🔥".repeat(20000) })],
  ["bad-url", json({ avatarUrl: "javascript:alert(1)" })],
  ["file-url", json({ avatarUrl: "file:///etc/passwd" })],
  ["extra-fields", json({ displayName: "x", admin: true, role: "owner" })],
  ["dup-keys", '{"displayName":"a","displayName":"b"}'],
  ["bool", json({ displayName: true })],
  ["trailing-garbage", json({ displayName: "x" }) + "GARBAGE"],
  ["two-json", '{"displayName":"x"}{"a":1}'],
  ["empty-string", ""],
  ["whitespace", "   "],
];
for (const [label, b] of profileBodies) {
  await P("profile:" + label, "POST", "/api/account/profile", { headers: { "content-type": "application/json", origin: ORIGIN, "x-csrf-token": CSRF }, body: b });
}

// ---- updates query shapes (authed) ----
const updateQs = [
  "?limit=abc", "?limit=-1", "?limit=0", "?limit=999999999", "?limit=1e3", "?limit=",
  "?limit=1&limit=2", "?state=x&state=y", "?kinds=a&kinds=b", "?unknown=1",
  "?cursor=" + "c".repeat(5000), "?limit=%2e", "?limit=+5", "?limit=0x10",
  "?state=" + "s".repeat(5000), "?kinds=" + "k".repeat(5000),
];
for (const q of updateQs) await P("updates" + q.slice(0, 30), "GET", "/api/updates" + q, { headers: { "x-session-binding": BINDING } });
await P("updates-HEAD", "HEAD", "/api/updates", { headers: { "x-session-binding": BINDING } });
await P("profile-GET", "GET", "/api/account/profile");
console.log("DONE");
