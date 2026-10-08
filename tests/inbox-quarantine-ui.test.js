// Quarantine review UI pure contract: the relative-age copy shown on held
// message cards. The installer and its cards are DOM-bound and stay owned by
// the quarantine browser check; this pins the age buckets the cards display.
import test from "node:test";
import assert from "node:assert/strict";
import { quarantineAge } from "../src/inbox-quarantine-ui.js";

test("quarantineAge renders fresh holds as just now", () => {
  const now = Date.now();
  assert.equal(quarantineAge(now), "just now");
  assert.equal(quarantineAge(now - 30 * 1000), "just now");
  assert.equal(quarantineAge(now - 59 * 1000), "just now");
});

test("quarantineAge buckets minutes, hours, and days", () => {
  const now = Date.now();
  assert.equal(quarantineAge(now - 60 * 1000), "1m ago");
  assert.equal(quarantineAge(now - 5 * 60 * 1000), "5m ago");
  assert.equal(quarantineAge(now - 59 * 60 * 1000), "59m ago");
  assert.equal(quarantineAge(now - 60 * 60 * 1000), "1h ago");
  assert.equal(quarantineAge(now - 3 * 60 * 60 * 1000), "3h ago");
  assert.equal(quarantineAge(now - 23 * 60 * 60 * 1000), "23h ago");
  assert.equal(quarantineAge(now - 24 * 60 * 60 * 1000), "1d ago");
  assert.equal(quarantineAge(now - 3 * 24 * 60 * 60 * 1000), "3d ago");
});

test("quarantineAge never shows a future or negative age", () => {
  const now = Date.now();
  assert.equal(quarantineAge(now + 60 * 1000), "just now");
});
