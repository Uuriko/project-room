// F10: hostile inputs to room-key host-id derivation + attachment validators — 422s only, no hangs.
import assert from "node:assert/strict";
import { roomKeyHostId } from "../../server/room-key-presence.mjs";
import { validAttachmentData, base64LengthForBytes } from "../../server/room-attachment-bytes.mjs";
import { fuzz, throwsBounded } from "./lib.mjs";

const auth = { hostPrefix: "rk_deadbeef_" };
const NASTY_IDS = ["", "a".repeat(129), "a".repeat(10000), "has space", "semi;colon", "../x",
  "ünïcodé", "a\nb", "a\0b", ".", "..", "-", "_", "A".repeat(128), "ok.id_1-2",
  123, null, undefined, {}, [], true];
fuzz("F10-hostile-ids", async () => {
  let rejected = 0, accepted = 0;
  for (const id of NASTY_IDS) {
    const t0 = Date.now();
    try {
      const out = roomKeyHostId(auth, id);
      accepted++;
      assert.ok(out.startsWith("rk_deadbeef_"), "prefix lost");
      assert.equal(out.length, "rk_deadbeef_".length + 48, "hash length changed");
    } catch (e) {
      rejected++;
      assert.equal(e.status, 422, `hostId ${JSON.stringify(String(id)).slice(0, 30)} gave ${e.status}, want 422`);
      assert.ok(e.code === "invalid_heartbeat");
    }
    assert.ok(Date.now() - t0 < 2000, "hang on hostId");
  }
  console.log(`  roomKeyHostId: ${accepted} accepted, ${rejected} rejected-as-422`);

  // determinism: same input -> same output, no secret material embedded
  const a = roomKeyHostId(auth, "host-1"), b = roomKeyHostId(auth, "host-1");
  assert.equal(a, b);

  // attachment data validator: garbage never throws, never hangs
  const NASTY_DATA = ["", "!!!!", "a", "abc", "a".repeat(3), "====", "\nYWJj\n",
    "a".repeat(1000003), null, undefined, 42, {}, "YWJj", "YWJj\n", " YWJj"];
  for (const v of NASTY_DATA) {
    const r = validAttachmentData(v);
    assert.equal(typeof r, "boolean", `validAttachmentData threw/returned non-boolean for ${JSON.stringify(String(v)).slice(0, 20)}`);
  }
  console.log(`  validAttachmentData: ${NASTY_DATA.length} hostile inputs, boolean-only`);
  assert.ok(base64LengthForBytes(0) === 0 && base64LengthForBytes(3) === 4 && base64LengthForBytes(4) === 8);
});
