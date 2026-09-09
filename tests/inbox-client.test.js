import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/client.js";
import { InboxClient, inboxTextVersion } from "../src/inbox-client.js";

const session = { authenticated: true, account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "a".repeat(64), csrf: "csrf" };
const viewer = { accountId: "owner", authEpoch: 2, sessionRevision: 4, sessionBinding: session.sessionBinding };
const reply = value => ({ ok: true, json: async () => value });
function setup(fetcher) {
  const account = new AccountClient({ fetcher }); account.session = structuredClone(session);
  let ended = 0; const client = new InboxClient(account, { onAccessEnded: () => ended++ });
  return { account, client, ended: () => ended };
}
test("provider review client negotiates a narrow view and validates its content, authority and exact receipt", async () => {
  const attempt = { id: "attempt", revision: 3, status: "awaiting_review", sourceRevision: 1, draftRevision: 1, canSend: false, canReview: true,
    observation: { version: "a".repeat(64), from: "me@example.test", sender: "me@example.test", to: ["you@example.test"], cc: [], bcc: [],
      subject: "Reply", body: "A private draft", format: "text", attachmentState: "complete", attachmentCount: 0, differences: [] }, review: null };
  const response = { contractVersion: 1, viewer, view: "reply-review-v4", sourceId: "mail", attempt, update: null, comparison: { originalBody: "Original reply", updateStatus: null } };
  const f = setup(async path => { assert.equal(path, "/api/inbox/sources/mail/reply-review?view=reply-review-v4"); return reply(response); });
  assert.equal((await f.client.replyReview("mail")).attempt.canReview, true);
  const acknowledged = structuredClone(response); acknowledged.comparison.updateStatus = "update_acknowledged"; acknowledged.attempt.canReview = false;
  acknowledged.update = { ...acknowledged.attempt, id: "update", attemptId: "attempt", status: "update_acknowledged", versionMismatch: false };
  assert.equal((await setup(async () => reply(acknowledged)).client.replyReview("mail")).attempt.canReview, false);
  acknowledged.attempt.canReview = true;
  await assert.rejects(setup(async () => reply(acknowledged)).client.replyReview("mail"), { code: "invalid_inbox_response" });
  for (const change of [v => v.view = "other", v => v.sourceId = "other", v => v.attempt.canSend = true,
    v => v.attempt.observation.body = "x".repeat(32769), v => v.attempt.observation.format = "html",
    v => v.attempt.observation.attachmentState = "not_loaded", v => v.attempt.observation.differences = ["sender"],
    v => v.attempt.review = { version: "b".repeat(64), current: true, at: 1 },
    v => delete v.comparison, v => v.comparison.originalBody = "x".repeat(4001), v => v.comparison.updateStatus = "sent",
    v => v.comparison.canExecute = true, v => v.view = "reply-review-v1", v => v.comparison.updateStatus = "update_unconfirmed"]) {
    const value = structuredClone(response); change(value);
    await assert.rejects(setup(async () => reply(value)).client.replyReview("mail"), { code: "invalid_inbox_response" });
  }
  const request = { action: "reply.review", requestId: "review", sourceId: "mail", attemptId: "attempt", expectedRevision: 3, reviewVersion: "a".repeat(64) };
  const receipt = { action: request.action, requestId: request.requestId, sourceId: request.sourceId, attemptId: request.attemptId, revision: 4, reviewVersion: request.reviewVersion };
  const g = setup(async (path, options) => {
    assert.equal(path, "/api/inbox/review"); assert.deepEqual(JSON.parse(options.body), request);
    return reply({ contractVersion: 1, viewer, duplicate: true, receipt });
  });
  assert.equal((await g.client.reviewReply(request)).duplicate, true);
  receipt.reviewVersion = "b".repeat(64);
  await assert.rejects(g.client.reviewReply(request), { code: "invalid_inbox_response" });
});
test("email reader negotiates bounded account-qualified excerpt support without sending", async () => {
  const source = { id: "mail", revision: 1, adapter: "email", sender: "from@example.test", recipient: "me@example.test", subject: "", paragraphs: ["Plain text"],
    capabilities: { draft: true, share: true, send: false }, email: { view: "email-excerpt-v1", accountId: "owner", format: "text", connectionState: "active",
      to: ["me@example.test"], cc: [], bcc: [], attachmentState: "not_loaded", attachmentCount: 0 } };
  const f = setup(async path => {
    assert.equal(path, "/api/inbox/sources/mail?view=email-excerpt-v1");
    return reply({ contractVersion: 1, viewer, source, draft: null });
  });
  assert.equal((await f.client.read("mail")).source.email.format, "text");
  for (const change of [s => s.email.accountId = "other", s => s.capabilities.send = true,
    s => s.capabilities.share = false, s => s.email.view = "email-text-v1", s => s.email.format = "html", s => s.paragraphs = ["A\r\nB"],
    s => s.paragraphs = ["x".repeat(262145)], s => s.email.attachmentCount = -1]) {
    const invalid = structuredClone(source); change(invalid);
    const g = setup(async () => reply({ contractVersion: 1, viewer, source: invalid, draft: null }));
    await assert.rejects(g.client.read("mail"), { code: "invalid_inbox_response" });
  }
  source.email.format = "html"; source.paragraphs = []; source.capabilities.share = false;
  assert.equal((await f.client.read("mail")).source.email.format, "html");
});
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
test("send previews pin recipients, body, revisions and current account authority", async () => {
  const envelope = { adapter: "synthetic", accountId: "owner", authEpoch: 2, sourceId: "note", sourceRevision: 1, draftRevision: 1,
    from: "you@example.test", to: ["maya@example.test"], subject: "Launch", body: "Exact reply 🪷", attachments: [] };
  const preview = { ...envelope, previewVersion: (await inboxTextVersion(JSON.stringify(envelope))).slice(7) };
  const response = { contractVersion: 1, viewer, sourceId: "note", simulationAvailable: true, preview };
  const f = setup(async () => reply(response));
  assert.deepEqual((await f.client.sendContext("note")).preview, preview);
  for (const patch of [{ body: "Changed" }, { to: ["other@example.test"] }, { draftRevision: 2 }, { authEpoch: 1 }]) {
    const g = setup(async () => reply({ ...response, preview: { ...preview, ...patch } }));
    await assert.rejects(g.client.sendContext("note"), { code: "invalid_inbox_response" });
  }
});
test("accepted sample status requires a provider identity, not just a label", async () => {
  const envelope = { adapter: "synthetic", accountId: "owner", authEpoch: 2, sourceId: "note", sourceRevision: 1, draftRevision: 1,
    from: "you@example.test", to: ["maya@example.test"], subject: "Launch", body: "Reply", attachments: [] };
  envelope.previewVersion = (await inboxTextVersion(JSON.stringify(envelope))).slice(7);
  const send = { id: "reply", sourceId: "note", revision: 2, status: "accepted", envelope, providerId: null, createdAt: 1, updatedAt: 2 };
  const response = { contractVersion: 1, viewer, sourceId: "note", simulationAvailable: true, sends: [send] };
  const f = setup(async () => reply(response));
  await assert.rejects(f.client.sends("note"), { code: "invalid_inbox_response" });
  send.providerId = "provider-message";
  assert.equal((await f.client.sends("note")).sends[0].status, "accepted");
});
