// Phase 1a step 2 (hard-h3-slim-projection): every rooms.projection writer is
// routed through storedProjection, flag off changes nothing, flag on keeps
// bodies at rest and every reader gets them back, and the way back works.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { readConversation } from "../server/conversation-sync.mjs";
import { runMessagesBackfill } from "../server/messages-store.mjs";
import { event, EVENT_TYPES } from "../src/events.js";
import { rehydrateAllRooms, BODY_AT_REST } from "../server/projection-codec.mjs";

// Ratchet: a new raw writer of rooms.projection fails here. Route it through
// storedProjection(db, roomId, state) and bump the pin in the same commit.
const WRITERS = {
  "access-requests.mjs": 2, "account-deletion.mjs": 1, "agent-invites.mjs": 1, "guest-agent-links.mjs": 1,
  "guest-invites.mjs": 4, "land-queue.mjs": 1, "message-redaction.mjs": 1, "receipt-cards.mjs": 1,
  "referral-invites.mjs": 1, "referrals.mjs": 1, "share-links.mjs": 2, "store.mjs": 7, "work-claim-events.mjs": 1
};
const WRITE = /(UPDATE\s+rooms\s+SET\s[^"`']*?\bprojection\s*=|INSERT\s+INTO\s+rooms\s*\([^)]*\bprojection\b)/g;

test("every rooms.projection writer is routed through storedProjection", () => {
  const dir = new URL("../server/", import.meta.url);
  const found = {};
  for (const file of readdirSync(dir).filter(name => name.endsWith(".mjs") && name !== "projection-codec.mjs")) {
    const text = readFileSync(new URL(file, dir), "utf8");
    const writes = (text.match(WRITE) ?? []).length;
    if (!writes) continue;
    found[file] = writes;
    const routed = (text.match(/storedProjection\(/g) ?? []).length;
    assert.ok(routed >= writes, `${file}: ${writes} projection writes but ${routed} storedProjection calls`);
  }
  assert.deepEqual(found, WRITERS, "a rooms.projection writer was added or removed; route it through storedProjection and update the pin");
});

const BODY = n => `message ${n} `.padEnd(900, "lorem ipsum dolor sit amet ");

function open(t, count) {
  const directory = mkdtempSync(join(tmpdir(), "p1a-writers-"));
  const file = join(directory, "room.sqlite");
  let store = new RoomStore(file);
  // Seed through the log (the flood guard would stop 2.5k commands), then let
  // the MSG-2 backfill fill the messages table the way prod's cron does.
  const seeded = Array.from({ length: count }, (_, i) => event({ type: EVENT_TYPES.MESSAGE_POSTED, actorId: "owner", roomId: "commons",
    data: { messageId: `m${i}`, body: BODY(i) } }));
  store.initialize([...initialRoom("commons"), ...seeded]);
  for (let pass = 0; pass < 20; pass += 1) if (runMessagesBackfill(store, { limit: 5000 }).done) break;
  const owner = store.issueAccessKey("commons", "owner");
  const post = (id, body) => store.command(owner, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: id, body } });
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); delete process.env.PROJECTION_BODIES_AT_REST; });
  const reopen = () => { store.close(); store = new RoomStore(file); return store; };
  return { get store() { return store; }, owner, post, reopen };
}
const row = store => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;

test("flag off: the stored row is exactly JSON of the room (first deploy is a no-op)", t => {
  delete process.env.PROJECTION_BODIES_AT_REST;
  const room = open(t, 20);
  const text = row(room.store);
  assert.ok(!text.includes(BODY_AT_REST));
  assert.equal(text, JSON.stringify(room.reopen().room("commons").state));
});

test("flag on: bodies leave the row, every reader gets them back, the way back restores inline rows", t => {
  delete process.env.PROJECTION_BODIES_AT_REST;
  const room = open(t, 2500);
  const full = row(room.store);
  const expected = JSON.parse(full);
  process.env.PROJECTION_BODIES_AT_REST = "1";
  let started = process.hrtime.bigint();
  room.post("m-last", BODY(9999));
  const writeMs = Number(process.hrtime.bigint() - started) / 1e6;
  const slim = row(room.store);
  assert.ok(slim.includes(`"${BODY_AT_REST}":1`));
  assert.ok(Buffer.byteLength(slim) < Buffer.byteLength(full) / 3, `slim ${Buffer.byteLength(slim)} vs full ${Buffer.byteLength(full)}`);
  const store = room.reopen();
  started = process.hrtime.bigint();
  const state = store.room("commons").state;
  const readMs = Number(process.hrtime.bigint() - started) / 1e6;
  const byId = Object.fromEntries(state.messages.map(m => [m.id, m]));
  for (const message of expected.messages) assert.equal(byId[message.id].body, message.body);
  assert.equal(byId["m-last"].body, BODY(9999));
  assert.ok(!JSON.stringify(state).includes(BODY_AT_REST));
  t.diagnostic(`2.5k msgs: write ${writeMs.toFixed(1)} ms, cold room() ${readMs.toFixed(1)} ms, row ${Buffer.byteLength(full)} -> ${Buffer.byteLength(slim)} B`);
  // conversation-sync reads the row in SQL; it must refill from the table.
  const page = readConversation(store, room.owner, "commons", { limit: 5 });
  assert.equal(page.messages.length, 5);
  for (const message of page.messages) {
    assert.equal(message.body, byId[message.id].body);
    assert.equal(message[BODY_AT_REST], undefined);
  }
  // The way back: inline every row, then pre-Phase-1a code reads plain JSON.
  delete process.env.PROJECTION_BODIES_AT_REST;
  assert.equal(rehydrateAllRooms(store.db), 1);
  const back = JSON.parse(row(store));
  assert.ok(!row(store).includes(BODY_AT_REST));
  assert.deepEqual(back.messages.map(m => m.body), state.messages.map(m => m.body));
});
