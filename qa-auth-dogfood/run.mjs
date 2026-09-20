// QA-Auth dogfood harness — magic-link + OAuth2 provider against loopback.
// Never touches a real mailer: codes are intercepted via the injected
// memory mailer. Each scenario group boots a fresh server+fixture so the
// per-IP/per-email rate limiters don't bleed across scenarios.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { createHash } from "node:crypto";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const errCode = body => body?.error?.code ?? body?.code ?? null;

async function boot({ mailer } = {}) {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const memoryMailer = mailer === "none" ? createMagicLinkMailer()
    : createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  const server = createRoomServer({ store: fixture.store, magicLinkMailer: memoryMailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, store: fixture.store, sent, links: fixture.links,
    async close() { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); fixture.store.close(); }
  };
}

async function openSlot(origin) {
  const res = await fetch(`${origin}/api/account-session`);
  const view = await res.json();
  const m = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error("no slot cookie: " + JSON.stringify(view).slice(0, 120));
  return { token: m[1], csrf: view.csrf, revision: view.sessionRevision, binding: view.sessionBinding };
}

const postMagic = (origin, path, slot, body, { csrf = true } = {}) => fetch(origin + path, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cookie": "account_session=" + slot.token,
    ...(csrf ? { "X-CSRF-Token": slot.csrf } : {}),
    Origin: origin
  },
  body: JSON.stringify(body)
});
const req = (origin, slot, email, opts) => postMagic(origin, "/api/auth/magic/request", slot, { email }, opts);
const consume = (origin, slot, email, code, opts) => postMagic(origin, "/api/auth/magic/consume", slot,
  { email, code, sessionToken: slot.token, sessionRevision: slot.revision }, opts);

// A: unconfigured mailer
{
  const s = await boot({ mailer: "none" });
  const slot = await openSlot(s.origin);
  const res = await req(s.origin, slot, "nobody@example.com");
  const body = await res.json();
  const rows = s.store.db.prepare("SELECT count(*) n FROM account_magic_codes").get().n;
  check("A1 unconfigured mailer -> mail_not_configured", res.status === 200 && body.reason === "mail_not_configured");
  check("A2 unconfigured mailer issues no code rows", rows === 0, `rows=${rows}`);
  await s.close();
}

// B/C/D/E/F/H/I: per-group servers
async function fresh(fn) { const s = await boot(); try { await fn(s); } finally { await s.close(); } }

await fresh(async s => {
  const slot = await openSlot(s.origin);
  const email = "qa-b@example.com";
  const r1 = await req(s.origin, slot, email);
  const t1 = await r1.text();
  const code = s.sent.at(-1).code;
  check("B1 request -> 200 sent", r1.status === 200 && t1.includes('"status":"sent"'));
  check("B2 plaintext code never in request response", !t1.includes(code));
  check("B3 mailer got normalized recipient", s.sent.at(-1).to === email);
  const c1 = await consume(s.origin, slot, email, code);
  const t2 = await c1.text();
  check("B4 consume -> 201 authenticated", c1.status === 201 && t2.includes('"authenticated":true'), `status=${c1.status}`);
  check("B5 consume response carries no code", !t2.includes(code));
});

await fresh(async s => {
  const slot = await openSlot(s.origin);
  const email = "qa-c@example.com";
  await req(s.origin, slot, email);
  const code = s.sent.at(-1).code;
  const c1 = await consume(s.origin, slot, email, code);
  // QAS-702 rotates the slot on login: replay with the FRESH slot token so
  // the code itself (not the dead slot) is what's being re-verified.
  const freshTok = /account_session=([A-Za-z0-9_-]{43})/.exec(c1.headers.get("set-cookie") ?? "")[1];
  const freshView = await (await fetch(`${s.origin}/api/account-session`, { headers: { "Cookie": "account_session=" + freshTok } })).json();
  const c2 = await postMagic(s.origin, "/api/auth/magic/consume", { token: freshTok, csrf: freshView.csrf, revision: freshView.sessionRevision },
    { email, code, sessionToken: freshTok, sessionRevision: freshView.sessionRevision });
  const b2 = await c2.json();
  check("C1 single-use: second consume -> 401 invalid_magic_code", c1.status === 201 && c2.status === 401 && errCode(b2) === "invalid_magic_code", `statuses=${c1.status},${c2.status} code=${errCode(b2)}`);
});

await fresh(async s => {
  const slot = await openSlot(s.origin);
  const email = "qa-d@example.com";
  await req(s.origin, slot, email);
  const first = s.sent.at(-1).code;
  await req(s.origin, slot, email);
  const second = s.sent.at(-1).code;
  const c = await consume(s.origin, slot, email, first);
  check("D1 sibling invalidated on fresh request", c.status === 401 && errCode(await c.json()) === "invalid_magic_code", `status=${c.status}`);
  const c2 = await consume(s.origin, slot, email, second);
  check("D2 newest code still live", c2.status === 201, `status=${c2.status}`);
});

