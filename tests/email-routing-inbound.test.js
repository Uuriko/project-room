import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { routeInboundEmail, recipientCandidates, resolveRoutedConnection, lookupFromProfiles, completeRoutedImport, applyRoutedEmail,
  emailRoutingLimits, emailRoutingRejections, routingKey } from "../server/email-routing-inbound.mjs";
import { bindRouting, emailRoutingFolderId, emailRoutingCapabilities, normalizeRoutedEmail, rawEmailDigest, provider, channel } from "../server/channel-adapters/email.mjs";
import { readEmailEnvelope, emailSourceId } from "../server/email-envelope.mjs";
import { readChannelEnvelope, adapterFor } from "../server/channel-adapters/index.mjs";
import { parseMimeMessage } from "../server/mime-message.mjs";
import { prepareChannelFixturePage } from "../server/channel-import.mjs";

const crlf = lines => lines.join("\r\n");
const connection = (accountId = "account-fixture") => ({ accountId, id: "room-mail", revision: 1, provider: "microsoft-graph", mailboxId: "routing-mailbox",
  identity: { name: "Room", address: "room@example.test" }, aliases: [{ name: "Help", address: "Help@Example.test" }, { name: "Catch-all", address: "*@mail.example.test" }] });
const other = (accountId = "account-fixture") => ({ accountId, id: "other-mail", revision: 2, provider: "microsoft-graph", mailboxId: "other-mailbox",
  identity: { name: "Other", address: "other@example.test" }, aliases: [] });
const raw = (overrides = {}) => Buffer.from(crlf([`From: ${overrides.from ?? "Avery Quinn <avery@example.test>"}`, `To: ${overrides.to ?? "room@example.test"}`,
  `Subject: ${overrides.subject ?? "A small collaboration"}`, "Date: Tue, 08 Sep 2026 12:00:00 +0000", ...(overrides.messageId === null ? [] : [`Message-ID: ${overrides.messageId ?? "<hello-1@example.test>"}`]),
  ...(overrides.headers ?? []), "Content-Type: text/plain; charset=utf-8", "", overrides.body ?? "Shall we work on this together?", ""]));
const inbound = (extra = {}) => ({ from: "avery@example.test", to: "room@example.test", raw: raw(extra.rawOverrides), rawSize: undefined, receivedAt: "2026-09-08T12:00:05.000Z", ...extra });
const lookup = lookupFromProfiles([connection(), other()]);

test("recipient candidates: exact, plus-addressing, then catch-all; routing is case-insensitive", () => {
  assert.deepEqual(recipientCandidates("<Room+Alpha@Example.TEST>"), [{ match: "exact", address: "room+alpha@example.test" },
    { match: "plus", address: "room@example.test", tag: "alpha" }, { match: "catch-all", address: "*@example.test" }]);
  assert.deepEqual(recipientCandidates("room@example.test").map(c => c.match), ["exact", "catch-all"]);
  assert.deepEqual(recipientCandidates("not an address"), []); assert.deepEqual(recipientCandidates("a".repeat(400) + "@x.test"), []);
  assert.equal(routingKey("<Help@Example.test>"), "help@example.test"); assert.equal(routingKey("bad<>@x"), null);
});

test("connections resolve by exact address, alias, plus tag and declared catch-all; a lying lookup is ignored", async () => {
  assert.equal((await resolveRoutedConnection("room@example.test", lookup)).match, "exact");
  assert.deepEqual(await resolveRoutedConnection("HELP@example.test", lookup).then(r => [r.match, r.connection.id]), ["exact", "room-mail"]);
  const plus = await resolveRoutedConnection("room+ticket-42@example.test", lookup);
  assert.equal(plus.match, "plus"); assert.equal(plus.tag, "ticket-42"); assert.equal(plus.connection.id, "room-mail");
  const catchAll = await resolveRoutedConnection("anyone@mail.example.test", lookup);
  assert.equal(catchAll.match, "catch-all"); assert.equal(catchAll.address, "*@mail.example.test");
  assert.equal(await resolveRoutedConnection("nobody@example.test", lookup), null, "no catch-all is declared for example.test");
  assert.equal(await resolveRoutedConnection("other+x@example.test", lookup).then(r => r.connection.id), "other-mail");
  assert.equal(await resolveRoutedConnection("room@example.test", () => other()), null, "a lookup returning a connection that does not list the address is refused");
  await assert.rejects(resolveRoutedConnection("room@example.test", () => ({ accountId: "a" })), { name: "EmailContractError" });
  await assert.rejects(resolveRoutedConnection("room@example.test", null), TypeError);
});

