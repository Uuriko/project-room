// Dead-route removal (RC-2026-09-19-001): routes removed in the 2026-09-19
// cleanup wave must return 404 for an authenticated caller — proving the
// route is gone, not merely auth-gated. (With no session these paths would
// 401/403 on the auth layer instead.)
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { account, token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.headers = { Cookie: "account_session=" + f.session.token, "X-Session-Binding": f.session.sessionBinding };
  return f;
}
async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}
async function status(origin, headers, method, path, body = null) {
  const res = await fetch(origin + path, { method, headers: { ...headers, "Content-Type": "application/json" },
    body: body === null ? undefined : JSON.stringify(body) });
  await res.text();
  return res.status;
}

const REMOVED = [
  ["GET", "/api/inbox/stitch/status"],
  ["GET", "/api/inbox/stitch/suggestions"],
  ["POST", "/api/inbox/stitch/confirm", {}],
  ["POST", "/api/inbox/stitch/dismiss", {}],
  ["POST", "/api/inbox/stitch/split", {}],
  ["POST", "/api/inbox/handoffs", { threadId: "t", to: "someone" }],
  ["GET", "/api/inbox/handoffs"],
  ["POST", "/api/inbox/handoffs/transition", { handoffId: "h", status: "accepted" }],
  ["GET", "/api/inbox/digest"],
  ["GET", "/api/work-item-sessions"],
  ["HEAD", "/api/work-item-sessions"],
  ["GET", "/api/rooms/commons/onboarding-funnel"],
];

test("removed cleanup-wave routes return 404 for an authenticated caller", async t => {
  const f = fixture(t), origin = await serve(t, f);
  for (const [method, path, body] of REMOVED) {
    const s = await status(origin, f.headers, method, path, body ?? null);
    assert.equal(s, 404, `${method} ${path} should be gone (got ${s})`);
  }
});

test("preserved neighbors still answer (not swept by the removal)", async t => {
  const f = fixture(t), origin = await serve(t, f);
  // SLA dashboard route (kept): authenticated read works.
  assert.equal(await status(origin, f.headers, "GET", "/api/inbox/sla/dashboard"), 200);
  // Quarantine coverage route (kept, restored after false-positive): authenticated read works.
  assert.equal(await status(origin, f.headers, "GET", "/api/inbox/quarantine/coverage"), 200);
});
