import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { composeBriefing } from "../src/briefing.js";
import { BRIEFING_ROUTES } from "../server/routes/briefing.mjs";

const item = (id, kind, roomId, at, state = "unread") => ({ id, kind, roomId, title: `${kind} ${id}`, updatedAt: at, state, next: null });

test("composeBriefing: headline, changed since last, top items and per-room counts", () => {
  const items = [item("a", "mention", "r1", "2026-10-20T08:00:00Z"), item("b", "approval", "r1", "2026-10-20T15:00:00Z"),
    item("c", "approval", "r2", "2026-10-20T16:00:00Z"), item("d", "dm", "r2", "2026-10-20T16:00:00Z", "done")];
  const b = composeBriefing(items, { since: "2026-10-20T12:00:00Z" });
  assert.equal(b.headline, "3 things need you: 2 approvals, 1 mentions.");
  assert.equal(b.changedSinceLast, 2);
  assert.deepEqual(b.needsYou.map(i => i.id), ["a", "b", "c"]);
  assert.deepEqual(b.byRoom, [{ roomId: "r1", count: 2 }, { roomId: "r2", count: 1 }]);
  assert.equal(composeBriefing([]).headline, "Nothing needs you.");
});

function ctx({ token = "slot", body = null } = {}) {
  const db = new DatabaseSync(":memory:");
  const reject = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
  return { req: {}, res: {}, params: {}, accountCookieName: "account_session", remoteAddress: "127.0.0.1",
    cookie: () => token, accountBinding: () => "binding", reject, rate: () => {}, protectWrite: () => {},
    body: async () => body, json: (_res, status, payload) => ({ status, body: payload }),
    store: { db, now: () => 1000, authenticateAccountSession: () => ({ account: { id: "acct-1" } }) } };
}
const route = method => BRIEFING_ROUTES.find(row => row.method === method).handler;

test("the briefing is off by default and needs an account session", async () => {
  await assert.rejects(Promise.resolve().then(() => route("GET")(ctx({ token: null }))), { status: 401, code: "account_session_required" });
  assert.deepEqual((await route("GET")(ctx())).body, { enabled: false, hour: 8, briefing: null });
});

test("turning it on stores the preference; bad input is refused", async () => {
  const c = ctx({ body: { enabled: true, hour: 7 } });
  assert.deepEqual((await route("PUT")(c)).body, { enabled: true, hour: 7 });
  assert.equal(c.store.db.prepare("SELECT enabled, hour FROM account_briefings WHERE account_id='acct-1'").get().hour, 7);
  await assert.rejects(route("PUT")(ctx({ body: { enabled: "yes" } })), { status: 422, code: "invalid_briefing" });
  await assert.rejects(route("PUT")(ctx({ body: { enabled: true, hour: 24 } })), { status: 422 });
});
