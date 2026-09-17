import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";

const data = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Subject", paragraphs: ["Body."] };
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.search = (opts) => f.store.inbox.search(f.session.token, f.session.sessionBinding, opts);
  f.addSource = (id, subject, body) => f.store.inbox.apply(f.session.token,
    { action: "source.save", requestId: randomUUID(), sourceId: id, expectedRevision: 0, data: { ...data, subject, paragraphs: [body] } },
    f.session.sessionBinding);
  f.email = emailContractFixture(); f.email.connection.accountId = account.id;
  f.emailConfigured = false;
  f.configureEmail = () => {
    if (f.emailConfigured) return;
    f.store.email.apply(f.session.token, { action: "connection.configure", requestId: randomUUID(),
      connectionId: f.email.connection.id, expectedRevision: 0, profile: structuredClone(f.email.connection) }, f.session.sessionBinding);
    f.emailConfigured = true;
  };
  f.importEmail = (messageId, subject, body) => {
    f.configureEmail();
    f.email.message.id = messageId; f.email.message.subject = subject; f.email.message.body.content = body;
    f.email.options.attachmentObservation.messageId = messageId;
    f.email.options.attachmentObservation.messageRevision = f.email.message.changeKey;
    const envelope = normalizeGraphEmail(f.email.connection, f.email.message, f.email.options);
    const state = f.store.email.state(f.session.token, f.email.connection.id, f.email.message.parentFolderId, f.session.sessionBinding);
    f.store.email.apply(f.session.token, { action: "page.apply", requestId: randomUUID(), connectionId: f.email.connection.id,
      connectionRevision: f.email.connection.revision, folderId: f.email.message.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] }, f.session.sessionBinding);
    return envelope.sourceId;
  };
  return f;
}

test("finds sources by subject and body text, best first", t => {
  const f = fixture(t);
  f.addSource("s-1", "Harbor plans harbor", "harbor logistics and harbor fees");
  f.addSource("s-2", "Dawn notes", "the harbor at dawn");
  f.addSource("s-3", "Unrelated", "nothing to see here");
  const result = f.search({ query: "harbor" });
  assert.equal(result.contractVersion, 1);
  assert.equal(result.query, "harbor");
  assert.equal(result.total, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].source.id, "s-1");
  assert.equal(result.results[1].source.id, "s-2");
  assert.ok(result.results[0].score > result.results[1].score);
  for (const { source, score } of result.results) {
    assert.equal(typeof score, "number"); assert.ok(score > 0);
    assert.equal(source.adapter, "synthetic");
    assert.equal(typeof source.subject, "string");
    assert.equal(typeof source.needsYou, "boolean");
  }
});

test("empty or missing queries and bad limits are 422", t => {
  const f = fixture(t);
  f.addSource("s-1", "Hello", "world");
  for (const query of [null, undefined, "", "   ", 42, "x".repeat(501)])
    assert.throws(() => f.search({ query }), err => err.status === 422 && err.code === "invalid_search_query", `query ${JSON.stringify(query)}`);
  for (const limit of [0, -1, 201, 1.5, "abc"])
    assert.throws(() => f.search({ query: "hello", limit }), err => err.status === 422 && err.code === "invalid_limit", `limit ${JSON.stringify(limit)}`);
});

test("sourceId scopes the search to one source", t => {
  const f = fixture(t);
  f.addSource("s-1", "Harbor plans", "harbor logistics");
  f.addSource("s-2", "Harbor notes", "harbor fees");
  const result = f.search({ query: "harbor", sourceId: "s-2" });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].source.id, "s-2");
  const missing = f.search({ query: "harbor", sourceId: "nope" });
  assert.equal(missing.total, 0);
  assert.deepEqual(missing.results, []);
});

test("limit caps results while total counts every match", t => {
  const f = fixture(t);
  for (let i = 1; i <= 5; i++) f.addSource(`s-${i}`, `Harbor ${i}`, "harbor logistics");
  const result = f.search({ query: "harbor", limit: 2 });
  assert.equal(result.results.length, 2);
  assert.equal(result.total, 5);
  const coerced = f.search({ query: "harbor", limit: "3" });
  assert.equal(coerced.results.length, 3);
});

test("search is per-account", t => {
  const f = fixture(t);
  f.addSource("s-1", "Harbor plans", "harbor logistics");
  const guest = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(guest.id), slot = f.store.createAccountSessionSlot();
  const gs = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const result = f.store.inbox.search(gs.token, gs.sessionBinding, { query: "harbor" });
  assert.equal(result.total, 0);
  assert.deepEqual(result.results, []);
});

test("email sources are hidden by default and searchable with a reading view", t => {
  const f = fixture(t);
  f.addSource("s-1", "Harbor plans", "harbor logistics");
  const emailId = f.importEmail("msg-search-1", "Harbor invoice", "the harbor invoice totals");
  const hidden = f.search({ query: "harbor" });
  assert.deepEqual(hidden.results.map(r => r.source.id), ["s-1"]);
  const shown = f.search({ query: "harbor", includeChannels: true });
  assert.equal(shown.total, 2);
  assert.deepEqual(new Set(shown.results.map(r => r.source.id)), new Set(["s-1", emailId]));
  const emailHit = shown.results.find(r => r.source.id === emailId);
  assert.equal(emailHit.source.adapter, "email");
  assert.equal(emailHit.source.subject, "Harbor invoice");
});
