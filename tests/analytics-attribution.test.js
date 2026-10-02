import test from "node:test";
import assert from "node:assert/strict";
import { attributionFromRef, mintRef, readRef, REF_TTL_SEC } from "../server/analytics/attribution.mjs";

const KEY = "analytics-test-key";
const NOW = Date.parse("2026-09-30T15:00:00.000Z");

test("a signed ref round-trips, and a tampered, expired, unsigned, or plain-text ref is not stored", async () => {
  const token = await mintRef({ memberId: "owner", artifactId: "rcpt:wcr_abc", loop: "receipt", now: NOW }, KEY);
  assert.ok(token.length <= 160);
  assert.ok(token.startsWith("r1."));
  const read = await readRef(token, KEY, NOW);
  assert.equal(read.trusted, true);
  assert.equal(read.memberId, "owner");
  assert.equal(read.artifactId, "rcpt:wcr_abc");
  assert.equal(read.loop, "receipt");

  const [prefix, payload, mac] = token.split(".");
  const flipped = `${prefix}.${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
  const tampered = await attributionFromRef(flipped, KEY, NOW);
  assert.equal(tampered.refMemberId, null);
  assert.equal(tampered.artifactId, null);

  const expired = await readRef(token, KEY, NOW + (REF_TTL_SEC + 86_400) * 1000);
  assert.equal(expired.trusted, false);
  assert.equal(expired.expired, true);
  const expiredKeep = await attributionFromRef(token, KEY, NOW + (REF_TTL_SEC + 86_400) * 1000);
  assert.equal(expiredKeep.refMemberId, null);

  const unsigned = await mintRef({ memberId: "owner", artifactId: "room:alpha", loop: "invite", now: NOW }, null);
  assert.ok(unsigned.startsWith("r0."));
  const untrusted = await attributionFromRef(unsigned, KEY, NOW);
  assert.equal(untrusted.refMemberId, null);
  assert.equal(untrusted.legacy, false);

  const legacy = await attributionFromRef("LeakNameZZ", KEY, NOW);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.refMemberId, null);
  assert.equal(JSON.stringify(legacy).includes("LeakNameZZ"), false);
});
