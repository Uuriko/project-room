import test from "node:test";
import assert from "node:assert/strict";
import { holdersForPath } from "../client/swarm-brief.mjs";

const nfc = "server/caf\u00e9.mjs";
const nfd = "server/cafe\u0301.mjs";

test("an NFD holders query finds the NFC lease of the same file", () => {
  const claims = [{
    id: "lane-a",
    state: "claimed",
    owner: "ai_a",
    files: [nfc],
    leaseExpiresAt: "2026-10-11T00:00:00.000Z",
  }, {
    id: "lane-done",
    state: "done",
    owner: "ai_old",
    files: [nfd],
  }];
  const holders = holdersForPath(claims, nfd);
  assert.equal(holders.length, 1);
  assert.equal(holders[0].id, "lane-a");
  assert.equal(holders[0].owner, "ai_a");
  assert.equal(holdersForPath([{
    id: "lane-nfd",
    state: "in_progress",
    owner: "ai_b",
    files: [nfd],
  }], nfc)[0].id, "lane-nfd");
  assert.equal(holdersForPath([{
    id: "lane-case",
    state: "claimed",
    owner: "ai_c",
    files: ["Server/Cafe.mjs"],
  }], "server/cafe.mjs").length, 0);
  assert.throws(() => holdersForPath(claims, "../cafe.mjs"), /invalid_text_plug/);
});