test("an accepted message becomes a shared email envelope with a stable idempotency key", async () => {
  const routed = await routeInboundEmail(inbound(), { lookup });
  assert.deepEqual(routed.decision, { accept: true, reason: null }); assert.equal(routed.match, "exact"); assert.equal(routed.connection.id, "room-mail");
  assert.match(routed.requestId, /^email-routing-[a-f0-9]{64}$/); assert.equal(routed.messageId, "<hello-1@example.test>");
  const e = routed.envelope;
  assert.equal(e.channel, "email"); assert.equal(e.contractVersion, 1); assert.equal(e.sourceId, emailSourceId(connection(), "hello-1@example.test"));
  assert.equal(e.message.id, "hello-1@example.test"); assert.equal(e.message.folderId, emailRoutingFolderId); assert.equal(e.message.threadId, "hello-1@example.test");
  assert.equal(e.message.internetMessageId, "<hello-1@example.test>"); assert.equal(e.message.revision, routed.rawDigest);
  assert.equal(e.message.sentAt, "2026-09-08T12:00:00.000Z"); assert.equal(e.message.receivedAt, "2026-09-08T12:00:05.000Z");
  assert.deepEqual(e.message.from, { name: "Avery Quinn", address: "avery@example.test" }); assert.deepEqual(e.message.sender, e.message.from);
  assert.deepEqual(e.message.to, [{ name: "", address: "room@example.test" }]); assert.deepEqual([e.message.cc, e.message.bcc, e.message.replyTo], [[], [], []]);
  assert.deepEqual(e.body, { format: "text", content: "Shall we work on this together?\n" });
  assert.deepEqual(e.replyHeaders, { state: "complete", inReplyTo: [], references: [] });
  assert.deepEqual(e.attachments, { state: "complete", hint: false, items: [] });
  assert.deepEqual(readEmailEnvelope(e), e); assert.deepEqual(readChannelEnvelope(structuredClone(e)), e);
  assert.equal(adapterFor(provider).scope(e), emailRoutingFolderId);
  const again = await routeInboundEmail(inbound(), { lookup });
  assert.equal(again.requestId, routed.requestId); assert.equal(again.envelope.sourceVersion, e.sourceVersion);
  const redelivered = await routeInboundEmail(inbound({ rawOverrides: { headers: ["X-Hop: second delivery"] } }), { lookup });
  assert.equal(redelivered.requestId, routed.requestId, "same Message-ID, same request id"); assert.equal(redelivered.envelope.sourceId, e.sourceId);
  assert.notEqual(redelivered.envelope.sourceVersion, e.sourceVersion, "different raw bytes are a new version of the same source");
});

