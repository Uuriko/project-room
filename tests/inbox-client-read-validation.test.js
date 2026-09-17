import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/client.js";
import { InboxClient } from "../src/inbox-client.js";

const session = { authenticated: true, account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "a".repeat(64), csrf: "csrf" };
const viewer = { accountId: "owner", authEpoch: 2, sessionRevision: 4, sessionBinding: session.sessionBinding };
const reply = value => ({ ok: true, json: async () => value });
function setup(fetcher) {
  const account = new AccountClient({ fetcher }); account.session = structuredClone(session);
  return new InboxClient(account, { onAccessEnded: () => {} });
}
const rejects = (client, call) => assert.rejects(call.call(client), { code: "invalid_inbox_response" });
const summary = () => ({ id: "s1", revision: 1, adapter: "email", sender: "a@example.test", recipient: "b@example.test",
  subject: "Hello", connection: { id: "mail-a", channel: "email", provider: "microsoft-graph", state: "active" }, needsYou: false });
const thread = () => ({ threadId: "email:mail-a:conv-1", messageCount: 2, depth: 1,
  firstAt: "2026-09-01T00:00:00Z", lastAt: "2026-09-01T01:00:00Z",
  entries: [{ depth: 0, source: summary() }, { depth: 1, source: { ...summary(), id: "s2" } }] });

test("thread view responses are validated strictly in the browser client", async () => {
  const ok = setup(async path => { assert.ok(path.startsWith("/api/inbox/threads?")); return reply({ contractVersion: 1, viewer, total: 1, threads: [thread()] }); });
  assert.equal((await ok.threads()).threads[0].messageCount, 2);
  for (const change of [v => v.total = -1, v => v.threads = {}, v => v.threads[0].threadId = 7,
    v => v.threads[0].messageCount = 0, v => v.threads[0].depth = -1, v => v.threads[0].firstAt = 12,
    v => v.threads[0].entries = null, v => v.threads[0].entries[1].depth = -1,
    v => v.threads[0].entries[0].source.adapter = "sms", v => v.threads[0].entries[0].source.connection = null,
    v => v.threads[0].entries[0].source.needsYou = "yes", v => delete v.threads[0].entries[0].source]) {
    const value = { contractVersion: 1, viewer: structuredClone(viewer), total: 1, threads: [thread()] };
    change(value);
    await rejects(setup(async () => reply(value)), async function () { return this.threads(); });
  }
});

test("search responses are validated strictly in the browser client", async () => {
  const ok = setup(async () => reply({ contractVersion: 1, viewer, query: "budget", total: 1, results: [{ score: 1.5, source: summary() }] }));
  assert.equal((await ok.search({ query: "budget" })).results[0].score, 1.5);
  for (const change of [v => v.total = -1, v => v.query = null, v => v.results = {},
    v => v.results[0].score = 0, v => v.results[0].score = -2, v => v.results[0].score = "high",
    v => delete v.results[0].source, v => v.results[0].source.id = "../x"]) {
    const value = { contractVersion: 1, viewer: structuredClone(viewer), query: "budget", total: 1, results: [{ score: 1.5, source: summary() }] };
    change(value);
    await rejects(setup(async () => reply(value)), async function () { return this.search({ query: "budget" }); });
  }
});

test("attachment descriptor responses are validated strictly in the browser client", async () => {
  const descriptor = () => ({ id: "attachment-1=", kind: "file", name: "brief.txt", contentType: "text/plain", size: 128, inline: false });
  const ok = setup(async path => { assert.ok(path.includes("/api/inbox/sources/s1/attachments")); return reply({ contractVersion: 1, viewer, sourceId: "s1", attachments: [descriptor()] }); });
  assert.equal((await ok.attachments("s1")).attachments[0].name, "brief.txt");
  for (const change of [v => v.sourceId = "other", v => v.attachments = {}, v => v.attachments[0].inline = "no",
    v => delete v.attachments[0].id, v => v.attachments[0].size = -1, v => v.attachments.push({ id: "x" })]) {
    const value = { contractVersion: 1, viewer: structuredClone(viewer), sourceId: "s1", attachments: [descriptor()] };
    change(value);
    await rejects(setup(async () => reply(value)), async function () { return this.attachments("s1"); });
  }
});

test("single attachment responses keep retrieval honestly unavailable in the browser client", async () => {
  const good = () => ({ contractVersion: 1, viewer: structuredClone(viewer), sourceId: "s1",
    attachment: { id: "attachment-1=", kind: "file", name: "brief.txt", contentType: "text/plain", size: 128, inline: false },
    retrieval: { available: false, reason: "attachment_bytes_not_retained" } });
  const ok = setup(async () => reply(good()));
  const result = await ok.attachment("s1", "attachment-1=");
  assert.equal(result.retrieval.available, false);
  assert.equal(typeof result.retrieval.reason, "string");
  for (const change of [v => v.attachment.id = "other", v => v.retrieval.available = true,
    v => v.retrieval.available = "false", v => delete v.retrieval.reason, v => delete v.attachment,
    v => v.sourceId = "other", v => v.retrieval = null]) {
    const value = good(); change(value);
    await rejects(setup(async () => reply(value)), async function () { return this.attachment("s1", "attachment-1="); });
  }
});
