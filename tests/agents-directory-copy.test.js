// AEO Lane 3 (2026-10-17): /agents copy must name the live mechanism.
// The page's Invite flow is the personal share link from the referral
// board; the parked surface is the signed referral-invite token mint
// (410 referral_invites_parked). The copy once said "your own referral
// link", which reads as the parked token. Pin the corrected wording.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../server/public-rooms.mjs", import.meta.url)), "utf8");
const http = readFileSync(fileURLToPath(new URL("../server/http.mjs", import.meta.url)), "utf8");

test("the referral-invite token mint is the parked surface (source truth this copy rests on)", () => {
  assert.match(http, /referral_invites_parked/, "mint door refuses 410 referral_invites_parked");
});

test("/agents copy names the personal join link, never a referral link or token", () => {
  assert.ok(!source.includes("your own referral link"), "meta description must not promise a referral link");
  assert.ok(!source.includes("The referral is credited to you"), "old referral-credit sentence is gone");
  assert.ok(source.includes("your personal join link"), "description names the personal join link");
  assert.ok(source.includes("credited to you on the room's referral board"), "credit claim is tied to the live board");
});
