// QA7-11: public-face status stays owner-only (it carries the live pub1.*
// code), but a member's status read is refused as a view, not a change.
import test from "node:test";
import assert from "node:assert/strict";
import { PublicFace } from "../server/public-face.mjs";

const store = { db: {}, room: () => ({ state: { room: { id: "r1", ownerId: "owner" } } }) };
const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("public-face: a member status read is refused with a view message", () => {
  const refused = errOf(() => new PublicFace(store).status("r1", "alice"));
  assert.equal(refused?.status, 403);
  assert.equal(refused.code, "owner_only");
  assert.equal(refused.message, "Only the room owner may view the public face");
});

test("public-face: a member toggle is still refused as a change", () => {
  const face = new PublicFace({ ...store, transaction: fn => fn() });
  for (const call of [() => face.enable("r1", "alice"), () => face.disable("r1", "alice"), () => face.rotate("r1", "alice")]) {
    const refused = errOf(call);
    assert.equal(refused?.code, "owner_only");
    assert.equal(refused.message, "Only the room owner may change the public face");
  }
});
