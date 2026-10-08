// QA200-MUT-09B hardening: recoverable registration must carry a generated
// identity credential.
//
// create(displayName, { secret }) fails closed with 422 invalid_identity when
// the supplied recoverable credential is not a generated `pri_` credential
// (43 base64url chars). Without that gate, an arbitrary garbage bearer value
// mints a fresh identity and is stored as its verifier — breaking the
// recoverable-registration invariant that only generated credentials re-mint.
// Probe C found no existing test asserting this gate; this test fails first
// against the neutralized gate and passes against the real one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "identity-recoverable-cred-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test("recoverable mint rejects a malformed supplied credential (422 invalid_identity)", t => {
  const store = openStore(t);
  let error = null;
  try {
    store.identities.create("Recovery Wrangler", { secret: "garbage-not-a-pri-credential" });
  } catch (err) { error = err; }
  assert.ok(error, "expected the malformed recoverable credential to be rejected, but the mint succeeded");
  assert.equal(error.status, 422, `expected 422, got ${error.status}`);
  assert.equal(error.code, "invalid_identity", `expected invalid_identity, got ${error.code}`);
});

test("recoverable mint accepts a well-formed pri_ credential path (control case)", t => {
  const store = openStore(t);
  // A normally-minted identity's secret re-mints as a recoverable duplicate.
  const first = store.identities.create("Recovery Control");
  assert.ok(first.secret.startsWith("pri_"));
  const again = store.identities.create("Recovery Control 2", { secret: first.secret });
  assert.equal(again.duplicate, true);
  assert.equal(again.identityId, first.identityId);
});
