import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { commitMessageRedaction } from "../server/message-redaction.mjs";
import { MESSAGE_BODY_READS } from "../server/routes/table.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";

// Deleting a message used to leave the text in the event log. PRIV-0 hid it
// on read. This test is the write: after delete, the text is gone from storage
// and from every read MESSAGE_BODY_READS names.

const EDITED = ["priv-edit-a-7f3a", "priv-edit-b-7f3b", "priv-edit-c-7f3c"];
const THREAD = "priv-thread-7f3d";
const DM = "priv-dm-7f3e";
const FILE = "priv-file-7f3f";
const ROOM_NEEDLES = [...EDITED, THREAD, DM, FILE];
const EVIDENCE = "The agenda is owned by Potter.";
const WORK_ITEM = "test-handoff";

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return JSON.stringify(value);
}

function databaseText(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const parts = [];
  for (const { name } of names) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    for (const row of rows) for (const value of Object.values(row)) parts.push(cellText(value));
  }
  return parts.join("\n");
}

function absent(label, text, needles) {
  for (const needle of needles) assert.equal(text.includes(needle), false, `${label} still contains ${needle}`);
}

function fill(path, vars) {
  return path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(vars[key] ?? ""));
}

async function listen(store) {
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function readStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  const started = Date.now();
  while (Date.now() - started < 1200) {
    const chunk = await reader.read();
    if (chunk.done) break;
    streamed += decoder.decode(chunk.value, { stream: true });
    if (streamed.length > 0 && Date.now() - started > 200) break;
  }
  await reader.cancel();
  return streamed;
}

async function mcp(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  return { status: response.status, text: JSON.stringify(await response.json()) };
}

