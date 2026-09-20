import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { RoomAgentClient } from "./room-agent.mjs";

// The caller selects a private local file and one configured host. This is not
// a watcher or permission to run arbitrary room messages. SQLite serializes
// concurrent intent claims; a crash after claiming never silently reruns a host.
export function openRequestJournal(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  closeSync(openSync(filename, "a", 0o600)); chmodSync(filename, 0o600);
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS request_runs (id TEXT PRIMARY KEY, response TEXT, delivered INTEGER NOT NULL DEFAULT 0)");
  return db;
}

// execute receives no connection secret: only the selected conversation and
// preparation. It returns { body }, not commands. Room validates the exact
// original answer basis on delivery; no automatic rebase after clarification.
export async function runRequestOnce({ connection, requestMessageId, db, execute, signal }) {
  if (typeof execute !== "function" || !connection.memberId) throw new Error("A configured host and pinned member are required");
  const client = new RoomAgentClient(connection);
  let context = await client.replyContext(requestMessageId, { limit: 50, signal });
  if (context.viewerId !== connection.memberId || context.request.recipientId !== connection.memberId)
    throw new Error("Request must be addressed to the configured member");
  const id = "host-" + createHash("sha256").update(JSON.stringify([
    connection.origin, connection.roomId, connection.memberId, requestMessageId,
    context.roomCreatedEventId, context.request.openingEventId
  ])).digest("hex");
  const deliver = async record => {
    const input = JSON.parse(record.response);
    const receipt = await client.replyAction("room_respond_to_request", input, { signal });
    if (receipt.status !== "recorded") throw new Error("Reply delivery is unconfirmed; retain the journal and retry unchanged");
    db.prepare("UPDATE request_runs SET delivered=1 WHERE id=?").run(id);
    return { status: "delivered", requestId: id, receipt, hostExecuted: false };
  };
  const prior = db.prepare("SELECT * FROM request_runs WHERE id=?").get(id);
  if (prior) {
    if (!prior.response) throw new Error("Host outcome is unknown; reconcile the original attempt before proceeding");
    // Even an already delivered response is reconciled through the service's
    // idempotent command path, never a stale local assertion of current access.
    return deliver(prior);
  }
  const messages = [...context.page.items];
  let pages = 1;
  while (context.page.hasMore) {
    if (++pages > 10) throw new Error("Request exceeds the automatic preparation limit; inspect it directly");
    context = await client.replyContext(requestMessageId, { cursor: context.page.nextCursor, limit: 50, signal });
    if (context.viewerId !== connection.memberId || context.request.recipientId !== connection.memberId)
      throw new Error("Request identity changed while preparing");
    messages.push(...context.page.items);
  }
  if (!context.current.answerBasis || !context.preparation) throw new Error("Request is not ready or service lacks prepared context");
  if (Buffer.byteLength(JSON.stringify({ messages, preparation: context.preparation })) > 262144)
    throw new Error("Request exceeds the automatic preparation limit; inspect it directly");
  signal?.throwIfAborted();
  const claimed = db.prepare("INSERT OR IGNORE INTO request_runs(id) VALUES (?)").run(id).changes;
  if (!claimed) throw new Error("Another runner owns this attempt; reconcile before proceeding");
  const result = await execute({ requestId: id, request: structuredClone(context.request), messages,
    preparation: context.preparation, signal });
  if (typeof result?.body !== "string" || !result.body.trim() || result.body.length > 4096 || !result.body.isWellFormed())
    throw new Error("Host must return a nonempty reply of at most 4096 characters; reconcile this attempt");
  const response = { requestId: id, responseToRequestId: requestMessageId,
    ...context.current.answerBasis, responseOutcome: "answered", toMemberId: context.request.requesterId,
    workItemId: context.request.workItemId, body: result.body };
  db.prepare("UPDATE request_runs SET response=? WHERE id=?").run(JSON.stringify(response), id);
  const delivered = await deliver({ response: JSON.stringify(response) });
  return { ...delivered, hostExecuted: true };
}