await fresh(async s => {
  const slot = await openSlot(s.origin);
  const email = "qa-e@example.com";
  await req(s.origin, slot, email);
  const code = s.sent.at(-1).code;
  let ok = true;
  for (let i = 0; i < 5; i += 1) {
    const bad = await consume(s.origin, slot, email, "wrong-code-" + i);
    if (bad.status !== 401) ok = false;
  }
  check("E1 five wrong attempts -> 401 each", ok);
  const c = await consume(s.origin, slot, email, code);
  check("E2 burn window: correct code fails after 5 misses", c.status === 401, `status=${c.status}`);
});

await fresh(async s => {
  const email = "qa-f@example.com";
  const issued = s.store.accountLogins.issueMagicCode({ email, ttlMs: 40 });
  await sleep(70);
  const slot = await openSlot(s.origin);
  const c = await consume(s.origin, slot, email, issued.code);
  check("F1 expired code fails closed -> 401", c.status === 401 && errCode(await c.json()) === "invalid_magic_code", `status=${c.status}`);
});

await fresh(async s => {
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const slot = await openSlot(s.origin);
    statuses.push((await req(s.origin, slot, "qa-g@example.com")).status);
  }
  check("G1 per-email 3/hour: [200,200,200,429]", JSON.stringify(statuses) === "[200,200,200,429]", `got ${statuses}`);
});

await fresh(async s => {
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const slot = await openSlot(s.origin);
    statuses.push((await req(s.origin, slot, `qa-g2-${i}@example.com`)).status);
  }
  check("G2 per-IP 5/min: 5x200 then 429s", statuses.slice(0, 5).every(x => x === 200) && statuses.slice(5).every(x => x === 429), `got ${statuses}`);
});

await fresh(async s => {
  const slot = await openSlot(s.origin);
  const email = "qa-h@example.com";
  await req(s.origin, slot, email);
  const code = s.sent.at(-1).code;
  const noCsrf = await consume(s.origin, slot, email, code, { csrf: false });
  check("H1 consume without CSRF -> 403", noCsrf.status === 403, `status=${noCsrf.status}`);
  const yes = await consume(s.origin, slot, email, code);
  check("H2 code survives CSRF failure", yes.status === 201, `status=${yes.status}`);
});

await fresh(async s => {
  const slotA = await openSlot(s.origin);
  const emailA = "qa-ia@example.com";
  await req(s.origin, slotA, emailA);
  const loginA = await consume(s.origin, slotA, emailA, s.sent.at(-1).code);
  // QAS-702 rotated the slot: continue on the fresh session cookie.
  const freshTokA = /account_session=([A-Za-z0-9_-]{43})/.exec(loginA.headers.get("set-cookie") ?? "")[1];
  const freshViewA = await (await fetch(`${s.origin}/api/account-session`, { headers: { "Cookie": "account_session=" + freshTokA } })).json();
  const slotAf = { token: freshTokA, csrf: freshViewA.csrf, revision: freshViewA.sessionRevision };
  const emailB = "qa-ib@example.com";
  await req(s.origin, slotAf, emailB);
  const codeB = s.sent.at(-1).code;
  const c = await consume(s.origin, slotAf, emailB, codeB);
  const body = await c.json();
  check("I1 cross-account consume -> 409 magic_account_mismatch", c.status === 409 && errCode(body) === "magic_account_mismatch", `status=${c.status} code=${errCode(body)}`);
  const slotB = await openSlot(s.origin);
  const c2 = await consume(s.origin, slotB, emailB, codeB);
  check("I2 B's code still live after refusal", c2.status === 201, `status=${c2.status}`);
});
await fresh(async s => {
  const slot = await openSlot(s.origin);
  const r = await req(s.origin, slot, "a@b.invalid<script>alert(1)</script>");
  const b = await r.json();
  check("K1 malformed email -> 422 (R2-002 fix)", r.status === 422 && errCode(b) === "invalid_email", `status=${r.status} code=${errCode(b)}`);
  const r2 = await req(s.origin, slot, "o'brien+tag@example-mail.com");
  check("K2 legit exotic email (apostrophe/plus) still accepted", r2.status === 200, `status=${r2.status}`);
});

