import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml } from "../src/board-ui.js";
import {
  STALE_CLAIM_MS, fixedBoardColumns, partitionConversation, readRoomTabsFlag,
  receiptEntries, staleClaim, updateLine, updatesLabel,
} from "../src/room-tabs.js";

const memory = () => {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
  };
};

const members = {
  ada: { displayName: "Ada", kind: "human" },
  leo: { displayName: "Leo", kind: "agent" },
  sys: { displayName: "Room", kind: "system" },
};

test("room tabs stay off until the page asks, and a stored choice sticks", () => {
  assert.equal(readRoomTabsFlag("", null), false);
  assert.equal(readRoomTabsFlag("?tabs=1", null), true);
  const storage = memory();
  assert.equal(readRoomTabsFlag("?tabs=1", storage), true);
  storage.setItem("project-room-tabs", "0");
  storage.setItem("project-room-tabs-query", "1");
  assert.equal(readRoomTabsFlag("?tabs=1", storage), false);
});

test("conversation keeps human and agent posts and folds the rest", () => {
  const messages = [
    { id: "m1", authorId: "ada", body: "Hello" },
    { id: "m2", authorId: "leo", body: "On it" },
    { id: "m3", authorId: "sys", body: "Claim recorded for the notes" },
    { id: "m4", authorId: "gone", body: "A removed sender" },
  ];
  const part = partitionConversation(messages, members);
  assert.deepEqual(part.messages.map(message => message.id), ["m1", "m2"]);
  assert.deepEqual(part.updates.map(message => message.id), ["m3", "m4"]);
  assert.equal(updatesLabel(0), "");
  assert.equal(updatesLabel(1), "1 update");
  assert.equal(updatesLabel(part.updates.length), "2 updates");
  assert.equal(updateLine(part.updates[0], members), "Room: Claim recorded for the notes");
  assert.equal(updateLine(part.updates[1], members), "A removed sender");
  assert.equal(updateLine({ authorId: "id_hidden", body: "" }, { id_hidden: { kind: "system" } }), "Update");
});

test("a stale claim follows expiresAt when the claim has one", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const old = new Date(now - STALE_CLAIM_MS - 1000).toISOString();
  const future = new Date(now + 60 * 60 * 1000).toISOString();
  const past = new Date(now - 1000).toISOString();
  assert.equal(staleClaim({ state: "claimed", claimedAt: old, expiresAt: future }, now), false);
  assert.equal(staleClaim({ state: "claimed", claimedAt: future, expiresAt: past }, now), true);
  assert.equal(staleClaim({ state: "claimed", claimedAt: future, leaseExpiresAt: past }, now), true);
  assert.equal(staleClaim({ state: "claimed", claimedAt: old }, now), true);
  assert.equal(staleClaim({ state: "done", claimedAt: old, expiresAt: past }, now), false);
});

test("fixed columns pin Needs you and keep the other states in order", () => {
  const ready = { id: "r", state: "unclaimed" };
  const waiting = { id: "w", state: "unclaimed" };
  const blocked = { id: "b", state: "blocked" };
  const arranged = fixedBoardColumns({
    ready: [ready],
    claimed: [{ id: "c", state: "claimed" }],
    blocked: [waiting, blocked],
    review: [{ id: "v", state: "delivered" }],
    landed: [{ id: "d", state: "done" }],
  });
  assert.deepEqual(arranged.map(([id]) => id), ["needs", "ready", "claimed", "review", "done"]);
  assert.deepEqual(arranged[0][1].map(item => item.id), ["b"]);
  assert.deepEqual(arranged[1][1].map(item => item.id), ["r", "w"]);
});

test("the board keeps today's columns until the tab face is on", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const viewer = { id: "ada", manage: false, owner: false, write: true };
  const people = { ada: { displayName: "Ada", kind: "human" } };
  const items = [
    { id: "ready", title: "Draft the notes", state: "unclaimed", owner: null, dependsOn: [], updatedAt: "2026-10-24T11:30:00.000Z" },
    { id: "held", title: "Wait on the draft", state: "unclaimed", owner: null, dependsOn: ["ready"], updatedAt: "2026-10-24T11:30:00.000Z" },
    { id: "stuck", title: "Needs a person", state: "blocked", owner: "ada", claimedAt: "2026-10-24T11:00:00.000Z", expiresAt: "2026-10-24T11:30:00.000Z", updatedAt: "2026-10-24T11:00:00.000Z" },
    { id: "fresh", title: "Still in lease", state: "claimed", owner: "ada", claimedAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T18:00:00.000Z", updatedAt: "2026-10-23T12:00:00.000Z" },
    { id: "review", title: "Check the notes", state: "delivered", owner: "ada", updatedAt: "2026-10-24T11:40:00.000Z" },
    { id: "done", title: "Ship the notes", state: "done", owner: "ada", updatedAt: "2026-10-24T11:50:00.000Z" },
  ];
  const plain = boardHtml(items, null, viewer, people, now);
  assert.match(plain, /id="board-col-landed"/);
  assert.doesNotMatch(plain, /id="board-col-needs"/);
  assert.doesNotMatch(plain, /Stale claim/);
  const fixed = boardHtml(items, null, viewer, people, now, { fixedView: true });
  const needs = fixed.indexOf('id="board-col-needs"');
  const ready = fixed.indexOf('id="board-col-ready"');
  assert.ok(needs !== -1 && ready !== -1 && needs < ready);
  assert.match(fixed.slice(needs, ready), /Needs you/);
  assert.match(fixed.slice(needs, ready), /data-claim-id="stuck"/);
  assert.match(fixed.slice(needs, ready), /Stale claim/);
  assert.doesNotMatch(fixed.slice(needs, ready), /data-claim-id="held"/);
  const claimed = fixed.indexOf('id="board-col-claimed"');
  assert.doesNotMatch(fixed.slice(claimed, fixed.indexOf('id="board-col-review"')), /Stale claim/);
});

test("receipt rows keep the public title and drop a row with no title", () => {
  const entries = receiptEntries({
    receipts: [
      { id: "rec_1", title: "Notes shipped" },
      { id: "rec_2", title: "  " },
      { id: "rec/3", title: "Bad id" },
    ],
  });
  assert.deepEqual(entries, [{ id: "rec_1", title: "Notes shipped", href: "/receipts/rec_1" }]);
});