test("threading, attachments, html bodies, plus tags and missing headers map onto the envelope", async () => {
  const threaded = await routeInboundEmail(inbound({ to: "Room+Alpha@example.test", rawOverrides: { headers: ["In-Reply-To: <earlier@example.test>", "References: <start@example.test> <earlier@example.test>", "Cc: Lee <lee@example.test>", "Reply-To: replies@example.test"] } }), { lookup });
  assert.equal(threaded.match, "plus"); assert.equal(threaded.tag, "alpha");
  assert.equal(threaded.envelope.message.threadId, "start@example.test");
  assert.deepEqual(threaded.envelope.replyHeaders, { state: "complete", inReplyTo: ["<earlier@example.test>"], references: ["<start@example.test>", "<earlier@example.test>"] });
  assert.deepEqual(threaded.envelope.message.cc, [{ name: "Lee", address: "lee@example.test" }]); assert.deepEqual(threaded.envelope.message.replyTo, [{ name: "", address: "replies@example.test" }]);
  const mixed = Buffer.from(crlf(["From: a@example.test", "Subject: Files", "Content-Type: multipart/mixed; boundary=m", "", "--m", "Content-Type: text/html", "", "<p>Only <b>html</b></p>",
    "--m", "Content-Type: application/pdf; name=brief.pdf", "Content-Disposition: attachment; filename=brief.pdf", "Content-Transfer-Encoding: base64", "", Buffer.alloc(30).toString("base64"),
    "--m", "Content-Type: image/png", "Content-ID: <logo@x>", "", "png", "--m--", ""]));
  const files = await routeInboundEmail(inbound({ raw: mixed, from: "<bounce@example.test>", to: "<anyone@mail.example.test>" }), { lookup });
  assert.equal(files.match, "catch-all"); assert.equal(files.decision.accept, true);
  assert.deepEqual(files.envelope.body, { format: "html", content: "<p>Only <b>html</b></p>" }); assert.equal(files.preview, "Only html");
  assert.equal(files.envelope.message.id, "raw-" + files.rawDigest, "no Message-ID: the raw digest identifies the message");
  assert.equal(files.envelope.message.internetMessageId, null); assert.equal(files.envelope.message.sentAt, null);
  assert.deepEqual(files.envelope.message.to, [{ name: "", address: "anyone@mail.example.test" }], "SMTP recipient stands in for a missing To header");
  assert.deepEqual(files.envelope.attachments, { state: "complete", hint: true, items: [
    { id: "part-1", kind: "file", name: "brief.pdf", contentType: "application/pdf", size: 30, inline: false, contentId: null },
    { id: "part-2", kind: "file", name: "", contentType: "image/png", size: 3, inline: true, contentId: "<logo@x>" }] });
  const noFrom = await routeInboundEmail(inbound({ from: "<sender@example.test>", raw: Buffer.from("Subject: envelope sender\r\n\r\nx") }), { lookup });
  assert.deepEqual(noFrom.envelope.message.from, { name: "", address: "sender@example.test" });
  const oversize = await routeInboundEmail(inbound({ rawOverrides: { from: "\"" + "名".repeat(400) + "\" <avery@example.test>", headers: ["Cc: <" + "c".repeat(300) + "@" + "d".repeat(100) + ".test>, Lee <lee@example.test>"] } }), { lookup });
  assert.equal(oversize.decision.accept, true, "oversize names are cut and oversize addr-specs dropped instead of rejecting the message");
  assert.equal(Buffer.byteLength(oversize.envelope.message.from.name), 1023); assert.deepEqual(oversize.envelope.message.cc, [{ name: "Lee", address: "lee@example.test" }]);
  const noSender = await routeInboundEmail(inbound({ from: "", raw: Buffer.from("Subject: bounce\r\n\r\nx") }), { lookup });
  assert.deepEqual(noSender.decision, { accept: false, reason: emailRoutingRejections.malformed }); assert.equal(noSender.code, "email_routing_sender_required");
});

test("unknown recipients, oversized and malformed messages are rejected with a setReject reason and nothing else", async () => {
  const unknown = await routeInboundEmail(inbound({ to: "nobody@example.test" }), { lookup });
  assert.deepEqual(unknown, { decision: { accept: false, reason: emailRoutingRejections.unknownRecipient }, code: "email_routing_unknown_recipient", match: null, tag: null,
    connection: null, envelope: null, requestId: null, messageId: null, rawDigest: null, preview: null, truncated: false });
  assert.equal((await routeInboundEmail(inbound({ to: "not-an-address" }), { lookup })).code, "email_routing_unknown_recipient");
  const declared = await routeInboundEmail(inbound({ rawSize: emailRoutingLimits.rawBytes + 1 }), { lookup: () => { throw new Error("lookup must not run for oversized mail"); } });
  assert.deepEqual(declared.decision, { accept: false, reason: emailRoutingRejections.tooLarge }); assert.equal(declared.code, "email_routing_too_large");
  const actual = await routeInboundEmail(inbound({ raw: Buffer.alloc(emailRoutingLimits.rawBytes + 1, 0x61), rawSize: 10 }), { lookup });
  assert.equal(actual.code, "email_routing_too_large");
  const capped = await routeInboundEmail(inbound(), { lookup, limits: { ...emailRoutingLimits, rawBytes: 64 } });
  assert.equal(capped.code, "email_routing_too_large", "a configured lower cap applies");
  const malformed = await routeInboundEmail(inbound({ raw: Buffer.from("Content-Type: multipart/mixed; boundary=b\r\n\r\nno parts") }), { lookup });
  assert.deepEqual(malformed.decision, { accept: false, reason: emailRoutingRejections.malformed }); assert.equal(malformed.code, "malformed_mime_boundary");
  const injected = await routeInboundEmail(inbound({ raw: Buffer.from("From: a@example.test\r\nnot a header\r\n\r\nx") }), { lookup });
  assert.equal(injected.code, "malformed_mime_header");
  await assert.rejects(routeInboundEmail(inbound(), { lookup: () => { throw new Error("database down"); } }), /database down/, "infrastructure failures propagate for a temporary reject");
  for (const reason of Object.values(emailRoutingRejections)) assert.match(reason, /^[ -~]{1,64}$/, "reject reasons are short ASCII");
});

