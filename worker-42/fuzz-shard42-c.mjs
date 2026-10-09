// WORKER 42 batch C: leftover edge probes for the shard handlers.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createHash } from "node:crypto";

const f = createAcceptanceFixture();
const store = f.store;
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

async function req({ method = "GET", path, headers = {}, body = null }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(origin + path, { method, headers, body: body ?? undefined, signal: ctl.signal, redirect: "manual" });
    clearTimeout(t);
    return { status: r.status, text: (await r.text()).slice(0, 300) };
  } catch (e) { clearTimeout(t); return { status: "ERR", text: String(e.message).slice(0, 120) }; }
}

const mkAcct = (tag) => {
  const accountId = `email:${createHash("sha256").update(`w42c-${tag}@example.invalid`, "utf8").digest("hex")}`;
  store.createAccount(accountId, "w42c");
  const m1 = store.accountLogins.linkMagicMethod(accountId, { email: `w42c-${tag}@example.invalid` });
  const m2 = store.accountLogins.linkMagicMethod(accountId, { email: `w42c-${tag}-b@example.invalid` });
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, store.issueAccountAccessKey(accountId), slot.session.sessionRevision);
  const csrf = store.accountSessionSlot(slot.token).csrf;
  return { accountId, m1: m1.id, m2: m2.id, cookie: `account_session=${slot.token}`, csrf, binding: session.sessionBinding };
};
const J = { "Content-Type": "application/json" };
const acct = mkAcct("c1");
const ident = store.identities.create("w42c-ident");

const results = [];
const check = (name, got, exp, note = "") => {
  const ok = exp.includes(got.status);
  results.push({ name, status: got.status, expected: exp, ok, note, body: got.text.slice(0, 160) });
  console.log(`${ok ? "ok" : "!!"} ${name}: ${got.status} (exp ${exp.join("|")}) ${note} ${got.text.slice(0, 100)}`);
};

// C1: valid cookie+binding + malformed Authorization header -> strict 401
let r = await req({ path: "/api/updates", headers: { Cookie: acct.cookie, "X-Session-Binding": acct.binding, Authorization: "Bearer" } });
check("C1 malformed Authorization + valid cookie", r, [401]);

// C2: valid cookie+binding + wrong-shape bearer token -> strict 401
r = await req({ path: "/api/updates", headers: { Cookie: acct.cookie, "X-Session-Binding": acct.binding, Authorization: "Bearer zzz" } });
check("C2 bad bearer + valid cookie", r, [401]);

// C3: stale cursor (well-formed, correct viewer, unknown id) -> 409 cursor_stale
const staleCursor = Buffer.from(JSON.stringify({ v: 1, viewer: `identity:${ident.identityId}`, updatedAt: "2026-01-01T00:00:00.000Z", id: "no-such-id" })).toString("base64url");
r = await req({ path: `/api/updates?cursor=${staleCursor}`, headers: { Authorization: `Bearer ${ident.secret}` } });
check("C3 stale cursor", r, [409], r.text.slice(0, 80));

// C4: identity bearer + binding header present -> bearer path wins, 200
r = await req({ path: "/api/updates", headers: { Authorization: `Bearer ${ident.secret}`, "X-Session-Binding": acct.binding } });
check("C4 bearer ignores binding header", r, [200]);

// C5: disable a method then re-enable it -> 200, disabled:false
store.accountLogins.setMethodDisabled(acct.accountId, acct.m1, true);
r = await req({ method: "POST", path: "/api/auth/methods/enable",
  headers: { ...J, Origin: origin, Cookie: acct.cookie, "X-CSRF-Token": acct.csrf }, body: JSON.stringify({ id: acct.m1 }) });
check("C5 re-enable disabled method", r, [200], r.text.slice(0, 120));

// C6: enable with id matching another account's method id format but valid uuid-ish -> 404 (not 500)
r = await req({ method: "POST", path: "/api/auth/methods/enable",
  headers: { ...J, Origin: origin, Cookie: acct.cookie, "X-CSRF-Token": acct.csrf }, body: JSON.stringify({ id: "m_0123456789abcdef" }) });
check("C6 unknown id format", r, [404]);

// C7: updates with ?state=all&limit=1 on account with no rooms -> 200 empty
r = await req({ path: "/api/updates?state=all&limit=1", headers: { Cookie: acct.cookie, "X-Session-Binding": acct.binding } });
check("C7 account empty rooms", r, [200], r.text.slice(0, 120));

// C8: enable id that is a number-as-string "123" -> 404 (string passes methodIdFrom, misses row)
r = await req({ method: "POST", path: "/api/auth/methods/enable",
  headers: { ...J, Origin: origin, Cookie: acct.cookie, "X-CSRF-Token": acct.csrf }, body: JSON.stringify({ id: "123" }) });
check("C8 numeric-string id", r, [404]);

server.closeStreams(); server.closeAllConnections();
await new Promise(x => server.close(x)); store.close();
const bad = results.filter(x => !x.ok);
console.log(`\nbatch C: ${results.length - bad.length}/${results.length} as expected`);
if (bad.length) console.log("DEVIATIONS:", JSON.stringify(bad, null, 1));
