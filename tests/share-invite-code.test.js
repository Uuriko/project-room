import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  const f = { store, ownerKey, filename: join(directory, "room.sqlite") };
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
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

test("short invite codes parse out of join URLs and links", () => {
  assert.equal(parseShareInviteCode("https://www.getdasha.com/room#code/abc-def-ghj"), "ABC-DEF-GHJ");
  assert.equal(parseShareInviteCode("https://www.getdasha.com/room#code/ABCDEFGHJ"), "ABC-DEF-GHJ");
  assert.equal(parseShareInviteCode("https://www.getdasha.com/room?code=abc-def-ghj"), "ABC-DEF-GHJ");
  assert.equal(parseShareInviteCode("https://example.com/x/abc-def-ghj"), "ABC-DEF-GHJ");
  assert.equal(parseShareInviteCode("https://www.getdasha.com/room#code/abc-def-ghj/extra"), "ABC-DEF-GHJ");
  assert.equal(parseShareInviteCode("https://www.getdasha.com/room"), "");
  assert.equal(parseShareInviteCode("https://example.com/x/not-a-code"), "");
  assert.equal(parseShareInviteCode(""), "");
  assert.equal(parseShareInviteCode(null), "");
  assert.equal(isShareInviteCode("https://www.getdasha.com/room#code/abc-def-ghj"), true);
  assert.equal(shareJoinSecretFromText("https://www.getdasha.com/room#code/abc-def-ghj"), "ABC-DEF-GHJ");
});

test("persisted legacy invite aliases still preview and redeem without issuing new codes", t => {
  const f = fixture(t);
  const { store, ownerKey } = f;
  const linkToken = randomBytes(32).toString("base64url");
  const requestId = randomUUID();
  const expiresAt = Date.now() + 3600000;
  const created = store.shareLinks.create(ownerKey, "commons", {
    requestId, linkToken, expiresAt, maxJoins: 2, expectedMemberRevision: 0
  }, null);
  const legacyCode = "ABC-DEF-GHJ";
  const codeHash = createHash("sha256").update("ABCDEFGHJ").digest("hex");
  // Historical persisted alias: neither creation nor its retry may replace it.
  store.db.prepare("INSERT INTO share_link_codes(code_hash,link_id,created_at) VALUES(?,?,?)").run(codeHash, created.link.id, Date.now());
  store.close();
  f.store = new RoomStore(f.filename);
  const reopened = f.store;
  const preview = reopened.shareLinks.preview(legacyCode);
  assert.equal(preview.room.id, "commons");
  assert.equal(reopened.shareLinks.preview("ABCDEFGHJ").room.id, "commons");
  assert.equal(JSON.stringify(reopened.shareLinks.list(ownerKey, "commons", null)).includes(legacyCode), false);
  const again = reopened.shareLinks.create(ownerKey, "commons", {
    requestId, linkToken, expiresAt, maxJoins: 2, expectedMemberRevision: 0
  }, null);
  assert.equal(again.duplicate, true);
  assert.equal(Object.hasOwn(again, "code"), false);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM share_link_codes").get().n, 1);
  const slot = reopened.createAccountSessionSlot();
  const joined = reopened.shareLinks.join(slot.token, legacyCode, {
    displayName: "Code Guest", redemptionId: randomUUID(),
    expectedSessionRevision: reopened.accountSessionSlot(slot.token).sessionRevision,
    expectedSessionBinding: reopened.accountSessionSlot(slot.token).sessionBinding
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
