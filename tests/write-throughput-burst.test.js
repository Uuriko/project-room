// P1 write-throughput recheck (wave500-g2-p1-write-throughput-r2):
// burst 50 rapid concurrent message.posted commands at a hermetic local
// HTTP server and assert every write lands exactly once with a contiguous
// sequence run — no drops, no duplicates, no gaps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const MEMBERS = 5;
const POSTS_PER_MEMBER = 10;
const TOTAL = MEMBERS * POSTS_PER_MEMBER;

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-write-throughput-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const tokens = [];
  for (let m = 0; m < MEMBERS; m += 1) {
    const memberId = `burst-member-${m}`;
    store.command(ownerToken, "commons", {
      id: randomUUID(), type: "member.added",
      data: { memberId, displayName: `Burst ${m}`, kind: "agent", permissions: ["accept_work"] }
    });
    tokens.push(store.issueAccessKey("commons", memberId));
  }
  const postCommand = (token, command) => fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(command)
  }).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));
  return { store, postCommand, tokens };
}

test("50 rapid concurrent posts land exactly once with a contiguous sequence run", async t => {
  const { store, postCommand, tokens } = await fixture(t);
  const sent = [];
  const attempts = [];
  for (let m = 0; m < MEMBERS; m += 1) {
    for (let i = 0; i < POSTS_PER_MEMBER; i += 1) {
      const messageId = randomUUID();
      const body = `burst-${m}-${i}`;
      sent.push({ messageId, body, member: m });
      attempts.push(postCommand(tokens[m], {
        id: randomUUID(), type: "message.posted", data: { messageId, body }
      }));
    }
  }
  const results = await Promise.all(attempts);

  // Every attempt is accepted exactly once.
  const statuses = results.map(r => r.status);
  assert.deepEqual(statuses, Array(TOTAL).fill(201),
    `all ${TOTAL} posts accepted; got ${JSON.stringify(statuses.filter(s => s !== 201))}`);
  assert.ok(results.every(r => r.body?.duplicate !== true), "no post reported as duplicate");
  const responseSeqs = results.map(r => r.body.sequence);
  assert.equal(new Set(responseSeqs).size, TOTAL, "every response carries a distinct sequence");

  // The event log holds all 50 messages exactly once, on a contiguous run.
  const rows = store.db.prepare(
    "SELECT sequence, body FROM events WHERE room_id=? AND sequence >= ? ORDER BY sequence"
  ).all("commons", Math.min(...responseSeqs));
  const posted = rows.filter(r => {
    try { return JSON.parse(r.body).type === "message.posted"; } catch { return false; }
  });
  const bodies = posted.map(r => JSON.parse(r.body));
  const seqs = posted.map(r => r.sequence);
  const byMessageId = new Map(bodies.map(e => [e.data.messageId, e]));
  assert.equal(byMessageId.size, TOTAL, "50 distinct messageIds in the log");
  for (const { messageId } of sent) assert.ok(byMessageId.has(messageId), `message ${messageId} present`);
  const sorted = [...seqs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.equal(sorted[i], sorted[i - 1] + 1, `contiguous sequences, gap at ${sorted[i - 1]}`);
  }

  // The message read model agrees: one row per message, same bodies.
  const stored = store.db.prepare(
    "SELECT message_id, body FROM messages WHERE room_id=?"
  ).all("commons");
  assert.equal(new Set(stored.map(r => r.message_id)).size, TOTAL, "messages table has 50 distinct rows");
  const storedBodies = new Set(stored.map(r => r.body));
  for (const { body } of sent) assert.ok(storedBodies.has(body), `row for ${body} present`);

  // Projection agrees too: the 50 messages are in state.messages.
  const state = store.room("commons").state;
  const burst = (state.messages ?? []).filter(m => typeof m?.body === "string" && m.body.startsWith("burst-"));
  assert.equal(new Set(burst.map(m => m.id)).size, TOTAL, "projection holds all 50 messages");
});
