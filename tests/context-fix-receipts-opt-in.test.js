// CONTEXT-FIX R3 (lane 09): room.public_receipts_set must be qualified for
// current-format rooms the way its siblings (room.public_page_set,
// room.join_link_set) were. Lane 08's filed cases (a1 command route, a2
// directory route, a-c1 sibling control, a-c2 legacy control), plus the
// charter adversarial item (i) for this root.
//
// FAIL-on-main: at the pin, (a1) throws 409 current_room_context_unavailable
// (current-room-repository.mjs:703, the command is absent from the :689-690
// diversion), and (a2) throws 409 current_room_context_required
// (store.mjs:4035 via RoomDirectory._roomState's legacy whole-room read).
// Both controls pass on main and at head. Copy into tests/ to run.
//
// LANE-11 REWORK (lane 10 PROBE.md C3 + D3; pin-verified): initialRoom is
// imported from server/bootstrap.mjs (its only export site, :3), and the
// non-owner directory assertion expects the pin's real error code
// owner_only (server/room-directory.mjs:94). All results remain NOT-RUN.
import assert from "node:assert/strict";
import test from "node:test";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { currentInviteContext } from "../server/current-room-repository.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function currentRoom() {
  const store = new RoomStore(":memory:");
  const owner = store.identities.create("Receipts Owner");
  new AgentRooms(store).create(owner.secret, {
    roomId: "receipts-room", title: "Receipts",
    purpose: "receipts opt-in qualification repro", kind: "personal",
    displayName: "Receipts Owner",
  });
  return { store, owner };
}

const receiptsEnabled = (store, roomId) =>
  currentInviteContext(store, roomId, {})?.room?.state?.room?.publicReceipts?.enabled === true;

test("a1: room.public_receipts_set succeeds in a current-format room and reads back", () => {
  const { store, owner } = currentRoom();
  store.command(owner.secret, "receipts-room", {
    id: "opt-in-1", type: "room.public_receipts_set", data: { enabled: true },
  });
  assert.equal(receiptsEnabled(store, "receipts-room"), true);
  // Disabling must also work — including from the already-enabled state the
  // :724-725 blanket refusal used to poison (the receipts command itself is
  // diverted before that disposition; other commands there are a named
  // follow-up, out of this root's scope).
  store.command(owner.secret, "receipts-room", {
    id: "opt-in-2", type: "room.public_receipts_set", data: { enabled: false },
  });
  assert.equal(receiptsEnabled(store, "receipts-room"), false);
});

test("a-c1 control: sibling room.public_page_set succeeds in the same current-format room", () => {
  const { store, owner } = currentRoom();
  store.command(owner.secret, "receipts-room", {
    id: "page-1", type: "room.public_page_set", data: { enabled: true },
  });
});

test("a-c2 control: room.public_receipts_set succeeds in a legacy room", () => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "opt-in-legacy", type: "room.public_receipts_set", data: { enabled: true },
  });
  assert.equal(store.room("commons").state.room.publicReceipts.enabled, true);
});

test("a2: RoomDirectory owner reads/writes work in a current-format room", () => {
  const { store, owner } = currentRoom();
  const status = store.roomDirectory.status("receipts-room", owner.identityId);
  assert.equal(typeof status.discoverable, "boolean");
  assert.equal(store.roomDirectory.set("receipts-room", owner.identityId, true).discoverable, true);
  assert.equal(
    store.roomDirectory.setReceiptsVisibility("receipts-room", owner.identityId, false).publicReceipts,
    false);
  assert.equal(store.roomDirectory.publicReceiptsVisible("receipts-room"), false);
});

test("a2: RoomDirectory refuses a non-owner with owner_only, not the format refusal", () => {
  const { store, owner } = currentRoom();
  const other = store.identities.create("Receipts Other");
  linkWithProof(store, owner.secret, "receipts-room", other, { permissions: [] });
  assert.throws(
    () => store.roomDirectory.status("receipts-room", other.identityId),
    (error) => error.code === "owner_only");
});

test("adversarial (i): a non-owner member cannot set the receipts opt-in", () => {
  const { store, owner } = currentRoom();
  const other = store.identities.create("Receipts Other");
  linkWithProof(store, owner.secret, "receipts-room", other, { permissions: [] });
  const otherKey = store.issueAccessKey("receipts-room", other.identityId);
  assert.throws(
    () => store.command(otherKey, "receipts-room", {
      id: "opt-in-evil", type: "room.public_receipts_set", data: { enabled: true },
    }),
    (error) => error.code !== "current_room_context_unavailable");
  assert.equal(receiptsEnabled(store, "receipts-room"), false);
});
