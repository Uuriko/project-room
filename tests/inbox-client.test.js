import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/client.js";
import { InboxClient } from "../src/inbox-client.js";

const session = { authenticated: true, account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "a".repeat(64), csrf: "csrf" };
const viewer = { accountId: "owner", authEpoch: 2, sessionRevision: 4, sessionBinding: session.sessionBinding };
const reply = value => ({ ok: true, json: async () => value });
function setup(fetcher) {
  const account = new AccountClient({ fetcher }); account.session = structuredClone(session);
  let ended = 0; const client = new InboxClient(account, { onAccessEnded: () => ended++ });
  return { account, client, ended: () => ended };
}
test("private browser client uses account credentials and verifies exact draft receipt", async () => {
  const command = { action: "draft.save", requestId: "save", sourceId: "note", expectedRevision: 0, sourceRevision: 1, body: "Private" };
  const f = setup(async (path, options) => {
    assert.equal(path, "/api/inbox/commands"); assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers["X-Session-Binding"], session.sessionBinding);
    assert.deepEqual(JSON.parse(options.body), command);
    return reply({ contractVersion: 1, viewer, duplicate: false, receipt: { action: command.action, requestId: command.requestId, sourceId: command.sourceId, revision: 1, sourceRevision: 1 } });
  });
  assert.equal((await f.client.apply(command)).receipt.revision, 1);
  f.account.session = null; await assert.rejects(f.client.list(), { code: "account_session_required" });
});
test("private response or error from an obsolete account cannot repopulate or end the replacement", async () => {
  for (const rejects of [false, true]) {
    let finish; const pending = new Promise(resolve => { finish = resolve; });
    const f = setup(async () => { await pending; if (rejects) throw Object.assign(new Error("ended"), { status: 401 }); return reply({ contractVersion: 1, viewer, sources: [] }); });
    const flight = f.client.list(); f.account.generation++; f.account.session = { ...session, account: { id: "replacement", authEpoch: 0 } };
    finish(); await assert.rejects(flight, { code: "obsolete_inbox" }); assert.equal(f.ended(), 0);
    assert.equal(f.account.session.account.id, "replacement");
  }
});
test("wrong private ownership clears current view; malformed exact receipts remain unconfirmed", async () => {
  const f = setup(async () => reply({ contractVersion: 1, viewer: { ...viewer, accountId: "other" }, sources: [] }));
  await assert.rejects(f.client.list(), { code: "obsolete_inbox" }); assert.equal(f.ended(), 1);
  const g = setup(async () => reply({ contractVersion: 1, viewer, duplicate: false, receipt: { action: "draft.save", requestId: "another", sourceId: "note", revision: 1, sourceRevision: 1 } }));
  await assert.rejects(g.client.apply({ action: "draft.save", requestId: "save", sourceId: "note", expectedRevision: 0, sourceRevision: 1, body: "Private" }), { code: "invalid_inbox_response" });
  assert.equal(g.ended(), 0);
});
