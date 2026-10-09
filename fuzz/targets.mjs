// WAVE-2000 GUILD-02: 50 fuzz targets over server/http.mjs routes.
// Each target: { id, name, make(): case[] }. Cases come from adversarial.mjs.
import { methodMatrix, jsonCases, invalidUtf8Case, queryCases, headerCases, rawSocketCases } from "./adversarial.mjs";

const g = (path) => [
  ...methodMatrix(path),
  ...queryCases(path),
  { name: "get:plain", method: "GET", path, headers: {}, body: null, timeoutMs: 8000 },
];
const p = (path, extraHeaders = {}) => [
  ...methodMatrix(path),
  ...jsonCases(path, "POST", extraHeaders),
  invalidUtf8Case(path),
  ...headerCases(path, "POST"),
  ...queryCases(path),
];
const gp = (path, extraHeaders = {}) => [...g(path), ...jsonCases(path, "POST", extraHeaders)];

// 128/129-char id boundary probes for the {1,128} regex routes.
const id128 = "a".repeat(128);
const id129 = "a".repeat(129);

export const TARGETS = [
  { id: 1, name: "health/ready/version", make: () => [...g("/api/health"), ...g("/api/health/"), ...g("/api/ready"), ...g("/api/version")] },
  { id: 2, name: "well-known + security.txt", make: () => [...g("/.well-known/security.txt"), ...g("/security.txt"), ...g("/room/.well-known/security.txt"), ...g("/.well-known/oauth-authorization-server"), ...g("/.well-known/feedback")] },
  { id: 3, name: "static/meta (openapi, sitemap, templates, favicon)", make: () => [...g("/openapi.json"), ...g("/room/openapi.json"), ...g("/sitemap.xml"), ...g("/templates.json"), ...g("/templates"), ...g("/favicon.ico"), ...g("/room/favicon.ico"), ...g("/agents")] },
  { id: 4, name: "auth/email verify+resend", make: () => [...p("/api/auth/email/verify"), ...p("/api/auth/email/verify/resend")] },
  { id: 5, name: "github oauth link/start", make: () => [...g("/api/auth/github/link/start"), ...queryCases("/api/auth/github/link/start")] },
  { id: 6, name: "google oauth link/start", make: () => [...g("/api/auth/google/link/start"), ...queryCases("/api/auth/google/link/start")] },
  { id: 7, name: "gmail callback", make: () => [...g("/api/auth/gmail/callback"), ...queryCases("/api/auth/gmail/callback?code=zzz&state=zzz")] },
  { id: 8, name: "auth methods enable/disable/remove", make: () => [...g("/api/auth/methods"), ...p("/api/auth/methods/enable"), ...p("/api/auth/methods/disable"), ...p("/api/auth/methods/remove")] },
  { id: 9, name: "auth password set", make: () => [...p("/api/auth/password/set")] },
  { id: 10, name: "recovery codes gen/redeem/status", make: () => [...p("/api/auth/recovery-codes/generate"), ...p("/api/auth/recovery-codes/redeem"), ...p("/api/auth/recovery-codes/status")] },
  { id: 11, name: "oauth authorize GET+POST", make: () => [...g("/oauth/authorize"), ...p("/oauth/authorize"), ...queryCases("/oauth/authorize?client_id=x&redirect_uri=https://evil.example.com&response_type=code&state=s")] },
  { id: 12, name: "oauth token + revoke", make: () => [...p("/oauth/token"), ...p("/oauth/revoke")] },
  { id: 13, name: "oauth sessions + revoke-all", make: () => [...g("/api/oauth/sessions"), ...p("/api/oauth/sessions/revoke-all")] },
  { id: 14, name: "guest-invites family", make: () => [...gp("/api/guest-invites"), ...g("/api/guest-invites/preview"), ...p("/api/guest-invites/redeem"), ...p("/api/guest-invites/request"), ...p("/api/guest-invites/rotate")] },
  { id: 15, name: "guest-agent-links family", make: () => [...g("/api/guest-agent-links"), ...g("/api/guest-agent-links/preview"), ...p("/api/guest-agent-links/join"), ...p("/api/guest-agent-links/refresh")] },
  { id: 16, name: "agent-invites preview/redeem", make: () => [...g("/api/agent-invites/preview"), ...p("/api/agent-invites/redeem")] },
  { id: 17, name: "session endpoints", make: () => [...g("/api/session"), ...g("/api/account-session")] },
  { id: 18, name: "account-rooms + from-template", make: () => [...g("/api/account-rooms"), ...p("/api/account-rooms/from-template")] },
  { id: 19, name: "onboarding + ensure-default-room", make: () => [...g("/api/account/onboarding"), ...p("/api/account/onboarding/complete"), ...p("/api/account/ensure-default-room")] },
  { id: 20, name: "account profile/retention/deletion", make: () => [...g("/api/account/profile"), ...p("/api/account/profile"), ...g("/api/account/retention"), ...p("/api/account/retention"), ...g("/api/account/deletion/plan"), ...p("/api/account/delete")] },
  { id: 21, name: "public-work match", make: () => [...p("/api/public-work/match")] },
  { id: 22, name: "public-work tasks + actions", make: () => {
      const t = `/api/public-work/tasks/${id128}`, t129 = `/api/public-work/tasks/${id129}`;
      return [...gp("/api/public-work/tasks"),
        ...g(t), ...g(t129),
        ...p(`${t}/claim`), ...p(`${t}/renew`), ...p(`${t}/release`), ...p(`${t}/finish`),
        ...p(`${t129}/claim`),
        { name: "path:traversal-in-id", method: "GET", path: "/api/public-work/tasks/..%2f..%2fetc", headers: {}, body: null, timeoutMs: 8000 },
        { name: "path:encoded-slash", method: "GET", path: "/api/public-work/tasks/a%2fb", headers: {}, body: null, timeoutMs: 8000 },
        { name: "path:null-byte-id", method: "GET", path: "/api/public-work/tasks/a%00b", headers: {}, body: null, timeoutMs: 8000 }];
    } },
  { id: 23, name: "public-work receipts + artifact + review", make: () => {
      const r = `/api/public-work/receipts/${id128}`;
      return [...g(r), ...g(`${r}/artifact`), ...p(`${r}/review`),
        { name: "path:bad-action", method: "POST", path: `/api/public-work/receipts/${id128}/delete`, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 8000 }];
    } },
  { id: 24, name: "project-offers + brief.md", make: () => {
      const o = `/api/project-offers/${id128}`;
      return [...gp("/api/project-offers"), ...g(o), ...g(`${o}/brief.md`),
        { name: "path:brief-case-variant", method: "GET", path: `${o}/BRIEF.md`, headers: {}, body: null, timeoutMs: 8000 },
        { name: "path:brief-trailing", method: "GET", path: `${o}/brief.md/`, headers: {}, body: null, timeoutMs: 8000 },
        { name: "path:129-id", method: "GET", path: `/api/project-offers/${id129}`, headers: {}, body: null, timeoutMs: 8000 }];
    } },
  { id: 25, name: "opportunities.json", make: () => [...gp("/api/opportunities.json")] },
  { id: 26, name: "public rooms directory/feed/face", make: () => {
      const c = "a".repeat(128);
      return [...g("/api/public/rooms/directory"), ...g(`/api/public/rooms/${c}`), ...g(`/api/public/rooms/${c}/feed`), ...g(`/p/${c}`),
        { name: "path:feed-bad-sub", method: "GET", path: `/api/public/rooms/${c}/feed/extra`, headers: {}, body: null, timeoutMs: 8000 },
        { name: "path:code-129", method: "GET", path: `/p/${"b".repeat(129)}`, headers: {}, body: null, timeoutMs: 8000 }];
    } },
  { id: 27, name: "receipts public", make: () => [...g("/receipts"), ...g("/api/public/receipts"), ...g(`/api/public/receipts/${id128}`)] },
  { id: 28, name: "access-requests", make: () => [...gp("/api/access-requests")] },
  { id: 29, name: "share-links preview/join/join-agent", make: () => [...p("/api/share-links/preview"), ...p("/api/share-links/join"), ...p("/api/share-links/join-agent")] },
  { id: 30, name: "agent-identities + agent-rooms", make: () => [...gp("/api/agent-identities"), ...g("/api/agent-rooms")] },
  { id: 31, name: "agent auth rooms/session", make: () => [...g("/api/auth/agent/rooms"), ...g("/api/auth/agent/session"), ...p("/api/auth/agent/session")] },
  { id: 32, name: "needs-me + updates", make: () => [...g("/api/needs-me"), ...g("/api/updates"), ...queryCases("/api/updates?since=notanumber")] },
  { id: 33, name: "referral-invites mint/preview/redeem", make: () => [...p("/api/referral-invites/mint"), ...g("/api/referral-invites/preview"), ...p("/api/referral-invites/redeem")] },
  { id: 34, name: "invitations accept/preview", make: () => [...p("/api/invitations/accept"), ...g("/api/invitations/preview")] },
  { id: 35, name: "join pages", make: () => [...g("/api/join"), ...p("/api/join"), ...g("/join"), ...g("/room/join"), ...g("/join.html"), ...g("/room/join.html"), ...g(`/join/${id128}`), ...g("/join/")] },
  { id: 36, name: "claims validate", make: () => [...p("/api/claims/validate")] },
  { id: 37, name: "web fetch + research", make: () => [...p("/api/web/fetch"), ...p("/api/web/research")] },
  { id: 38, name: "room invitation revoke regex route", make: () => {
      const good = `/api/rooms/${id128}/invitations/${id128}/revoke`;
      const long = "r".repeat(384), tooLong = "r".repeat(385);
      return [...p(good),
        { name: "path:roomid-384", method: "POST", path: `/api/rooms/${long}/invitations/${id128}/revoke`, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 8000 },
        { name: "path:roomid-385", method: "POST", path: `/api/rooms/${tooLong}/invitations/${id128}/revoke`, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 8000 },
        { name: "path:roomid-nullbyte", method: "POST", path: `/api/rooms/a%00b/invitations/${id128}/revoke`, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 8000 },
        { name: "path:missing-invitation", method: "POST", path: `/api/rooms/${id128}/invitations/revoke`, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 8000 }];
    } },
  { id: 39, name: "rooms dispatch: malformed roomIds + unknown sub-routes", make: () => [
      { name: "dispatch:unknown-subroute", method: "GET", path: `/api/rooms/${id128}/no-such-route-xyz`, headers: {}, body: null, timeoutMs: 8000 },
      { name: "dispatch:roomid-dotdot", method: "GET", path: `/api/rooms/..%2f..%2f/events`, headers: {}, body: null, timeoutMs: 8000 },
      { name: "dispatch:roomid-400", method: "GET", path: `/api/rooms/${"r".repeat(400)}/events`, headers: {}, body: null, timeoutMs: 8000 },
      { name: "dispatch:roomid-invalid-chars", method: "GET", path: "/api/rooms/!!!/events", headers: {}, body: null, timeoutMs: 8000 },
      { name: "dispatch:double-slash", method: "GET", path: `/api/rooms//events`, headers: {}, body: null, timeoutMs: 8000 },
      { name: "dispatch:trailing-dot", method: "GET", path: `/api/rooms/${id128}./events`, headers: {}, body: null, timeoutMs: 8000 },
      { name: "dispatch:empty-roomid-sub", method: "GET", path: "/api/rooms//stream", headers: {}, body: null, timeoutMs: 8000 },
    ] },
  { id: 40, name: "trailing-slash variants", make: () => ["/api/ready/", "/api/version/", "/api/updates/", "/api/needs-me/", "/api/session/", "/api/account/profile/", "/openapi.json/", "/api/public/rooms/directory/", "/api/opportunities.json/"].map(path => ({ name: `trailslash:${path}`, method: "GET", path, headers: {}, body: null, timeoutMs: 8000 })) },
  { id: 41, name: "oversize sweep (declared + actual)", make: () => [
      { name: "oversize:actual-1mb", method: "POST", path: "/api/claims/validate", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: "x".repeat(1024 * 1024) }), timeoutMs: 20000 },
      { name: "oversize:actual-100k-public-match", method: "POST", path: "/api/public-work/match", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: "x".repeat(100 * 1024) }), timeoutMs: 20000 },
      { name: "oversize:many-keys-50k", method: "POST", path: "/api/claims/validate", headers: { "Content-Type": "application/json" }, body: "{" + Array.from({ length: 50000 }, (_, i) => `"k${i}":1`).join(",") + "}", timeoutMs: 20000 },
    ] },
  { id: 42, name: "import route 8MB reader probe", make: () => [
      { name: "import:oversize-9mb", method: "POST", path: `/api/rooms/${id128}/import`, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: "x".repeat(9 * 1024 * 1024) }), timeoutMs: 30000 },
      { name: "import:truncated-json", method: "POST", path: `/api/rooms/${id128}/import`, headers: { "Content-Type": "application/json" }, body: '{"a":', timeoutMs: 15000 },
    ] },
  { id: 43, name: "content-type confusion sweep", make: () => {
      const paths = ["/api/claims/validate", "/api/public-work/match", "/api/account/profile", "/oauth/token", "/api/web/fetch"];
      return paths.flatMap(path => [
        { name: `ct:empty:${path}`, method: "POST", path, headers: { "Content-Type": "" }, body: '{"a":1}', timeoutMs: 8000 },
        { name: `ct:json-uppercase:${path}`, method: "POST", path, headers: { "Content-Type": "Application/JSON" }, body: '{"a":1}', timeoutMs: 8000 },
        { name: `ct:json-suffix:${path}`, method: "POST", path, headers: { "Content-Type": "application/problem+json" }, body: '{"a":1}', timeoutMs: 8000 },
        { name: `ct:multipart:${path}`, method: "POST", path, headers: { "Content-Type": "multipart/form-data; boundary=zzz" }, body: "--zzz\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--zzz--\r\n", timeoutMs: 8000 },
        { name: `ct:urlencoded:${path}`, method: "POST", path, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1&b=2", timeoutMs: 8000 },
      ]);
    } },
  { id: 44, name: "header adversarial sweep", make: () => {
      const paths = ["/api/health", "/api/claims/validate", "/api/public-work/tasks"];
      return paths.flatMap(path => headerCases(path, path === "/api/health" ? "GET" : "POST"));
    } },
  { id: 45, name: "OPTIONS/CORS preflight sweep", make: () => {
      const paths = ["/api/claims/validate", "/api/session", "/api/public-work/tasks", "/oauth/token", "/api/rooms/abc123/events"];
      return paths.flatMap(path => [
        { name: `preflight:${path}`, method: "OPTIONS", path, headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, body: null, timeoutMs: 8000 },
        { name: `preflight:trusted:${path}`, method: "OPTIONS", path, headers: {}, body: null, timeoutMs: 8000 },
      ]);
    } },
  { id: 46, name: "raw socket abuses", make: () => rawSocketCases().map(c => ({ ...c, raw: true })) },
  { id: 47, name: "HEAD + conditional requests", make: () => [
      { name: "head:openapi", method: "HEAD", path: "/openapi.json", headers: {}, body: null, timeoutMs: 8000 },
      { name: "head:health", method: "HEAD", path: "/api/health", headers: {}, body: null, timeoutMs: 8000 },
      { name: "get:if-none-match", method: "GET", path: "/openapi.json", headers: { "If-None-Match": "*" }, body: null, timeoutMs: 8000 },
      { name: "get:range", method: "GET", path: "/openapi.json", headers: { Range: "bytes=0-10" }, body: null, timeoutMs: 8000 },
    ] },
  { id: 48, name: "auth-required routes unauthenticated matrix", make: () => {
      const paths = ["/api/account-rooms", "/api/session", "/api/auth/methods", "/api/account/profile", "/api/updates", "/api/needs-me", "/api/oauth/sessions", `/api/rooms/${id128}/events`];
      return paths.flatMap(path => [
        { name: `unauth:get:${path}`, method: "GET", path, headers: {}, body: null, timeoutMs: 8000 },
        { name: `unauth:post-empty:${path}`, method: "POST", path, headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 8000 },
        { name: `unauth:bearer-empty:${path}`, method: "GET", path, headers: { Authorization: "Bearer " }, body: null, timeoutMs: 8000 },
      ]);
    } },
  { id: 49, name: "slow-drip + abort robustness", make: () => [
      { name: "slowdrip:trickle-body", method: "POST", path: "/api/claims/validate", headers: { "Content-Type": "application/json" }, trickle: true, body: '{"a":1}', timeoutMs: 15000 },
      { name: "abort:mid-body", method: "POST", path: "/api/claims/validate", headers: { "Content-Type": "application/json" }, abortAfterMs: 100, body: JSON.stringify({ a: "x".repeat(50000) }), timeoutMs: 15000 },
    ] },
  { id: 50, name: "encoding edges", make: () => [
      { name: "enc:utf16-body", method: "POST", path: "/api/claims/validate", headers: { "Content-Type": "application/json; charset=utf-16" }, raw: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', "utf16le")]), timeoutMs: 8000 },
      { name: "enc:lone-surrogate", method: "POST", path: "/api/claims/validate", headers: { "Content-Type": "application/json" }, body: '{"a":"\\ud800"}', timeoutMs: 8000 },
      { name: "enc:overlong-path", method: "GET", path: "/api/health/%c0%af", headers: {}, body: null, timeoutMs: 8000 },
      { name: "enc:double-encoded", method: "GET", path: "/api/health/%252e%252e", headers: {}, body: null, timeoutMs: 8000 },
    ] },
];
