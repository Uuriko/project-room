// Unit tests for src/session-expiry.js: the session-expiration rendering
// helpers shared by the join page and the room app. The server always
// supplies the genuine session expiry (epoch ms); these helpers only
// format it for display in the user's locale, never invent one.
import test from "node:test";
import assert from "node:assert/strict";
import { validSessionExpiry, formatSessionExpiry } from "../src/session-expiry.js";

test("validSessionExpiry accepts positive safe integers", () => {
  assert.equal(validSessionExpiry(1_758_745_200_000), 1_758_745_200_000);
  assert.equal(validSessionExpiry(1), 1);
});

test("validSessionExpiry rejects everything that is not a usable expiry", () => {
  for (const bad of [null, undefined, 0, -1, Number.NaN, 1.5, "1758745200000", Infinity, {}, []]) {
    assert.equal(validSessionExpiry(bad), null, String(bad));
  }
});

test("formatSessionExpiry renders a real date/time in the locale", () => {
  const formatted = formatSessionExpiry(Date.UTC(2026, 8, 24, 12, 0, 0));
  assert.equal(typeof formatted, "string");
  assert.match(formatted, /2026/, "carries the genuine year");
});

test("formatSessionExpiry returns null instead of guessing", () => {
  assert.equal(formatSessionExpiry(null), null);
  assert.equal(formatSessionExpiry(undefined), null);
  assert.equal(formatSessionExpiry(0), null);
  assert.equal(formatSessionExpiry("soon"), null);
});
