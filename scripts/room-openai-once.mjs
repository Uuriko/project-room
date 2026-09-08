import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validId } from "../src/events.js";
import { completeChat } from "../server/openai-complete.mjs";

export function openJournal(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  closeSync(openSync(filename, "a", 0o600));
  chmodSync(filename, 0o600);
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, command TEXT, done INTEGER NOT NULL DEFAULT 0)");
  return db;
}

// One operator-selected human message per invocation. No polling, history upload,
// tool execution, model-output dispatch, or agent-to-agent reply loop.
export async function replyOnce({ client, origin, roomId, messageId, db, complete = completeChat, env = process.env }) {
  if (!env.PROJECT_ROOM_OPENAI_API_KEY?.trim()) throw new Error("PROJECT_ROOM_OPENAI_API_KEY is missing");
  if (!validId(messageId)) throw new Error("ROOM_OPENAI_MESSAGE_ID is required");
  const snapshot = await client.snapshot();
  const member = snapshot.state.members[snapshot.viewerId];
  if (member?.kind !== "agent") throw new Error("Use a provisioned agent membership");
  const source = snapshot.state.messages.find(message => message.id === messageId);
  if (!source || source.toMemberId !== member.id || snapshot.state.members[source.authorId]?.kind !== "human") {
    throw new Error("Select a human message addressed to this agent");
  }
  const id = "openai-" + createHash("sha256").update(JSON.stringify([origin, roomId, member.id, messageId])).digest("hex");
  const existing = snapshot.state.messages.find(message => message.id === id && message.authorId === member.id && message.replyToId === messageId);
  if (existing) return { posted: true, duplicate: true, messageId: id };
  const claimed = db.prepare("INSERT OR IGNORE INTO replies(id) VALUES (?)").run(id).changes;
  let record = db.prepare("SELECT * FROM replies WHERE id = ?").get(id);
  if (!claimed && !record.command) throw new Error("Previous OpenAI attempt has uncertain outcome; operator reconciliation required");
  if (claimed) {
    const result = await complete({ text: source.body, env });
    if (typeof result.text !== "string" || !result.text.trim()) throw new Error("No reply text");
    const command = { id, type: "message.posted", data: {
      messageId: id, body: result.text.trim().slice(0, 4096), replyToId: messageId, toMemberId: source.authorId
    } };
    db.prepare("UPDATE replies SET command = ? WHERE id = ?").run(JSON.stringify(command), id);
    record = { command: JSON.stringify(command) };
  }
  // Saved before delivery: after a lost Room response, resend identical bytes
  // under the same command ID, without another provider call.
  const receipt = await client.command(JSON.parse(record.command));
  db.prepare("UPDATE replies SET done = 1 WHERE id = ?").run(id);
  return { posted: true, duplicate: Boolean(receipt.duplicate), messageId: id, sequence: receipt.sequence };
}

export async function main(env = process.env) {
  if (!env.PROJECT_ROOM_OPENAI_API_KEY?.trim()) throw new Error("PROJECT_ROOM_OPENAI_API_KEY is missing");
  if (process.argv.includes("--test-key")) {
    const result = await completeChat({ text: "Reply exactly: PROJECT_ROOM_OPENAI_OK", env, maxTokens: 32 });
    if (result.text !== "PROJECT_ROOM_OPENAI_OK") throw new Error("OpenAI returned text but did not match the test phrase");
    console.log(JSON.stringify({ ok: true, status: result.status, model: result.model, result: "PROJECT_ROOM_OPENAI_OK" }));
    return;
  }
  const origin = env.ROOM_AGENT_ORIGIN;
  const roomId = env.ROOM_AGENT_ROOM || "commons";
  const client = new RoomAgentClient({ origin, roomId, token: env.ROOM_AGENT_TOKEN });
  const db = openJournal(resolve(env.ROOM_OPENAI_STATE || ".operator/openai-replies.sqlite"));
  try { console.log(JSON.stringify(await replyOnce({ client, origin, roomId, messageId: env.ROOM_OPENAI_MESSAGE_ID, db, env }))); }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("OpenAI Room operation failed; no success is claimed. Check credentials, addressed message and private journal before retrying."); process.exitCode = 1; });
}