// J: join-then-sign-in
await fresh(async s => {
  const slot = await openSlot(s.origin);
  const email = "qa-j@example.com";
  await req(s.origin, slot, email);
  const c = await consume(s.origin, slot, email, s.sent.at(-1).code);
  const view = await c.json();
  const m = /account_session=([A-Za-z0-9_-]{43})/.exec(c.headers.get("set-cookie") ?? "");
  check("J1 consume mints account session cookie", typeof m?.[1] === "string");
  const joinRes = await fetch(`${s.origin}/api/share-links/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": "account_session=" + m[1], "X-CSRF-Token": view.csrf, Origin: s.origin, "X-Session-Binding": view.sessionBinding },
    body: JSON.stringify({ linkToken: s.links.valid, displayName: "QA Auth Guest", redemptionId: crypto.randomUUID(), expectedSessionRevision: view.sessionRevision })
  });
  check("J2 share-link join with magic authed account", [200, 201].includes(joinRes.status), `status=${joinRes.status} ${(await joinRes.text()).slice(0, 100)}`);
  const snap = await fetch(`${s.origin}/api/rooms/commons/events?auth=account&limit=5`, {
    headers: { "Cookie": "account_session=" + m[1], "X-Session-Binding": view.sessionBinding }
  });
  check("J3 account-authed snapshot read after join", snap.status === 200, `status=${snap.status}`);
});

// --- OAuth2 provider: model-level audit ---
{
  const p = createOAuthProvider({});
  p.registerClient({ clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/callback"] });
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { code } = p.issueCode({ clientId: "muse", userId: "acct-1", redirectUri: "https://muse.ai/callback", scopes: ["rooms:read", "chat:read"], codeChallenge: challenge });
  const t1 = p.exchangeCode({ code, clientId: "muse", redirectUri: "https://muse.ai/callback", codeVerifier: verifier });
  check("O1 PKCE exchange issues token pair", !!t1.accessToken && !!t1.refreshToken && t1.expiresIn === 3600);
  check("O2 granted scopes match request", JSON.stringify(t1.scopes) === JSON.stringify(["rooms:read", "chat:read"]));
  // replay
  let replay = "ok";
  try { p.exchangeCode({ code, clientId: "muse", redirectUri: "https://muse.ai/callback", codeVerifier: verifier }); replay = "replayed"; } catch (e) { replay = e.code; }
  check("O3 code replay rejected", replay === "invalid_request", replay);
  // wrong verifier
  const { code: c2 } = p.issueCode({ clientId: "muse", userId: "acct-1", redirectUri: "https://muse.ai/callback", scopes: ["rooms:read"], codeChallenge: challenge });
  let bad = "ok";
  try { p.exchangeCode({ code: c2, clientId: "muse", redirectUri: "https://muse.ai/callback", codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjX9" }); } catch (e) { bad = e.code; }
  check("O4 wrong PKCE verifier rejected", bad === "invalid_request", bad);
  // redirect mismatch
  const { code: c3 } = p.issueCode({ clientId: "muse", userId: "acct-1", redirectUri: "https://muse.ai/callback", scopes: ["rooms:read"], codeChallenge: challenge });
  let rm = "ok";
  try { p.exchangeCode({ code: c3, clientId: "muse", redirectUri: "https://evil.example/x", codeVerifier: verifier }); } catch (e) { rm = e.code; }
  check("O5 redirect_uri mismatch rejected", rm === "invalid_request", rm);
  // open redirect: unknown redirect at issue
  let or = "ok";
  try { p.issueCode({ clientId: "muse", userId: "acct-1", redirectUri: "https://evil.example/x", scopes: ["rooms:read"], codeChallenge: challenge }); } catch (e) { or = e.code; }
  check("O6 unregistered redirect_uri rejected at issue", or === "invalid_request", or);
  // refresh rotation
  const r1 = p.refresh({ refreshToken: t1.refreshToken, clientId: "muse" });
  let reused = "ok";
  try { p.refresh({ refreshToken: t1.refreshToken, clientId: "muse" }); } catch (e) { reused = e.code; }
  check("O7 refresh rotation: old refresh token dies", r1.accessToken !== t1.accessToken && reused === "invalid_request", reused);
  // revoke
  check("O8 revoked access token verifies null", (p.revoke(r1.accessToken), p.verifyAccessToken(r1.accessToken)) === null);
  // read-only default enforcement via grants
  check("O9 grants: read-only token fails chat:write", !p.grants(t1.accessToken, "chat:write") && p.grants(t1.accessToken, "chat:read"));
  // http-redirect registration: non-localhost http refused
  let httpreg = "ok";
  try { p.registerClient({ clientId: "bad", name: "bad", redirectUris: ["http://evil.example/cb"] }); } catch (e) { httpreg = e.code; }
  check("O10 http redirect rejected unless localhost", httpreg === "invalid_request", httpreg);
  // expired code
  let now = Date.now();
  const p2 = createOAuthProvider({ clock: () => now });
  p2.registerClient({ clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/callback"] });
  const c4 = p2.issueCode({ clientId: "muse", userId: "a", redirectUri: "https://muse.ai/callback", scopes: ["rooms:read"], codeChallenge: challenge });
  now += 11 * 60 * 1000;
  let exp = "ok";
  try { p2.exchangeCode({ code: c4.code, clientId: "muse", redirectUri: "https://muse.ai/callback", codeVerifier: verifier }); } catch (e) { exp = e.code; }
  check("O11 expired auth code rejected", exp === "invalid_request", exp);
}

// --- OAuth HTTP wiring: oat_ bearer on a room route ---
await fresh(async s => {
  const r = await fetch(`${s.origin}/api/rooms/commons/events`, { headers: { Authorization: "Bearer oat_" + "x".repeat(43) } });
  const b = await r.json();
  check("O12 oat_ bearer on room route -> 401 (no consumer wired)", r.status === 401, `status=${r.status} code=${errCode(b)}`);
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