test("completeRoutedImport builds the importer's page.apply request and reports duplicates", async () => {
  const routed = await routeInboundEmail(inbound(), { lookup });
  const first = completeRoutedImport(routed);
  assert.deepEqual(first, { duplicate: false, receipt: null, request: { action: "page.apply", requestId: routed.requestId, connectionId: "room-mail", connectionRevision: 1,
    folderId: emailRoutingFolderId, expectedRevision: 0, expectedCursor: null, cursor: routed.requestId, complete: true, reset: false,
    observations: [{ kind: "message", envelope: routed.envelope, expectedSourceRevision: 0 }] } });
  const later = completeRoutedImport(routed, { folder: { revision: 3 }, expectedCursor: "prev", needsReset: true, sourceRevision: 2 });
  assert.equal(later.request.expectedRevision, 3); assert.equal(later.request.expectedCursor, "prev"); assert.equal(later.request.reset, true);
  assert.equal(later.request.observations[0].expectedSourceRevision, 2);
  const dup = completeRoutedImport(routed, { priorReceipt: { requestId: routed.requestId } });
  assert.deepEqual(dup, { duplicate: true, receipt: { requestId: routed.requestId }, request: null });
  const rejected = await routeInboundEmail(inbound({ to: "nobody@example.test" }), { lookup });
  assert.throws(() => completeRoutedImport(rejected), { code: "email_routing_not_accepted", reason: emailRoutingRejections.unknownRecipient });
});

function storeFixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.account = f.store.accountForMember("commons", "owner"); f.connection = connection(f.account.id);
  f.key = f.store.issueAccountAccessKey(f.account.id); const slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.key, 0) };
  f.store.email.apply(f.auth.token, { action: "connection.configure", requestId: randomUUID(), connectionId: f.connection.id, expectedRevision: 0, profile: structuredClone(f.connection) }, f.auth.sessionBinding);
  f.lookup = lookupFromProfiles([f.connection]);
  f.apply = routed => applyRoutedEmail({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, routed });
  f.read = sourceId => f.store.inbox.read(f.auth.token, sourceId, f.auth.sessionBinding);
  return f;
}
test("the existing importer accepts routed messages: import, duplicate Message-ID, redelivery, second message, rejected mail", async t => {
  const f = storeFixture(t);
  const routed = await routeInboundEmail(inbound(), { lookup: f.lookup });
  const first = f.apply(routed);
  assert.equal(first.applied, true); assert.equal(first.duplicate, false); assert.equal(first.receipt.folderId, emailRoutingFolderId);
  assert.deepEqual(first.receipt.imports.map(i => [i.sourceId, i.sourceRevision]), [[routed.envelope.sourceId, 1]]);
  const stored = f.read(routed.envelope.sourceId);
  assert.equal(stored.source.revision, 1); assert.equal(stored.source.adapter, "email"); assert.deepEqual(stored.source.envelope, routed.envelope);
  const duplicate = f.apply(await routeInboundEmail(inbound(), { lookup: f.lookup }));
  assert.deepEqual([duplicate.applied, duplicate.duplicate, duplicate.receipt.requestId], [false, true, routed.requestId]);
  assert.equal(f.read(routed.envelope.sourceId).source.revision, 1, "a duplicate Message-ID imports nothing");
  const redelivered = await routeInboundEmail(inbound({ rawOverrides: { headers: ["X-Hop: 2"] } }), { lookup: f.lookup });
  assert.equal(f.apply(redelivered).duplicate, true, "same Message-ID with different bytes is still one delivery");
  const second = await routeInboundEmail(inbound({ to: "room+beta@example.test", rawOverrides: { messageId: "<hello-2@example.test>", body: "Second" } }), { lookup: f.lookup });
  const applied = f.apply(second);
  assert.equal(applied.applied, true); assert.equal(applied.receipt.revision, 2); assert.equal(applied.receipt.cursor, second.requestId);
  assert.equal(f.read(second.envelope.sourceId).source.envelope.body.content, "Second\n");
  const state = f.store.email.state(f.auth.token, f.connection.id, emailRoutingFolderId, f.auth.sessionBinding);
  assert.deepEqual(state.folder.members.sort(), ["hello-1@example.test", "hello-2@example.test"]); assert.equal(state.folder.complete, true);
  const rejected = f.apply(await routeInboundEmail(inbound({ to: "nobody@example.test" }), { lookup: f.lookup }));
  assert.deepEqual(rejected, { applied: false, duplicate: false, receipt: null, decision: { accept: false, reason: emailRoutingRejections.unknownRecipient } });
  const view = f.read(routed.envelope.sourceId);
  const projected = f.store.inbox.read(f.auth.token, routed.envelope.sourceId, f.auth.sessionBinding, { emailView: true });
  assert.equal(projected.source.email.view.startsWith("email-"), true); assert.equal(JSON.stringify(projected).includes(routed.rawDigest), false, "raw digests stay off the browser projection");
  assert.equal(JSON.stringify(f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeEmail: true })).includes(view.source.envelope.sourceId), true);
});

