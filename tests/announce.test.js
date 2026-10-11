// Tests for src/announce.js (WAVE-500 guild 8 worker 16/50):
// attention arrivals (new notifications, new activity, due reminders) update
// their badges silently today — no aria-live region announces them. The fix
// adds one shared polite region plus delta-announcement helpers. No DOM here:
// tests install a minimal fake globalThis.document (restored afterwards).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { announceAttention, trackIncrease } from "../src/announce.js";

const dir = dirname(fileURLToPath(import.meta.url));
const realDocument = globalThis.document;

function fakeDocument() {
  const region = { textContent: "" };
  return { region, getElementById: id => (id === "attention-announcement" ? region : null) };
}

test.beforeEach(() => { globalThis.document = fakeDocument(); });
test.after(() => { globalThis.document = realDocument; });

const region = () => globalThis.document.region;

test("announceAttention posts text to the shared live region", () => {
  announceAttention("2 new notifications for you");
  assert.equal(region().textContent, "2 new notifications for you");
});

test("announceAttention is a no-op when the region is absent", () => {
  globalThis.document = { getElementById: () => null };
  assert.doesNotThrow(() => announceAttention("hello"));
});

test("announceAttention ignores empty text", () => {
  announceAttention("");
  assert.equal(region().textContent, "");
});

test("announceAttention re-announces identical text (clear, then re-set)", async () => {
  announceAttention("1 reminder due");
  announceAttention("1 reminder due");
  assert.equal(region().textContent, "", "same text clears synchronously so AT re-reads it");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(region().textContent, "1 reminder due");
});

test("trackIncrease stays silent on first sighting (baseline, not new)", () => {
  const update = trackIncrease(d => `${d} new`);
  update(5);
  assert.equal(region().textContent, "", "pre-existing unread must not announce on load");
});

test("trackIncrease announces only the delta on growth", () => {
  const update = trackIncrease(d => `${d} new notification${d === 1 ? "" : "s"} for you`);
  update(3);
  update(5);
  assert.equal(region().textContent, "2 new notifications for you");
  update(5);
  assert.equal(region().textContent, "2 new notifications for you", "unchanged count stays silent");
  update(4);
  assert.equal(region().textContent, "2 new notifications for you", "decreases stay silent");
  update(7);
  assert.equal(region().textContent, "3 new notifications for you");
});

test("trackIncrease self-heals after counts reset to zero", () => {
  const update = trackIncrease(d => `${d} new`);
  update(5);
  update(0);
  assert.equal(region().textContent, "");
  update(2);
  assert.equal(region().textContent, "2 new");
});

test("index.html carries the shared polite live region", () => {
  const html = readFileSync(join(dir, "..", "index.html"), "utf8");
  assert.match(html, /id="attention-announcement"/, "region exists");
  assert.match(html, /id="attention-announcement"[^>]*role="status"/, "role=status (implicit polite live region)");
  assert.match(html, /id="attention-announcement"[^>]*aria-live="polite"/, "explicitly polite, never assertive");
});
