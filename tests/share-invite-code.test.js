import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  formatShareInviteCode, normalizeShareInviteCode, parseShareInviteCode,
  shareJoinSecretFromText, isShareInviteCode
} from "../src/share-invite-code.js";
import { consumeJoinFragment } from "../src/share-links.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-join-code-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

test("short invite codes fold confusable letters and reject lookalikes", () => {
  assert.equal(parseShareInviteCode("abc-def-ghj"), "ABC-DEF-GHJ");
  assert.equal(parseShareInviteCode("ABCDEFGHJ"), "ABC-DEF-GHJ");
  assert.equal(normalizeShareInviteCode("ilo-ilo-ilo"), "110110110");
  assert.equal(formatShareInviteCode("110110110"), "110-110-110");
  assert.equal(isShareInviteCode("RM-ABCDEFGHJKLMNP"), false);
  assert.equal(isShareInviteCode("ga1." + "A".repeat(43)), false);
  assert.equal(isShareInviteCode("A".repeat(43)), false);
  assert.equal(shareJoinSecretFromText("https://www.getdasha.com/room/#join/" + "T".repeat(43)), "T".repeat(43));
  assert.equal(shareJoinSecretFromText("abc def ghj"), "ABC-DEF-GHJ");
});

test("share-link mint returns a one-time short code that previews and joins", t => {
  const { store, ownerKey } = fixture(t);
  const linkToken = randomBytes(32).toString("base64url");
  const requestId = randomUUID();
  const expiresAt = Date.now() + 3600000;
  const created = store.shareLinks.create(ownerKey, "commons", {
    requestId, linkToken, expiresAt, maxJoins: 2, expectedMemberRevision: 0
  }, null);
  assert.match(created.code, /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
  const preview = store.shareLinks.preview(created.code);
  assert.equal(preview.room.id, "commons");
  assert.equal(store.shareLinks.preview(created.code.replaceAll("-", "")).room.id, "commons");
  assert.equal(JSON.stringify(store.shareLinks.list(ownerKey, "commons", null)).includes(created.code), false);
  const again = store.shareLinks.create(ownerKey, "commons", {
    requestId, linkToken, expiresAt, maxJoins: 2, expectedMemberRevision: 0
  }, null);
  assert.equal(again.duplicate, true);
  assert.equal(again.code, undefined);
  const slot = store.createAccountSessionSlot();
  const joined = store.shareLinks.join(slot.token, created.code, {
    displayName: "Code Guest", redemptionId: randomUUID(),
    expectedSessionRevision: store.accountSessionSlot(slot.token).sessionRevision,
    expectedSessionBinding: store.accountSessionSlot(slot.token).sessionBinding
  });
  assert.equal(joined.session.member.displayName, "Code Guest");
  assert.equal(joined.session.member.role, "guest");
});

test("consumeJoinFragment reads #code/ aliases and clears the hash", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  const history = Object.getOwnPropertyDescriptor(globalThis, "history");
  let replaced = "";
  Object.defineProperty(globalThis, "location", {
    configurable: true, value: { hash: "#code/abc-def-ghj", pathname: "/room", search: "" }
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true, value: { replaceState() { replaced = "/room"; } }
  });
  try {
    assert.deepEqual(consumeJoinFragment(), { token: "ABC-DEF-GHJ", focus: null });
    assert.equal(replaced, "/room");
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous); else delete globalThis.location;
    if (history) Object.defineProperty(globalThis, "history", history); else delete globalThis.history;
  }
});
