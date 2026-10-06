/**
 * pins-dm-visibility.test.js — H-1 regression: pinned DMs must never leak
 * to non-participants through the pin library.
 *
 * The pre-fix defect: server/pins.mjs returned the pin list to any room
 * member without checking DM participation, so anyone in the room could read
 * a DM body via the pin list. (The HTTP route had its own wrapper; the
 * library itself did not filter.)
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { listPins, setPin } from "../server/pins.mjs";
import { buildActivationPack } from "../server/room-activation-pack.mjs";

let tmpdirPath;
let store;

function storeFixture() {
  tmpdirPath = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pins-dm-"));
  store = new RoomStore(join(tmpdirPath, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const addMember = memberId =>
    store.command(ownerKey, "commons", {
      id: randomUUID(),
      type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: [] },
    });
  for (const m of ["alice", "bob", "mallory"]) addMember(m);
  return {
    aliceKey: store.issueAccessKey("commons", "alice"),
    bobKey: store.issueAccessKey("commons", "bob"),
    malloryKey: store.issueAccessKey("commons", "mallory"),
    cmd: (token, type, data) =>
      store.command(token, "commons", { id: randomUUID(), type, data }),
  };
}

beforeEach(() => { storeFixture(); });
afterEach(() => {
  store?.close();
  rmSync(tmpdirPath, { recursive: true, force: true });
});

test("a pinned DM is hidden from non-participants but visible to the author and recipient", () => {
  const { aliceKey, bobKey, malloryKey, cmd } = storeFixture();
  const dmId = cmd(aliceKey, T.MESSAGE_POSTED, {
    messageId: randomUUID(), body: "secret DM body", toMemberId: "bob",
  }).event.data.messageId;
  // DM pins are permitted (participants may pin their own DMs) but the pin
  // list is filtered per viewer, so the body never reaches a bystander.
  setPin(store, aliceKey, "commons", { messageId: dmId, pinned: true });

  const malloryView = listPins(store, malloryKey, "commons");
  assert.equal(malloryView.pins.length, 0, "a bystander must not see another pair's pinned DM");

  const bobView = listPins(store, bobKey, "commons");
  assert.equal(bobView.pins.length, 1, "the DM recipient still sees their pinned DM");
  assert.equal(bobView.pins[0].body, "secret DM body");

  const aliceView = listPins(store, aliceKey, "commons");
  assert.equal(aliceView.pins.length, 1, "the DM author still sees their pinned DM");
});

test("room message pins remain visible to every room member", () => {
  const { aliceKey, malloryKey, cmd } = storeFixture();
  const roomMsgId = cmd(aliceKey, T.MESSAGE_POSTED, {
    messageId: randomUUID(), body: "room announcement",
  }).event.data.messageId;
  setPin(store, aliceKey, "commons", { messageId: roomMsgId, pinned: true });

  const malloryView = listPins(store, malloryKey, "commons");
  assert.equal(malloryView.pins.length, 1, "room pins must not be over-filtered");
  assert.equal(malloryView.pins[0].body, "room announcement");
});

test("the activation pack hides another pair's pinned DM from a bystander", () => {
  const { aliceKey, cmd } = storeFixture();
  const dmId = cmd(aliceKey, T.MESSAGE_POSTED, {
    messageId: randomUUID(), body: "secret DM body", toMemberId: "bob",
  }).event.data.messageId;
  setPin(store, aliceKey, "commons", { messageId: dmId, pinned: true });

  const malloryPack = buildActivationPack(store, "commons", "mallory");
  assert.equal(malloryPack.pinnedResources.length, 0,
    "the activation pack must not leak another pair's pinned DM");

  const bobPack = buildActivationPack(store, "commons", "bob");
  assert.equal(bobPack.pinnedResources.length, 1,
    "the DM recipient still sees their pinned DM in the pack");
});

test("a non-party cannot pin another pair's DM at the event layer", () => {
  const { aliceKey, malloryKey, cmd } = storeFixture();
  const dmId = cmd(aliceKey, T.MESSAGE_POSTED, {
    messageId: randomUUID(), body: "secret DM body", toMemberId: "bob",
  }).event.data.messageId;
  assert.throws(
    () => cmd(malloryKey, T.MESSAGE_PINNED, { messageId: dmId }),
    /not a party/,
    "pinning a DM you cannot read must be refused by the reducer",
  );
});
