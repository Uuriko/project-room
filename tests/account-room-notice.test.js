import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ROOM_ACCESS_NOTICE } from "../src/room-deep-link.js";

// Exercise the actual snapshot acceptance boundary without mounting unrelated
// room panels. The browser journey also covers sign-out and account restore.
const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const start = source.indexOf("  onSnapshot(snapshot, identity) {");
const end = source.indexOf("    displayNames = createMemberDisplayNames(state.members);", start);
assert.ok(start >= 0 && end > start);
const acceptedSnapshot = source.slice(start, end) + "\n  }";
const showStart = source.indexOf("function showRoomAccessNotice() {");
const showEnd = source.indexOf("\nasync function openRememberedRoomOrList()", showStart);
assert.ok(showStart >= 0 && showEnd > showStart);

function harness(text = "") {
  const status = { textContent: text, hidden: !text };
  const context = {
    ROOM_ACCESS_NOTICE, state: null, session: null, roomGeneration: -1,
    activeWorkNavigationId: null, client: { generation: 1 },
    selectedMessage: { clear() {} }, directDirectory: { clear() {} },
    stopPresencePoll() {}, $: selector => selector === "#account-status" ? status : null,
    snapshotAuditView: null, nativeEventsWindow: null,
    recordLoading: null, recordLoadFailed: false, partialWorkSnapshot: false,
    inspectedWorkRecord: null,
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(showStart, showEnd)}\nthis.accept = ({${acceptedSnapshot}}).onSnapshot;`, context);
  const accept = roomId => context.accept({ state: { room: { id: roomId }, messages: [] } }, { roomId, member: { id: roomId + "-owner" } });
  return { status, context, accept, deny: () => context.showRoomAccessNotice() };
}

test("denied deep link stays visible until an authorized room snapshot arrives", () => {
  const h = harness();
  h.deny();
  assert.equal(h.status.textContent, ROOM_ACCESS_NOTICE);
  assert.equal(h.status.hidden, false);
  h.accept("account-b-room");
  assert.equal(h.context.session.roomId, "account-b-room");
  assert.equal(h.status.hidden, true);
  assert.equal(h.status.textContent, "");
});

test("returning to account A clears its stale denial without suppressing a later denial", () => {
  const h = harness(ROOM_ACCESS_NOTICE);
  h.accept("account-b-room");
  h.deny();
  h.accept("account-a-room");
  assert.equal(h.status.hidden, true);
  h.deny();
  assert.equal(h.status.hidden, false);
  assert.equal(h.status.textContent, ROOM_ACCESS_NOTICE);
});

test("room snapshots preserve unrelated account errors", () => {
  for (const message of ["Couldn’t confirm account. Refresh to retry.", "Couldn’t sign out. Try again."]) {
    const h = harness(message);
    h.accept("account-a-room");
    assert.equal(h.status.hidden, false);
    assert.equal(h.status.textContent, message);
  }
});
