// worker-6 follow-up: verify happy path + suspected edge behaviors.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const fixture = await createAcceptanceFixture();
const store = fixture.store;
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

function loginAccount(accountId) {
  store.createAccount(accountId);
  const cred = store.issueAccountAccessKey(accountId);
  const accessKey = typeof cred === "string" ? cred : (cred?.token ?? cred?.key ?? cred?.accessKey);
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token, accessKey, 0);
  const auth = store.authenticateAccountSession(slot.token, null, null);
  return { token: slot.token, binding: auth.sessionBinding, csrf: auth.csrf };
}
const A = loginAccount("w6v2acct1");
const H = (acct, extra = {}) => ({ "Cookie": `account_session=${acct.token}`, "X-Session-Binding": acct.binding, "X-CSRF-Token": acct.csrf, "Origin": base, ...extra });
const j = (m, path, opts = {}) => fetch(base + path, { method: m, headers: { ...H(A), ...(opts.headers || {}), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }).then(async r => ({ status: r.status, body: await r.text() }));

const room = (id, extra = {}) => ({ roomId: id, title: "T", purpose: "P", kind: "personal", displayName: "W6", ...extra });

// 1. happy path
let r = await j("POST", "/api/account-rooms", { body: room("w6h1") });
console.log("create:", r.status, r.body.slice(0, 200));
r = await j("POST", "/api/account-rooms", { body: room("w6h1") });
console.log("dup:", r.status, r.body.slice(0, 200));
r = await j("POST", "/api/account-rooms", { body: room("w6h1", { title: "Different" }) });
console.log("conflict:", r.status, r.body.slice(0, 160));

// 2. GET list + pagination
r = await j("GET", "/api/account-rooms");
console.log("list:", r.status, r.body.slice(0, 200));

// 3. wrong methods
for (const m of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
  const rr = await fetch(base + "/api/account-rooms", { method: m, headers: H(A) });
  console.log(m, "/api/account-rooms ->", rr.status);
  await rr.text().catch(() => {});
}

// 4. precise rate-limit count on a fresh account
const C = loginAccount("w6v2acct3");
const HC = (extra = {}) => ({ "Cookie": `account_session=${C.token}`, "X-Session-Binding": C.binding, "X-CSRF-Token": C.csrf, "Origin": base, ...extra });
const statuses = [];
for (let i = 0; i < 13; i++) {
  const rr = await fetch(base + "/api/account-rooms", { method: "POST", headers: { ...HC(), "Content-Type": "application/json" }, body: JSON.stringify(room(`w6rl${i}`)) });
  statuses.push(rr.status); await rr.text().catch(() => {});
  await new Promise(x => setTimeout(x, 30));
}
console.log("rate statuses (13 creates):", JSON.stringify(statuses));

// 5. match sanity
let m = await (await fetch(base + "/api/public-work/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).text();
console.log("match {}:", m.slice(0, 160));
m = await (await fetch(base + "/api/public-work/match", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + "A".repeat(43) }, body: "{}" })).text();
console.log("match bogus-bearer:", m.slice(0, 160));

server.closeStreams(); server.closeAllConnections();
await new Promise(x => server.close(x));
store.close();
console.log("DONE");
