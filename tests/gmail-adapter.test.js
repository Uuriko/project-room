import test from "node:test";
import assert from "node:assert/strict";
import { gmailContractFixture } from "../scripts/gmail-contract-fixture.mjs";
import { channel, provider, readEnvelope, sourceId, scope, gmailConnection, normalizeGmailMessage, gmailListChanges,
  qualifyGmailCursor, RecordedGmailMailbox, bind } from "../server/channel-adapters/gmail.mjs";
import { EmailContractError, readEmailEnvelope } from "../server/email-envelope.mjs";
import { adapterFor, channelAdapters, readChannelEnvelope } from "../server/channel-adapters/index.mjs";

const f = () => gmailContractFixture();
const full = () => { const { messages } = f(); return messages.map(m => m.response.message); };

test("gmail messages normalize onto the shared email envelope", () => {
  const { connection, labelId } = f(), [one, two, three] = full();
  const first = normalizeGmailMessage(connection, one, { labelId });
  assert.equal(first.channel, "email"); assert.equal(first.contractVersion, 1);
  assert.equal(first.sourceId, sourceId(connection, "18d3f2a1b4c50001"));
  assert.match(first.sourceId, /^email-[a-f0-9]{64}$/);
  assert.deepEqual(first.message, { id: "18d3f2a1b4c50001", revision: "9876501", threadId: "18d3f2a1b4c50001",
    internetMessageId: "<hello-1@example.test>", folderId: "INBOX", subject: "A small collaboration",
    sentAt: "2026-09-08T12:00:01.000Z", receivedAt: "2026-09-08T12:00:01.000Z",
    from: { name: "Avery Quinn", address: "avery@example.test" },
    sender: { name: "Avery's assistant", address: "assistant@example.test" },
    replyTo: [{ name: "Project replies", address: "replies@example.test" }],
    to: [{ name: "Morgan", address: "morgan@gmail.test" }, { name: "Lee", address: "lee@example.test" }],
    cc: [{ name: "Sam", address: "sam@example.test" }], bcc: [], isDraft: false, isRead: false });
  assert.deepEqual(first.body, { format: "text", content: "Shall we work on this together?\n\nPrivate budget: 4200." });
  assert.deepEqual(first.replyHeaders, { state: "complete", inReplyTo: ["<earlier@example.test>"],
    references: ["<start@example.test> <earlier@example.test>"] });
  assert.deepEqual(first.attachments, { state: "complete", hint: true,
    items: [{ id: "1", kind: "file", name: "brief.txt", contentType: "text/plain", size: 128, inline: false, contentId: null }] });
  assert.equal(scope(first), "INBOX");
  const html = normalizeGmailMessage(connection, two, { labelId });
  assert.deepEqual(html.body, { format: "html", content: "<p>Hello <b>Morgan</b></p>" });
  assert.deepEqual(html.message.from, { name: "Quinn, Avery", address: "avery@example.test" }, "a quoted comma stays inside the display name");
  assert.equal(html.message.isDraft, true); assert.equal(html.message.isRead, true);
  assert.deepEqual(html.replyHeaders, { state: "complete", inReplyTo: [], references: [] });
  assert.deepEqual(html.attachments, { state: "complete", hint: false, items: [] });
  assert.equal(html.message.sentAt, "2026-09-09T09:30:00.000Z");
  const minimal = normalizeGmailMessage(connection, three, { labelId });
  assert.equal(minimal.message.subject, ""); assert.equal(minimal.message.sentAt, null);
  assert.equal(minimal.message.receivedAt, "2026-09-09T09:30:00.000Z");
  assert.deepEqual(minimal.message.from, { name: "", address: "lee@example.test" });
  assert.deepEqual(minimal.message.sender, minimal.message.from);
  for (const envelope of [first, html, minimal]) {
    assert.deepEqual(readEnvelope(envelope), envelope);
    assert.deepEqual(readEmailEnvelope(structuredClone(envelope)), envelope);
    assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope);
  }
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /Shall we work on this together\? Private budget|do not project this header|ANGjd_fixtureAttachment1/,
    "snippet, unknown headers and attachment ids never enter the envelope");
  assert.doesNotMatch(JSON.stringify(html), /Draft with HTML body/);
  const other = { ...connection, accountId: "someone-else" };
  assert.notEqual(normalizeGmailMessage(other, one, { labelId }).sourceId, first.sourceId, "source identity is account scoped");
  assert.equal(normalizeGmailMessage({ ...connection, revision: 2 }, one, { labelId }).sourceId, first.sourceId,
    "source identity is stable across connection revisions");
});

