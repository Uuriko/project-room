import test from "node:test";
import assert from "node:assert/strict";
import { composerAudienceNote, composerAudiencePickerVisible } from "../src/composer-files.js";

test("an inherited composer recipient is not a private audience", () => {
  const members = { ada: { id: "ada", displayName: "Ada", active: true } };
  assert.equal(composerAudienceNote(members, "toString"), null);
  assert.equal(composerAudienceNote(members, "missing"), null);
  assert.equal(
    composerAudienceNote(members, "ada"),
    "Private — only you and Ada can see this message."
  );
});

// bu-09: the audience picker is the broadcast-vs-DM control. It must be
// visible whenever there is someone to address — including when no recipient
// is chosen yet, so a human can discover and start a DM.
test("audience picker stays visible while a recipient can be chosen", () => {
  const members = [
    { id: "me", displayName: "Me", active: true },
    { id: "ada", displayName: "Ada", active: true },
  ];
  // No recipient chosen yet: the picker must still be shown (this is the
  // regression — the old rule hid the only entry point until one was set).
  assert.equal(composerAudiencePickerVisible({ members, selfId: "me", requestMode: false }), true);
  assert.equal(composerAudiencePickerVisible({ members, selfId: "me", requestMode: true }), true);
  // Inactive members are not an audience.
  const inactive = [
    { id: "me", displayName: "Me", active: true },
    { id: "ghost", displayName: "Ghost", active: false },
  ];
  assert.equal(composerAudiencePickerVisible({ members: inactive, selfId: "me", requestMode: false }), false);
});

test("audience picker hides when there is nobody to address", () => {
  // Solo room: the control would only offer "Everyone".
  assert.equal(
    composerAudiencePickerVisible({ members: [{ id: "me", displayName: "Me", active: true }], selfId: "me", requestMode: false }),
    false
  );
  assert.equal(composerAudiencePickerVisible({ members: [], selfId: "me", requestMode: false }), false);
  assert.equal(composerAudiencePickerVisible({ requestMode: false }), false);
  // Request mode always needs the recipient picker.
  assert.equal(
    composerAudiencePickerVisible({ members: [{ id: "me", displayName: "Me", active: true }], selfId: "me", requestMode: true }),
    true
  );
});
