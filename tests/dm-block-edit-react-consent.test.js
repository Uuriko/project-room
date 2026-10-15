// r233 (John's Tab QA, follow-up to R232-1): after Ada blocks Nightbot, the
// blocked member could still put new words and new notifications in front of
// her through an old DM. Editing its own DM to her swapped in a new body (her
// DM view and her activity row both read the live message), and reacting to
// a DM she had sent it filed a fresh "reaction" activity event for her. Both
// are new contact in the direction she denied, the same as a fresh DM.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function seeded(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [id, name] of [["ada", "Ada"], ["bot", "Nightbot"]]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId: id, displayName: name, kind: id === "bot" ? "agent" : "human", permissions: ["steer"] } });
  }
  const botKey = store.issueAccessKey("commons", "bot");
  const adaKey = store.issueAccessKey("commons", "ada");
  // Default-open DMs both ways before any consent row exists.
  store.command(botKey, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-bot", body: "hi Ada", toMemberId: "ada" } });
  store.command(adaKey, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-ada", body: "hi Nightbot", toMemberId: "bot" } });
  return { store, botKey, adaKey };
}

const run = (store, key, type, data) => {
  try { store.command(key, "commons", { id: randomUUID(), type, data }); return null; }
  catch (error) { return error; }
};
const message = (store, id) => store.room("commons").state.messages.find(m => m.id === id);
const revision = (store, key, id) => store.snapshot(key, "commons").state.messages.find(m => m.id === id)?.revision ?? 0;
const edit = (store, key, id, body) => run(store, key, "message.edited",
  { messageId: id, body, expectedMessageRevision: revision(store, key, id) });
const react = (store, key, id, active = true) => run(store, key, "message.reaction_set", { messageId: id, reaction: "👍", active });
const reactionEventsFor = (store, userId) => store.db.prepare(
  "SELECT actor_id FROM activity_events WHERE room_id='commons' AND type='reaction' AND user_id=?").all(userId);

test("a blocked member cannot edit new words into an old DM to the blocker", t => {
  const { store, botKey } = seeded(t);
  store.dmConsents.block("commons", "ada", "bot");
  const refused = edit(store, botKey, "dm-bot", "new words after the block");
  assert.equal(refused?.code, "dm_blocked", "an edit is new content to the blocker, refused like a fresh DM");
  assert.equal(message(store, "dm-bot").body, "hi Ada", "the old DM keeps its pre-block body");
});

test("a blocked member cannot notify the blocker by reacting to her DM", t => {
  const { store, botKey } = seeded(t);
  store.dmConsents.block("commons", "ada", "bot");
  const refused = react(store, botKey, "dm-ada");
  assert.equal(refused?.code, "dm_blocked", "a reaction on the blocker's DM is refused");
  assert.deepEqual(reactionEventsFor(store, "ada"), [], "no reaction activity event reaches the blocker");
});

test("the blocker keeps her own direction, and the blocked member can still retract or delete", t => {
  const { store, botKey, adaKey } = seeded(t);
  assert.equal(react(store, botKey, "dm-ada"), null, "before the block a reaction lands");
  store.dmConsents.block("commons", "ada", "bot");
  assert.equal(edit(store, adaKey, "dm-ada", "ada edits her own DM"), null, "the blocker's own edits are not denied");
  assert.equal(react(store, adaKey, "dm-bot"), null, "the blocker may still react");
  assert.equal(react(store, botKey, "dm-ada", false), null, "taking a reaction back adds nothing for the blocker");
  assert.equal(run(store, botKey, "message.deleted", { messageId: "dm-bot", expectedMessageRevision: revision(store, botKey, "dm-bot") }), null, "the blocked member may still delete its own DM");
});
