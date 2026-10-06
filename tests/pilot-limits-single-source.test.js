// G11 guard (John's Tab, 2026-10-06): one source for the room event cap.
// The 10000 literal was copied into five modules beside PILOT_LIMITS, so
// raising the cap in store.mjs would have left joins, invites, share links,
// referrals and access requests refusing at 10,000.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PILOT_LIMITS } from "../server/store.mjs";

test("no server module hard-codes the room event cap", () => {
  const offenders = [];
  for (const name of readdirSync(new URL("../server/", import.meta.url))) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(new URL(`../server/${name}`, import.meta.url), "utf8");
    text.split("\n").forEach((line, i) => {
      if (/sequence\s*(\+\s*1\s*)?>=?\s*\d{4,}/.test(line) || /MAX_ROOM_EVENTS\s*=\s*\d/.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the raised limits hold: events 1,000,000 and projection 16 MB", () => {
  assert.equal(PILOT_LIMITS.eventsPerRoom, 1_000_000);
  assert.equal(PILOT_LIMITS.projectionBytes, 16 * 1024 * 1024);
});