test("a recorded mailbox pages by page token; the bound adapter hydrates one message per id", async () => {
  const { connection, labelId, recording } = f(), reader = new RecordedGmailMailbox(recording);
  assert.deepEqual(reader.connection, connection);
  assert.equal(reader.kind, "gmail-api");
  const first = await reader.page(null);
  assert.equal(first.status, 200);
  const page = gmailListChanges(connection, labelId, first.body);
  assert.equal(page.contractVersion, 1); assert.equal(page.folderId, "INBOX");
  assert.deepEqual(page.changes, [{ messageId: "18d3f2a1b4c50001", action: "hydrate" }, { messageId: "18d3f2a1b4c50002", action: "hydrate" }]);
  assert.equal(page.cursor, "tok-2"); assert.equal(page.complete, false);
  const second = gmailListChanges(connection, labelId, (await reader.page(page.cursor)).body);
  assert.deepEqual(second.changes, [{ messageId: "18d3f2a1b4c50003", action: "hydrate" }]);
  assert.equal(second.cursor, null); assert.equal(second.complete, true);
  assert.equal((await reader.message("18d3f2a1b4c5gone")).status, 404);
  assert.throws(() => gmailListChanges(connection, labelId, { messages: [], nextPageToken: 7 }), { code: "invalid_gmail_list" });
  assert.throws(() => qualifyGmailCursor(""), { code: "invalid_gmail_cursor" });
  assert.throws(() => qualifyGmailCursor(null), { code: "invalid_gmail_cursor" });
  await assert.rejects(reader.page("unknown-token"), error => error instanceof EmailContractError && error.code === "gmail_recording_page_missing");
  await assert.rejects(reader.message("18d3f2a1b4c5missing"), error => error instanceof EmailContractError && error.code === "gmail_recording_message_missing");
  assert.throws(() => new RecordedGmailMailbox({ connection, pages: recording.pages, messages: recording.messages.concat(recording.messages[0]) }),
    { code: "invalid_gmail_recording" });
  assert.throws(() => new RecordedGmailMailbox({ ...recording, connection: { ...connection, provider: "microsoft-graph" } }), EmailContractError);
  const adapter = bind({ reader: new RecordedGmailMailbox(recording), connection, labelId });
  assert.deepEqual([adapter.channel, adapter.provider, adapter.scope()], ["email", "gmail-api", "INBOX"]);
  for (const key of ["normalize", "changes", "hydrate", "submit", "lookup", "sourceId"]) assert.equal(typeof adapter[key], "function", key);
  const changes = await adapter.changes({ cursor: null });
  assert.deepEqual(changes.changes.map(c => c.messageId), ["18d3f2a1b4c50001", "18d3f2a1b4c50002"]);
  assert.equal(changes.cursor, "tok-2"); assert.equal(changes.complete, false);
  const done = await adapter.changes({ cursor: changes.cursor });
  assert.equal(done.complete, true); assert.equal(done.cursor, null);
  await assert.rejects(adapter.changes({ cursor: "unknown-token" }), { code: "gmail_recording_page_missing" });
  await assert.rejects(adapter.changes({ cursor: "" }), { code: "invalid_gmail_cursor" });
  const hydrated = await adapter.hydrate("18d3f2a1b4c50001");
  assert.equal(hydrated.message.id, "18d3f2a1b4c50001");
  assert.equal(adapter.normalize(hydrated).message.subject, "A small collaboration");
  assert.equal(adapter.normalize(hydrated.message).message.subject, "A small collaboration", "normalize also accepts the bare resource");
  assert.equal(await adapter.hydrate("18d3f2a1b4c5gone"), null);
  assert.equal(await adapter.hydrate("18d3f2a1b4c50003") && adapter.normalize(await adapter.hydrate("18d3f2a1b4c50003")).message.threadId, "18d3f2a1b4c50001");
  assert.equal(adapter.sourceId("18d3f2a1b4c50001"), sourceId(connection, "18d3f2a1b4c50001"));
  assert.throws(() => bind({ reader: {}, connection, labelId }), { code: "gmail_fixture_reader_required" });
  assert.throws(() => bind({ reader, connection: { ...connection, provider: "microsoft-graph" }, labelId }), { code: "unsupported_channel" });
});