test("deleting a message removes its text from storage and every listed read", async t => {
  const groups = new Set(["room", "mcp", "receipt"]);
  for (const row of MESSAGE_BODY_READS) assert.ok(groups.has(row.group), `${row.id} has no redaction group`);
  const seen = new Set();

  const directory = mkdtempSync(join(tmpdir(), "message-redaction-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Redaction reader");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, displayName: "Reader", permissions: [] });
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  cmd(T.MEMBER_ADDED, { memberId: "agent-priv", displayName: "Priv agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  const agentKey = store.issueAccessKey("commons", "agent-priv");
  cmd(T.MESSAGE_POSTED, { messageId: "edited", body: EDITED[0] });
  store.roomAttachments.stage(ownerKey, "commons", {
    id: "secret-file", filename: "note.txt", mediaType: "text/plain", data: Buffer.from(FILE).toString("base64")
  });
  store.roomAttachments.commit(ownerKey, "commons", { id: "secret-file", messageId: "edited" });
  cmd(T.MESSAGE_EDITED, { messageId: "edited", body: EDITED[1], expectedMessageRevision: 0 });
  cmd(T.MESSAGE_EDITED, { messageId: "edited", body: EDITED[2], expectedMessageRevision: 1 });
  cmd(T.MESSAGE_DELETED, { messageId: "edited", expectedMessageRevision: 2, reason: "remove" });
  cmd(T.MESSAGE_POSTED, { messageId: "root", body: "visible-root" });
  cmd(T.MESSAGE_POSTED, { messageId: "thread", body: THREAD, replyToId: "root", alsoSendToChannel: true });
  cmd(T.MESSAGE_DELETED, { messageId: "thread", expectedMessageRevision: 0, reason: "remove" });
  cmd(T.MESSAGE_POSTED, { messageId: "dm-secret", body: DM, toMemberId: "agent-priv" });
  cmd(T.MESSAGE_DELETED, { messageId: "dm-secret", expectedMessageRevision: 0, reason: "remove" });

  const room = store.room("commons");
  const edited = room.state.messages.find(message => message.id === "edited");
  const copy = room.state.messages.find(message => message.id === "thread:channel");
  assert.equal(edited.body, null);
  assert.equal(edited.editHistory.length, 0);
  assert.equal(copy.body, null);
  assert.equal(typeof copy.deletedAt, "string");
  assert.equal(store.db.prepare("SELECT body FROM messages WHERE message_id='edited'").get().body, null);
  assert.equal(store.db.prepare("SELECT body FROM messages WHERE message_id='thread:channel'").get().body, null);
  const file = store.db.prepare("SELECT state, bytes, filename FROM room_attachments WHERE id='secret-file'").get();
  assert.equal(file.state, "deleted");
  assert.equal(file.bytes, null);
  assert.equal(file.filename, "purged");
  absent("database", databaseText(store.db), ROOM_NEEDLES);
  assert.doesNotThrow(() => auditRecovery(store));

  const before = room.sequence;
  const second = store.transaction(() => commitMessageRedaction(store.db, {
    roomId: "commons", state: store.room("commons").state, actorId: "owner", at: edited.deletedAt, messageId: "edited"
  }));
  assert.equal(second.rewritten, 0);
  assert.equal(second.sequence, before);
  absent("database after a second redaction", databaseText(store.db), ROOM_NEEDLES);

  const server = await listen(store);
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const vars = { roomId: "commons", messageId: "thread", needle: EDITED[0], workItemId: WORK_ITEM };
  for (const row of MESSAGE_BODY_READS) {
    if (row.group === "receipt") continue;
    seen.add(row.id);
    if (row.tool) {
      const result = await mcp(server.origin, row.tool, { roomId: "commons", after: 0, limit: 100 }, identity.secret);
      assert.equal(result.status, 200, result.text);
      absent(row.id, result.text, ROOM_NEEDLES);
      continue;
    }
    const token = row.auth === "agent" ? agentKey : ownerKey;
    const response = await fetch(server.origin + fill(row.path, vars), {
      headers: { Origin: server.origin, Authorization: `Bearer ${token}` }
    });
    const text = row.stream ? await readStream(response) : await response.text();
    assert.equal(response.status, 200, `${row.id} ${text.slice(0, 300)}`);
    const readable = row.id === "search" ? JSON.stringify({ ...JSON.parse(text), query: "" }) : text;
    absent(row.id, readable, ROOM_NEEDLES);
  }

  const fixture = createAcceptanceFixture();
  const send = (actor, type, data) => fixture.store.command(fixture.keys[actor], "commons", { id: randomUUID(), type, data });
  const item = () => fixture.store.room("commons").state.workItems[WORK_ITEM];
  send("producer", T.WORK_ACCEPTED, { workItemId: WORK_ITEM, expectedRevision: item().revision });
  const posted = send("producer", T.MESSAGE_POSTED, { messageId: "draft-1", workItemId: WORK_ITEM, body: EVIDENCE });
  const version = textVersion(EVIDENCE);
  send("producer", T.WORK_COMPLETED, {
    workItemId: WORK_ITEM, expectedRevision: item().revision, evidenceKind: "room_text",
    evidenceMessageId: "draft-1", evidenceMessageEventId: posted.event.id,
    evidenceVersion: version, previousCompletionEventId: null,
    producerId: "producer", summary: "Exact room result", nextAction: "Review the stored text"
  });
  send("owner", T.MESSAGE_DELETED, { messageId: "draft-1", expectedMessageRevision: 0, reason: "names a private person" });
  const receipt = item().receipt;
  assert.equal(receipt.nativeText.evidence, "removed");
  assert.equal(receipt.evidenceVersion, version);
  assert.ok(item().evidenceWithdrawals.some(entry => entry.messageId === "draft-1" && entry.evidence === "removed"));
  absent("receipt database", databaseText(fixture.store.db), [EVIDENCE]);
  assert.doesNotThrow(() => auditRecovery(fixture.store));
  const receiptServer = await listen(fixture.store);
  t.after(async () => {
    await receiptServer.close();
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const receiptVars = { roomId: "commons", messageId: "draft-1", needle: "Potter", workItemId: WORK_ITEM };
  const receiptIdentity = fixture.store.identities.create("Receipt reader");
  fixture.store.identities.link(fixture.keys.owner, "commons", { identityId: receiptIdentity.identityId, displayName: "Receipt", permissions: [] });
  for (const row of MESSAGE_BODY_READS) {
    if (row.group !== "receipt" && row.group !== "mcp") continue;
    seen.add(row.id);
    if (row.tool) {
      const result = await mcp(receiptServer.origin, row.tool, { roomId: "commons", after: 0, limit: 100 }, receiptIdentity.secret);
      assert.equal(result.status, 200, result.text);
      absent(row.id, result.text, [EVIDENCE]);
      continue;
    }
    const response = await fetch(receiptServer.origin + fill(row.path, receiptVars), {
      headers: { Origin: receiptServer.origin, Authorization: `Bearer ${fixture.keys.owner}` }
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${row.id} ${text.slice(0, 400)}`);
    absent(row.id, text, [EVIDENCE]);
    const body = JSON.parse(text);
    assert.equal(body.result.text.body, null);
    assert.equal(body.result.text.evidence, "removed");
    assert.equal(body.result.text.evidenceVersion, version);
    assert.equal(body.result.receipt.nativeText.evidence, "removed");
  }
  assert.deepEqual([...seen].sort(), MESSAGE_BODY_READS.map(row => row.id).sort());
});
