// WORKER 19 — wrong-status semantic probes for fuzz target 18.
// Boots the same acceptance-fixture server as fuzz/run.mjs and checks that
// malformed/unauthenticated requests get the *right* 4xx, not 200/500.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const BIND = "0".repeat(64); // well-formed per bindingPattern /^[a-f0-9]{64}$/

const results = [];
async function probe(name, method, path, opts = {}) {
  const headers = { "x-session-binding": BIND, ...(opts.headers ?? {}) };
  const r = await fetch(base + path, { method, headers, body: opts.body, redirect: "manual" });
  const text = await r.text().catch(() => "");
  results.push({ name, method, path, status: r.status, body: text.slice(0, 200) });
}

await probe("post-account-rooms:unauth", "POST", "/api/account-rooms", { headers: { "Content-Type": "application/json" }, body: "{}" });
await probe("post-account-rooms:bad-cookie", "POST", "/api/account-rooms", { headers: { "Content-Type": "application/json", Cookie: "account_session=garbage" }, body: "{}" });
await probe("post-from-template:unauth", "POST", "/api/account-rooms/from-template", { headers: { "Content-Type": "application/json" }, body: "{}" });
await probe("get-account-rooms:unauth", "GET", "/api/account-rooms");
await probe("get-account-rooms:after-dup", "GET", "/api/account-rooms?after=a&after=b");
await probe("get-account-rooms:after-once", "GET", "/api/account-rooms?after=a");
await probe("post-account-rooms:bad-json", "POST", "/api/account-rooms", { headers: { "Content-Type": "application/json" }, body: "{oops" });
await probe("post-account-rooms:null-body", "POST", "/api/account-rooms", { headers: { "Content-Type": "application/json" }, body: "null" });
await probe("post-account-rooms:array-body", "POST", "/api/account-rooms", { headers: { "Content-Type": "application/json" }, body: "[1]" });

for (const r of results) console.log(`${r.status}  ${r.method} ${r.path}  <- ${r.name}\n    ${r.body.slice(0, 140)}`);

await new Promise(r => server.close(r));
try { fixture.store.close(); } catch {}