test("submit and lookup refuse with channel_sending_unavailable", async () => {
  const { connection, labelId, recording } = f(), adapter = bind({ reader: new RecordedGmailMailbox(recording), connection, labelId });
  await assert.rejects(adapter.submit(), { code: "channel_sending_unavailable" });
  await assert.rejects(adapter.lookup(), { code: "channel_sending_unavailable" });
});

test("malformed gmail resources are contract errors, never silent misreads", () => {
  const { connection, labelId } = f(), [one] = full();
  const breaks = [
    [m => { delete m.id; }, "gmail_hydration_required"], [m => { m.id = 41; }, "gmail_hydration_required"],
    [m => { delete m.historyId; }, "gmail_hydration_required"], [m => { delete m.threadId; }, "gmail_hydration_required"],
    [m => { m.labelIds = "INBOX"; }, "gmail_hydration_required"], [m => { delete m.payload; }, "gmail_hydration_required"],
    [m => { m.payload.headers = [{ name: "From" }]; }, "invalid_gmail_headers"],
    [m => { m.payload.headers.find(h => h.name === "From").value = "not an address"; }, "unsupported_email_address"],
    [m => { m.payload.headers.find(h => h.name === "From").value = ""; }, "gmail_sender_required"],
    [m => { m.payload.headers = m.payload.headers.filter(h => h.name !== "From"); }, "gmail_sender_required"],
    [m => { m.payload.headers.find(h => h.name === "To").value = "a@example.test, <bad>"; }, "unsupported_email_address"],
    [m => { m.payload.headers.find(h => h.name === "Date").value = "not a date"; }, "invalid_gmail_date"],
    [m => { m.internalDate = "99999999999999999"; }, "invalid_gmail_date"],
    [m => { m.payload.parts[0].body.data = "!!!not-base64url!!!"; }, "invalid_gmail_body"],
    [m => { m.payload.parts = []; m.payload.body.data = undefined; }, "gmail_body_required"],
    [m => { m.snippet = 42; }, "invalid_gmail_message"],
    [m => { m.payload.parts[0].body.data = Buffer.from("x".repeat(300000), "utf8").toString("base64url"); }, "invalid_email"]
  ];
  for (const [change, code] of breaks) {
    const message = structuredClone(one); change(message);
    assert.throws(() => normalizeGmailMessage(connection, message, { labelId }), { code });
  }
  // Duplicate From keeps the first; a second From never overrides the sender.
  const dup = structuredClone(one);
  dup.payload.headers.push({ name: "From", value: "second <two@example.test>" });
  assert.equal(normalizeGmailMessage(connection, dup, { labelId }).message.from.address, "avery@example.test");
  assert.throws(() => normalizeGmailMessage({ ...connection, provider: "telegram-bot" }, one, { labelId }), EmailContractError);
  assert.throws(() => gmailConnection({ ...connection, provider: "microsoft-graph" }), { code: "unsupported_channel" });
  assert.deepEqual(gmailConnection(connection), connection);
});

test("the gmail adapter is registered without disturbing the existing email default", () => {
  assert.equal(channel, "email"); assert.equal(provider, "gmail-api");
  assert.ok(channelAdapters.get("gmail-api"));
  assert.equal(adapterFor("gmail-api").provider, "gmail-api");
  assert.equal(adapterFor("gmail-api").channel, "email");
  for (const key of ["channel", "provider", "readEnvelope", "sourceId", "scope", "bind"]) assert.ok(key in adapterFor("gmail-api"), key);
  assert.throws(() => adapterFor("gmail"), { code: "unsupported_channel" });
});
