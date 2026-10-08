// QA200-MUT-09B hardening: identity mint must refuse deceptive display names.
//
// The mint path runs checkAgentDisplayName(name, { activeNames }) over the
// active global identity names and must fail closed with 422 invalid_identity
// when the name is unsafe: confusable lookalikes of an existing active name
// (width/style lookalikes that NFKC folds to the same skeleton), mixed
// scripts, and invisible characters. Removing the `!checked.safe` gate
// (mutation probe B2) lets a deceptive lookalike mint succeed; these tests
// fail first against that mutation and pass against the real gate.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "identity-deceptive-name-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

// The mint gate fails closed with 422 invalid_identity (ServiceError carries
// .status/.code). Assert the shape, not just "it threw".
function assertInvalidIdentity(t, displayName) {
  let error = null;
  try { t.store.identities.create(displayName); } catch (err) { error = err; }
  assert.ok(error, `expected mint(${JSON.stringify(displayName)}) to fail, but it succeeded`);
  assert.equal(error.status, 422, `expected 422, got ${error.status}`);
  assert.equal(error.code, "invalid_identity", `expected invalid_identity, got ${error.code}`);
}

test("mint refuses a confusable lookalike of an active identity name", t => {
  t.store = openStore(t);
  const first = t.store.identities.create("Mint Prober");
  assert.ok(first.identityId.startsWith("ai_"));
  // Fullwidth Ｍ (U+FF2D): same glyph as ASCII M, different codepoint.
  // NFKC folds it to "M", so the skeleton collides with "Mint Prober".
  assertInvalidIdentity(t, "Ｍint Prober");
});

test("mint refuses a lookalike with a trailing confusable glyph", t => {
  t.store = openStore(t);
  t.store.identities.create("Ledger Clerk");
  // Cyrillic е (U+0435) in place of Latin e.
  assertInvalidIdentity(t, "Ledger Clеrk");
});

test("mint refuses mixed-script display names", t => {
  t.store = openStore(t);
  // Cyrillic е (U+0435) mixed into an otherwise Latin name.
  assertInvalidIdentity(t, "Quillbоt");
});

test("mint refuses invisible characters in display names", t => {
  t.store = openStore(t);
  // Zero-width space (U+200B) is not a C0 control, so only the guard catches it.
  assertInvalidIdentity(t, "Al\u200bice");
});
