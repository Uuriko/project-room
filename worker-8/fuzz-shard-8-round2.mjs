// WORKER 8 — round 2: /api/account/delete validation edges in rate-safe batches.
// The delete route is rate(`account-delete:${remoteAddress}`, 5) — 5 POSTs/IP/min.
// Fresh server boot per batch resets the in-memory bucket.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const findings = [];
let n = 0;

async function boot() {
  const fixture = await createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { fixture, server, base, async close() {
    try { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
    try { fixture.store.close(); } catch {}
  }};
}
const post = (base, path, data, headers) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: data,
});
async function makeAccount(env, tag) {
  const email = `w8b2-${tag}-${Date.now() % 1000000}@example.invalid`;
  const slot = env.fixture.store.createAccountSessionSlot();
  const res = await post(env.base, "/api/auth/password/signup", JSON.stringify({
    email, password: `fixture-password-x-long-enough`, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  }), {});
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  const session = env.fixture.store.authenticateAccountSession(token);
  env.fixture.store.accountLogins.markEmailVerified(session.account.id, email);
  return { email, token, auth: { Cookie: `account_session=${token}`, "X-CSRF-Token": session.csrf } };
}
async function one(env, name, headers, body, expect) {
  const r = await post(env.base, "/api/account/delete", body, headers);
  const text = await r.text().catch(() => "");
  const ok = expect === null
    ? (typeof r.status === "number" && r.status >= 400 && r.status < 500)
    : r.status === expect;
  console.log(`${name}: ${r.status} (expect ${expect === null ? "4xx" : expect}) ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) findings.push({ case: name, status: r.status, expect, head: text.slice(0, 200) });
  return { r, text };
}

// ---------- Batch 1: auth edges + one valid delete ----------
{
  const env = await boot(); n++;
  const a = await makeAccount(env, "b1");
  const plan = await (await fetch(env.base + "/api/account/deletion/plan", { headers: { Cookie: a.auth.Cookie } })).json();
  await one(env, "no-cookie", {}, JSON.stringify({ confirmationToken: plan.confirmationToken }), 401);
  await one(env, "garbage-cookie", { Cookie: "account_session=garbage" }, JSON.stringify({ confirmationToken: plan.confirmationToken }), 401);
  await one(env, "foreign-origin", { ...a.auth, Origin: "https://evil.example.com" }, JSON.stringify({ confirmationToken: plan.confirmationToken }), 403);
  await one(env, "missing-csrf", { Cookie: a.auth.Cookie }, JSON.stringify({ confirmationToken: plan.confirmationToken }), 403);
  await one(env, "control:valid-delete", a.auth, JSON.stringify({ confirmationToken: plan.confirmationToken }), 200);
  await env.close();
}
// ---------- Batch 2: token type edges ----------
{
  const env = await boot();
  const a = await makeAccount(env, "b2");
  await one(env, "token:missing-keys", a.auth, "{}", 422);
  await one(env, "token:empty-string", a.auth, JSON.stringify({ confirmationToken: "" }), 422);
  await one(env, "token:number", a.auth, JSON.stringify({ confirmationToken: 123 }), 422);
  await one(env, "token:null", a.auth, JSON.stringify({ confirmationToken: null }), 422);
  await one(env, "token:array", a.auth, JSON.stringify({ confirmationToken: [] }), 422);
  await env.close();
}
// ---------- Batch 3: token value edges ----------
{
  const env = await boot();
  const a = await makeAccount(env, "b3");
  await one(env, "token:object", a.auth, JSON.stringify({ confirmationToken: {} }), 422);
  await one(env, "token:garbage-string", a.auth, JSON.stringify({ confirmationToken: "not-a-real-token" }), null);
  await one(env, "token:tampered", a.auth, JSON.stringify({ confirmationToken: "x".repeat(64) }), null);
  await one(env, "token:huge-100k", a.auth, JSON.stringify({ confirmationToken: "t".repeat(100000) }), null);
  await one(env, "token:proto-pollution", a.auth, '{"confirmationToken":"x","__proto__":{"admin":true}}', null);
  await env.close();
}
// ---------- Batch 4: delete -> replay -> plan-after ----------
{
  const env = await boot();
  const a = await makeAccount(env, "b4");
  const plan = await (await fetch(env.base + "/api/account/deletion/plan", { headers: { Cookie: a.auth.Cookie } })).json();
  await one(env, "control:valid-delete", a.auth, JSON.stringify({ confirmationToken: plan.confirmationToken }), 200);
  // replay same token: account gone, session invalidated
  await one(env, "replay:token-after-delete", a.auth, JSON.stringify({ confirmationToken: plan.confirmationToken }), null);
  const pr = await fetch(env.base + "/api/account/deletion/plan", { headers: { Cookie: a.auth.Cookie } });
  console.log(`plan-after-delete: ${pr.status}`);
  if (pr.status === 200) findings.push({ case: "plan-after-delete", note: "200 for deleted account" });
  // health
  const h = await fetch(env.base + "/api/health");
  console.log("health:", h.status);
  await env.close();
}

await writeFile(new URL("./findings-round2.json", import.meta.url), JSON.stringify({ findings }, null, 2));
console.log(`round2 done, findings=${findings.length}`);
