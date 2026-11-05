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

test("room chat does not need a recipient picker", () => {
  assert.equal(composerAudiencePickerVisible(), false);
  assert.equal(composerAudiencePickerVisible({ recipientId: "" }), false);
});

test("private drafts, explicit selection and requests retain audience controls", () => {
  for (const state of [{ recipientId: "ada" }, { recipientId: "removed-member" },
    { choosingRecipient: true }, { requestMode: true }]) {
    assert.equal(composerAudiencePickerVisible(state), true);
  }
});