test("bindRouting presents the uniform adapter driver and drives the shared page preparer", async t => {
  const f = storeFixture(t);
  const messages = [{ from: "avery@example.test", to: "room@example.test", raw: raw(), receivedAt: "2026-09-08T12:00:05Z" },
    { from: "lee@example.test", to: "room@example.test", raw: raw({ messageId: "<hello-2@example.test>", from: "lee@example.test" }), receivedAt: new Date("2026-09-08T12:01:00Z") }];
  const adapter = bindRouting({ connection: f.connection, messages });
  assert.equal(adapter.channel, channel); assert.equal(adapter.provider, provider); assert.equal(adapter.scope(), emailRoutingFolderId);
  assert.deepEqual(adapter.capabilities, emailRoutingCapabilities); assert.equal(emailRoutingCapabilities.outbound, "none"); assert.equal(emailRoutingCapabilities.send, false);
  const page = await adapter.changes({});
  assert.deepEqual(page, { changes: [{ messageId: "hello-1@example.test", action: "hydrate" }, { messageId: "hello-2@example.test", action: "hydrate" }], cursor: "2", complete: true });
  assert.deepEqual(await adapter.changes({ cursor: "2" }), { changes: [], cursor: "2", complete: true });
  assert.equal(await adapter.hydrate("missing"), null);
  const hydrated = await adapter.hydrate("hello-2@example.test");
  assert.equal(adapter.normalize(hydrated).message.from.address, "lee@example.test"); assert.equal(adapter.sourceId("hello-2@example.test"), emailSourceId(f.connection, "hello-2@example.test"));
  await assert.rejects(adapter.submit({}), { code: "channel_sending_unavailable" }); await assert.rejects(adapter.lookup({}), { code: "channel_sending_unavailable" });
  const request = await prepareChannelFixturePage({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.connection.id, folderId: emailRoutingFolderId, adapter });
  assert.equal(request.observations.length, 2); assert.equal(request.cursor, "2");
  const result = f.store.email.apply(f.auth.token, request, f.auth.sessionBinding);
  assert.equal(result.receipt.imports.length, 2);
  assert.throws(() => bindRouting({ connection: f.connection, messages: Array(51).fill(messages[0]) }), { code: "email_routing_page_limit" });
  assert.throws(() => bindRouting({ connection: f.connection, messages: [{ raw: raw() }] }), { code: "email_routing_message_required" });
  assert.throws(() => normalizeRoutedEmail(f.connection, parseMimeMessage(raw()), { envelopeTo: "room@example.test", receivedAt: "not a date", rawDigest: rawEmailDigest(raw()) }), { code: "email_routing_received_at_required" });
  assert.throws(() => normalizeRoutedEmail(f.connection, parseMimeMessage(raw()), { envelopeTo: "room@example.test", receivedAt: 0, rawDigest: "short" }), { code: "email_routing_digest_required" });
});
