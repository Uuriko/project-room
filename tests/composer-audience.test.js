import test from "node:test";
import assert from "node:assert/strict";
import { composerAudienceNote } from "../src/composer-files.js";

test("an inherited composer recipient is not a private audience", () => {
  const members = { ada: { id: "ada", displayName: "Ada", active: true } };
  assert.equal(composerAudienceNote(members, "toString"), null);
  assert.equal(composerAudienceNote(members, "missing"), null);
  assert.equal(
    composerAudienceNote(members, "ada"),
    "Private — only you and Ada can see this message."
  );
});
